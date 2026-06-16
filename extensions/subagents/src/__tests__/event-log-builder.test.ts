// src/__tests__/event-log-builder.test.ts
//
// Tests for appendEventLogEntries logic (via updateWidgetFromEvent public API).
// Covers: ring buffer truncation, text_delta accumulation, thinking slicing,
// and edge cases complementary to runtime-eventlog.test.ts.

import { describe, expect, it } from "vitest";

import { updateWidgetFromEvent } from "../event-log-builder.ts";
import { createExecutionState } from "../state/execution-state.ts";
import {
  EVENT_LOG_LABEL_MAX,
  MAX_EVENT_LOG_ENTRIES,
  TEXT_OUTPUT_CHUNK,
  THINKING_CHUNK,
  TURN_SUMMARY_MAX,
} from "../types.ts";
import type { WidgetAgentState } from "../tui/agent-widget.ts";

function makeState(): WidgetAgentState {
  return createExecutionState("test-1", {
    agent: "worker",
    model: "test/model",
    startedAt: Date.now(),
  });
}

describe("appendEventLogEntries — edge cases", () => {
  it("eventLog starts as empty array and grows on events", () => {
    const s = makeState();
    expect(s.eventLog).toEqual([]);
    updateWidgetFromEvent(s, { type: "tool_start", toolName: "read" }, 0);
    expect(s.eventLog).toHaveLength(1);
  });

  it("unknown event type produces no entry", () => {
    const s = makeState();
    updateWidgetFromEvent(s, { type: "unknown_event" }, 0);
    expect(s.eventLog ?? []).toHaveLength(0);
  });

  it("interleaved text_delta and thinking_delta accumulate independently", () => {
    const s = makeState();
    updateWidgetFromEvent(s, { type: "text_delta", delta: "hello " }, 0);
    updateWidgetFromEvent(s, { type: "thinking_delta", delta: "reasoning " }, 0);
    updateWidgetFromEvent(s, { type: "text_delta", delta: "world" }, 0);
    updateWidgetFromEvent(s, { type: "thinking_delta", delta: "done" }, 0);
    // Neither buffer reached threshold → no entries yet
    expect(s.eventLog ?? []).toHaveLength(0);
    // Flush via turn_end
    updateWidgetFromEvent(s, { type: "turn_end" }, 0);
    const entries = s.eventLog ?? [];
    const textEntries = entries.filter((e) => e.type === "text_output");
    const thinkingEntries = entries.filter((e) => e.type === "thinking");
    expect(textEntries).toHaveLength(1);
    expect(textEntries[0].label).toBe("hello world");
    expect(thinkingEntries).toHaveLength(1);
    expect(thinkingEntries[0].label).toBe("reasoning done");
  });

  it("turn_end summary truncated to TURN_SUMMARY_MAX", () => {
    const s = makeState();
    // text_delta below TEXT_OUTPUT_CHUNK so buffer is NOT sliced during accumulation
    const text = "a".repeat(TURN_SUMMARY_MAX + 10);
    updateWidgetFromEvent(s, { type: "text_delta", delta: text }, 0);
    updateWidgetFromEvent(s, { type: "turn_end" }, 0);
    const entries = s.eventLog ?? [];
    const turnEnd = entries.find((e) => e.type === "turn_end");
    expect(turnEnd).toBeDefined();
    expect(turnEnd!.label.length).toBe(TURN_SUMMARY_MAX);
  });

  it("text_delta label truncated to EVENT_LOG_LABEL_MAX", () => {
    const s = makeState();
    // Exactly TEXT_OUTPUT_CHUNK chars → one chunk, label capped at EVENT_LOG_LABEL_MAX
    updateWidgetFromEvent(
      s,
      { type: "text_delta", delta: "b".repeat(TEXT_OUTPUT_CHUNK) },
      0,
    );
    const entries = s.eventLog ?? [];
    const textEntry = entries.find((e) => e.type === "text_output");
    expect(textEntry).toBeDefined();
    expect(textEntry!.label.length).toBeLessThanOrEqual(EVENT_LOG_LABEL_MAX);
  });

  it("multiple thinking chunks produced from large thinking_delta", () => {
    const s = makeState();
    const bigThinking = "t".repeat(THINKING_CHUNK * 3);
    updateWidgetFromEvent(s, { type: "thinking_delta", delta: bigThinking }, 0);
    const entries = s.eventLog ?? [];
    const thinkingEntries = entries.filter((e) => e.type === "thinking");
    expect(thinkingEntries.length).toBeGreaterThanOrEqual(3);
  });

  it("ring buffer evicts oldest when exceeding MAX_EVENT_LOG_ENTRIES", () => {
    const s = makeState();
    const count = MAX_EVENT_LOG_ENTRIES + 10;
    for (let i = 0; i < count; i++) {
      updateWidgetFromEvent(s, { type: "tool_start", toolName: `tool-${i}` }, 0);
    }
    expect(s.eventLog).toHaveLength(MAX_EVENT_LOG_ENTRIES);
    // Oldest entries (tool-0 .. tool-9) should be evicted
    expect(s.eventLog![0].label).toContain("tool-10");
  });

  it("tool_end isError=true produces failed status", () => {
    const s = makeState();
    updateWidgetFromEvent(s, { type: "tool_end", toolName: "bash", isError: true }, 0);
    expect(s.eventLog![0].status).toBe("failed");
  });

  it("tool_end isError=false produces done status", () => {
    const s = makeState();
    updateWidgetFromEvent(s, { type: "tool_end", toolName: "read", isError: false }, 0);
    expect(s.eventLog![0].status).toBe("done");
  });

  it("turn_end increments turns counter", () => {
    const s = makeState();
    expect(s.turns).toBe(0);
    updateWidgetFromEvent(s, { type: "turn_end" }, 0);
    expect(s.turns).toBe(1);
    updateWidgetFromEvent(s, { type: "turn_end" }, 0);
    expect(s.turns).toBe(2);
  });

  it("message_end accumulates totalTokens", () => {
    const s = makeState();
    updateWidgetFromEvent(
      s,
      {
        type: "message_end",
        usage: { input: 100, output: 200, cacheRead: 50, cacheWrite: 30 },
      },
      0,
    );
    expect(s.totalTokens).toBe(380);
  });
});
