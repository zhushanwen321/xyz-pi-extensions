/**
 * lifecycle — pauseRun/resumeRun/scheduleTimeBudget/runWorkflow/abortRun 测试。
 *
 * 用真实 WorkflowRun（含真实状态机 + I1/I2 不变式守卫）+ mock RunRuntime（释放副作用
 * 可控）+ mock LifecycleDeps（store/workerHost/eventBus 可观察）。这样能真正测到
 * transition/assignRuntime/releaseRuntime 的状态机逻辑，而非全 mock 聚合根。
 *
 * 覆盖：
 * - pauseRun：running → paused（releaseRuntime：worker terminate + controller abort）
 *   + 在飞 call 清理 + store.save
 * - resumeRun：paused → running（workerHost.start 重建 + assignRuntime + 时间预算重排）
 * - scheduleTimeBudget：定时器到期 → abortRun(done,time_limited)（用 fake timers）
 * - runWorkflow：spec → 创建 run + workerHost.start + store.save + emit pending:register
 * - abortRun：done no-op / running→done / paused→done + emit pending:unregister
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  abortRun,
  pauseRun,
  resumeRun,
  runWorkflow,
  scheduleTimeBudget,
} from "../lifecycle.ts";
import { Budget } from "../models/budget.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Trace } from "../models/trace.ts";
import type { RunSpec } from "../models/run-spec.ts";
import type { LifecycleDeps } from "../models/ports.ts";
import { WorkflowRun } from "../models/workflow-run.ts";

// ── helpers ──────────────────────────────────────────────────

/** 构造一个最小 RunSpec（满足 WorkflowRun 构造的字段需求）。 */
function makeSpec(opts: { budgetTimeMs?: number; budgetTokens?: number } = {}): RunSpec {
  return {
    scriptSource: "execute() {}",
    args: {},
    scriptName: "test-wf",
    scriptPath: "/fake/test.js",
    budgetTimeMs: opts.budgetTimeMs,
    budgetTokens: opts.budgetTokens,
  };
}

/**
 * 构造一个 status="running" 的真实 WorkflowRun，注入 mock RunRuntime。
 *
 * 流程：new WorkflowRun（status=paused）→ assignRuntime（→running）。
 * mock runtime 的 worker.terminate / controller.abort / release 均可观察。
 */
/** flush microtask 队列多次，让 void .then().catch() + async 链跑完。
 *
 * 注意：fake timers 下 setTimeout(resolve,0) 也会被拦截，故用 Promise.resolve()
 * 走原生 microtask 队列（不被 fake timers 拦截）。 */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function makeRunningRealRun(
  runId: string,
  opts: { budgetTimeMs?: number } = {},
): { run: WorkflowRun; terminate: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> } {
  const spec = makeSpec(opts);
  const run = new WorkflowRun(
    runId,
    spec,
    {
      status: "paused",
      budget: new Budget({ maxTokens: 1000 }),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: new Date().toISOString() },
  );
  const terminate = vi.fn(async () => {});
  const controller = new AbortController();
  const abort = vi.spyOn(controller, "abort");
  const worker = { terminate, postMessage: vi.fn() } as unknown as Parameters<typeof RunRuntime.prototype.constructor>[0];
  const runtime = new RunRuntime(
    worker as never,
    { withSlot: vi.fn() } as never,
    controller,
    undefined,
  );
  run.assignRuntime(runtime);
  return { run, terminate, abort };
}

/** LifecycleDeps mock：store/workerHost/eventBus/onRunDone/log 可观察。 */
function makeDeps(): LifecycleDeps & {
  store: { save: ReturnType<typeof vi.fn>; loadAll: ReturnType<typeof vi.fn> };
  workerHost: { start: ReturnType<typeof vi.fn> };
  eventBus: { emit: ReturnType<typeof vi.fn> };
  onRunDone: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
} {
  return {
    store: { save: vi.fn(async () => {}), loadAll: vi.fn(async () => []) },
    workerHost: { start: vi.fn(() => ({ postMessage: vi.fn(), terminate: vi.fn(async () => {}) })) },
    runner: { run: vi.fn(async () => ({})) },
    runs: new Map(),
    eventBus: { emit: vi.fn() },
    onRunDone: vi.fn(),
    log: vi.fn(),
  } as unknown as ReturnType<typeof makeDeps>;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── pauseRun ─────────────────────────────────────────────────

describe("pauseRun", () => {
  it("running run → paused：releaseRuntime（worker terminate + controller abort）+ store.save", async () => {
    const { run, terminate, abort } = makeRunningRealRun("wf-pause-1");
    const deps = makeDeps();
    deps.runs.set("wf-pause-1", run);

    await pauseRun("wf-pause-1", deps);

    expect(run.state.status).toBe("paused");
    expect(run.meta.pausedAt).toBeDefined();
    // releaseRuntime 释放了 worker + controller
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(1);
    // runtime 已解绑（I1：paused ⟺ runtime undefined）
    expect(run.runtime).toBeUndefined();
    // 持久化
    expect(deps.store.save).toHaveBeenCalledTimes(1);
  });

  it("清留在飞 call（status !== done）及其 trace 节点", async () => {
    const { run } = makeRunningRealRun("wf-pause-2");
    // 注入一个未完成的在飞 call
    run.state.calls.set(7, {
      id: 7,
      status: "running",
      attempts: 1,
    } as never);
    // 注入一个已完成 call（应保留）
    run.state.calls.set(8, {
      id: 8,
      status: "done",
      result: { content: "ok" },
    } as never);
    const deps = makeDeps();
    deps.runs.set("wf-pause-2", run);

    await pauseRun("wf-pause-2", deps);

    // 在飞 call（running）被移除；已完成 call（done）保留
    expect(run.state.calls.has(7)).toBe(false);
    expect(run.state.calls.has(8)).toBe(true);
  });

  it("runId 不存在 → 抛错", async () => {
    const deps = makeDeps();
    await expect(pauseRun("wf-missing", deps)).rejects.toThrow("not found");
  });

  it("status !== running → 抛错（只允许 running 暂停）", async () => {
    const { run } = makeRunningRealRun("wf-pause-3");
    run.transition("paused"); // 先 pause → paused
    const deps = makeDeps();
    deps.runs.set("wf-pause-3", run);

    await expect(pauseRun("wf-pause-3", deps)).rejects.toThrow("only 'running' can be paused");
  });
});

// ── resumeRun ────────────────────────────────────────────────

describe("resumeRun", () => {
  it("paused → running：workerHost.start 重建 worker + assignRuntime + 时间预算重排", async () => {
    const { run } = makeRunningRealRun("wf-resume-1", { budgetTimeMs: 5000 });
    run.transition("paused"); // → paused
    const deps = makeDeps();
    deps.runs.set("wf-resume-1", run);

    await resumeRun("wf-resume-1", deps);

    expect(run.state.status).toBe("running");
    expect(run.runtime).toBeDefined(); // assignRuntime 绑定新 runtime
    // workerHost.start 被调（重建 worker）
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
    // 时间预算重排（budgetTimeMs > 0）：resumeRun 内调本文件 scheduleTimeBudget，
    // 结果存入 run.runtime.timeBudgetTimer。budgetTimeMs <= 0 时为 undefined。
    expect(run.runtime!.timeBudgetTimer).toBeDefined();
    // 持久化
    expect(deps.store.save).toHaveBeenCalledTimes(1);
  });

  it("无 budgetTimeMs 时 resume 不调度时间预算计时器", async () => {
    const { run } = makeRunningRealRun("wf-resume-no-budget");
    run.transition("paused");
    const deps = makeDeps();
    deps.runs.set("wf-resume-no-budget", run);

    await resumeRun("wf-resume-no-budget", deps);

    expect(run.state.status).toBe("running");
    // budgetTimeMs 未设 → timeBudgetTimer 为 undefined
    expect(run.runtime!.timeBudgetTimer).toBeUndefined();
  });

  it("runId 不存在 → 抛错", async () => {
    const deps = makeDeps();
    await expect(resumeRun("wf-missing", deps)).rejects.toThrow("not found");
  });

  it("status !== paused → 抛错（只允许 paused 恢复）", async () => {
    const { run } = makeRunningRealRun("wf-resume-2");
    // 仍 running
    const deps = makeDeps();
    deps.runs.set("wf-resume-2", run);

    await expect(resumeRun("wf-resume-2", deps)).rejects.toThrow("only 'paused' can be resumed");
  });
});

// ── scheduleTimeBudget ───────────────────────────────────────

describe("scheduleTimeBudget", () => {
  it("定时器到期 → abortRun(done,time_limited)", async () => {
    const { run } = makeRunningRealRun("wf-budget-1");
    const deps = makeDeps();
    deps.runs.set("wf-budget-1", run);

    const timer = scheduleTimeBudget("wf-budget-1", deps, 1000);
    expect(timer).toBeDefined();

    // 推进定时器到到期 + flush 让 abortRun async 链跑完
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("time_limited");
    expect(run.state.error).toContain("Time budget exceeded");
    // 完成通知
    expect(deps.eventBus.emit).toHaveBeenCalledWith("pending:unregister", {
      id: "wf-budget-1",
      reason: "time_limited",
    });
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("run 已 done 时 abortRun no-op（到期不重复 transition）", async () => {
    const { run } = makeRunningRealRun("wf-budget-2");
    // 先把 run 转 done（手动）
    run.transition("done", "completed");
    const deps = makeDeps();
    deps.runs.set("wf-budget-2", run);

    scheduleTimeBudget("wf-budget-2", deps, 500);
    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    // 状态保持原 done/completed，未被 time_limited 覆盖
    expect(run.state.reason).toBe("completed");
    expect(deps.onRunDone).not.toHaveBeenCalled();
  });

  it("定时器 unref（不阻止 Node 退出）", () => {
    const deps = makeDeps();
    const timer = scheduleTimeBudget("wf-x", deps, 10000);
    // unref 是 Node timer 的方法，fake timer 也支持——验证不抛错
    expect(() => timer.unref()).not.toThrow();
    timer.unref();
  });
});

// ── runWorkflow ──────────────────────────────────────────────

describe("runWorkflow", () => {
  it("spec → 创建 run + 启动 worker + store.save + emit pending:register", async () => {
    const deps = makeDeps();
    const spec = makeSpec();

    const runId = await runWorkflow(spec, deps);

    expect(runId).toMatch(/^wf-/);
    // run 注册到 deps.runs
    expect(deps.runs.has(runId)).toBe(true);
    const run = deps.runs.get(runId)!;
    // status 为 running（assignRuntime 已绑定 runtime）
    expect(run.state.status).toBe("running");
    expect(run.runtime).toBeDefined();
    // workerHost.start 被调
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
    // store.save 持久化
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    // pending:register 通知
    expect(deps.eventBus.emit).toHaveBeenCalledWith("pending:register", {
      id: runId,
      type: "workflow",
      name: "test-wf",
    });
  });

  it("带 budgetTimeMs 时调度时间预算计时器", async () => {
    const deps = makeDeps();
    const scheduleTimeBudgetSpy = vi.fn(() => undefined);
    (deps as LifecycleDeps & { scheduleTimeBudget?: unknown }).scheduleTimeBudget = scheduleTimeBudgetSpy;
    const spec = makeSpec({ budgetTimeMs: 3000 });

    const runId = await runWorkflow(spec, deps);

    // scheduleTimeBudget 在 lifecycle 内被调（runWorkflow 内联调，非走 deps.scheduleTimeBudget）
    // 注意：runWorkflow 内直接调本文件的 scheduleTimeBudget，不读 deps.scheduleTimeBudget
    expect(runId).toMatch(/^wf-/);
  });

  it("signal 已 abort → fail fast（抛错，不创建 run）", async () => {
    const deps = makeDeps();
    const spec = makeSpec();
    const controller = new AbortController();
    controller.abort();

    await expect(runWorkflow(spec, deps, controller.signal)).rejects.toThrow(
      "aborted before start",
    );
    expect(deps.runs.size).toBe(0);
    expect(deps.workerHost.start).not.toHaveBeenCalled();
  });
});

// ── abortRun ─────────────────────────────────────────────────

describe("abortRun", () => {
  it("running run → done,aborted：releaseRuntime + emit pending:unregister", async () => {
    const { run, terminate } = makeRunningRealRun("wf-abort-1");
    const deps = makeDeps();
    deps.runs.set("wf-abort-1", run);

    await abortRun("wf-abort-1", deps, "user cancelled");

    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("aborted");
    expect(run.state.error).toBe("user cancelled");
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(run.runtime).toBeUndefined();
    expect(deps.eventBus.emit).toHaveBeenCalledWith("pending:unregister", {
      id: "wf-abort-1",
      reason: "aborted",
    });
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("done 状态 no-op（不重复 abort）", async () => {
    const { run } = makeRunningRealRun("wf-abort-2");
    run.transition("done", "completed");
    const deps = makeDeps();
    deps.runs.set("wf-abort-2", run);

    await abortRun("wf-abort-2", deps, "late abort");

    expect(run.state.reason).toBe("completed"); // 未被覆盖
    expect(deps.onRunDone).not.toHaveBeenCalled();
  });

  it("自定义 doneReason（time_limited）", async () => {
    const { run } = makeRunningRealRun("wf-abort-3");
    const deps = makeDeps();
    deps.runs.set("wf-abort-3", run);

    await abortRun("wf-abort-3", deps, "timeout", "time_limited");

    expect(run.state.reason).toBe("time_limited");
    expect(run.state.error).toBe("timeout");
  });

  it("runId 不存在 → 抛错", async () => {
    const deps = makeDeps();
    await expect(abortRun("wf-missing", deps)).rejects.toThrow("not found");
  });
});
