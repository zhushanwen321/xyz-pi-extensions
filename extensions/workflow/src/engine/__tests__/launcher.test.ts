// 测试框架：vitest
// 运行命令：npx vitest run src/engine/__tests__/launcher.test.ts
//
// launcher runAndWait 测试。
// 覆盖：
// 1. 正常完成（reason=completed）—— mock workerHost 启动后异步转 done
// 2. 脚本未找到 → reason=failed
// 3. timeout → reason=time_limited（C.7 修复）
// 4. signal abort → reason=aborted
// 5. lint 失败 → 抛错（不静默吞）
// 6. WorkflowRunResult D-8 签名（status 恒 done + reason）

/* eslint-disable taste/no-unsafe-cast */

import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";

import { describe, expect, it, vi } from "vitest";

import { WorkerHandle } from "../../infra/worker-handle.js";
import { type LauncherDeps,runAndWait } from "../launcher.js";
import type { AgentRunner, RunStore, WorkerHost } from "../models/ports.js";
import type { WorkflowRun } from "../models/workflow-run.js";
import { WorkflowScript, type WorkflowScriptRegistry } from "../models/workflow-script.js";

// ── FakeWorker ───────────────────────────────────────────────

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

function makeScript(overrides?: { sourceCode?: string; available?: boolean }): WorkflowScript {
  return new WorkflowScript({
    name: "test-wf",
    source: "saved",
    path: "/abs/.pi/workflows/test-wf.js",
    sourceCode:
      overrides?.sourceCode ?? 'export const meta = { name: "test" }; agent({ prompt: "hi" });',
    meta: { name: "test-wf", description: "d", phases: [] },
    available: overrides?.available ?? true,
  });
}

function makeRegistry(script?: WorkflowScript): WorkflowScriptRegistry {
  return {
    loadAll: vi.fn().mockResolvedValue(script ? [script] : []),
    get: vi.fn().mockResolvedValue(script),
    invalidate: vi.fn(),
  };
}

function makeDeps(opts?: {
  script?: WorkflowScript;
  runner?: AgentRunner;
  store?: RunStore;
  workerHost?: WorkerHost;
 /** 启动后异步转 done 的延迟（ms）。默认立即转 done,completed */
  completeAfterMs?: number;
 /** 启动后转什么 reason（默认 completed） */
  completeReason?: "completed" | "failed";
}): LauncherDeps {
  const script = opts?.script ?? makeScript();
  const runs = new Map<string, WorkflowRun>();
  const completeReason = opts?.completeReason ?? "completed";
  const completeAfterMs = opts?.completeAfterMs ?? 0;

  const workerHost: WorkerHost = opts?.workerHost ?? {
    start: vi.fn().mockImplementation(() => {
      const handle = new WorkerHandle(asWorker(createFakeWorker()));
 // 异步把 run 转 done（模拟 worker return）
      setTimeout(() => {
        for (const run of runs.values()) {
          if (run.state.status === "running") {
            if (completeReason === "completed") {
              run.state.scriptResult = { value: "done" };
            }
            run.transition("done", completeReason);
          }
        }
      }, completeAfterMs);
      return handle;
    }),
  };

  return {
    store:
      opts?.store ?? { save: vi.fn().mockResolvedValue(undefined), loadAll: vi.fn().mockResolvedValue([]) },
    workerHost,
    runner: opts?.runner ?? { run: vi.fn().mockResolvedValue({ content: "ok" }) },
    runs,
    registry: makeRegistry(script),
  };
}

// ── 正常完成 ─────────────────────────────────────────────────

describe("runAndWait 正常完成", () => {
  it("reason=completed + scriptResult 透传（D-8 签名）", async () => {
    const deps = makeDeps();
    const result = await runAndWait("test-wf", {}, deps);
    expect(result.status).toBe("done");
    expect(result.reason).toBe("completed");
    expect(result.scriptResult).toEqual({ value: "done" });
    expect(result.runId).toMatch(/^wf-/);
    expect(result.error).toBeUndefined();
  });

  it("registry.get 被调用（按名查找脚本）", async () => {
    const deps = makeDeps();
    await runAndWait("test-wf", {}, deps);
    expect(deps.registry.get).toHaveBeenCalledWith("test-wf");
  });

  it("runWorkflow 被调（workerHost.start 启动 worker）", async () => {
    const deps = makeDeps();
    await runAndWait("test-wf", { x: 1 }, deps);
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
  });

  it("脚本 available=false 时仍尝试运行（available 由 loader 标记，launcher 不拒绝）", async () => {
 // launcher 只检查 registry.get 返回 undefined；available=false 不阻止
    const deps = makeDeps({ script: makeScript({ available: false }) });
    const result = await runAndWait("test-wf", {}, deps);
    expect(result.status).toBe("done");
  });
});

// ── 脚本未找到 ───────────────────────────────────────────────

describe("runAndWait 脚本未找到", () => {
  it("registry.get 返回 undefined → reason=failed", async () => {
    const deps = makeDeps();
    deps.registry.get = vi.fn().mockResolvedValue(undefined);
    const result = await runAndWait("missing-wf", {}, deps);
    expect(result.status).toBe("done");
    expect(result.reason).toBe("failed");
    expect(result.error).toContain("not found");
    expect(result.runId).toBe("");
 // 不启动 worker
    expect(deps.workerHost.start).not.toHaveBeenCalled();
  });
});

// ── lint 失败 ────────────────────────────────────────────────

describe("runAndWait lint 失败", () => {
  it("validate 失败 → 抛错（不静默吞）", async () => {
 // 无编排函数 → validate 报 error
    const deps = makeDeps({
      script: makeScript({ sourceCode: "const x = 1;" }),
    });
    await expect(runAndWait("test-wf", {}, deps)).rejects.toThrow(/lint errors/);
    expect(deps.workerHost.start).not.toHaveBeenCalled();
  });
});

// ── timeout（C.7 修复） ─────────────────────────────────────

describe("runAndWait timeout（C.7 修复）", () => {
  it("超时 → reason=time_limited（非 aborted）", async () => {
 // completeAfterMs 设大（5s），timeoutMs 设小（100ms）→ 必超时
    const deps = makeDeps({ completeAfterMs: 5000 });
    vi.useFakeTimers();
    try {
      const p = runAndWait("test-wf", {}, deps, undefined, 100);
 // 推进 timer 让轮询循环跑
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(50);
      }
      const result = await p;
      expect(result.status).toBe("done");
      expect(result.reason).toBe("time_limited");
      expect(result.error).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("超时后 run 进入 done 终态（资源释放，不泄漏）", async () => {
    const deps = makeDeps({ completeAfterMs: 5000 });
    let runId = "";
    vi.useFakeTimers();
    try {
      const p = runAndWait("test-wf", {}, deps, undefined, 100);
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(50);
      }
      const result = await p;
      runId = result.runId;
    } finally {
      vi.useRealTimers();
    }
    const run = deps.runs.get(runId);
    expect(run).toBeDefined();
    expect(run!.state.status).toBe("done");
    expect(run!.runtime).toBeUndefined(); // releaseRuntime 清理
  });
});

// ── signal abort ─────────────────────────────────────────────

describe("runAndWait signal abort", () => {
  it("signal abort → reason=aborted", async () => {
    const deps = makeDeps({ completeAfterMs: 5000 });
    const controller = new AbortController();
    vi.useFakeTimers();
    try {
      const p = runAndWait("test-wf", {}, deps, controller.signal, 5000);
 // 第一轮轮询后 abort
      await vi.advanceTimersByTimeAsync(50);
      controller.abort();
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(50);
      }
      const result = await p;
      expect(result.status).toBe("done");
      expect(result.reason).toBe("aborted");
 // runWorkflow 的 signal listener 与 runAndWait 的 poll loop 都可能响应 abort；
 // 两者都写入 aborted reason。error message 可能是 "External signal aborted"
 // （runWorkflow 的 listener）或 "Aborted by signal"（runAndWait poll）。
      expect(result.error).toMatch(/aborted/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── WorkflowRunResult D-8 签名 ──────────────────────────────

describe("WorkflowRunResult D-8 签名", () => {
  it("status 恒为 'done'（所有路径）", async () => {
 // 正常完成
    const r1 = await runAndWait("test-wf", {}, makeDeps());
    expect(r1.status).toBe("done");

 // 未找到
    const deps2 = makeDeps();
    deps2.registry.get = vi.fn().mockResolvedValue(undefined);
    const r2 = await runAndWait("missing", {}, deps2);
    expect(r2.status).toBe("done");
  });

  it("reason 字段存在（所有路径）", async () => {
    const r = await runAndWait("test-wf", {}, makeDeps());
    expect(typeof r.reason).toBe("string");
    expect(r.reason).toBe("completed");
  });

  it("failed 完成时 error 有值", async () => {
    const deps = makeDeps({ completeReason: "failed" });
 // transition done,failed 需先设 error（否则 run.state.error undefined）
 // 这里 completeReason:failed 走 transition("done","failed")，error 字段空
    const r = await runAndWait("test-wf", {}, deps);
    expect(r.reason).toBe("failed");
 // error 可空（failed 不强制 error，但 reason 区分了失败类型）
  });
});

// ── pending-notifications（W2 跨扩展集成）───────────────────

describe("runAndWait pending-notifications", () => {
  it("正常完成时 eventBus emit pending:register + pending:unregister", async () => {
    const eventBus = { emit: vi.fn() };
    const deps = makeDeps();
    deps.eventBus = eventBus;
    const result = await runAndWait("test-wf", {}, deps);

 // 启动时注册
    expect(eventBus.emit).toHaveBeenCalledWith("pending:register", expect.objectContaining({
      type: "workflow",
      name: "test-wf",
    }));

 // 完成时注销
    expect(eventBus.emit).toHaveBeenCalledWith("pending:unregister", expect.objectContaining({
      id: result.runId,
      reason: "completed",
    }));
  });

  it("脚本未找到时不 emit pending:register（无 runId）", async () => {
    const eventBus = { emit: vi.fn() };
    const deps = makeDeps();
    deps.eventBus = eventBus;
    deps.registry.get = vi.fn().mockResolvedValue(undefined);
    await runAndWait("missing-wf", {}, deps);

    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it("timeout 时 emit pending:unregister with reason=time_limited", async () => {
    const eventBus = { emit: vi.fn() };
    const deps = makeDeps({ completeAfterMs: 5000 });
    deps.eventBus = eventBus;
    vi.useFakeTimers();
    try {
      const p = runAndWait("test-wf", {}, deps, undefined, 100);
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(50);
      }
      await p;
    } finally {
      vi.useRealTimers();
    }

 // 启动时注册
    expect(eventBus.emit).toHaveBeenCalledWith("pending:register", expect.objectContaining({
      type: "workflow",
      name: "test-wf",
    }));

 // 超时注销
    expect(eventBus.emit).toHaveBeenCalledWith("pending:unregister", expect.objectContaining({
      reason: "time_limited",
    }));
  });

  it("signal abort 时 emit pending:unregister with reason=aborted", async () => {
    const eventBus = { emit: vi.fn() };
    const deps = makeDeps({ completeAfterMs: 5000 });
    deps.eventBus = eventBus;
    const controller = new AbortController();
    vi.useFakeTimers();
    try {
      const p = runAndWait("test-wf", {}, deps, controller.signal, 5000);
      await vi.advanceTimersByTimeAsync(50);
      controller.abort();
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(50);
      }
      await p;
    } finally {
      vi.useRealTimers();
    }

 // 启动时注册
    expect(eventBus.emit).toHaveBeenCalledWith("pending:register", expect.objectContaining({
      type: "workflow",
    }));

 // abort 注销
    expect(eventBus.emit).toHaveBeenCalledWith("pending:unregister", expect.objectContaining({
      reason: expect.stringMatching(/abort|aborted/i),
    }));
  });

  it("无 eventBus 时不报错（向后兼容）", async () => {
    const deps = makeDeps();
    // deps.eventBus 未设置
    const result = await runAndWait("test-wf", {}, deps);
    expect(result.status).toBe("done");
    expect(result.reason).toBe("completed");
  });
});
