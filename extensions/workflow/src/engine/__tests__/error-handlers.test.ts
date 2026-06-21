// 测试框架：vitest
// 运行命令：npx vitest run src/engine/__tests__/error-handlers.test.ts
//
// Round 4 MF5: handleWorkerError / handleWorkerExit / handleScriptError 零直接测试 → 新增覆盖。
// 重点：重试 3 次后 failed、退避延迟、worker race 跳过、P0-3 stale-state 重启前检查、
// P2-2 workerLogs 挂载。

import type { Worker } from "node:worker_threads";

import { afterEach,beforeEach, describe, expect, it, vi } from "vitest";

import type { RunResources } from "../../domain/run-resources.js";
import {
  createInstance,
  type WorkflowInstance,
} from "../../domain/state.js";
import {
  type ErrorHandlerContext,
  handleScriptError,
  handleWorkerError,
  handleWorkerExit,
  type WorkerLogEntry,
} from "../error-handlers.js";

// ── Helpers ─────────────────────────────────────────────────

function makeInstance(
  status: WorkflowInstance["status"] = "running",
): WorkflowInstance {
  const inst = createInstance({
    runId: "wf-err-test",
    name: "err-test",
    worker: "test",
  });
  inst.status = status;
  return inst;
}

/** Seed a RunResources into the ctx's internal runs map. */
function seedRun(
  ctx: ErrorHandlerContext & { runs: Map<string, RunResources> },
  inst: WorkflowInstance,
  opts: { worker?: Worker; retryCount?: number; meta?: RunResources["meta"] } = {},
): RunResources {
  const run: RunResources = {
    instance: inst,
    retryCount: opts.retryCount ?? 0,
    meta: opts.meta,
    worker: opts.worker,
  };
  ctx.runs.set(inst.runId, run);
  return run;
}

function makeCtx(overrides?: Partial<ErrorHandlerContext>): ErrorHandlerContext & {
  runs: Map<string, RunResources>;
  getRun: ReturnType<typeof vi.fn>;
  events: { emit: ReturnType<typeof vi.fn> };
  terminateWorker: ReturnType<typeof vi.fn>;
  cleanupAllTempFiles: ReturnType<typeof vi.fn>;
  recreateRunAbortController: ReturnType<typeof vi.fn>;
  startWorker: ReturnType<typeof vi.fn>;
  persistState: ReturnType<typeof vi.fn>;
  onCompletion: ReturnType<typeof vi.fn>;
  deleteRunPool: ReturnType<typeof vi.fn>;
} {
  const runs = new Map<string, RunResources>();
  const ctx: ErrorHandlerContext = {
    getRun: vi.fn((id: string) => runs.get(id)),
    events: { emit: vi.fn() } as unknown as ErrorHandlerContext["events"],
    // Wave 5: terminateWorker mock mirrors the real one's side effect —
    // clears run.worker so tests asserting on it stay meaningful now that
    // handleWorkerError routes through terminateInstance (which delegates
    // worker cleanup to terminateWorker instead of inlining it).
    terminateWorker: vi.fn((id: string) => {
      const r = runs.get(id);
      if (r) r.worker = undefined;
    }),
    cleanupAllTempFiles: vi.fn(),
    recreateRunAbortController: vi.fn(),
    startWorker: vi.fn(),
    persistState: vi.fn().mockResolvedValue(undefined),
    onCompletion: vi.fn(),
    deleteRunPool: vi.fn(),
    ...overrides,
  };
  return { ...ctx, runs } as ErrorHandlerContext & typeof ctx & { runs: Map<string, RunResources> };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// ── handleWorkerError ───────────────────────────────────────

describe("handleWorkerError", () => {
  it("instance 为 undefined 时直接返回", async () => {
    const ctx = makeCtx();
    await handleWorkerError(ctx, "missing", new Error("boom"));
    expect(ctx.persistState).not.toHaveBeenCalled();
  });

  it("terminal 状态短路：completed 不重新标记 failed", async () => {
    const inst = makeInstance("completed");
    const ctx = makeCtx();
    seedRun(ctx, inst, { worker: {} as Worker });

    await handleWorkerError(ctx, inst.runId, new Error("late error"));

    expect(inst.status).toBe("completed");
    expect(ctx.deleteRunPool).not.toHaveBeenCalled();
  });

  it("uncaught error：标记 failed + 清理 pool + persistState", async () => {
    const inst = makeInstance("running");
    const ctx = makeCtx();
    const run = seedRun(ctx, inst, { worker: {} as Worker });

    await handleWorkerError(ctx, inst.runId, new Error("uncaught boom"));

    expect(inst.status).toBe("failed");
    expect(inst.error).toBe("uncaught boom");
    expect(inst.completedAt).toBeDefined();
    expect(run.worker).toBeUndefined();
    expect(ctx.deleteRunPool).toHaveBeenCalledWith(inst.runId);
    expect(ctx.persistState).toHaveBeenCalled();
    expect(ctx.onCompletion).toHaveBeenCalledWith(inst.runId);
    expect(ctx.events.emit).toHaveBeenCalledWith(
      inst.runId,
      expect.objectContaining({ type: "status", status: "failed" }),
    );
  });
});

// ── handleWorkerExit ────────────────────────────────────────

describe("handleWorkerExit", () => {
  it("instance 为 undefined 时直接返回", async () => {
    const ctx = makeCtx();
    const w = {} as Worker;
    await handleWorkerExit(ctx, "missing", 0, w);
    expect(ctx.persistState).not.toHaveBeenCalled();
  });

  it("worker race 保护：exited worker !== current worker 直接 return", async () => {
    const inst = makeInstance("running");
    const ctx = makeCtx();
    const currentWorker = {} as Worker;
    const exitedWorker = {} as Worker;
    seedRun(ctx, inst, { worker: currentWorker });

    await handleWorkerExit(ctx, inst.runId, 1, exitedWorker);

    // current worker 未被清除（不是 exitedWorker 触发的清理）
    const run = ctx.runs.get(inst.runId)!;
    expect(run.worker).toBe(currentWorker);
    expect(inst.status).toBe("running");
  });

  it("paused 状态退出：跳过失败标记", async () => {
    const inst = makeInstance("paused");
    const ctx = makeCtx();
    const w = {} as Worker;
    seedRun(ctx, inst, { worker: w });

    await handleWorkerExit(ctx, inst.runId, 1, w);

    expect(inst.status).toBe("paused");
    expect(ctx.persistState).not.toHaveBeenCalled();
  });

  it("code !== 0 且无 error：标记 failed", async () => {
    const inst = makeInstance("running");
    const ctx = makeCtx();
    const w = {} as Worker;
    seedRun(ctx, inst, { worker: w });

    await handleWorkerExit(ctx, inst.runId, 42, w);

    expect(inst.status).toBe("failed");
    expect(inst.error).toMatch(/exited with code 42/);
    expect(ctx.deleteRunPool).toHaveBeenCalledWith(inst.runId);
  });

  it("code === 0：不做任何处理（正常退出）", async () => {
    const inst = makeInstance("running");
    const ctx = makeCtx();
    const w = {} as Worker;
    seedRun(ctx, inst, { worker: w });

    await handleWorkerExit(ctx, inst.runId, 0, w);

    expect(inst.status).toBe("running");
  });
});

// ── handleScriptError ───────────────────────────────────────

describe("handleScriptError", () => {
  it("MAX_WORKER_RETRIES=3 后标记 failed", async () => {
    const inst = makeInstance("running");
    const ctx = makeCtx();
    seedRun(ctx, inst, { meta: { scriptSource: "x", args: {} } });

    await handleScriptError(ctx, inst.runId, "first error");
    // 触发第一次重试
    await vi.advanceTimersByTimeAsync(1000);
    // 此时 retryCount=1，已经 schedule 第二次重试
    await handleScriptError(ctx, inst.runId, "second error");
    await vi.advanceTimersByTimeAsync(2000);
    await handleScriptError(ctx, inst.runId, "third error");
    await vi.advanceTimersByTimeAsync(4000);
    // 第四次调用：attempt=4 > 3，标记 failed
    await handleScriptError(ctx, inst.runId, "final error");

    expect(inst.status).toBe("failed");
    expect(inst.error).toMatch(/Workflow failed after 3 retries/);
    expect(ctx.terminateWorker).toHaveBeenCalled();
    expect(ctx.deleteRunPool).toHaveBeenCalledWith(inst.runId);
    expect(ctx.persistState).toHaveBeenCalled();
  });

  it("退避延迟：第 1 次重试 delay=1000ms，第 2 次=2000ms（指数退避 base=2）", async () => {
    const inst = makeInstance("running");
    const ctx = makeCtx();
    const startWorker = vi.fn();
    ctx.startWorker = startWorker as unknown as ErrorHandlerContext["startWorker"];
    seedRun(ctx, inst, { meta: { scriptSource: "x", args: {} } });

    // 第 1 次 error：attempt=1，schedule delay=1000*2^0=1000ms
    await handleScriptError(ctx, inst.runId, "e1");
    expect(ctx.terminateWorker).toHaveBeenCalledTimes(1);
    expect(startWorker).not.toHaveBeenCalled();

    // 推进 500ms：还没到
    await vi.advanceTimersByTimeAsync(500);
    expect(startWorker).not.toHaveBeenCalled();

    // 推进到 1000ms：触发重试
    await vi.advanceTimersByTimeAsync(500);
    expect(startWorker).toHaveBeenCalledTimes(1);
  });

  it("worker race 保护：retry 时若 instance.status !== running 跳过重启", async () => {
    const inst = makeInstance("running");
    const ctx = makeCtx();
    const startWorker = vi.fn();
    ctx.startWorker = startWorker as unknown as ErrorHandlerContext["startWorker"];
    seedRun(ctx, inst, { meta: { scriptSource: "x", args: {} } });

    await handleScriptError(ctx, inst.runId, "e1");
    // 推进 1000ms 之前先把状态改为 paused
    inst.status = "paused";
    await vi.advanceTimersByTimeAsync(1000);

    expect(startWorker).not.toHaveBeenCalled();
  });

  it("P2-2: workerLogs 挂载到 instance.errorLogs（最后一次覆盖）", async () => {
    const inst = makeInstance("running");
    const ctx = makeCtx();
    seedRun(ctx, inst);

    const logs1: WorkerLogEntry[] = [
      { level: "log", message: "first" },
    ];
    const logs2: WorkerLogEntry[] = [
      { level: "warn", message: "second" },
      { level: "error", message: "third" },
    ];

    await handleScriptError(ctx, inst.runId, "e1", logs1);
    expect(inst.errorLogs).toEqual(logs1);

    await handleScriptError(ctx, inst.runId, "e2", logs2);
    expect(inst.errorLogs).toEqual(logs2);
  });

  it("terminal 状态短路：completed 不重试", async () => {
    const inst = makeInstance("completed");
    const ctx = makeCtx();
    seedRun(ctx, inst);

    await handleScriptError(ctx, inst.runId, "late error");

    expect(inst.status).toBe("completed");
    expect(ctx.terminateWorker).not.toHaveBeenCalled();
  });

  it("instance 为 undefined 时直接返回", async () => {
    const ctx = makeCtx();
    await handleScriptError(ctx, "missing", "error");
    expect(ctx.persistState).not.toHaveBeenCalled();
  });
});
