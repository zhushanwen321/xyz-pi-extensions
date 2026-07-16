// src/orchestration/__tests__/agent-call-stream.test.ts
//
// U4: dispatchAgentCall 创建 SubagentStream 并在 agent call 结束后 dispose
// U5: dispatchAgentCall widgetKey 格式 = subagent-stream-<runId>-<stepIndex>
// U6: streamSink 为 undefined 时 dispatchAgentCall 不创建 stream 不报错
//
// 通过 handleWorkerMessage 触发 dispatchAgentCall（内部函数不 export）。

import { describe, expect, it, vi } from "vitest";

import { handleWorkerMessage } from "../error-recovery.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import { Trace } from "../models/trace.ts";
import type { WorkflowRun } from "../models/workflow-run.ts";
import type { AgentResult } from "../models/types.ts";

// ── helpers ──────────────────────────────────────────────────

function makeMockResult(): AgentResult {
  return { content: "OK", durationMs: 10, error: undefined, toolCalls: [] };
}

/** 构造 status="running" 的 mock WorkflowRun，含 trace/budget/calls/runtime */
function makeRunningRun(runId: string): WorkflowRun {
  const trace = new Trace();
  const controller = new AbortController();
  return {
    runId,
    spec: { scriptName: "test-wf", scriptSource: "agent('hi')", args: {}, runId, slug: undefined },
    state: {
      status: "running" as const,
      reason: undefined,
      trace,
      budget: {
        usedTokens: 0,
        usedCost: 0,
        totalCallCount: 0,
        consume: vi.fn(),
        isExceeded: vi.fn(() => false),
        incrementCallCount: vi.fn(),
      },
      calls: new Map(),
      scriptResult: undefined,
    },
    meta: { startedAt: new Date().toISOString(), workerErrorCount: 0, scriptErrorCount: 0 },
    runtime: {
      controller,
      worker: { postMessage: vi.fn() },
      gate: {
        withSlot: vi.fn(async (fn: () => Promise<void>, _signal: AbortSignal) => {
          await fn();
        }),
      },
    },
    transition: vi.fn(),
    replaceRuntime: vi.fn(),
  } as unknown as WorkflowRun;
}

/** LifecycleDeps mock，runner.run 可控制返回值，streamSink 可配置 */
function makeDeps(opts: {
  streamSink?: { setWidget: ReturnType<typeof vi.fn> };
  runnerResult?: AgentResult;
} = {}): LifecycleDeps {
  return {
    store: { save: vi.fn(async () => {}) },
    workerHost: { start: vi.fn() },
    runner: { run: vi.fn(async () => opts.runnerResult ?? makeMockResult()) },
    runs: new Map(),
    eventBus: { emit: vi.fn() },
    onRunDone: vi.fn(),
    log: vi.fn(),
    streamSink: opts.streamSink,
  } as unknown as LifecycleDeps;
}

function makeHandlers(): WorkerHandlers {
  return {
    onMessage: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
    onExit: vi.fn(async () => {}),
  } as unknown as WorkerHandlers;
}

/** agent-call 消息 */
function makeAgentCallMsg(callId: number): unknown {
  return {
    type: "agent-call",
    callId,
    phase: "test-phase",
    opts: { prompt: "test task", agent: "worker", description: "test-slug" },
  };
}

// ── U4: dispatchAgentCall 创建 SubagentStream 并 dispose ──

describe("U4: dispatchAgentCall stream dispose", () => {
  it("agent call 结束后 stream.dispose 被调用（setWidget 末次 lines=undefined）", async () => {
    const setWidget = vi.fn();
    const deps = makeDeps({ streamSink: { setWidget } });
    const run = makeRunningRun("wf-test-123");
    const handlers = makeHandlers();

    await handleWorkerMessage(run, makeAgentCallMsg(0), deps, handlers);
    // dispatchAgentCall 内部 void withSlot(...)（fire-and-forget），需等 microtask 完成
    await vi.waitFor(() => {
      expect(setWidget.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    const calls = setWidget.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[1]).toBeUndefined();
  });
});

// ── U5: widgetKey 格式 ──

describe("U5: widgetKey 格式", () => {
  it("widgetKey = subagent-stream-<runId>-<stepIndex>", async () => {
    const setWidget = vi.fn();
    const deps = makeDeps({ streamSink: { setWidget } });
    const run = makeRunningRun("wf-test-123");
    const handlers = makeHandlers();

    await handleWorkerMessage(run, makeAgentCallMsg(2), deps, handlers);
    await vi.waitFor(() => {
      expect(setWidget.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    const widgetKey = setWidget.mock.calls[0][0] as string;
    expect(widgetKey).toBe("subagent-stream-wf-test-123-2");
  });
});

// ── U6: streamSink 为 undefined 时不报错 ──

describe("U6: streamSink undefined 降级", () => {
  it("streamSink=undefined → runner.run 仍被调用，无异常", async () => {
    const runnerRun = vi.fn(async () => makeMockResult());
    const deps = {
      store: { save: vi.fn(async () => {}) },
      workerHost: { start: vi.fn() },
      runner: { run: runnerRun },
      runs: new Map(),
      eventBus: { emit: vi.fn() },
      onRunDone: vi.fn(),
      log: vi.fn(),
      // streamSink 不设 = undefined
    } as unknown as LifecycleDeps;
    const run = makeRunningRun("wf-test-456");
    const handlers = makeHandlers();

    await handleWorkerMessage(run, makeAgentCallMsg(0), deps, handlers);

    expect(runnerRun).toHaveBeenCalledTimes(1);
  });
});
