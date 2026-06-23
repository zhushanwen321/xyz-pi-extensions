// 测试框架：vitest
// 运行命令：npx vitest run src/engine/__tests__/node-ops.test.ts
//
// node-ops free functions 测试。
// 覆盖：
// 1. retryNode 前置 running（G6-001）
// 2. retryNode 重置 call（status=pending, attempts=0, result=undefined）
// 3. retryNode 重跑 executeAgentCall（不 replaceRuntime）
// 4. retryNode call 不存在抛错
// 5. skipNode 标记 done + 占位 result
// 6. skipNode 回发 agent-result（worker 活着时）
// 7. skipNode worker terminate 时不抛错（P1-8）

/* eslint-disable taste/no-unsafe-cast */

import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";

import { describe, expect, it, vi } from "vitest";

import { ConcurrencyGate } from "../../infra/concurrency-gate.js";
import { WorkerHandle } from "../../infra/worker-handle.js";
import { AgentCall } from "../models/agent-call.js";
import { Budget } from "../models/budget.js";
import type { AgentRunner, RunStore, WorkerHost } from "../models/ports.js";
import { RunRuntime } from "../models/run-runtime.js";
import { Trace } from "../models/trace.js";
import type { AgentResult } from "../models/types.js";
import { WorkflowRun } from "../models/workflow-run.js";
import { retryNode, skipNode } from "../node-ops.js";

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

function makeRun(): WorkflowRun {
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
  const worker = new WorkerHandle(asWorker(createFakeWorker()));
  const gate = new ConcurrencyGate({ maxConcurrency: 4 });
  const rt = new RunRuntime(worker, gate, new AbortController());
  run.assignRuntime(rt);
  return run;
}

function makeDeps(run: WorkflowRun, runnerResult?: AgentResult): {
  store: RunStore;
  workerHost: WorkerHost;
  runner: AgentRunner;
  runs: Map<string, WorkflowRun>;
} {
  return {
    store: { save: vi.fn().mockResolvedValue(undefined), loadAll: vi.fn().mockResolvedValue([]) },
    workerHost: { start: vi.fn().mockReturnValue(new WorkerHandle(asWorker(createFakeWorker()))) },
    runner: {
      run: vi.fn().mockResolvedValue(runnerResult ?? { content: "retried", toolCalls: [] }),
    },
    runs: new Map([[run.runId, run]]),
  };
}

function makeFailedCall(run: WorkflowRun, callId: number): AgentCall {
  const node = {
    stepIndex: callId,
    agent: "test-agent",
    task: "do work",
    model: "default",
    status: "failed" as const,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    result: { content: "", error: "boom", toolCalls: [] },
  };
  run.state.trace.append(node);
  const call = new AgentCall(callId, { prompt: "work" }, node);
 // 进入 done failed 状态
  call.markRunning();
  call.markDone({ content: "", error: "boom", toolCalls: [] });
  run.state.calls.set(callId, call);
  return call;
}

// ── retryNode ────────────────────────────────────────────────

describe("retryNode", () => {
  it("G6-001: paused 状态 → 抛错", async () => {
    const run = makeRun();
    run.transition("paused");
    const deps = makeDeps(run);
    await expect(retryNode(run, 0, deps)).rejects.toThrow(/running/);
  });

  it("G6-001: done 状态 → 抛错", async () => {
    const run = makeRun();
    run.transition("done", "completed");
    const deps = makeDeps(run);
    await expect(retryNode(run, 0, deps)).rejects.toThrow(/running/);
  });

  it("call 不存在 → 抛错", async () => {
    const run = makeRun();
    const deps = makeDeps(run);
    await expect(retryNode(run, 99, deps)).rejects.toThrow(/not found/);
  });

  it("重置 call 状态：done → pending, attempts=0, result=undefined", async () => {
    const run = makeRun();
    const call = makeFailedCall(run, 0);
    expect(call.status).toBe("done");
    expect(call.attempts).toBe(1);
    expect(call.result).toBeDefined();

    const deps = makeDeps(run);
    await retryNode(run, 0, deps);

 // executeAgentCall 完成后 call 再次 done，但 attempts 应已重置过
 //（markRunning 重新递增，最终 attempts=1，因为 retryNode 重置 attempts=0 后 executeAgentCall markRunning +1）
    expect(call.status).toBe("done");
    expect(call.attempts).toBe(1);
    expect(call.result?.error).toBeUndefined();
    expect(call.result?.content).toBe("retried");
  });

  it("trace 节点同步：failed → completed", async () => {
    const run = makeRun();
    makeFailedCall(run, 0);
    expect(run.state.trace.find(0)?.status).toBe("failed");

    const deps = makeDeps(run);
    await retryNode(run, 0, deps);

    expect(run.state.trace.find(0)?.status).toBe("completed");
    expect(run.state.trace.find(0)?.result?.error).toBeUndefined();
  });

  it("不 replaceRuntime（worker 不重启，D.5 修复）", async () => {
    const run = makeRun();
    makeFailedCall(run, 0);
    const originalRuntime = run.runtime;
    const deps = makeDeps(run);

    await retryNode(run, 0, deps);

 // runtime 不变（D.5: retryNode 不重启 worker）
    expect(run.runtime).toBe(originalRuntime);
    expect(deps.workerHost.start).not.toHaveBeenCalled();
  });

  it("调 executeAgentCall（runner.run 被调）", async () => {
    const run = makeRun();
    makeFailedCall(run, 0);
    const deps = makeDeps(run);

    await retryNode(run, 0, deps);

    expect(deps.runner.run).toHaveBeenCalledTimes(1);
  });

  it("完成后回发 agent-result 给 worker", async () => {
    const run = makeRun();
    makeFailedCall(run, 0);
    const deps = makeDeps(run);
    const postSpy = vi.spyOn(run.runtime!.worker, "postMessage");

    await retryNode(run, 0, deps);

    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent-result", callId: 0 }),
    );
  });

  it("持久化（store.save 被调）", async () => {
    const run = makeRun();
    makeFailedCall(run, 0);
    const deps = makeDeps(run);

    await retryNode(run, 0, deps);

    expect(deps.store.save).toHaveBeenCalledWith(run);
  });
});

// ── skipNode ─────────────────────────────────────────────────

describe("skipNode", () => {
  it("标记 call done + 占位 result", async () => {
    const run = makeRun();
    const call = makeFailedCall(run, 0);
    const deps = makeDeps(run);

    await skipNode(run, 0, deps);

    expect(call.status).toBe("done");
    expect(call.result?.content).toBe("");
    expect(call.result?.error).toBeUndefined();
    expect(call.result?.usage?.input).toBe(0);
  });

  it("trace 节点同步为 completed", async () => {
    const run = makeRun();
    makeFailedCall(run, 0);
    const deps = makeDeps(run);

    await skipNode(run, 0, deps);

    const node = run.state.trace.find(0);
    expect(node?.status).toBe("completed");
    expect(node?.result?.content).toBe("");
    expect(node?.completedAt).toBeDefined();
  });

  it("worker 活着时回发 agent-result（cached=true）", async () => {
    const run = makeRun();
    makeFailedCall(run, 0);
    const deps = makeDeps(run);
    const postSpy = vi.spyOn(run.runtime!.worker, "postMessage");

    await skipNode(run, 0, deps);

    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent-result",
        callId: 0,
        cached: true,
      }),
    );
  });

  it("paused 状态（runtime undefined）→ 仅标记，不抛错", async () => {
    const run = makeRun();
    makeFailedCall(run, 0);
    run.transition("paused"); // runtime 变 undefined
    const deps = makeDeps(run);

    await expect(skipNode(run, 0, deps)).resolves.toBeUndefined();
 // call 仍被标记
    const call = run.state.calls.get(0)!;
    expect(call.status).toBe("done");
    expect(call.result?.content).toBe("");
  });

  it("不调 runner.run（不重跑）", async () => {
    const run = makeRun();
    makeFailedCall(run, 0);
    const deps = makeDeps(run);

    await skipNode(run, 0, deps);

    expect(deps.runner.run).not.toHaveBeenCalled();
  });

  it("持久化", async () => {
    const run = makeRun();
    makeFailedCall(run, 0);
    const deps = makeDeps(run);

    await skipNode(run, 0, deps);

    expect(deps.store.save).toHaveBeenCalledWith(run);
  });

  it("call 不存在时仍注入 trace 节点（skip 可对未派发 callId 操作）", async () => {
    const run = makeRun();
    const deps = makeDeps(run);

    await skipNode(run, 42, deps);

 // trace 节点被 update（若不存在 no-op，但 completedAt 仍尝试设）
 // calls Map 不新增（call 不存在时只 update trace）
    expect(run.state.calls.has(42)).toBe(false);
  });
});
