// src/__tests__/execution-state.test.ts
//
// Direct unit tests for execution-state.ts core functions.
// Covers MF#3: 240-line state module with no direct unit tests.

import { describe, expect, it, vi } from "vitest";

import {
  completeState,
  createExecutionState,
  executionStateToDetails,
  updateStateFromEvent,
} from "../state/execution-state.ts";
import type { AgentResult } from "../types.ts";

// ============================================================
// createExecutionState
// ============================================================

describe("createExecutionState", () => {
  it("initializes with correct defaults", () => {
    const state = createExecutionState("bg-1-worker", {
      agent: "worker",
      model: "anthropic/claude-sonnet-4-20250514",
      thinkingLevel: "high",
      startedAt: 1000,
    });

    expect(state.id).toBe("bg-1-worker");
    expect(state.agent).toBe("worker");
    expect(state.model).toBe("anthropic/claude-sonnet-4-20250514");
    expect(state.thinkingLevel).toBe("high");
    expect(state.status).toBe("running");
    expect(state.eventLog).toEqual([]);
    expect(state.turns).toBe(0);
    expect(state.totalTokens).toBe(0);
    expect(state.startedAt).toBe(1000);
    expect(state.endedAt).toBeUndefined();
    expect(state.result).toBeUndefined();
    expect(state.error).toBeUndefined();
    expect(state.agentResult).toBeUndefined();
    expect(state._currentTurnText).toBe("");
    expect(state._currentThinking).toBe("");
  });

  it("handles optional thinkingLevel", () => {
    const state = createExecutionState("run-1", {
      agent: "default",
      model: "anthropic/claude-sonnet-4-20250514",
      startedAt: 2000,
    });
    expect(state.thinkingLevel).toBeUndefined();
  });
});

// ============================================================
// updateStateFromEvent
// ============================================================

describe("updateStateFromEvent", () => {
  it("increments turns on turn_end", () => {
    const state = createExecutionState("t-1", {
      agent: "default",
      model: "m",
      startedAt: 0,
    });
    updateStateFromEvent(state, { type: "turn_end" });
    expect(state.turns).toBe(1);
    updateStateFromEvent(state, { type: "turn_end" });
    expect(state.turns).toBe(2);
  });

  it("accumulates tokens on message_end", () => {
    const state = createExecutionState("t-2", {
      agent: "default",
      model: "m",
      startedAt: 0,
    });
    updateStateFromEvent(state, {
      type: "message_end",
      usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10 },
    });
    expect(state.totalTokens).toBe(180);

    updateStateFromEvent(state, {
      type: "message_end",
      usage: { input: 30, output: 20, cacheRead: 0, cacheWrite: 0 },
    });
    expect(state.totalTokens).toBe(230);
  });

  it("appends tool_start to eventLog", () => {
    const state = createExecutionState("t-3", {
      agent: "default",
      model: "m",
      startedAt: 0,
    });
    updateStateFromEvent(state, {
      type: "tool_start",
      toolName: "bash",
      args: { command: "ls" },
    });
    expect(state.eventLog).toHaveLength(1);
    expect(state.eventLog[0].type).toBe("tool_start");
    expect(state.eventLog[0].label).toContain("bash");
  });

  it("appends tool_end to eventLog", () => {
    const state = createExecutionState("t-4", {
      agent: "default",
      model: "m",
      startedAt: 0,
    });
    updateStateFromEvent(state, { type: "tool_end", toolName: "read", isError: false });
    expect(state.eventLog).toHaveLength(1);
    expect(state.eventLog[0].type).toBe("tool_end");
    expect(state.eventLog[0].status).toBe("done");
  });

  it("marks tool_end as failed when isError", () => {
    const state = createExecutionState("t-5", {
      agent: "default",
      model: "m",
      startedAt: 0,
    });
    updateStateFromEvent(state, { type: "tool_end", toolName: "bash", isError: true });
    expect(state.eventLog[0].status).toBe("failed");
  });

  it("accumulates text_delta into _currentTurnText", () => {
    const state = createExecutionState("t-6", {
      agent: "default",
      model: "m",
      startedAt: 0,
    });
    updateStateFromEvent(state, { type: "text_delta", delta: "hello " });
    expect(state._currentTurnText).toBe("hello ");
    expect(state.eventLog).toHaveLength(0); // below TEXT_OUTPUT_CHUNK

    updateStateFromEvent(state, { type: "text_delta", delta: "world" });
    expect(state._currentTurnText).toBe("hello world");
  });

  it("accumulates thinking_delta into _currentThinking", () => {
    const state = createExecutionState("t-7", {
      agent: "default",
      model: "m",
      startedAt: 0,
    });
    updateStateFromEvent(state, { type: "thinking_delta", delta: "reasoning..." });
    expect(state._currentThinking).toBe("reasoning...");
  });

  it("flushes text/thinking buffers on turn_end", () => {
    const state = createExecutionState("t-8", {
      agent: "default",
      model: "m",
      startedAt: 0,
    });
    updateStateFromEvent(state, { type: "text_delta", delta: "partial text" });
    updateStateFromEvent(state, { type: "thinking_delta", delta: "partial think" });
    updateStateFromEvent(state, { type: "turn_end" });

    // Buffers should be flushed
    expect(state._currentTurnText).toBe("");
    expect(state._currentThinking).toBe("");
    // turn_end should have flushed entries + the turn_end entry itself
    expect(state.eventLog.length).toBeGreaterThanOrEqual(1);
    expect(state.eventLog.at(-1)!.type).toBe("turn_end");
  });

  it("enforces ring buffer limit (MAX_EVENT_LOG_ENTRIES=20)", () => {
    const state = createExecutionState("t-9", {
      agent: "default",
      model: "m",
      startedAt: 0,
    });
    // Push 25 tool_start events to exceed the 20-entry limit
    for (let i = 0; i < 25; i++) {
      updateStateFromEvent(state, { type: "tool_start", toolName: `tool-${i}` });
    }
    expect(state.eventLog).toHaveLength(20);
    // Oldest entries should have been removed
    expect(state.eventLog[0].label).toContain("tool-5");
  });

  it("ignores unknown event types gracefully", () => {
    const state = createExecutionState("t-10", {
      agent: "default",
      model: "m",
      startedAt: 0,
    });
    // compaction and error events don't add to eventLog
    updateStateFromEvent(state, { type: "compaction" });
    updateStateFromEvent(state, { type: "error", error: "something broke" });
    expect(state.eventLog).toHaveLength(0);
    expect(state.turns).toBe(0);
    expect(state.totalTokens).toBe(0);
  });
});

// ============================================================
// completeState
// ============================================================

describe("completeState", () => {
  it("freezes status, writes result and endedAt", () => {
    const state = createExecutionState("c-1", {
      agent: "default",
      model: "m",
      startedAt: 1000,
    });
    const result: AgentResult = { text: "done", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

    vi.useFakeTimers();
    vi.setSystemTime(2000);

    completeState(state, result, "done");

    expect(state.status).toBe("done");
    expect(state.endedAt).toBe(2000);
    expect(state.result).toBe("done");
    expect(state.agentResult).toBe(result);

    vi.useRealTimers();
  });

  it("sets error from AgentResult", () => {
    const state = createExecutionState("c-2", {
      agent: "default",
      model: "m",
      startedAt: 0,
    });
    const result: AgentResult = {
      text: "",
      error: "timeout exceeded",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };

    completeState(state, result, "failed");
    expect(state.status).toBe("failed");
    expect(state.error).toBe("timeout exceeded");
  });

  it("supports cancelled status", () => {
    const state = createExecutionState("c-3", {
      agent: "default",
      model: "m",
      startedAt: 0,
    });
    const result: AgentResult = {
      text: "cancelled by user",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };

    completeState(state, result, "cancelled");
    expect(state.status).toBe("cancelled");
    expect(state.result).toBe("cancelled by user");
  });
});

// ============================================================
// executionStateToDetails
// ============================================================

describe("executionStateToDetails", () => {
  it("projects running state with elapsed computed from Date.now()", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5000);

    const state = createExecutionState("p-1", {
      agent: "reviewer",
      model: "anthropic/claude-sonnet-4-20250514",
      thinkingLevel: "low",
      startedAt: 1000,
    });

    const details = executionStateToDetails(state);
    expect(details.status).toBe("running");
    expect(details.agent).toBe("reviewer");
    expect(details.model).toBe("anthropic/claude-sonnet-4-20250514");
    expect(details.thinkingLevel).toBe("low");
    expect(details.elapsedSeconds).toBe(4); // (5000-1000)/1000
    expect(details.turns).toBe(0);
    expect(details.totalTokens).toBe(0);
    expect(details.result).toBeUndefined();
    expect(details.error).toBeUndefined();

    vi.useRealTimers();
  });

  it("projects completed state with endedAt-based elapsed", () => {
    const state = createExecutionState("p-2", {
      agent: "worker",
      model: "m",
      startedAt: 1000,
    });
    state.endedAt = 4500;

    const details = executionStateToDetails(state);
    expect(details.elapsedSeconds).toBe(3); // floor((4500-1000)/1000)
  });

  it("truncates elapsedSeconds with Math.floor", () => {
    const state = createExecutionState("p-3", {
      agent: "default",
      model: "m",
      startedAt: 1000,
    });
    state.endedAt = 3999; // 2.999s → 2s

    const details = executionStateToDetails(state);
    expect(details.elapsedSeconds).toBe(2);
  });

  it("includes eventLog in projection", () => {
    const state = createExecutionState("p-4", {
      agent: "default",
      model: "m",
      startedAt: 0,
    });
    updateStateFromEvent(state, { type: "tool_start", toolName: "read" });
    updateStateFromEvent(state, { type: "turn_end" });

    const details = executionStateToDetails(state);
    expect(details.eventLog.length).toBeGreaterThanOrEqual(1);
  });

  // ── P1#2: 别名（aliasing）隔离回归测试 ──────────────────────────
  // 投影产出的 eventLog 必须是快照（.slice），不能是 state.eventLog 的裸引用。
  // 否则渲染层持有的数组会被并发 updateStateFromEvent（push/shift）原地 mutate，
  // 导致渲染读到中途态/错位。这是 HANDOFF「架构分析结论 #2」的核心修复。

  it("P1#2: details.eventLog 是快照，与 state.eventLog 不同引用", () => {
    const state = createExecutionState("p-alias-1", {
      agent: "default",
      model: "m",
      startedAt: 0,
    });
    updateStateFromEvent(state, { type: "tool_start", toolName: "read" });

    const details = executionStateToDetails(state);
    // 内容相同
    expect(details.eventLog).toEqual(state.eventLog);
    // 但引用不同（快照）
    expect(details.eventLog).not.toBe(state.eventLog);
  });

  it("P1#2: 投影后 mutate state.eventLog 不影响已返回的 details", () => {
    const state = createExecutionState("p-alias-2", {
      agent: "default",
      model: "m",
      startedAt: 0,
    });
    updateStateFromEvent(state, { type: "tool_start", toolName: "read" });

    const details = executionStateToDetails(state);
    const detailsLengthAtProjection = details.eventLog.length;

    // 模拟并发 streaming：投影后继续 updateStateFromEvent（push 新条目）
    updateStateFromEvent(state, { type: "tool_end", toolName: "read", isError: false });
    updateStateFromEvent(state, { type: "tool_start", toolName: "bash" });

    // 已返回的 details.eventLog 不应被影响——长度仍是投影时的快照
    expect(details.eventLog.length).toBe(detailsLengthAtProjection);
    // state.eventLog 已增长
    expect(state.eventLog.length).toBeGreaterThan(detailsLengthAtProjection);
  });

  it("P1#2: ring buffer shift 不影响已返回的 details（streaming 期间高活跃场景）", () => {
    // 模拟高活跃 sync subagent：eventLog 已满（20 条），投影后再来事件触发 shift。
    // 渲染层持有的快照不应丢失最旧条目（shift 只作用于 state.eventLog）。
    const state = createExecutionState("p-alias-3", {
      agent: "default",
      model: "m",
      startedAt: 0,
    });
    // 填满 ring buffer（MAX_EVENT_LOG_ENTRIES=20）
    for (let i = 0; i < 20; i++) {
      updateStateFromEvent(state, { type: "tool_start", toolName: `tool-${i}` });
    }
    expect(state.eventLog).toHaveLength(20);

    const details = executionStateToDetails(state);
    const firstEntryAtProjection = details.eventLog[0];

    // 投影后再来 5 个事件 → state.eventLog shift 掉最旧 5 条
    for (let i = 20; i < 25; i++) {
      updateStateFromEvent(state, { type: "tool_start", toolName: `tool-${i}` });
    }
    expect(state.eventLog).toHaveLength(20);
    expect(state.eventLog[0].label).not.toBe(firstEntryAtProjection!.label); // state 已 shift

    // details 快照保持完整（仍 20 条，首条目不变）
    expect(details.eventLog).toHaveLength(20);
    expect(details.eventLog[0]).toEqual(firstEntryAtProjection);
  });

  // ── P1#3: currentActivity 实时活动行投影 ──────────────────────────

  it("P1#3: terminal 态 currentActivity 为 undefined", () => {
    const state = createExecutionState("ca-term", { agent: "default", model: "m", startedAt: 0 });
    updateStateFromEvent(state, { type: "tool_start", toolName: "read" });
    completeState(state, { text: "done", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, "done");
    const details = executionStateToDetails(state);
    expect(details.currentActivity).toBeUndefined();
  });

  it("P1#3: running + tool_start 在最后 → currentActivity.type === 'tool'", () => {
    const state = createExecutionState("ca-tool", { agent: "default", model: "m", startedAt: 0 });
    updateStateFromEvent(state, { type: "tool_start", toolName: "read", args: { path: "/a.ts" } });
    const details = executionStateToDetails(state);
    expect(details.currentActivity?.type).toBe("tool");
    expect(details.currentActivity?.label).toContain("read");
  });

  it("P1#3: running + tool_end 在最后（无 running tool）→ 落到 thinking/text", () => {
    // tool_end 后无 tool_start，应看 streaming 缓冲
    const state = createExecutionState("ca-after-tool", { agent: "default", model: "m", startedAt: 0 });
    updateStateFromEvent(state, { type: "tool_start", toolName: "read" });
    updateStateFromEvent(state, { type: "tool_end", toolName: "read", isError: false });
    // 无 streaming 缓冲 → undefined
    expect(executionStateToDetails(state).currentActivity).toBeUndefined();
    // 有 thinking 缓冲 → thinking
    updateStateFromEvent(state, { type: "thinking_delta", delta: "reasoning about results" });
    expect(executionStateToDetails(state).currentActivity?.type).toBe("thinking");
  });

  it("P1#3: running + thinking streaming → currentActivity.type === 'thinking'", () => {
    const state = createExecutionState("ca-think", { agent: "default", model: "m", startedAt: 0 });
    updateStateFromEvent(state, { type: "thinking_delta", delta: "analyzing the structure" });
    const details = executionStateToDetails(state);
    expect(details.currentActivity?.type).toBe("thinking");
    expect(details.currentActivity?.label).toContain("analyzing");
  });

  it("P1#3: running + text streaming（无 thinking）→ currentActivity.type === 'text'", () => {
    const state = createExecutionState("ca-text", { agent: "default", model: "m", startedAt: 0 });
    updateStateFromEvent(state, { type: "text_delta", delta: "generating response" });
    const details = executionStateToDetails(state);
    expect(details.currentActivity?.type).toBe("text");
    expect(details.currentActivity?.label).toContain("generating");
  });

  it("P1#3: tool 优先级高于 thinking/text（tool 执行中时不显示 streaming）", () => {
    const state = createExecutionState("ca-prio", { agent: "default", model: "m", startedAt: 0 });
    updateStateFromEvent(state, { type: "thinking_delta", delta: "thinking..." });
    updateStateFromEvent(state, { type: "tool_start", toolName: "bash", args: { command: "ls" } });
    const details = executionStateToDetails(state);
    // tool_start 在最后 → 优先 tool，即使有 thinking 缓冲
    expect(details.currentActivity?.type).toBe("tool");
  });

  it("P1#3: currentActivity 反映 streaming 缓冲的剩余（chunk 后）", () => {
    // text 250 字符：TEXT_OUTPUT_CHUNK=100 → while 循环推 2 chunk（200），剩 50 在 _currentTurnText。
    // currentActivity 应反映剩余缓冲（type=text, label=50 个 x），证明活动行是实时的、非历史 chunk。
    const state = createExecutionState("ca-trunc", { agent: "default", model: "m", startedAt: 0 });
    updateStateFromEvent(state, { type: "text_delta", delta: "x".repeat(250) });
    const details = executionStateToDetails(state);
    expect(details.currentActivity?.type).toBe("text");
    expect(details.currentActivity?.label).toBe("x".repeat(50));

    // thinking 150 字符同理：THINKING_CHUNK=100 → 推 1 chunk，剩 50
    const state2 = createExecutionState("ca-trunc2", { agent: "default", model: "m", startedAt: 0 });
    updateStateFromEvent(state2, { type: "thinking_delta", delta: "y".repeat(150) });
    expect(executionStateToDetails(state2).currentActivity?.label).toBe("y".repeat(50));
  });
});
