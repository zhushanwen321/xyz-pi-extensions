// 测试框架：vitest
// 运行命令：npx vitest run src/engine/__tests__/terminate-instance.test.ts
//
// Wave 5: terminateInstance 单元测试。重点验证 A4 原子性——cleanup 抛错时
// instance.status 必须保持原状（未变更），让调用方可以重试或观察真实状态。
// 同时覆盖：副作用顺序（cleanup → mutate → persist → notify）、各 cleanup
// 开关默认值、idempotent terminal 短路。

import { describe, expect, it, vi } from "vitest";

import type { RunResources } from "../../domain/run-resources.js";
import { createInstance, type WorkflowInstance } from "../../domain/state.js";
import {
  type TerminateDeps,
  terminateInstance,
} from "../terminate-instance.js";

// ── Helpers ─────────────────────────────────────────────────

function makeInstance(
  status: WorkflowInstance["status"] = "running",
): WorkflowInstance {
  const inst = createInstance({
    runId: "wf-term-test",
    name: "term-test",
    worker: "test",
  });
  inst.status = status;
  return inst;
}

function makeRun(status: WorkflowInstance["status"] = "running"): RunResources {
  return {
    instance: makeInstance(status),
    retryCount: 0,
  };
}

function makeDeps(overrides?: Partial<TerminateDeps>): TerminateDeps & {
  terminateWorker: ReturnType<typeof vi.fn>;
  cleanupAllTempFiles: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  persistState: ReturnType<typeof vi.fn>;
  deletePool: ReturnType<typeof vi.fn>;
  onCompletion: ReturnType<typeof vi.fn>;
} {
  return {
    terminateWorker: vi.fn(),
    cleanupAllTempFiles: vi.fn(),
    emit: vi.fn(),
    persistState: vi.fn().mockResolvedValue(undefined),
    deletePool: vi.fn(),
    onCompletion: vi.fn(),
    ...overrides,
  };
}

// ── A4 atomicity: cleanup throws → status unchanged ─────────

describe("terminateInstance — A4 atomicity", () => {
  it("terminateWorker 抛错时 status 不变（仍是 running）", async () => {
    const run = makeRun("running");
    const deps = makeDeps({
      terminateWorker: vi.fn(() => { throw new Error("terminate boom"); }),
    });

    await expect(
      terminateInstance(run, { status: "aborted" }, deps),
    ).rejects.toThrow(/terminate boom/);

    // 核心断言：status 未变，调用方可重试
    expect(run.instance.status).toBe("running");
    expect(run.instance.completedAt).toBeUndefined();
    // 后续副作用均未执行
    expect(deps.cleanupAllTempFiles).not.toHaveBeenCalled();
    expect(deps.deletePool).not.toHaveBeenCalled();
    expect(deps.emit).not.toHaveBeenCalled();
    expect(deps.persistState).not.toHaveBeenCalled();
    expect(deps.onCompletion).not.toHaveBeenCalled();
  });

  it("cleanupAllTempFiles 抛错时 status 不变（仍是 running）", async () => {
    const run = makeRun("running");
    const deps = makeDeps({
      cleanupAllTempFiles: vi.fn(() => { throw new Error("cleanup boom"); }),
    });

    await expect(
      terminateInstance(run, { status: "aborted" }, deps),
    ).rejects.toThrow(/cleanup boom/);

    expect(run.instance.status).toBe("running");
    // terminateWorker 已执行（在 cleanupAllTempFiles 之前）
    expect(deps.terminateWorker).toHaveBeenCalled();
    // 但状态变更未发生
    expect(deps.emit).not.toHaveBeenCalled();
    expect(deps.persistState).not.toHaveBeenCalled();
  });

  it("deletePool 抛错时 status 不变（仍是 running）", async () => {
    const run = makeRun("running");
    const deps = makeDeps({
      deletePool: vi.fn(() => { throw new Error("pool boom"); }),
    });

    await expect(
      terminateInstance(run, { status: "aborted" }, deps),
    ).rejects.toThrow(/pool boom/);

    expect(run.instance.status).toBe("running");
    // 前置 cleanup 已执行
    expect(deps.terminateWorker).toHaveBeenCalled();
    expect(deps.cleanupAllTempFiles).toHaveBeenCalled();
    // 但状态变更未发生
    expect(deps.emit).not.toHaveBeenCalled();
  });

  it("persistState 抛错时 status 已变（cleanup 成功），但 onCompletion 不调用", async () => {
    const run = makeRun("running");
    const deps = makeDeps({
      persistState: vi.fn().mockRejectedValue(new Error("disk full")),
    });

    await expect(
      terminateInstance(run, { status: "aborted" }, deps),
    ).rejects.toThrow(/disk full/);

    // cleanup 成功 → status 已变更（这是合理的：cleanup 成功代表资源已释放，
    // 即使持久化失败，内存中的状态是正确的；下次 persistState 会同步）
    expect(run.instance.status).toBe("aborted");
    expect(run.instance.completedAt).toBeDefined();
    expect(deps.emit).toHaveBeenCalled();
    // persistState 抛错 → onCompletion 未调用（通知只发生在持久化成功后）
    expect(deps.onCompletion).not.toHaveBeenCalled();
  });
});

// ── Side-effect ordering ────────────────────────────────────

describe("terminateInstance — ordering (cleanup → mutate → persist → notify)", () => {
  it("abort: 完整流程，按顺序执行所有副作用", async () => {
    const run = makeRun("running");
    const deps = makeDeps();

    await terminateInstance(run, { status: "aborted", error: "user aborted" }, deps);

    expect(run.instance.status).toBe("aborted");
    expect(run.instance.error).toBe("user aborted");
    expect(run.instance.completedAt).toBeDefined();

    // 顺序：terminateWorker → cleanupAllTempFiles → deletePool → emit → persistState → onCompletion
    expect(deps.terminateWorker).toHaveBeenCalledWith("wf-term-test", false);
    expect(deps.cleanupAllTempFiles).toHaveBeenCalledTimes(1);
    expect(deps.deletePool).toHaveBeenCalledWith("wf-term-test");
    expect(deps.emit).toHaveBeenCalledWith(
      "wf-term-test",
      { type: "status", status: "aborted" },
    );
    expect(deps.persistState).toHaveBeenCalledTimes(1);
    expect(deps.onCompletion).toHaveBeenCalledWith("wf-term-test");
  });

  it("completed: scriptResult 写入，onCompletion 调用", async () => {
    const run = makeRun("running");
    const deps = makeDeps();
    const result = { ok: true };

    await terminateInstance(
      run,
      { status: "completed", scriptResult: result, cleanupWorker: false },
      deps,
    );

    expect(run.instance.status).toBe("completed");
    expect(run.instance.scriptResult).toBe(result);
    expect(deps.terminateWorker).not.toHaveBeenCalled();
    expect(deps.onCompletion).toHaveBeenCalledWith("wf-term-test");
  });

  it("paused: 默认不调用 deletePool，keepController 传给 terminateWorker", async () => {
    const run = makeRun("running");
    const deps = makeDeps();

    await terminateInstance(
      run,
      { status: "paused", cleanupWorker: true, keepController: true, deletePool: false },
      deps,
    );

    expect(run.instance.status).toBe("paused");
    expect(deps.terminateWorker).toHaveBeenCalledWith("wf-term-test", true);
    expect(deps.deletePool).not.toHaveBeenCalled();
    // paused 非终态 → onCompletion 不调用
    expect(deps.onCompletion).not.toHaveBeenCalled();
  });
});

// ── Cleanup toggle defaults ────────────────────────────────

describe("terminateInstance — cleanup toggle defaults", () => {
  it("默认 cleanupWorker=true / cleanupTempFiles=true / deletePool=true / keepController=false", async () => {
    const run = makeRun("running");
    const deps = makeDeps();

    await terminateInstance(run, { status: "aborted" }, deps);

    expect(deps.terminateWorker).toHaveBeenCalledWith("wf-term-test", false);
    expect(deps.cleanupAllTempFiles).toHaveBeenCalledTimes(1);
    expect(deps.deletePool).toHaveBeenCalledTimes(1);
  });

  it("cleanupWorker=false 跳过 terminateWorker", async () => {
    const run = makeRun("running");
    const deps = makeDeps();

    await terminateInstance(
      run,
      { status: "completed", cleanupWorker: false },
      deps,
    );

    expect(deps.terminateWorker).not.toHaveBeenCalled();
    expect(deps.cleanupAllTempFiles).toHaveBeenCalledTimes(1);
    expect(deps.deletePool).toHaveBeenCalledTimes(1);
  });

  it("cleanupTempFiles=false 跳过 cleanupAllTempFiles", async () => {
    const run = makeRun("running");
    const deps = makeDeps();

    await terminateInstance(
      run,
      { status: "aborted", cleanupTempFiles: false },
      deps,
    );

    expect(deps.cleanupAllTempFiles).not.toHaveBeenCalled();
  });

  it("deletePool=false 跳过 deletePool（pause 场景）", async () => {
    const run = makeRun("running");
    const deps = makeDeps();

    await terminateInstance(
      run,
      { status: "paused", deletePool: false },
      deps,
    );

    expect(deps.deletePool).not.toHaveBeenCalled();
  });

  it("deps.deletePool 未定义时跳过（不抛错）", async () => {
    const run = makeRun("running");
    const deps = makeDeps();
    // 删除 deletePool
    const { deletePool: _unused, ...depsWithoutPool } = deps;
    void _unused;

    await expect(
      terminateInstance(run, { status: "aborted" }, depsWithoutPool),
    ).resolves.toBeUndefined();

    expect(run.instance.status).toBe("aborted");
  });
});

// ── Idempotent terminal short-circuit ──────────────────────

describe("terminateInstance — idempotent terminal short-circuit", () => {
  it("已是同终态时短路，不执行任何副作用", async () => {
    const run = makeRun("aborted");
    const deps = makeDeps();

    await terminateInstance(run, { status: "aborted" }, deps);

    // status 未变（已是 aborted）
    expect(run.instance.status).toBe("aborted");
    // 所有副作用未执行
    expect(deps.terminateWorker).not.toHaveBeenCalled();
    expect(deps.cleanupAllTempFiles).not.toHaveBeenCalled();
    expect(deps.deletePool).not.toHaveBeenCalled();
    expect(deps.emit).not.toHaveBeenCalled();
    expect(deps.persistState).not.toHaveBeenCalled();
    expect(deps.onCompletion).not.toHaveBeenCalled();
  });

  it("已是不同终态时（completed → aborted）不短路，由 transitionStatus 抛错", async () => {
    const run = makeRun("completed");
    const deps = makeDeps();

    // completed → aborted 是非法转换，transitionStatus 会抛错
    await expect(
      terminateInstance(run, { status: "aborted" }, deps),
    ).rejects.toThrow(/Invalid state transition/);

    // cleanup 已执行（在 transitionStatus 之前），但状态变更失败
    expect(deps.terminateWorker).toHaveBeenCalled();
    expect(run.instance.status).toBe("completed");
  });
});
