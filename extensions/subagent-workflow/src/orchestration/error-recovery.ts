/**
 * Workflow Extension — error-recovery
 *
 * Worker 失败处理 free functions（D-12）。
 *
 * 4 个导出函数（domain-models.md §失败处理矩阵）：
 * - handleWorkerMessage(run, raw, deps, handlers) — 路由 agent_call/return/error
 * - handleWorkerError(run, err, deps, handlers) — worker uncaught error
 * - handleWorkerExit(run, code, handle, deps, handlers) — worker exit
 * - handleScriptError(run, msg, deps, handlers) — type:"error" from worker
 *
 * 重试矩阵（domain-models.md §失败处理矩阵）：
 * - worker error/exit（非零）→ 3 次重试 + 指数退避 1s/2s/4s；超限 failed
 * - script error → 3 次重试 + 指数退避；超限 failed
 * - 重试前 rebuildRuntime（G3-001：整个 RunRuntime 重建：worker+gate+controller）
 *
 * 关键不变式：
 * - 重试前必须 rebuildRuntime（worker+gate+controller 整体重建，避免孤儿资源）。
 * - 重试计数载体是 run.meta.workerErrorCount/scriptErrorCount（跨 runtime 存活，
 * retry replaceRuntime 后计数不丢）。
 * - handleWorkerExit 检查 handle.isCurrent（G-025：stale exit 事件丢弃）。
 *
 * 层归属：Engine。依赖 ports + ConcurrencyGate + WorkflowRun + executeAgentCall。
 *
 * 参考：domain-models.md §失败处理矩阵。
 */

import { SLUG_MAX_LENGTH } from "../execution/execute-options-mapper.ts";
import { createRecord, updateFromEvent } from "../execution/execution-record.ts";
import { SubagentStream } from "../execution/stream-sink.ts";
import type { AgentEvent } from "../shared/agent-event.ts";
import { resolveAgentOpts } from "./agent-opts-resolver.ts";
import { ConcurrencyGate, DEFAULT_CONCURRENCY } from "./concurrency-gate.ts";
import { executeAgentCall } from "./execute-agent-call.ts";
import { AgentCall } from "./models/agent-call.ts";
import type { LifecycleDeps, WorkerHandlers } from "./models/ports.ts";
import { RunRuntime } from "./models/run-runtime.ts";
import type { WorkerLogEntry } from "./models/types.ts";
import type { AgentCallOpts, AgentResult, ExecutionTraceNode } from "./models/types.ts";
import type { WorkflowRun } from "./models/workflow-run.ts";
import type { WorkerHandle } from "./worker-handle.ts";

// ── 常量 ─────────────────────────────────────────────────────

/** Worker/script 错误最大重试次数（domain-models.md §失败处理矩阵）。 */
const MAX_WORKER_RETRIES = 3;

/** 指数退避基数（ms）。 */
const RETRY_BACKOFF_BASE_MS = 1000;
const EXPONENTIAL_BACKOFF_BASE = 2;

// ── Worker 消息类型（与 infra/worker-script-builder.ts WorkerInMsg 对齐） ──

interface AgentCallMsg {
  type: "agent-call";
  callId: number;
  opts: {
    prompt: string;
    schema?: unknown;
    model?: string;
    scene?: string;
    description?: string;
    agent?: string;
    skill?: string;
    timeoutMs?: number;
    cwd?: string; // ADR-029 决策 1：per-call cwd（worktree 隔离）
  };
  phase?: string;
}

interface ReturnMsg {
  type: "return";
  result: unknown;
  workerLogs?: WorkerLogEntry[];
}

interface ErrorMsg {
  type: "error";
  error: string;
  workerLogs?: WorkerLogEntry[];
}

interface WorkflowCallMsg {
  type: "workflow-call";
  callId: number;
  name: string;
  args: Record<string, unknown>;
}

type WorkerMsg = AgentCallMsg | WorkflowCallMsg | ReturnMsg | ErrorMsg;

// ── 内部 helper ──────────────────────────────────────────────

function isTerminal(run: WorkflowRun): boolean {
  return run.state.status === "done";
}

/** 计算第 n 次重试前的退避时间（ms）：1s, 2s, 4s 指数。 */
function backoffDelay(retryIndex: number): number {
  return RETRY_BACKOFF_BASE_MS * Math.pow(EXPONENTIAL_BACKOFF_BASE, retryIndex - 1);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── rebuildRuntime（G3-001 整重建） ─────────────────────────

/**
 * 重建整个 RunRuntime：新 controller + 新 gate + 新 worker。
 *
 * 调 run.replaceRuntime(newRt)（G5-001）：原子释放旧 runtime（worker.terminate +
 * abort）+ 绑定新 runtime，全程 status==="running" 不变（不变式 I1 不违反）。
 *
 * handlers 由调用方（lifecycle makeHandlers）构造——它们路由 onMessage/onError/
 * onExit 回本文件的 handle* 函数。handlers 捕获 run + deps 闭包，runtime 重建后
 * 仍有效（run 实例不变，deps 不变）。
 *
 * 前置：run.state.status === "running"（replaceRuntime 要求，G6-001）。
 *
 * @throws status !== "running"（由 replaceRuntime 抛）
 */
export function rebuildRuntime(
  run: WorkflowRun,
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): void {
  const controller = new AbortController();
  const gate = new ConcurrencyGate({ maxConcurrency: DEFAULT_CONCURRENCY });
  const worker = deps.workerHost.start(run.spec, run.spec.args, handlers);
 // D-12 regression fix (round-2 #2)：重新调度 run 级墙钟预算计时器。
 // replaceRuntime 释放旧 runtime 时 clearTimeout 了旧计时器（run-runtime.release），
 // 新 runtime 必须重排，否则带 budgetTimeMs 的 run 命中一次 worker/script 错误重试后
 // 时间预算静默失效（直到 pause/resume 才重排）。deps.scheduleTimeBudget 由 Interface
 // 层注入；未注入时（旧测试）跳过重排（兼容，不影响无时间预算的 run）。
  const timeBudgetTimer =
    run.spec.budgetTimeMs && run.spec.budgetTimeMs > 0 && deps.scheduleTimeBudget
      ? deps.scheduleTimeBudget(run.runId, run.spec.budgetTimeMs)
      : undefined;
  run.replaceRuntime(new RunRuntime(worker, gate, controller, timeBudgetTimer));
}

// ── handleWorkerMessage（消息路由） ──────────────────────────

/**
 * 路由 worker → main 的业务消息。
 *
 * agent_call → 派发 executeAgentCall（异步，不 await——立即返回让 worker 继续发消息）
 * return → transition done,completed（脚本正常返回）
 * error → handleScriptError（脚本主动抛错）
 *
 * 终态/paused 状态下的 stale 消息丢弃（P0-1）。
 */
export async function handleWorkerMessage(
  run: WorkflowRun,
  raw: unknown,
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): Promise<void> {
 // 终态/paused 状态丢弃 stale 消息（P0-1）
  if (isTerminal(run) || run.state.status === "paused") return;

  const msg = raw as WorkerMsg;
  switch (msg.type) {
    case "agent-call":
      dispatchAgentCall(run, msg, deps);
      return;
    case "workflow-call":
      dispatchWorkflowCall(run, msg, deps);
      return;
    case "return":
      await handleReturn(run, msg, deps);
      return;
    case "error":
 // M1: 传 handlers（rebuildRuntime 需要）
      await handleScriptError(
        run,
        msg.error,
        msg.workerLogs ?? [],
        deps,
        handlers,
      );
      return;
  }
}

/**
 * 派发 agent 调用：构建 AgentCall + trace 节点，异步触发 executeAgentCall。
 *
 * 异步触发（不 await）——立即返回，让 worker 能继续发后续 agent-call（parallel 场景）。
 * executeAgentCall 内部完成 markDone + trace.update。
 *
 * **C-3 修复**：executeAgentCall 通过 `run.runtime.gate.withSlot` 包装——gate 管并发
 * 上限（maxConcurrency=4）+ FIFO 排队，runner 管 spawn。两层职责分离。
 *
 * **C-2 修复**：call 完成后检查 `budget.isExceeded` → abortRun(budget_limited)，
 * 终止整个 run（避免烧光预算后继续 spawn 新 call）。
 *
 * **stale 完成守卫**：.then 内 recheck `run.state.status === "running"`，paused 后到达的
 * call 完成不写 run.state.calls / 不 postAgentResult（pause 是干净快照）。
 */
function dispatchAgentCall(
  run: WorkflowRun,
  msg: AgentCallMsg,
  deps: LifecycleDeps,
): void {
 // 已缓存的调用直接 replay（跨 pause/resume）
  const cached = run.state.calls.get(msg.callId);
  if (cached && cached.status === "done") {
    postAgentResult(run, msg.callId, cached.result!, true);
    return;
  }

  // 构建 trace 节点 + live record（TUI 实时进度）
  const agentName = msg.opts.description ?? msg.opts.agent ?? "unknown";
  // slug 复用 agentName（超长截断），live record 的 slug 仅用于 TUI 展示。
  const liveSlug = agentName.length > SLUG_MAX_LENGTH ? agentName.slice(0, SLUG_MAX_LENGTH) : agentName;
  const now = new Date().toISOString();
  // live record：收口 agent 执行过程中的 text/thinking/toolCalls/usage，
  // 供 TUI 在 agent 运行期间显示进度（getEventLog/getCurrentActivity）。
  // 完成时由下方 .then 清除（终态由 node.result 承载）。
  const liveRecord = createRecord(String(msg.callId), {
    agent: agentName,
    model: msg.opts.model ?? "default",
    mode: "background",
    task: msg.opts.prompt,
    slug: liveSlug,
    startedAt: Date.now(),
  });
  const node: ExecutionTraceNode = {
    stepIndex: msg.callId,
    agent: agentName,
    task: msg.opts.prompt,
    model: msg.opts.model ?? "default",
    status: "running" as const,
    phase: msg.phase,
    startedAt: now,
    live: liveRecord,
  };
  run.state.trace.append(node);

 // 构建 AgentCall（opts 形状对齐 AgentCallOpts；schema: unknown → Record）
 // 跨进程 IPC 边界的 schema 为 unknown，窄化前加 typeof guard 兜底。
  const rawSchema = msg.opts.schema;
  const opts: AgentCallOpts = {
    ...msg.opts,
    schema:
      typeof rawSchema === "object" && rawSchema !== null
        ? (rawSchema as Record<string, unknown>)
        : undefined,
  };

 // BL-1：解析 agent/skill/schema → systemPromptFiles / skillPath / schemaEnv。
 // D-12 重构误删 resolveAgentOpts，导致 inline override 静默失效。此处从
 // LifecycleDeps 取 agentRegistry/sessionDir/activeTempFiles（per-session，由
 // Interface 层 session_start 注入），调 resolveAgentOpts 解析 inline override。
 // 解析失败（agent/skill 未找到、临时文件写入错）走 error 路径，不发 slot、不 spawn。
  const hasResolverDeps = deps.agentRegistry && deps.sessionDir && deps.activeTempFiles;
  const resolved = hasResolverDeps
    ? resolveAgentOpts(opts, deps.agentRegistry!, deps.sessionDir!, deps.activeTempFiles!)
    : { opts };
  if (resolved.error) {
    const call = new AgentCall(msg.callId, opts, node);
    call.markRunning();
    const errorResult: AgentResult = { content: "", error: resolved.error };
    call.markDone(errorResult);
    run.state.calls.set(msg.callId, call);
    // 无子进程执行，清除空 live record（终态由 result 承载）
    node.live = undefined;
    run.state.trace.update(msg.callId, {
      status: "failed",
      result: errorResult,
      completedAt: new Date().toISOString(),
    });
    postAgentResult(run, msg.callId, errorResult, false);
    void deps.store.save(run);
    return;
  }

  const call = new AgentCall(msg.callId, resolved.opts, node);
  run.state.calls.set(msg.callId, call);

 // C-3：经 ConcurrencyGate.withSlot 获取并发槽位后执行。
 // gate 管 maxConcurrency=4 + FIFO；executeAgentCall 管 retry/budget/stale-context；
 // runner（runner.run）管 spawn pi 子进程。
 // assignRuntime/replaceRuntime 保证 status==="running" ⟺ runtime defined，
 // 故 run.runtime 在此必存在（dispatchAgentCall 仅从 handleWorkerMessage 调用，
 // 后者已守 paused/terminal 早期 return）。fallback new AbortController 已移除。
  const runtime = run.runtime!;
  const signal = runtime.controller.signal;
  // D-005: onEvent 签名升级——executeAndAwait 直接出 AgentEvent（强类型，
  // session-runner handleSdkEvent 出口），不再有 raw JSONL 中间层。
  // 删 jsonlToAgentEvent 翻译——直接 updateFromEvent。
  // TUI 靠 tick 轮询 trace.toArray() 读 node.live，无需显式通知。
  const onEvent = (event: AgentEvent): void => {
    updateFromEvent(liveRecord, event);
  };
  // 创建 streaming sink：widgetKey = subagent-stream-<runId>-<stepIndex>。
  // 复用 background subagent 的 SubagentStream → setWidget → RPC 链路（agent-call-streaming-extension.md）。
  // streamSink 缺失（无 UI 模式）时 stream=undefined，executeAgentCall 正常执行不 streaming。
  const stream = deps.streamSink
    ? new SubagentStream(`${run.runId}-${msg.callId}`, deps.streamSink)
    : undefined;
  void runtime.gate
    .withSlot(
      async () => {
        try {
          await executeAgentCall(call, deps.runner, run.state.budget, signal, run.state.trace, onEvent, stream);
        } finally {
          stream?.dispose();
        }
      },
      signal,
    )
    .then(() => {
 // pause/abort 后到达的 stale completion 不写 state（pause 是干净快照）
      if (run.state.status !== "running") return;
      // 清除 live record：终态已由 executeAgentCall → finalizeCall 写入 node.result，
      // live 不再需要（且含可变状态，不保留）。无论 stale 与否都清，避免内存泄漏。
      node.live = undefined;
      if (call.result) postAgentResult(run, msg.callId, call.result, false);
 // D-12 regression fix (round-2 #1)：executeAgentCall 内 consume/incrementCallCount
 // 后同步 worker $BUDGET（否则 $BUDGET.spent()/remaining() 恒为 0）
      postBudgetUpdate(run);
      void deps.store.save(run);

 // C-2：budget 超限 → 终止整个 run（避免继续 spawn 烧预算）
 // 内联 terminate（不调 lifecycle.abortRun 避免 engine 内循环依赖）：
 // 若 run 仍非终态，transition done,budget_limited + 持久化。
 // 上方 status !== "running" 已保证此处非 done（且 transition 内含 done no-op 守卫）。
      if (run.state.budget.isExceeded()) {
        run.state.error = run.state.error ?? "Budget exceeded";
        deps.log?.("debug", "workflow:error-recovery", "budget exceeded, transition done", { runId: run.runId });
        try {
          run.transition("done", "budget_limited");
          void deps.store.save(run);
          deps.log?.("debug", "workflow:error-recovery", "run saved after budget done", { runId: run.runId, reason: run.state.reason });
 // C-4: budget 终止也触发完成通知
          deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister", { runId: run.runId, reason: run.state.reason });
          deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "completed" });
          deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister done", { runId: run.runId });
          deps.onRunDone?.(run);
        } catch (err) {
 // run 可能在 budget 检查后、transition 前被并发 abort——忽略
          void err;
        }
      }
    })
    .catch((err: unknown) => {
 // withSlot 在 queued + signal-aborted 时 reject AbortError——预期，不记错。
      if (err instanceof Error && err.name === "AbortError") return;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[workflow] agent call ${msg.callId} failed: ${message}`);
 // 兜底回发：executeAgentCall 抛非 Abort 异常时（如 runner undefined 的 TypeError、
 // gate.withSlot 内部 bug）原 catch 仅 console.error，worker 内对 callId 的 pending
 // Promise 永不 resolve → agent() 永久 await → worker 脚本挂死。构造 failed AgentResult
 //（与 resolveAgentOpts 失败路径 L262-275 一致的模式）postAgentResult 回 worker，
 // 让 pending Promise resolve（结果为 error），脚本可继续或失败退出。
 // 注意：run 可能已进入非 running 终态（stale），此时 run.runtime 为 undefined，
 // postAgentResult 内部用 optional chaining (run.runtime?.worker) 安全跳过。
      const errorResult: AgentResult = { content: "", error: message };
      if (call.status !== "done") {
 // markDone 要求 status==="running"；若 gate.withSlot 在 markRunning 前 reject
 // （call 仍 pending），先 markRunning。非 running/done 的意外态防御：跳过 markDone。
        if (call.status === "pending") call.markRunning();
        call.markDone(errorResult);
      }
      postAgentResult(run, msg.callId, errorResult, false);
    });
}

/**
 * 派发 workflow 嵌套调用：调 deps.onWorkflowCall 获取子 workflow 结果，
 * 异步 postMessage(workflow-result) 回 worker。
 *
 * onWorkflowCall 未注入时（向后兼容），返回 error result 让脚本 soft-fail。
 * 与 dispatchAgentCall 对称：异步触发（不 await），stale 完成守卫（paused/terminal 不发）。
 */
function dispatchWorkflowCall(
  run: WorkflowRun,
  msg: WorkflowCallMsg,
  deps: LifecycleDeps,
): void {
  const postResult = (result: unknown): void => {
    if (run.state.status !== "running") return;
    run.runtime?.worker.postMessage({
      type: "workflow-result",
      callId: msg.callId,
      result,
    });
  };

  if (!deps.onWorkflowCall) {
    postResult({
      content: "",
      error: `workflow() not supported: onWorkflowCall not injected`,
    });
    return;
  }

  void deps
    .onWorkflowCall(msg.name, msg.args, run)
    .then(postResult)
    .catch((err: unknown) => {
      postResult({
        content: "",
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

/**
 * 回发 agent-result 给 worker（worker 内 pending Promise 据此 resolve）。
 */
function postAgentResult(
  run: WorkflowRun,
  callId: number,
  result: AgentResult,
  cached: boolean,
): void {
  run.runtime?.worker.postMessage({ type: "agent-result", callId, result, cached });
}

/**
 * 回发 budget-update 给 worker（$BUDGET 据 worker-script-builder 的 budget-update 分支
 * 更新 spent()/remaining()）。每次 agent 调用消费 usage 后发送，保持 worker 内 $BUDGET
 * 与主线程 Budget 值对象同步。
 *
 * D-12 regression fix (round-2 #1)：重建 budget-update 发送方。被 error-recovery（dispatch
 * 后）和 node-ops（retry/skip 后）共用——单一实现，避免消息形状漂移。
 */
export function postBudgetUpdate(run: WorkflowRun): void {
  run.runtime?.worker.postMessage({
    type: "budget-update",
    budget: {
      usedTokens: run.state.budget.usedTokens,
      usedCost: run.state.budget.usedCost,
    },
  });
}

/**
 * 处理脚本的 return 消息：transition done,completed + 持久化。
 */
async function handleReturn(
  run: WorkflowRun,
  msg: ReturnMsg,
  deps: LifecycleDeps,
): Promise<void> {
  deps.log?.("debug", "workflow:error-recovery", "handleReturn", { runId: run.runId, status: run.state.status });
 // 捕获 worker 诊断日志（P2-2）
  if (msg.workerLogs && msg.workerLogs.length > 0) {
    run.state.errorLogs = msg.workerLogs;
  }
  run.state.scriptResult = msg.result;
  run.transition("done", "completed");
  await deps.store.save(run);
  deps.log?.("debug", "workflow:error-recovery", "run saved after return", { runId: run.runId, reason: run.state.reason });
 // C-4: run 到达 done 终态 → 注销 pending-notification + 通知 Interface 层
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister", { runId: run.runId, reason: run.state.reason });
  deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "completed" });
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister done", { runId: run.runId });
  deps.onRunDone?.(run);
}

// ── handleWorkerError ────────────────────────────────────────

/**
 * 处理 worker 线程 uncaught error。
 *
 * 重试矩阵（domain-models.md §失败处理矩阵）：
 * - run.meta.workerErrorCount（C.5，跨 runtime 存活）< MAX → 退避 + rebuildRuntime
 * - >= MAX → transition done,failed
 *
 * @throws 不抛错——所有失败路径转 transition 或日志
 */
export async function handleWorkerError(
  run: WorkflowRun,
  err: Error,
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): Promise<void> {
 // 与 handleWorkerMessage 对称——paused/terminal 状态丢弃 stale error。
 // 否则 paused 后到达的 worker error 仍会 workerErrorCount++（污染跨 runtime 计数）。
  if (isTerminal(run) || run.state.status === "paused") return;

  const count = (run.meta.workerErrorCount ?? 0) + 1;
  run.meta.workerErrorCount = count;

  if (count <= MAX_WORKER_RETRIES) {
    await scheduleRebuild(run, deps, handlers);
    return;
  }

 // 超限 → failed
  run.state.error = err.message;
  deps.log?.("debug", "workflow:error-recovery", "handleWorkerError retries exceeded, transition done", { runId: run.runId, count });
  run.transition("done", "failed");
  await deps.store.save(run);
  deps.log?.("debug", "workflow:error-recovery", "run saved after worker error", { runId: run.runId, reason: run.state.reason });
 // C-4: run 到达 done 终态 → 注销 pending-notification + 通知 Interface 层
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister", { runId: run.runId, reason: run.state.reason });
  deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "completed" });
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister done", { runId: run.runId });
  deps.onRunDone?.(run);
}

// ── handleWorkerExit ─────────────────────────────────────────

/**
 * 处理 worker 线程 exit。
 *
 * code === 0 → 正常退出（脚本主动 return 或自然结束），no-op
 * code !== 0 → 委托 handleWorkerError（非零 exit 视为崩溃）
 *
 * **G-025 竞态防护**：检查 handle.isCurrent——stale exit 事件（已 terminate 的旧
 * worker 的 exit）直接丢弃，不影响当前 runtime 的新 worker。
 */
export async function handleWorkerExit(
  run: WorkflowRun,
  code: number,
  handle: WorkerHandle,
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): Promise<void> {
 // G-025: stale exit 事件丢弃（handle 已不是当前 runtime 的 worker）
  if (!handle.isCurrent) return;
  if (isTerminal(run) || run.state.status === "paused") return;

  if (code === 0) return; // 正常退出，no-op

 // 非零 exit → 委托 handleWorkerError（C.3: onExit 传 handle 用于竞态防护）
  await handleWorkerError(
    run,
    new Error(`Worker exited with code ${code}`),
    deps,
    handlers,
  );
}

// ── handleScriptError ────────────────────────────────────────

/**
 * 处理脚本主动抛出的 error（type:"error" from worker）。
 *
 * 重试矩阵：
 * - run.meta.scriptErrorCount（C.5）< MAX → 退避 + rebuildRuntime（N2: 补全重建）
 * - >= MAX → transition done,failed
 *
 * @param workerLogs worker console.* 捕获（P2-2，存 run.state.errorLogs 供 TUI 展示）
 */
export async function handleScriptError(
  run: WorkflowRun,
  errorMsg: string,
  workerLogs: WorkerLogEntry[],
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): Promise<void> {
 // 与 handleWorkerMessage/handleWorkerError 对称——paused/terminal 守卫前置。
  if (isTerminal(run) || run.state.status === "paused") return;

 // P2-2: 捕获 worker 诊断日志
  if (workerLogs.length > 0) {
    run.state.errorLogs = workerLogs;
  }

  const count = (run.meta.scriptErrorCount ?? 0) + 1;
  run.meta.scriptErrorCount = count;

  if (count <= MAX_WORKER_RETRIES) {
    await scheduleRebuild(run, deps, handlers);
    return;
  }

 // 超限 → failed
  run.state.error = `Workflow failed after ${MAX_WORKER_RETRIES} retries: ${errorMsg}`;
  deps.log?.("debug", "workflow:error-recovery", "handleScriptError retries exceeded, transition done", { runId: run.runId, count });
  run.transition("done", "failed");
  await deps.store.save(run);
  deps.log?.("debug", "workflow:error-recovery", "run saved after script error", { runId: run.runId, reason: run.state.reason });
 // C-4: run 到达 done 终态 → 注销 pending-notification + 通知 Interface 层
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister", { runId: run.runId, reason: run.state.reason });
  deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "completed" });
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister done", { runId: run.runId });
  deps.onRunDone?.(run);
}

// ── scheduleRebuild（退避 + 重建） ──────────────────────────

/**
 * 退避后重建 RunRuntime（G3-001 整重建）。
 *
 * 退避期间 run 可能被 pause/abort——rebuildRuntime 前重检状态，paused/terminal 时
 * 跳过重建（避免给已暂停的 run 启新 worker）。
 */
async function scheduleRebuild(
  run: WorkflowRun,
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): Promise<void> {
 // 用当前重试计数算退避（workerErrorCount 或 scriptErrorCount 已递增）
  const retryIndex = Math.max(
    run.meta.workerErrorCount ?? 0,
    run.meta.scriptErrorCount ?? 0,
  );
  await delay(backoffDelay(retryIndex));

 // 退避期间状态可能变化——重检
  if (isTerminal(run) || run.state.status !== "running") return;

  rebuildRuntime(run, deps, handlers);
}
