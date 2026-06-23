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

import { resolveAgentOpts } from "../infra/agent-opts-resolver.js";
import { ConcurrencyGate, DEFAULT_CONCURRENCY } from "../infra/concurrency-gate.js";
import type { WorkerHandle } from "../infra/worker-handle.js";
import { executeAgentCall } from "./execute-agent-call.js";
import { AgentCall } from "./models/agent-call.js";
import type { LifecycleDeps, WorkerHandlers } from "./models/ports.js";
import { RunRuntime } from "./models/run-runtime.js";
import type { WorkerLogEntry } from "./models/types.js";
import type { AgentCallOpts, AgentResult } from "./models/types.js";
import type { WorkflowRun } from "./models/workflow-run.js";

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

type WorkerMsg = AgentCallMsg | ReturnMsg | ErrorMsg;

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
  run.replaceRuntime(new RunRuntime(worker, gate, controller));
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

 // 构建 trace 节点
  const agentName = msg.opts.description ?? msg.opts.agent ?? "unknown";
  const now = new Date().toISOString();
  const node = {
    stepIndex: msg.callId,
    agent: agentName,
    task: msg.opts.prompt,
    model: msg.opts.model ?? "default",
    status: "running" as const,
    phase: msg.phase,
    startedAt: now,
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
  void runtime.gate
    .withSlot(() => executeAgentCall(call, deps.runner, run.state.budget, signal, run.state.trace), signal)
    .then(() => {
 // pause/abort 后到达的 stale completion 不写 state（pause 是干净快照）
      if (run.state.status !== "running") return;
      if (call.result) postAgentResult(run, msg.callId, call.result, false);
      void deps.store.save(run);

 // C-2：budget 超限 → 终止整个 run（避免继续 spawn 烧预算）
 // 内联 terminate（不调 lifecycle.abortRun 避免 engine 内循环依赖）：
 // 若 run 仍非终态，transition done,budget_limited + 持久化。
 // 上方 status !== "running" 已保证此处非 done（且 transition 内含 done no-op 守卫）。
      if (run.state.budget.isExceeded()) {
        run.state.error = run.state.error ?? "Budget exceeded";
        try {
          run.transition("done", "budget_limited");
          void deps.store.save(run);
 // C-4: budget 终止也触发完成通知
          deps.onRunDone?.(run);
        } catch (err) {
 // run 可能在 budget 检查后、transition 前被并发 abort——忽略
          void err;
        }
      }
    })
    .catch((err: unknown) => {
 // withSlot 在 queued + signal-aborted 时 reject AbortError——预期，不记错。
 // executeAgentCall 本身不 reject（runner.run 不 reject）。
      if (err instanceof Error && err.name === "AbortError") return;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[workflow] agent call ${msg.callId} failed: ${message}`);
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
 * 处理脚本的 return 消息：transition done,completed + 持久化。
 */
async function handleReturn(
  run: WorkflowRun,
  msg: ReturnMsg,
  deps: LifecycleDeps,
): Promise<void> {
 // 捕获 worker 诊断日志（P2-2）
  if (msg.workerLogs && msg.workerLogs.length > 0) {
    run.state.errorLogs = msg.workerLogs;
  }
  run.state.scriptResult = msg.result;
  run.transition("done", "completed");
  await deps.store.save(run);
 // C-4: run 到达 done 终态 → 通知 Interface 层
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
  run.transition("done", "failed");
  await deps.store.save(run);
 // C-4: run 到达 done 终态 → 通知 Interface 层
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
  run.transition("done", "failed");
  await deps.store.save(run);
 // C-4: run 到达 done 终态 → 通知 Interface 层
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
