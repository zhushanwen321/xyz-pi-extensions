// src/__tests__/runtime-eventlog.test.ts
import { describe, expect, it } from "vitest";

import { updateWidgetFromEvent } from "../runtime.ts";
import type { WidgetAgentState } from "../tui/agent-widget.ts";
import { MAX_EVENT_LOG_ENTRIES } from "../types.ts";

function makeWidgetState(overrides: Partial<WidgetAgentState> = {}): WidgetAgentState {
  return {
    id: "run-1",
    agent: "worker",
    status: "running",
    ...overrides,
  } as WidgetAgentState;
}

describe("updateWidgetFromEvent — append mode", () => {
  it("tool_start pushes eventLog entry with label and running status", () => {
    const s = makeWidgetState();
    updateWidgetFromEvent(s, { type: "tool_start", toolName: "read", args: { path: "foo/bar.ts" } }, Date.now());
    expect(s.eventLog).toHaveLength(1);
    expect(s.eventLog![0].type).toBe("tool_start");
    expect(s.eventLog![0].label).toBe("read bar.ts");
    expect(s.eventLog![0].status).toBe("running");
  });

  it("tool_end pushes entry with done status", () => {
    const s = makeWidgetState();
    updateWidgetFromEvent(s, { type: "tool_start", toolName: "read" }, Date.now());
    updateWidgetFromEvent(s, { type: "tool_end", toolName: "read", isError: false }, Date.now());
    expect(s.eventLog).toHaveLength(2);
    expect(s.eventLog![1].type).toBe("tool_end");
    expect(s.eventLog![1].status).toBe("done");
  });

  it("tool_end failed pushes entry with failed status", () => {
    const s = makeWidgetState();
    updateWidgetFromEvent(s, { type: "tool_end", toolName: "bash", isError: true }, Date.now());
    expect(s.eventLog![0].status).toBe("failed");
  });

  it("turn_end slices _currentTurnText and resets it", () => {
    const s = makeWidgetState();
    updateWidgetFromEvent(s, { type: "text_delta", delta: "Hello " }, Date.now());
    updateWidgetFromEvent(s, { type: "text_delta", delta: "world" }, Date.now());
    updateWidgetFromEvent(s, { type: "turn_end" }, Date.now());
    expect(s.eventLog).toHaveLength(1);
    expect(s.eventLog![0].type).toBe("turn_end");
    expect(s.eventLog![0].label).toBe("Hello world");
    expect(s._currentTurnText).toBe("");
  });

  it("turn_end truncates label to TURN_SUMMARY_MAX (80)", () => {
    const s = makeWidgetState();
    const longText = "x".repeat(200);
    updateWidgetFromEvent(s, { type: "text_delta", delta: longText }, Date.now());
    updateWidgetFromEvent(s, { type: "turn_end" }, Date.now());
    expect(s.eventLog![0].label).toHaveLength(80);
  });

  it("message_end does NOT push eventLog entry (only updates totalTokens)", () => {
    const s = makeWidgetState();
    updateWidgetFromEvent(
      s,
      { type: "message_end", usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0 } },
      Date.now(),
    );
    expect(s.eventLog ?? []).toHaveLength(0);
    expect(s.totalTokens).toBe(300);
  });

  it("ring buffer evicts oldest entry when exceeding MAX_EVENT_LOG_ENTRIES", () => {
    const s = makeWidgetState();
    for (let i = 0; i < MAX_EVENT_LOG_ENTRIES + 5; i++) {
      updateWidgetFromEvent(s, { type: "tool_start", toolName: "read" }, Date.now());
    }
    expect(s.eventLog).toHaveLength(MAX_EVENT_LOG_ENTRIES);
  });

  it("preserves activity field for backward compat", () => {
    const s = makeWidgetState();
    updateWidgetFromEvent(s, { type: "tool_start", toolName: "read" }, Date.now());
    expect(s.activity).toBe("read");
  });
});
