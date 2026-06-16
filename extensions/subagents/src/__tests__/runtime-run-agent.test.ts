// src/__tests__/runtime-run-agent.test.ts
//
// SubagentRuntime.runAgent() 单元测试。
// 覆盖 MF#3：sync 成功/失败/abort、skipWidget、hooks beforeRun/afterRun/onError、
// dispose 后调用拒绝。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SubagentRuntime } from "../runtime.ts";
import type { AgentResult, RunAgentOptions } from "../types.ts";

// ============================================================
// vi.mock: 替换 core/run-agent.ts 的 runAgent 函数
// ============================================================
const coreRunAgentMock = vi.hoisted(() => vi.fn<typeof import("../core/run-agent.ts").runAgent>());

vi.mock("../core/run-agent.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/run-agent.ts")>();
  return {
    ...actual,
    runAgent: coreRunAgentMock,
  };
});

// ============================================================
// Mock factories
// ============================================================

function successResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    text: "done",
    turns: 1,
    durationMs: 50,
    success: true,
    sessionId: "sess-1",
    toolCalls: [],
    ...overrides,
  };
}

function failResult(error = "boom"): AgentResult {
  return {
    text: "",
    turns: 0,
    durationMs: 10,
    success: false,
    error,
    sessionId: "",
    toolCalls: [],
  };
}

function makePi() {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  };
}

function makeModelRegistry() {
  return {
    find: vi.fn(() => ({ id: "test-model", name: "test-model", provider: "test" })),
    hasConfiguredAuth: vi.fn(() => true),
    getAvailable: vi.fn(() => []),
  } as never;
}

// ============================================================
// Tests
// ============================================================

describe("SubagentRuntime.runAgent", () => {
  let tmpDir: string;
  let runtime: SubagentRuntime;
  let pi: ReturnType<typeof makePi>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-test-"));
    runtime = new SubagentRuntime({
      cwd: tmpDir,
      homeDir: tmpDir,
      agentDir: path.join(tmpDir, "agents"),
    });
    pi = makePi();
    runtime.injectModelRegistry(makeModelRegistry());
    runtime.injectPi(pi as never);
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const baseOpts: RunAgentOptions = {
    task: "test task",
    agent: "worker",
    signal: new AbortController().signal,
  };

  // ── Success path ──────────────────────────────────────

  it("success: returns AgentResult, completes state, calls afterRun hook", async () => {
    const afterRun = vi.fn();
    runtime.registerHooks({ afterRun });

    coreRunAgentMock.mockResolvedValue(successResult());

    const result = await runtime.runAgent(baseOpts);

    expect(result.success).toBe(true);
    expect(result.text).toBe("done");
    expect(afterRun).toHaveBeenCalledOnce();
    // history is written to HistoryStore (JSONL file), not pi.appendEntry
  });

  it("success: widget registered in _runningAgents", async () => {
    coreRunAgentMock.mockResolvedValue(successResult());

    await runtime.runAgent(baseOpts);

    // After runAgent, the agent is in _runningAgents until linger timer fires
    const running = runtime.listRunningAgents();
    expect(running).toHaveLength(1);
  });

  // ── Failure path ──────────────────────────────────────

  it("failure: core runAgent returns success=false → status failed", async () => {
    coreRunAgentMock.mockResolvedValue(failResult("connection timeout"));

    const result = await runtime.runAgent(baseOpts);

    expect(result.success).toBe(false);
    expect(result.error).toBe("connection timeout");
    // onError is only called in catch path, not for success=false return
    const running = runtime.listRunningAgents();
    expect(running[0].status).toBe("failed");
  });

  it("failure: core runAgent throws → catch block handles, rethrows", async () => {
    const onError = vi.fn();
    runtime.registerHooks({ onError });

    coreRunAgentMock.mockRejectedValue(new Error("unexpected crash"));

    await expect(runtime.runAgent(baseOpts)).rejects.toThrow("unexpected crash");
    expect(onError).toHaveBeenCalledOnce();
    // onError receives the original Error object
    const [err] = onError.mock.calls[0] as [Error];
    expect(err.message).toBe("unexpected crash");
  });

  it("failure: non-Error thrown → String(err) fallback for error message", async () => {
    const onError = vi.fn();
    runtime.registerHooks({ onError });

    coreRunAgentMock.mockRejectedValue("string error");

    await expect(runtime.runAgent(baseOpts)).rejects.toBe("string error");
    expect(onError).toHaveBeenCalledOnce();
  });

  // ── Abort / cancelled ─────────────────────────────────

  it("abort: signal.aborted with success=false → status cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    coreRunAgentMock.mockResolvedValue(failResult());

    const result = await runtime.runAgent({ ...baseOpts, signal: controller.signal });

    expect(result.success).toBe(false);
    // signal.aborted + success=false → cancelled status
    const running = runtime.listRunningAgents();
    expect(running[0].status).toBe("cancelled");
  });

  it("abort: signal.aborted + throw → catch path returns cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const onError = vi.fn();
    runtime.registerHooks({ onError });

    coreRunAgentMock.mockRejectedValue(new DOMException("aborted", "AbortError"));

    await expect(runtime.runAgent({ ...baseOpts, signal: controller.signal })).rejects.toThrow();
    expect(onError).toHaveBeenCalled();
  });

  // ── skipWidget (background path) ──────────────────────

  it("skipWidget: _skipWidget=true → no widget registration, no history append", async () => {
    coreRunAgentMock.mockResolvedValue(successResult());

    const result = await runtime.runAgent({ ...baseOpts, _skipWidget: true });

    expect(result.success).toBe(true);
    // _skipWidget → no history append (background has its own persistence)
    expect(pi.appendEntry).not.toHaveBeenCalled();
    // _runningAgents should not contain this agent
    expect(runtime.listRunningAgents()).toHaveLength(0);
  });

  it("skipWidget: hooks still called even with skipWidget", async () => {
    const afterRun = vi.fn();
    runtime.registerHooks({ afterRun });
    coreRunAgentMock.mockResolvedValue(successResult());

    await runtime.runAgent({ ...baseOpts, _skipWidget: true });

    expect(afterRun).toHaveBeenCalledOnce();
  });

  // ── Hooks ─────────────────────────────────────────────

  it("beforeRun hook can modify opts", async () => {
    const beforeRun = vi.fn(async (opts: RunAgentOptions) => ({
      ...opts,
      task: "modified task",
    }));
    runtime.registerHooks({ beforeRun });
    coreRunAgentMock.mockResolvedValue(successResult());

    await runtime.runAgent(baseOpts);

    expect(beforeRun).toHaveBeenCalledOnce();
    // core runAgent should receive modified opts
    const [receivedOpts] = coreRunAgentMock.mock.calls[0] as [RunAgentOptions];
    expect(receivedOpts.task).toBe("modified task");
  });

  it("multiple hooks: beforeRun chains, afterRun all called", async () => {
    const calls: string[] = [];
    runtime.registerHooks({
      beforeRun: async (opts) => { calls.push("hook1-before"); return opts; },
      afterRun: () => { calls.push("hook1-after"); },
    });
    runtime.registerHooks({
      beforeRun: async (opts) => { calls.push("hook2-before"); return opts; },
      afterRun: () => { calls.push("hook2-after"); },
    });
    coreRunAgentMock.mockResolvedValue(successResult());

    await runtime.runAgent(baseOpts);

    expect(calls).toEqual(["hook1-before", "hook2-before", "hook1-after", "hook2-after"]);
  });

  it("onError hook called on failure with Error instance", async () => {
    const onError = vi.fn();
    runtime.registerHooks({ onError });
    coreRunAgentMock.mockRejectedValue(new TypeError("bad type"));

    await expect(runtime.runAgent(baseOpts)).rejects.toThrow();

    expect(onError).toHaveBeenCalledOnce();
    const [err] = onError.mock.calls[0] as [Error];
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe("bad type");
  });

  // ── onEvent interception ──────────────────────────────

  it("onEvent: user-provided onEvent is called alongside state update", async () => {
    const userOnEvent = vi.fn();
    coreRunAgentMock.mockImplementation(async (opts: RunAgentOptions) => {
      opts.onEvent?.({ type: "turn_end" });
      return successResult();
    });

    await runtime.runAgent({ ...baseOpts, onEvent: userOnEvent });

    expect(userOnEvent).toHaveBeenCalled();
  });

  // ── state lifecycle ───────────────────────────────────

  it("state: completed with done status on success", async () => {
    coreRunAgentMock.mockResolvedValue(successResult());

    await runtime.runAgent(baseOpts);

    // After completion, agent is still in _runningAgents until linger timer fires
    const running = runtime.listRunningAgents();
    expect(running).toHaveLength(1);
    expect(running[0].status).toBe("done");
  });

  it("state: completed with failed status on failure", async () => {
    coreRunAgentMock.mockResolvedValue(failResult("error msg"));

    await runtime.runAgent(baseOpts);

    const running = runtime.listRunningAgents();
    expect(running).toHaveLength(1);
    expect(running[0].status).toBe("failed");
  });

  // ── P1b: onEvent 中 notifyChange 按 shouldTriggerUpdate 过滤 ──────
  // 验证 streaming delta（text_delta/thinking_delta）不触发 notifyChange，
  // 离散边界事件（tool_start/turn_end/message_end）触发。
  // 用 mockImplementation 捕获 finalOpts.onEvent 并手动驱动事件流。
  it("P1b: streaming delta 不触发 notifyChange，边界事件触发", async () => {
    const listener = vi.fn();
    runtime.onChange(listener);

    let capturedOnEvent: ((event: { type: string }) => void) | undefined;
    coreRunAgentMock.mockImplementation(async (opts) => {
      capturedOnEvent = opts.onEvent as typeof capturedOnEvent;
      return successResult();
    });

    const runPromise = runtime.runAgent(baseOpts);
    // 等 mockImplementation 执行，捕获 onEvent
    await vi.waitFor(() => expect(capturedOnEvent).toBeDefined());

    const callsBefore = listener.mock.calls.length;
    // streaming delta：不应触发 notifyChange
    capturedOnEvent!({ type: "text_delta" });
    capturedOnEvent!({ type: "thinking_delta" });
    capturedOnEvent!({ type: "text_delta" });
    expect(listener.mock.calls.length).toBe(callsBefore);

    // 边界事件：应触发 notifyChange
    capturedOnEvent!({ type: "tool_start" });
    expect(listener.mock.calls.length).toBe(callsBefore + 1);

    capturedOnEvent!({ type: "turn_end" });
    expect(listener.mock.calls.length).toBe(callsBefore + 2);

    await runPromise;
  });
});
