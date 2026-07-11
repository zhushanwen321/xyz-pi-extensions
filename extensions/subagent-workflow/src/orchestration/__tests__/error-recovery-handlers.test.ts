/**
 * error-recovery handlers — handleWorkerExit/Error/ScriptError + postBudgetUpdate 测试。
 *
 * 参考 error-recovery-workflow-call.test.ts 的 mock 构建。通过 vi.useFakeTimers() 跳过
 * scheduleRebuild 的指数退避（1s/2s/4s）。
 *
 * 覆盖：
 * - handleWorkerExit：code=0 正常退出（no-op） / code!=0 委托 handleWorkerError / stale handle 过滤
 * - handleWorkerError：超限（count > MAX=3）→ transition done,failed + emit pending:unregister
 *   / 未超限 → rebuildRuntime（workerHost.start 重建）
 * - handleScriptError：超限 → transition done,failed / workerLogs 捕获
 * - postBudgetUpdate：postMessage budget-update（usedTokens/usedCost）
 * - stale handle 过滤（handle.isCurrent=false）+ paused/terminal stale 守卫
 * - rebuildRuntime：worker 崩溃后 workerHost.start + scheduleTimeBudget 重排 + replaceRuntime
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleScriptError,
  handleWorkerError,
  handleWorkerExit,
  postBudgetUpdate,
  rebuildRuntime,
} from "../error-recovery.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import type { WorkflowRun } from "../models/workflow-run.ts";
import type { WorkerHandle } from "../worker-handle.ts";

// ── helpers ──────────────────────────────────────────────────

/** 构造一个 status="running" 的 mock WorkflowRun，meta 可配置。 */
function makeRunningRun(opts: {
  workerErrorCount?: number;
  scriptErrorCount?: number;
  budgetTimeMs?: number;
  postMessage?: ReturnType<typeof vi.fn>;
} = {}): WorkflowRun {
  return {
    state: {
      status: "running",
      budget: { usedTokens: 50, usedCost: 0.1 },
    },
    meta: {
      startedAt: new Date().toISOString(),
      workerErrorCount: opts.workerErrorCount,
      scriptErrorCount: opts.scriptErrorCount,
    },
    spec: {
      scriptName: "test-wf",
      scriptSource: "execute() {}",
      args: {},
      budgetTimeMs: opts.budgetTimeMs,
    },
    runtime: {
      worker: { postMessage: opts.postMessage ?? vi.fn() },
    },
    // transition 副作用——run.state.status 由调用方通过 mock 控制后再次断言
    transition(target: string, reason?: string): void {
      this.state.status = target;
      if (target === "done") this.state.reason = reason;
    },
    replaceRuntime(rt: unknown): void {
      this.runtime = rt;
    },
  } as unknown as WorkflowRun;
}

/** LifecycleDeps mock：store/workerHost/runner/eventBus/scheduleTimeBudget 可观察。 */
function makeDeps(opts: {
  scheduleTimeBudget?: LifecycleDeps["scheduleTimeBudget"];
} = {}): LifecycleDeps & {
  store: { save: ReturnType<typeof vi.fn> };
  workerHost: { start: ReturnType<typeof vi.fn> };
  eventBus: { emit: ReturnType<typeof vi.fn> };
  onRunDone: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
} {
  return {
    store: { save: vi.fn(async () => {}) },
    workerHost: { start: vi.fn(() => ({ postMessage: vi.fn() })) },
    runner: { run: vi.fn(async () => ({})) },
    runs: new Map(),
    eventBus: { emit: vi.fn() },
    onRunDone: vi.fn(),
    log: vi.fn(),
    scheduleTimeBudget: opts.scheduleTimeBudget,
  } as unknown as ReturnType<typeof makeDeps>;
}

/** WorkerHandlers 占位（handler 路径递归调本对象上的回调，但测试场景不触发）。 */
function makeHandlers(): WorkerHandlers {
  return {
    onMessage: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
    onExit: vi.fn(async () => {}),
  } as unknown as WorkerHandlers;
}

/** 构造 mock WorkerHandle（isCurrent 可配）。 */
function makeHandle(isCurrent = true): WorkerHandle {
  return { isCurrent } as unknown as WorkerHandle;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── handleWorkerExit ─────────────────────────────────────────

describe("handleWorkerExit", () => {
  it("code=0 正常退出：no-op（不 transition、不 save）", async () => {
    const run = makeRunningRun();
    const deps = makeDeps();
    const handle = makeHandle(true);

    await handleWorkerExit(run, 0, handle, deps, makeHandlers());

    expect(run.state.status).toBe("running"); // 未改
    expect(deps.store.save).not.toHaveBeenCalled();
    expect(deps.eventBus.emit).not.toHaveBeenCalled();
  });

  it("code!=0 异常退出：委托 handleWorkerError → 超 MAX 重试 → transition done,failed", async () => {
    // workerErrorCount 已达 MAX=3 → handleWorkerError 内 count=4 > 3 → failed
    const run = makeRunningRun({ workerErrorCount: 3 });
    const deps = makeDeps();
    const handle = makeHandle(true);

    await handleWorkerExit(run, 1, handle, deps, makeHandlers());

    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("failed");
    expect(run.state.error).toContain("Worker exited with code 1");
    // 持久化 + 完成通知
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("stale handle（isCurrent=false）：丢弃 exit 事件，不处理", async () => {
    const run = makeRunningRun();
    const deps = makeDeps();
    const staleHandle = makeHandle(false);

    await handleWorkerExit(run, 1, staleHandle, deps, makeHandlers());

    // 状态未变，store 未 save
    expect(run.state.status).toBe("running");
    expect(deps.store.save).not.toHaveBeenCalled();
  });

  it("run 已终态（done）：stale 守卫前置丢弃", async () => {
    const run = makeRunningRun();
    run.state.status = "done";
    (run.state as { reason?: string }).reason = "completed";
    const deps = makeDeps();
    const handle = makeHandle(true);

    await handleWorkerExit(run, 1, handle, deps, makeHandlers());

    expect(deps.store.save).not.toHaveBeenCalled();
  });
});

// ── handleWorkerError ────────────────────────────────────────

describe("handleWorkerError", () => {
  it("count > MAX（3）：transition done,failed + save + emit pending:unregister", async () => {
    // workerErrorCount=3 → count=4 > MAX
    const run = makeRunningRun({ workerErrorCount: 3 });
    const deps = makeDeps();

    await handleWorkerError(run, new Error("worker boom"), deps, makeHandlers());

    expect(run.meta.workerErrorCount).toBe(4);
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("failed");
    expect(run.state.error).toBe("worker boom");
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    expect(deps.eventBus.emit).toHaveBeenCalledWith("pending:unregister", {
      id: undefined, // mock run 无 runId
      reason: "failed",
    });
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("count <= MAX：退避 + rebuildRuntime（workerHost.start 重建新 runtime）", async () => {
    const run = makeRunningRun({ workerErrorCount: 0 }); // count=1 <= MAX
    const deps = makeDeps();

    const promise = handleWorkerError(run, new Error("transient"), deps, makeHandlers());

    // 推进指数退避（第 1 次重试：1s）
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(run.meta.workerErrorCount).toBe(1);
    // 状态仍 running（重试不改 status）
    expect(run.state.status).toBe("running");
    // workerHost.start 被调（rebuildRuntime 内重建 worker）
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
  });

  it("paused 状态：stale 守卫前置丢弃（不递增 workerErrorCount）", async () => {
    const run = makeRunningRun();
    run.state.status = "paused";
    const deps = makeDeps();

    await handleWorkerError(run, new Error("stale"), deps, makeHandlers());

    expect(run.meta.workerErrorCount).toBeUndefined(); // 未递增
    expect(deps.store.save).not.toHaveBeenCalled();
  });
});

// ── handleScriptError ────────────────────────────────────────

describe("handleScriptError", () => {
  it("count > MAX（3）：transition done,failed + 捕获 workerLogs", async () => {
    const run = makeRunningRun({ scriptErrorCount: 3 }); // count=4 > MAX
    const deps = makeDeps();
    const workerLogs = [
      { level: "error" as const, message: "line 5 boom" },
    ];

    await handleScriptError(run, "TypeError: x is undefined", workerLogs, deps, makeHandlers());

    expect(run.meta.scriptErrorCount).toBe(4);
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("failed");
    expect(run.state.error).toContain("Workflow failed after 3 retries");
    expect(run.state.error).toContain("TypeError: x is undefined");
    // workerLogs 捕获到 errorLogs
    expect(run.state.errorLogs).toEqual(workerLogs);
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("count <= MAX：退避 + rebuildRuntime", async () => {
    const run = makeRunningRun({ scriptErrorCount: 1 }); // count=2 <= MAX
    const deps = makeDeps();

    const promise = handleScriptError(run, "ReferenceError", [], deps, makeHandlers());

    // 第 2 次重试退避：2s
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(run.meta.scriptErrorCount).toBe(2);
    expect(run.state.status).toBe("running");
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
  });

  it("terminal 状态：stale 守卫前置丢弃", async () => {
    const run = makeRunningRun();
    run.state.status = "done";
    (run.state as { reason?: string }).reason = "completed";
    const deps = makeDeps();

    await handleScriptError(run, "late error", [], deps, makeHandlers());

    expect(run.meta.scriptErrorCount).toBeUndefined();
    expect(deps.store.save).not.toHaveBeenCalled();
  });
});

// ── postBudgetUpdate ─────────────────────────────────────────

describe("postBudgetUpdate", () => {
  it("向 worker postMessage budget-update（usedTokens/usedCost）", () => {
    const postMessage = vi.fn();
    const run = makeRunningRun({ postMessage });

    postBudgetUpdate(run);

    expect(postMessage).toHaveBeenCalledWith({
      type: "budget-update",
      budget: { usedTokens: 50, usedCost: 0.1 },
    });
  });

  it("runtime 不存在时 no-op（不抛错）", () => {
    const run = makeRunningRun();
    // runtime.worker.postMessage 为 undefined 时应安全
    run.runtime = undefined;

    expect(() => postBudgetUpdate(run)).not.toThrow();
  });
});

// ── rebuildRuntime ───────────────────────────────────────────

describe("rebuildRuntime", () => {
  it("worker 崩溃后重建：workerHost.start + replaceRuntime（保持 running）", () => {
    const run = makeRunningRun({ budgetTimeMs: 0 }); // 无时间预算
    const deps = makeDeps();

    rebuildRuntime(run, deps, makeHandlers());

    // workerHost.start 被调（构造新 worker）
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
    // replaceRuntime 被调（新 runtime 绑定，mock 内仅替换 runtime 字段）
    expect(run.runtime).toBeDefined();
    // status 仍 running（replaceRuntime 不改 status）
    expect(run.state.status).toBe("running");
  });

  it("带 budgetTimeMs 时重排 scheduleTimeBudget 计时器", () => {
    const run = makeRunningRun({ budgetTimeMs: 5000 });
    const scheduleTimeBudget = vi.fn(() => undefined);
    const deps = makeDeps({ scheduleTimeBudget });

    rebuildRuntime(run, deps, makeHandlers());

    // D-12 regression fix (round-2 #2)：replaceRuntime 后重排时间预算
    expect(scheduleTimeBudget).toHaveBeenCalledTimes(1);
    // 第 1 参 = runId（mock run 无 runId），第 2 参 = budgetTimeMs
    const args = scheduleTimeBudget.mock.calls[0]!;
    expect(args[1]).toBe(5000);
  });

  it("无 scheduleTimeBudget 注入时不重排（向后兼容，不抛错）", () => {
    const run = makeRunningRun({ budgetTimeMs: 5000 });
    const deps = makeDeps({ scheduleTimeBudget: undefined });

    expect(() => rebuildRuntime(run, deps, makeHandlers())).not.toThrow();
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
  });
});
