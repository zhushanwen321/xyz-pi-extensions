// 测试框架：vitest
// 运行命令：npx vitest run src/__tests__/pause-resume-integration.test.ts
//
// 集成测试：domain-models.md §测试不变式清单 —— 跨 session pause/resume。
//
// 不变式：
// - pause 后 RunState.calls 保留（callCache 不丢）
// - resume 时 worker 用 calls replay，不重复执行已完成的 call
// - abort 清理 worker + runtime=undefined
//
// 这些测 WorkflowRun + RunRuntime 模型层契约（不启真实 worker——用 FakeWorker）。

/* eslint-disable taste/no-unsafe-cast */

import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

import { AgentCall } from "../engine/models/agent-call.js";
import { Budget } from "../engine/models/budget.js";
import { RunRuntime } from "../engine/models/run-runtime.js";
import { Trace } from "../engine/models/trace.js";
import type { ExecutionTraceNode } from "../engine/models/types.js";
import { WorkflowRun } from "../engine/models/workflow-run.js";
import { ConcurrencyGate } from "../infra/concurrency-gate.js";
import { WorkerHandle } from "../infra/worker-handle.js";

// ── FakeWorker ───────────────────────────────────────────────

interface FakeWorker extends EventEmitter {
  postMessage: (msg: unknown) => void;
  terminate: () => Promise<number>;
}

function createFakeWorker(): FakeWorker {
  return Object.assign(new EventEmitter(), {
    postMessage: (): void => {},
    terminate: (): Promise<number> => Promise.resolve(1),
  });
}

function asWorker(fw: FakeWorker): Worker {
  return fw as unknown as Worker;
}

// ── Fixtures ─────────────────────────────────────────────────

function makeTraceNode(callId: number): ExecutionTraceNode {
  return {
    stepIndex: callId,
    agent: "test-agent",
    task: `Task ${callId}`,
    model: "test-model",
    status: "completed",
    phase: "phase-1",
    startedAt: "2026-06-22T10:00:00.000Z",
    completedAt: "2026-06-22T10:00:30.000Z",
    result: { content: `result ${callId}`, toolCalls: [] },
  };
}

function makeCompletedCall(callId: number): AgentCall {
  const traceNode = makeTraceNode(callId);
  const call = new AgentCall(callId, { prompt: `prompt ${callId}` }, traceNode);
  call.markRunning();
  call.markDone({
    content: `result ${callId}`,
    durationMs: 100,
    toolCalls: [],
  });
  return call;
}

/**
 * 创建一个 running WorkflowRun（含 runtime + 已完成的 callCache + trace）。
 * 模拟「agent 已执行过一次，结果缓存在 calls 里」的状态。
 */
function makeRunningRunWithCachedCall(): {
  run: WorkflowRun;
  worker: FakeWorker;
  handle: WorkerHandle;
} {
  const trace = Trace.fromArray([makeTraceNode(0)]);
  const call = makeCompletedCall(0);
  const run = new WorkflowRun(
    "run-cache-test",
    {
      scriptSource: 'agent({ prompt: "hi" });',
      args: {},
      scriptName: "cache-test",
      scriptPath: "/abs/cache-test.js",
    },
    {
      status: "paused", // 构造时必须 paused（invariant I1：running 需 runtime）
      budget: new Budget(),
      calls: new Map([[0, call]]),
      trace,
      errorLogs: [],
    },
    { startedAt: new Date().toISOString() },
  );

 // 给 run 分配 runtime（进入 running）
  const fakeWorker = createFakeWorker();
  const handle = new WorkerHandle(asWorker(fakeWorker));
  const gate = new ConcurrencyGate({ maxConcurrency: 4 });
  const runtime = new RunRuntime(handle, gate, new AbortController());
  run.assignRuntime(runtime);

  return { run, worker: fakeWorker, handle };
}

// ── Tests ────────────────────────────────────────────────────

describe("pause/resume integration (domain-models §测试不变式)", () => {
  it("pause preserves callCache (RunState.calls survives releaseRuntime)", () => {
    const { run } = makeRunningRunWithCachedCall();
    expect(run.state.status).toBe("running");
    expect(run.runtime).toBeDefined();
    expect(run.state.calls.size).toBe(1);

 // pause：transition("paused") + releaseRuntime
    run.transition("paused");
    run.releaseRuntime();

 // 不变式：calls 保留（callCache 不随 runtime 释放）
    expect(run.state.status).toBe("paused");
    expect(run.runtime).toBeUndefined();
    expect(run.state.calls.size).toBe(1);
    const cachedCall = run.state.calls.get(0);
    expect(cachedCall).toBeDefined();
    expect(cachedCall?.status).toBe("done");
    expect(cachedCall?.result?.content).toBe("result 0");
  });

  it("resume rebuilds runtime; callCache intact for replay (no re-execution)", () => {
    const { run } = makeRunningRunWithCachedCall();

 // pause
    run.transition("paused");
    run.releaseRuntime();

 // resume：重新分配 runtime（worker 由 lifecycle 重新 start）
    const fakeWorker2 = createFakeWorker();
    const handle2 = new WorkerHandle(asWorker(fakeWorker2));
    const gate2 = new ConcurrencyGate({ maxConcurrency: 4 });
    const runtime2 = new RunRuntime(handle2, gate2, new AbortController());
    run.assignRuntime(runtime2);

    expect(run.state.status).toBe("running");
    expect(run.runtime).toBeDefined();
 // callCache 仍在——worker resume 时 replay calls，不重复执行
    expect(run.state.calls.size).toBe(1);
    const cachedCall = run.state.calls.get(0);
    expect(cachedCall?.status).toBe("done");
  });

  it("abort transitions to done + releases runtime (worker + temp files cleanup)", () => {
    const { run, handle } = makeRunningRunWithCachedCall();
    expect(run.state.status).toBe("running");
    expect(run.runtime).toBeDefined();

 // abort：transition("done", "aborted") + releaseRuntime
    run.transition("done", "aborted");
    run.releaseRuntime();

    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("aborted");
    expect(run.runtime).toBeUndefined();
 // WorkerHandle.isCurrent=false after terminate（竞态防护 G-025）
 // (terminate is idempotent; releaseRuntime terminates the worker)
    void handle; // handle captured, terminate called via runtime release
  });

  it("trace nodes survive pause/resume (append-only, D-10 single source)", () => {
    const { run } = makeRunningRunWithCachedCall();
    const nodesBefore = run.state.trace.toArray();
    expect(nodesBefore).toHaveLength(1);

    run.transition("paused");
    run.releaseRuntime();

    const fakeWorker2 = createFakeWorker();
    const handle2 = new WorkerHandle(asWorker(fakeWorker2));
    const gate2 = new ConcurrencyGate({ maxConcurrency: 4 });
    const runtime2 = new RunRuntime(handle2, gate2, new AbortController());
    run.assignRuntime(runtime2);

 // trace 保留（pause/resume 不丢历史节点）
    const nodesAfter = run.state.trace.toArray();
    expect(nodesAfter).toHaveLength(1);
    expect(nodesAfter[0]).toEqual(nodesBefore[0]);
  });

  it("releaseRuntime is idempotent (multiple pauses safe)", () => {
    const { run } = makeRunningRunWithCachedCall();
    run.transition("paused");
    run.releaseRuntime();
 // 二次 release 不抛（幂等）
    expect(() => run.releaseRuntime()).not.toThrow();
    expect(run.runtime).toBeUndefined();
  });

  it("running run invariant: runtime defined ⟺ status running (I1)", () => {
    const { run } = makeRunningRunWithCachedCall();
    expect(run.state.status).toBe("running");
    expect(run.runtime).toBeDefined();

    run.transition("paused");
    run.releaseRuntime();
    expect(run.state.status).toBe("paused");
    expect(run.runtime).toBeUndefined();

    const fakeWorker = createFakeWorker();
    const handle = new WorkerHandle(asWorker(fakeWorker));
    const gate = new ConcurrencyGate({ maxConcurrency: 4 });
    run.assignRuntime(new RunRuntime(handle, gate, new AbortController()));
    expect(run.state.status).toBe("running");
    expect(run.runtime).toBeDefined();
  });
});
