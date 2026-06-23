/**
 * Workflow Extension — executeAgentCall（关键路径）
 *
 * 单次 agent 调用执行的 Engine free function（D-12）。显式 5 参数
 * `(call, runner, budget, signal, trace)`，无依赖注入 bag（AC-2：消除散落的
 * Context factory）。
 *
 * 职责：
 * - 重试：3 次 + 指数退避（BACKOFF_MS = [1000, 2000, 4000]）
 * - 预算：超限不重试（直接 markDone failed）
 * - stale-context：不重试（直接 markDone failed）
 * - 成功：consume usage + incrementCallCount + markDone + trace.update(completed)
 *
 * 关键设计：
 * - **D.4**：构造合法 AgentUsage，cacheWrite 合并到 input（cacheWrite 本质是写入缓存的
 * input token，避免在 consume 的 input+output+cacheRead+cacheWrite 四项求和里被双重计数）。
 * - **参数显式化**：runner 直接传入（而非 ctx.getRun(runId).pool），无 runId 查找 / pool 守卫。
 * - **stale-state 检查**：signal.aborted 时早返回。WorkflowRun 状态由调用方 lifecycle
 * 持有，executeAgentCall 只关心单次 call 生命周期。
 *
 * 层归属：Engine。零 infra 依赖（runner 是 AgentRunner port，budget/trace/call 是 Engine 模型）。
 *
 * 参考：domain-models.md §5 + §失败处理矩阵。
 */

import type { AgentCall } from "./models/agent-call.js";
import type { Budget } from "./models/budget.js";
import type { AgentRunner } from "./models/ports.js";
import type { Trace } from "./models/trace.js";
import type { AgentResult, AgentUsage } from "./models/types.js";

// ── 常量 ─────────────────────────────────────────────────────

/** 指数退避基数（ms）：第 n 次重试等待 BASE^n。 */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_EXPONENT_BASE = 2;

/** 最大尝试次数（含首次）：initial + 2 retries = 3。 */
const MAX_ATTEMPTS = 3;

/**
 * Stale context 检测模式（P1-5）。
 *
 * pi session context 被 compact/cancel 时报告的模式。这种情况下重试无意义——
 * 同样的 call 会再次失败。直接 markDone failed 终止单次调用。
 */
export const STALE_CONTEXT_PATTERNS = [
  "stale context",
  "stalecontext",
  "context canceled",
  "aborted",
] as const;

/**
 * 判断错误信息是否表示 stale/canceled pi session context。
 * 命中时不重试——重试只会再次失败（P1-5）。
 */
export function isStaleContextErrorMsg(msg: string | undefined): boolean {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return STALE_CONTEXT_PATTERNS.some((p) => lower.includes(p));
}

// ── 内部 helper ──────────────────────────────────────────────

/**
 * 累加单次 agent 调用的 usage 到 budget（D.4）。
 *
 * cacheWrite 合并到 input（cacheWrite 本质是为缓存写入的 input token），
 * cacheWrite 设 0 避免 consume 四项求和里被双重计数。构造合法 AgentUsage，
 * 不用 `as never` 绕类型。
 */
function consumeUsage(budget: Budget, u: AgentUsage): void {
  budget.consume({
    input: u.input + u.cacheWrite,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: 0,
    cost: u.cost,
    contextTokens: u.contextTokens,
    turns: u.turns,
  });
}

/**
 * 计算第 n 次重试前的退避时间（ms）。
 * 第 1 次重试 → 1000ms，第 2 次 → 2000ms，第 3 次 → 4000ms（指数退避）。
 */
function backoffDelay(retryIndex: number): number {
  return BACKOFF_BASE_MS * Math.pow(BACKOFF_EXPONENT_BASE, retryIndex - 1);
}

/**
 * 终态化单次 call：markDone + trace.update。
 *
 * 成功：status="completed"；失败：status="failed"。
 * traceNode.stepIndex === call.id（D-10 单源，调用方保证）。
 */
function finalizeCall(call: AgentCall, result: AgentResult, trace: Trace): void {
  call.markDone(result);
  const status = result.error === undefined ? "completed" : "failed";
  trace.update(call.id, {
    status,
    result,
    completedAt: new Date().toISOString(),
    sessionId: result.sessionId,
  });
}

/**
 * 延迟工具（testable —— 测试可通过 fake timers 推进）。
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── executeAgentCall ─────────────────────────────────────────

/**
 * 执行单次 agent 调用，含重试 + 预算 + stale-context 检测。
 *
 * 流程：
 * 1. markRunning（attempts++，含首次）
 * 2. await runner.run(opts, signal)（AgentRunner port，infra 实现 spawn pi 子进程）
 * 3. 若 result.usage 存在：consumeUsage（D.4 修复）
 * 4. stale-context → finalizeCall failed，返回（不重试）
 * 5. signal.aborted → 返回（调用方已终止，不重试）
 * 6. budget.isExceeded → finalizeCall failed，返回（不重试）
 * 7. 失败 && attempts < MAX → 退避后递归（下一次 markRunning）
 * 8. 否则 finalizeCall（completed 或 failed）+ incrementCallCount
 *
 * @param call AgentCall 实体（markRunning/markDone 由本函数驱动）
 * @param runner AgentRunner port（执行子进程）
 * @param budget Budget 值对象（consume + isExceeded 检查）
 * @param signal AbortSignal（runner.run 传播；abort 后不重试）
 * @param trace Trace 值对象（finalizeCall 时 update）
 */
export async function executeAgentCall(
  call: AgentCall,
  runner: AgentRunner,
  budget: Budget,
  signal: AbortSignal,
  trace: Trace,
): Promise<void> {
  call.markRunning();

  const result = await runner.run(call.opts, signal);

 // 累加 usage（D.4：cacheWrite 合并到 input，cacheWrite=0 避免双重计数）
  if (result.usage) {
    consumeUsage(budget, result.usage);
  }

 // stale-context：不重试（P1-5）
  if (result.error !== undefined && isStaleContextErrorMsg(result.error)) {
    finalizeCall(call, result, trace);
    budget.incrementCallCount();
    return;
  }

 // signal 已 abort：调用方终止，不重试（避免无意义的递归）
  if (signal.aborted) {
    finalizeCall(call, result, trace);
    budget.incrementCallCount();
    return;
  }

 // 预算超限：不重试（重试只会突破预算且无意义）
  if (result.error !== undefined && budget.isExceeded()) {
    finalizeCall(call, result, trace);
    budget.incrementCallCount();
    return;
  }

 // 可重试失败：退避后递归
  if (result.error !== undefined && call.attempts < MAX_ATTEMPTS) {
    await delay(backoffDelay(call.attempts));
 // 退避期间 signal 可能 abort
    if (signal.aborted) {
      finalizeCall(call, result, trace);
      budget.incrementCallCount();
      return;
    }
    await executeAgentCall(call, runner, budget, signal, trace);
    return;
  }

 // 终态（成功或达到重试上限的失败）
  finalizeCall(call, result, trace);
  budget.incrementCallCount();
}
