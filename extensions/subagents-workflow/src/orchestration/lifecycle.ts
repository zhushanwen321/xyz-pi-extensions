/**
 * Workflow Extension — lifecycle
 *
 * Workflow run 生命周期 free functions（D-12）。
 *
 * 4 个导出函数：
 * - runWorkflow(spec, deps, signal?) → Promise<runId>
 * - pauseRun(runId, deps) → Promise<void>（A4 原子性）
 * - resumeRun(runId, deps) → Promise<void>（G3-001 整重建）
 * - abortRun(runId, deps, reason?) → Promise<void>（done no-op）
 *
 * 私有 makeHandlers(run, deps) → WorkerHandlers：
 * - onMessage → handleWorkerMessage(run, raw, deps, handlers)
 * - onError → handleWorkerError(run, err, deps, handlers) + workerErrorCount++
 * - onExit(code, handle) → handleWorkerExit(run, code, handle, deps, handlers)
 * （G-025：handle.isCurrent 检查内化在 handleWorkerExit 内）
 *
 * **A4 原子性**：pause/abort 内部 transition 先 releaseRuntime（cleanup before mutate），
 * 失败时 status 不变。transition("paused"/"done") 在 WorkflowRun.transition 内已实现
 * 「releaseRuntime → 改 status」原子顺序。
 *
 * **G3-001**：pause 时整个 RunRuntime 丢弃（AbortController 一次性，无法复用）；
 * resume 时 assignRuntime 重建 worker/gate/controller。
 *
 * **D-13**：maxConcurrency=4（ConcurrencyGate 默认值）。
 *
 * 层归属：Engine。依赖 LifecycleDeps + ConcurrencyGate + WorkerHost via port +
 * WorkflowRun + handleWorker* 函数。
 *
 * 参考：domain-models.md §1（聚合根状态机）。
 */

import { ConcurrencyGate, DEFAULT_CONCURRENCY } from "./concurrency-gate.ts";
import {
  handleWorkerError,
  handleWorkerExit,
  handleWorkerMessage,
} from "./error-recovery.ts";
import { Budget } from "./models/budget.ts";
import type { LifecycleDeps, WorkerHandlers } from "./models/ports.ts";
import { RunRuntime } from "./models/run-runtime.ts";
import type { RunSpec } from "./models/run-spec.ts";
import { Trace } from "./models/trace.ts";
import type { DoneReason } from "./models/types.ts";
import { WorkflowRun } from "./models/workflow-run.ts";

// ── 常量 ─────────────────────────────────────────────────────

/** runId 生成：wf-<timestamp>-<base36 random 6 chars>。 */
const RUNID_RADIX = 36;
const RUNID_SLICE_START = 2;
const RUNID_SLICE_END = 8;

function generateRunId(): string {
  return `wf-${Date.now()}-${Math.random().toString(RUNID_RADIX).slice(RUNID_SLICE_START, RUNID_SLICE_END)}`;
}

// ── makeHandlers（路由 worker 事件到 error-recovery handle* 函数） ──────

/**
 * 构造 WorkerHandlers——将 worker 的 onMessage/onError/onExit 事件路由到
 * error-recovery 的 handleWorker* 函数。
 *
 * 闭包捕获 run + deps。runtime 重建（replaceRuntime）后 run 实例不变、deps 不变，
 * 故 handlers 对新 worker 仍有效（lifecycle 与 error-recovery 共用 handlers）。
 *
 * **onExit G-025**：handleWorkerExit 内部检查 handle.isCurrent（stale exit 丢弃）。
 * 本函数不在 onExit 里重复检查——error-recovery.handleWorkerExit 是单一守卫点。
 *
 * **workerErrorCount**：onError 触发时递增（C.5 跨 runtime 存活的重试计数载体）。
 * 注意 handleWorkerError 内部也会递增——这里 onError 递增是 worker 事件层面的
 * 「error 事件到达」计数，handleWorkerError 内的是「错误处理决策」计数。
 * 实际 handleWorkerError 会做最终计数（含重试上限判断），onError 不重复递增。
 */
function makeHandlers(run: WorkflowRun, deps: LifecycleDeps): WorkerHandlers {
 // 自引用——error-recovery rebuildRuntime 需要 handlers 参数（handlers 引用自身）
  const handlers: WorkerHandlers = {
    async onMessage(raw: unknown): Promise<void> {
      await handleWorkerMessage(run, raw, deps, handlers);
    },
    async onError(err: Error): Promise<void> {
      await handleWorkerError(run, err, deps, handlers);
    },
    async onExit(code: number): Promise<void> {
 // handle 由 WorkerHost 在 onExit 回调里传入——此处闭包拿不到具体 handle，
 // 用 run.runtime?.worker 作为当前 handle（worker exit 时 runtime.worker 即
 // 触发 exit 的那个 handle）。G-025 检查在 handleWorkerExit 内（handle.isCurrent）。
      const handle = run.runtime?.worker;
      if (handle) {
        await handleWorkerExit(run, code, handle, deps, handlers);
      }
    },
  };
  return handlers;
}

// ── scheduleTimeBudget（C.7 Run 级时间预算调度） ──────────

/**
 * 启动 run 级墙钟时间预算计时器：到期后 abortRun(doneReason="time_limited")。
 *
 * 恢复旧 orchestrator-budget.ts 的 scheduleTimeBudgetCheck 语义——run/resume 各
 * 启一个 setTimeout(maxTimeMs)，到期若 run 仍 running/paused 则转 done,time_limited。
 * 计时器存入 RunRuntime.timeBudgetTimer，release（pause/abort/replaceRuntime）时
 * 自动清理，避免孤儿触发。resume 会调度全新计时器（与旧语义一致：pause+resume
 * 重置墙钟预算）。
 *
 * @returns 计时器句柄（未设预算时 undefined）
 */
export function scheduleTimeBudget(
  runId: string,
  deps: LifecycleDeps,
  budgetTimeMs: number,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    void abortRun(runId, deps, "Time budget exceeded", "time_limited").catch(
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[workflow] time budget abort failed: ${msg}`);
      },
    );
  }, budgetTimeMs);
 // unref：不阻止 Node 退出（workflow 是后台任务，不应因计时器持有事件循环）。
  timer.unref();
  return timer;
}

// ── runWorkflow ──────────────────────────────────────────────

/**
 * 启动一个 workflow run。
 *
 * 流程：创建 WorkflowRun（paused）+ makeHandlers + 构建 RunRuntime（worker+gate+controller）
 * + assignRuntime（paused → running）+ 注册到 deps.runs + store.save。
 *
 * @param spec RunSpec（不可变输入，含 scriptSource/args）
 * @param deps LifecycleDeps（store/workerHost/runner/runs）
 * @param signal 外部 abort signal（可选；abort 时调 abortRun）
 * @returns runId（wf-<timestamp>-<random>）
 * @throws signal 已 abort（pre-abort fail fast）
 */
export async function runWorkflow(
  spec: RunSpec,
  deps: LifecycleDeps,
  signal?: AbortSignal,
): Promise<string> {
  const runId = generateRunId();
  deps.log?.("debug", "workflow:lifecycle", "runWorkflow start", { runId, scriptName: spec.scriptName });

 // P1-2: pre-aborted signal → fail fast
  if (signal?.aborted) {
    throw new Error("Workflow run aborted before start");
  }

  const run = new WorkflowRun(
    runId,
    spec,
    {
      status: "paused",
      budget: new Budget({
        maxTokens: spec.budgetTokens,
        maxTimeMs: spec.budgetTimeMs,
      }),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: new Date().toISOString() },
  );

 // signal abort → abortRun（一次性监听）
  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        void abortRun(runId, deps, "External signal aborted").catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[workflow] abortRun on signal failed: ${msg}`);
        });
      },
      { once: true },
    );
  }

 // 注册到 deps.runs（makeHandlers + assignRuntime 需要 run 已在 map）
  deps.runs.set(runId, run);

 // 构造 handlers + runtime（worker + gate + controller）
  const handlers = makeHandlers(run, deps);
  const controller = new AbortController();
  const gate = new ConcurrencyGate({ maxConcurrency: DEFAULT_CONCURRENCY });
  const worker = deps.workerHost.start(spec, spec.args, handlers);
 // C.7：run 级时间预算计时器（spec.budgetTimeMs > 0 时启用，到期 abortRun time_limited）。
  const timeBudgetTimer =
    spec.budgetTimeMs && spec.budgetTimeMs > 0
      ? scheduleTimeBudget(runId, deps, spec.budgetTimeMs)
      : undefined;
  const runtime = new RunRuntime(worker, gate, controller, timeBudgetTimer);

 // assignRuntime（paused → running，原子绑定 runtime + status）
  run.assignRuntime(runtime);

  await deps.store.save(run);
  deps.log?.("debug", "workflow:lifecycle", "run saved", { runId, status: run.state.status });

 // pending-notifications: run 启动 → 注册（所有 workflow 启动路径的单一汇聚点：
 // runAndWait / actionRun / 未来入口全覆盖）
  deps.log?.("debug", "workflow:lifecycle", "emit pending:register", { runId });
  deps.eventBus?.emit("pending:register", {
    id: runId,
    type: "workflow",
    name: spec.scriptName || runId,
  });
  deps.log?.("debug", "workflow:lifecycle", "emit pending:register done", { runId });

  return runId;
}

// ── pauseRun ─────────────────────────────────────────────────

/**
 * 暂停 running workflow。
 *
 * **A4 原子性**：WorkflowRun.transition("paused") 内部先 releaseRuntime（cleanup
 * before mutate），再改 status。releaseRuntime 失败时 status 不变（仍 running）。
 *
 * **G3-001**：transition("paused") 调 releaseRuntime，整个 RunRuntime 丢弃
 * （runtime=undefined）。AbortController 一次性无法复用。
 *
 * @throws runId 不存在 / status !== "running"
 */
export async function pauseRun(runId: string, deps: LifecycleDeps): Promise<void> {
  const run = deps.runs.get(runId);
  if (!run) {
    throw new Error(`Workflow '${runId}' not found`);
  }
  if (run.state.status !== "running") {
    throw new Error(
      `Cannot pause workflow in state '${run.state.status}': only 'running' can be paused`,
    );
  }

 // A4: transition 内部 releaseRuntime（cleanup before mutate）
  run.transition("paused");

 // MUST_FIX (round-4 #1): 清理被 abort 的在飞 call（status !== "done"）。
 // transition 已同步 abort controller + terminate worker，但 in-flight 的
 // executeAgentCall 会在后续 microtask 被 finalizeCall 标记为 "done"（带 abort
 // 错误结果）。若保留，resume 时 dispatchAgentCall 的 cached 路径会把该 failed
 // 结果原样 replay，静默污染 workflow 输出。此处同步移除在飞 call + 其 trace 节点，
 // 让 resume 重发 agent-call 走全新执行路径。
 //
 // 同步执行（在 await store.save 前）：transition 与本清理间无 await，微任务无法
 // 插入，此时在飞 call 仍为 "running"/"pending"，可精确清理；genuinely-done 的
 // call 不受影响（resume 时正常 replay）。后续 finalizeCall 在已移除的 orphan call
 // 上运行（markDone 无外部副作用），trace.update 因节点已移除为 no-op。
  discardInFlightCalls(run);

  await deps.store.save(run);
}

/**
 * 移除 run 中未真正完成的在飞 call（status !== "done"）及其 trace 节点。
 *
 * 仅 pauseRun 调用——清理被 abort 的在飞 call，避免 resume 时 cached replay
 * 把 abort 产生的 failed 结果当作已完成结果回放（MUST_FIX round-4 #1）。
 * genuinely-done 的 call（成功或失败均 "done"）保留，resume 时按原语义 replay。
 */
function discardInFlightCalls(run: WorkflowRun): void {
  const inFlight: number[] = [];
  for (const [callId, call] of run.state.calls) {
    if (call.status !== "done") inFlight.push(callId);
  }
  for (const callId of inFlight) {
    run.state.calls.delete(callId);
    run.state.trace.removeByStepIndex(callId);
  }
}

// ── resumeRun ────────────────────────────────────────────────

/**
 * 恢复 paused workflow。
 *
 * **G3-001**：assignRuntime 重建 worker/gate/controller + transition running。
 * worker 重跑脚本，已完成调用从 RunState.calls replay（callCache 在 calls Map 里）。
 *
 * **A4 mirror**：先 startWorker（副作用可能抛），成功后才 assignRuntime 改 status。
 * 若 Worker 构造抛错，workflow 保持 paused，调用方可重试。
 *
 * @throws runId 不存在 / status !== "paused"
 */
export async function resumeRun(runId: string, deps: LifecycleDeps): Promise<void> {
  const run = deps.runs.get(runId);
  if (!run) {
    throw new Error(`Workflow '${runId}' not found`);
  }
  if (run.state.status !== "paused") {
    throw new Error(
      `Cannot resume workflow in state '${run.state.status}': only 'paused' can be resumed`,
    );
  }

 // A4 mirror: 先 startWorker（副作用），成功后才 assignRuntime
  const handlers = makeHandlers(run, deps);
  const controller = new AbortController();
  const gate = new ConcurrencyGate({ maxConcurrency: DEFAULT_CONCURRENCY });
  const worker = deps.workerHost.start(run.spec, run.spec.args, handlers);
 // C.7：resume 重新调度时间预算计时器（与 run 对称；旧 pause 已清旧计时器）。
  const timeBudgetTimer =
    run.spec.budgetTimeMs && run.spec.budgetTimeMs > 0
      ? scheduleTimeBudget(runId, deps, run.spec.budgetTimeMs)
      : undefined;
  const runtime = new RunRuntime(worker, gate, controller, timeBudgetTimer);

 // assignRuntime（paused → running，原子绑定 runtime + status）
  run.assignRuntime(runtime);
  await deps.store.save(run);
}

// ── abortRun ─────────────────────────────────────────────────

/**
 * 中止 workflow（running 或 paused）。
 *
 * **done 状态 no-op**：已终态的 run 不重复 abort。
 * **A4 原子性**：transition("done", doneReason) 内部先 releaseRuntime。
 *
 * @param runId
 * @param deps
 * @param reason 可选中止原因（存 run.state.error）
 * @param doneReason 终态原因（默认 "aborted"；超时场景传 "time_limited"，C.7）
 * @throws runId 不存在
 */
export async function abortRun(
  runId: string,
  deps: LifecycleDeps,
  reason?: string,
  doneReason: DoneReason = "aborted",
): Promise<void> {
  const run = deps.runs.get(runId);
  if (!run) {
    throw new Error(`Workflow '${runId}' not found`);
  }

  deps.log?.("debug", "workflow:lifecycle", "abortRun", { runId, status: run.state.status, reason, doneReason });

 // done 状态 no-op
  if (run.state.status === "done") {
    deps.log?.("debug", "workflow:lifecycle", "abortRun no-op: already done", { runId });
    return;
  }

 // 只允许 running/paused abort（防御）
  if (run.state.status !== "running" && run.state.status !== "paused") {
    throw new Error(
      `Cannot abort workflow in state '${run.state.status}': only 'running' or 'paused' can be aborted`,
    );
  }

 // 记录中止原因
  if (reason) {
    run.state.error = reason;
  }
 // A4: transition 内部 releaseRuntime（cleanup before mutate）
  run.transition("done", doneReason);
  await deps.store.save(run);
  deps.log?.("debug", "workflow:lifecycle", "abortRun transition done", { runId, reason: run.state.reason });
 // C-4: run 到达 done 终态 → 注销 pending-notification + 通知 Interface 层
  deps.log?.("debug", "workflow:lifecycle", "emit pending:unregister", { runId, reason: run.state.reason });
  deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "completed" });
  deps.log?.("debug", "workflow:lifecycle", "emit pending:unregister done", { runId });
  deps.onRunDone?.(run);
}
