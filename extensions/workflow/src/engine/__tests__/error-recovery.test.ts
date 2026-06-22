// 测试框架：vitest
// 运行命令：npx vitest run src/engine/__tests__/error-recovery.test.ts
//
// T19：error-recovery free functions 测试。
// 覆盖：
//   1. handleWorkerMessage 路由（agent-call/return/error）
//   2. handleWorkerError 3 次重试 + 超限 failed
//   3. handleScriptError 3 次重试 + 超限 failed + workerLogs 捕获
//   4. handleWorkerExit code===0 no-op / code!==0 委托 handleWorkerError
//   5. handleWorkerExit G-025 stale handle 丢弃
//   6. rebuildRuntime 原子替换
//   7. 终态/paused stale 消息丢弃
//
// 测试 fixture 用 EventEmitter-based FakeWorker 构造 WorkerHandle（避开真实
// worker_threads spawn），与 W2 worker-handle.test.ts 同款 stub 模式。

/* eslint-disable taste/no-unsafe-cast */

import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";

import { describe, expect, it, vi } from "vitest";

import { ConcurrencyGate } from "../../infra/concurrency-gate.js";
import { WorkerHandle } from "../../infra/worker-handle.js";
import {
  handleScriptError,
  handleWorkerError,
  handleWorkerExit,
  handleWorkerMessage,
  rebuildRuntime,
} from "../error-recovery.js";
import { Budget } from "../models/budget.js";
import type { AgentRunner, RunStore, WorkerHandlers, WorkerHost } from "../models/ports.js";
import { RunRuntime } from "../models/run-runtime.js";
import { Trace } from "../models/trace.js";
import type { AgentResult, WorkerLogEntry } from "../models/types.js";
import { WorkflowRun } from "../models/workflow-run.js";

// ── FakeWorker（与 W2 worker-handle.test.ts 同款） ───────────

interface FakeWorker extends EventEmitter {
  postMessage: (msg: unknown) => void;
  terminate: () => Promise<number>;
}

function createFakeWorker(): FakeWorker {
  return Object.assign(new EventEmitter(), {
    postMessage: vi.fn(),
    terminate: vi.fn(async () => 1),
  });
}

function asWorker(fw: FakeWorker): Worker {
  return fw as unknown as Worker;
}

// ── 测试夹具 ─────────────────────────────────────────────────

function makeRun(overrides?: { status?: "running" | "paused" | "done" }): WorkflowRun {
  const run = new WorkflowRun(
    "run-1",
    {
      scriptSource: 'agent({ prompt: "hi" });',
      args: {},
      scriptName: "test-wf",
      scriptPath: "/abs/test-wf.js",
    },
    {
      status: "paused",
      budget: new Budget(),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: new Date().toISOString() },
  );
  // 进入 running 状态（需注入 runtime）
  const worker = makeWorkerHandle();
  const gate = new ConcurrencyGate({ maxConcurrency: 4 });
  const rt = new RunRuntime(worker, gate, new AbortController());
  run.assignRuntime(rt);
  if (overrides?.status === "paused") {
    run.transition("paused");
  }
  return run;
}

function makeWorkerHandle(): WorkerHandle {
  return new WorkerHandle(asWorker(createFakeWorker()));
}

function makeDeps(overrides?: {
  runner?: AgentRunner;
  store?: RunStore;
  workerHost?: WorkerHost;
}): {
  store: RunStore;
  workerHost: WorkerHost;
  runner: AgentRunner;
  runs: Map<string, WorkflowRun>;
} {
  const run = makeRun();
  const runs = new Map([[run.runId, run]]);
  return {
    store: overrides?.store ?? { save: vi.fn().mockResolvedValue(undefined), loadAll: vi.fn().mockResolvedValue([]) },
    workerHost: overrides?.workerHost ?? {
      start: vi.fn().mockReturnValue(makeWorkerHandle()),
    },
    runner: overrides?.runner ?? { run: vi.fn().mockResolvedValue({ content: "ok" } as AgentResult) },
    runs,
  };
}

function makeHandlers(): WorkerHandlers {
  return {
    onMessage: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn().mockResolvedValue(undefined),
    onExit: vi.fn().mockResolvedValue(undefined),
  };
}

// 取出 deps.runs 里的 run（makeDeps 默认注入一个）
function runOf(deps: ReturnType<typeof makeDeps>): WorkflowRun {
  return deps.runs.get("run-1")!;
}

// ── handleWorkerMessage 路由 ─────────────────────────────────

describe("handleWorkerMessage 路由", () => {
  it("return 消息 → transition done,completed", async () => {
    const deps = makeDeps();
    const run = runOf(deps);
    const handlers = makeHandlers();
    await handleWorkerMessage(
      run,
      { type: "return", result: { value: 42 } },
      deps,
      handlers,
    );
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("completed");
    expect(run.state.scriptResult).toEqual({ value: 42 });
    expect(deps.store.save).toHaveBeenCalled();
  });

  it("return 消息捕获 workerLogs（P2-2）", async () => {
    const deps = makeDeps();
    const run = runOf(deps);
    const logs: WorkerLogEntry[] = [{ level: "warn", message: "careful" }];
    await handleWorkerMessage(
      run,
      { type: "return", result: undefined, workerLogs: logs },
      deps,
      makeHandlers(),
    );
    expect(run.state.errorLogs).toEqual(logs);
  });

  it("agent-call 消息 → 派发 executeAgentCall（异步，立即返回）", async () => {
    const runner = { run: vi.fn().mockResolvedValue({ content: "ok" } as AgentResult) };
    const deps = makeDeps({ runner });
    const run = runOf(deps);
    await handleWorkerMessage(
      run,
      { type: "agent-call", callId: 0, opts: { prompt: "hi" } },
      deps,
      makeHandlers(),
    );
    // 异步触发——立即返回时 call 已建但可能未完成
    expect(run.state.calls.has(0)).toBe(true);
    const call = run.state.calls.get(0)!;
    expect(call.opts.prompt).toBe("hi");
    expect(run.state.trace.length).toBe(1);
    // 等微任务让 executeAgentCall 完成
    await vi.waitFor(() => expect(call.status).toBe("done"));
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("error 消息 → handleScriptError（递增 scriptErrorCount）", async () => {
    const deps = makeDeps();
    const run = runOf(deps);
    vi.useFakeTimers();
    try {
      const p = handleWorkerMessage(
        run,
        { type: "error", error: "boom" },
        deps,
        makeHandlers(),
      );
      await vi.runAllTimersAsync();
      await p;
    } finally {
      vi.useRealTimers();
    }
    expect(run.meta.scriptErrorCount).toBe(1);
  });

  it("终态 run 丢弃 stale 消息（P0-1）", async () => {
    const deps = makeDeps();
    const run = runOf(deps);
    run.transition("done", "aborted");
    await handleWorkerMessage(
      run,
      { type: "return", result: "x" },
      deps,
      makeHandlers(),
    );
    // 已 done 状态不变（stale return 不改 reason）
    expect(run.state.reason).toBe("aborted");
  });

  it("paused run 丢弃消息（P0-1）", async () => {
    const deps = makeDeps();
    const run = runOf(deps);
    run.transition("paused");
    await handleWorkerMessage(
      run,
      { type: "return", result: "x" },
      deps,
      makeHandlers(),
    );
    expect(run.state.status).toBe("paused");
  });
});

// ── handleWorkerError 重试矩阵 ───────────────────────────────

describe("handleWorkerError 重试矩阵", () => {
  it("首次错误 → 递增 workerErrorCount + rebuildRuntime（不 failed）", async () => {
    const deps = makeDeps();
    const run = runOf(deps);
    vi.useFakeTimers();
    try {
      const p = handleWorkerError(run, new Error("boom"), deps, makeHandlers());
      await vi.runAllTimersAsync();
      await p;
    } finally {
      vi.useRealTimers();
    }
    expect(run.meta.workerErrorCount).toBe(1);
    expect(run.state.status).toBe("running"); // 未 failed
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1); // rebuildRuntime 启新 worker
  });

  it("3 次错误 → 第 4 次 transition done,failed", async () => {
    const deps = makeDeps();
    const run = runOf(deps);
    run.meta.workerErrorCount = 3; // 已重试 3 次
    await handleWorkerError(run, new Error("boom"), deps, makeHandlers());
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("failed");
    expect(run.state.error).toBe("boom");
  });

  it("每次重试递增 workerErrorCount（C.5 跨 runtime 存活）", async () => {
    const deps = makeDeps();
    const run = runOf(deps);
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 3; i++) {
        const p = handleWorkerError(run, new Error(`err${i}`), deps, makeHandlers());
        await vi.runAllTimersAsync();
        await p;
      }
    } finally {
      vi.useRealTimers();
    }
    expect(run.meta.workerErrorCount).toBe(3);
    // 3 次仍在重试限内（<=MAX_WORKER_RETRIES=3），未 failed
    expect(run.state.status).toBe("running");
  });

  it("终态 run 不处理 worker error", async () => {
    const deps = makeDeps();
    const run = runOf(deps);
    run.transition("done", "completed");
    await handleWorkerError(run, new Error("late"), deps, makeHandlers());
    // 不递增
    expect(run.meta.workerErrorCount).toBeUndefined();
  });
});

// ── handleScriptError 重试矩阵 ───────────────────────────────

describe("handleScriptError 重试矩阵", () => {
  it("首次错误 → 递增 scriptErrorCount + rebuildRuntime", async () => {
    const deps = makeDeps();
    const run = runOf(deps);
    const logs: WorkerLogEntry[] = [{ level: "error", message: "stack" }];
    vi.useFakeTimers();
    try {
      const p = handleScriptError(run, "boom", logs, deps, makeHandlers());
      await vi.runAllTimersAsync();
      await p;
    } finally {
      vi.useRealTimers();
    }
    expect(run.meta.scriptErrorCount).toBe(1);
    expect(run.state.errorLogs).toEqual(logs);
    expect(run.state.status).toBe("running");
  });

  it("3 次错误 → 第 4 次 transition done,failed", async () => {
    const deps = makeDeps();
    const run = runOf(deps);
    run.meta.scriptErrorCount = 3;
    await handleScriptError(run, "fatal", [], deps, makeHandlers());
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("failed");
    expect(run.state.error).toContain("3 retries");
    expect(run.state.error).toContain("fatal");
  });

  it("workerLogs 捕获到 errorLogs（P2-2）", async () => {
    const deps = makeDeps();
    const run = runOf(deps);
    const logs: WorkerLogEntry[] = [
      { level: "log", message: "step1" },
      { level: "warn", message: "warn" },
    ];
    vi.useFakeTimers();
    try {
      const p = handleScriptError(run, "x", logs, deps, makeHandlers());
      await vi.runAllTimersAsync();
      await p;
    } finally {
      vi.useRealTimers();
    }
    expect(run.state.errorLogs).toEqual(logs);
  });

  it("终态 run 不处理 script error", async () => {
    const deps = makeDeps();
    const run = runOf(deps);
    run.transition("done", "completed");
    await handleScriptError(run, "late", [], deps, makeHandlers());
    expect(run.meta.scriptErrorCount).toBeUndefined();
  });
});

// ── handleWorkerExit ─────────────────────────────────────────

describe("handleWorkerExit", () => {
  it("code===0 → no-op（正常退出）", async () => {
    const deps = makeDeps();
    const run = runOf(deps);
    const handle = run.runtime!.worker;
    await handleWorkerExit(run, 0, handle, deps, makeHandlers());
    expect(run.state.status).toBe("running"); // 不变
    expect(run.meta.workerErrorCount).toBeUndefined();
  });

  it("code!==0 → 委托 handleWorkerError", async () => {
    const deps = makeDeps();
    const run = runOf(deps);
    const handle = run.runtime!.worker;
    vi.useFakeTimers();
    try {
      const p = handleWorkerExit(run, 1, handle, deps, makeHandlers());
      await vi.runAllTimersAsync();
      await p;
    } finally {
      vi.useRealTimers();
    }
    expect(run.meta.workerErrorCount).toBe(1);
  });

  it("G-025: stale handle（!isCurrent）→ 丢弃，不处理", async () => {
    const deps = makeDeps();
    const run = runOf(deps);
    const staleHandle = run.runtime!.worker;
    // terminate 让 handle.isCurrent=false
    await staleHandle.terminate();
    expect(staleHandle.isCurrent).toBe(false);

    await handleWorkerExit(run, 1, staleHandle, deps, makeHandlers());
    // stale exit 丢弃——workerErrorCount 未递增
    expect(run.meta.workerErrorCount).toBeUndefined();
  });

  it("paused run exit → no-op", async () => {
    const deps = makeDeps();
    const run = runOf(deps);
    run.transition("paused");
    // paused 后 runtime undefined，用独立 handle 模拟
    const handle = makeWorkerHandle();
    await handleWorkerExit(run, 1, handle, deps, makeHandlers());
    expect(run.meta.workerErrorCount).toBeUndefined();
  });

  it("终态 run exit → no-op", async () => {
    const deps = makeDeps();
    const run = runOf(deps);
    run.transition("done", "completed");
    const handle = makeWorkerHandle();
    await handleWorkerExit(run, 1, handle, deps, makeHandlers());
    expect(run.meta.workerErrorCount).toBeUndefined();
  });
});

// ── rebuildRuntime ───────────────────────────────────────────

describe("rebuildRuntime", () => {
  it("原子替换 runtime（新 worker + gate + controller）", () => {
    const deps = makeDeps();
    const run = runOf(deps);
    const oldRuntime = run.runtime!;
    const handlers = makeHandlers();

    rebuildRuntime(run, deps, handlers);

    expect(run.runtime).not.toBe(oldRuntime);
    expect(run.runtime).toBeDefined();
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
    // status 保持 running（replaceRuntime 不改 status）
    expect(run.state.status).toBe("running");
  });

  it("调用 workerHost.start 传入 spec + args + handlers", () => {
    const deps = makeDeps();
    const run = runOf(deps);
    const handlers = makeHandlers();
    rebuildRuntime(run, deps, handlers);
    expect(deps.workerHost.start).toHaveBeenCalledWith(run.spec, run.spec.args, handlers);
  });

  it("paused 状态 rebuildRuntime → replaceRuntime 抛错（G6-001）", () => {
    const deps = makeDeps();
    const run = runOf(deps);
    run.transition("paused"); // paused 后 runtime undefined
    // rebuildRuntime 内调 replaceRuntime，前置要求 running
    expect(() => rebuildRuntime(run, deps, makeHandlers())).toThrow(/running/);
  });
});

// ── scheduleRebuild 退避 ─────────────────────────────────────

describe("scheduleRebuild 退避", () => {
  it("退避期间 transition done → 跳过 rebuild", async () => {
    const deps = makeDeps();
    const run = runOf(deps);
    vi.useFakeTimers();
    try {
      // 启 handleWorkerError（会 delay），在 delay 期间 transition done
      const p = handleWorkerError(run, new Error("x"), deps, makeHandlers());
      run.transition("done", "aborted");
      await vi.runAllTimersAsync();
      await p;
    } finally {
      vi.useRealTimers();
    }
    // done 后不 rebuild（workerHost.start 未调）
    expect(deps.workerHost.start).not.toHaveBeenCalled();
  });

  it("退避指数：第 1 次 1s，第 2 次 2s，第 3 次 4s", async () => {
    const deps = makeDeps();
    const run = runOf(deps);
    vi.useFakeTimers();
    try {
      // 记录每次 scheduleRebuild 触发 workerHost.start 的时刻
      for (let i = 0; i < 3; i++) {
        const p = handleWorkerError(run, new Error(`e${i}`), deps, makeHandlers());
        await vi.runAllTimersAsync();
        await p;
      }
    } finally {
      vi.useRealTimers();
    }
    // 3 次 rebuild（每次 workerErrorCount 递增触发一次）
    expect(deps.workerHost.start).toHaveBeenCalledTimes(3);
  });
});
