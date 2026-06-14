// src/__tests__/runtime-eventlog.test.ts
import { describe, expect, it } from "vitest";

import { updateWidgetFromEvent } from "../runtime.ts";
import type { WidgetAgentState } from "../tui/agent-widget.ts";
import { MAX_EVENT_LOG_ENTRIES, THINKING_CHUNK, TEXT_OUTPUT_CHUNK } from "../types.ts";

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

  it("turn_end flushes text_output + emits turn_end entry, resets buffer (FR-1.1b)", () => {
    const s = makeWidgetState();
    updateWidgetFromEvent(s, { type: "text_delta", delta: "Hello " }, Date.now());
    updateWidgetFromEvent(s, { type: "text_delta", delta: "world" }, Date.now());
    updateWidgetFromEvent(s, { type: "turn_end" }, Date.now());
    const entries = s.eventLog ?? [];
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe("text_output");
    expect(entries[0].label).toBe("Hello world");
    expect(entries[1].type).toBe("turn_end");
    expect(entries[1].label).toBe("Hello world");
    expect(s._currentTurnText).toBe("");
  });

  it("long text produces multiple text_output chunks, remainder preserved (FR-1.1b, W2)", () => {
    const s = makeWidgetState();
    const longText = "x".repeat(200);
    updateWidgetFromEvent(s, { type: "text_delta", delta: longText }, Date.now());
    updateWidgetFromEvent(s, { type: "turn_end" }, Date.now());
    const entries = s.eventLog ?? [];
    // W2: 切片保留余数。200 字符 → while 循环切 2 次（各 100），余 0。
    // turn_end 时缓冲已空 → summary 为空。共 3 条：2 text_output + 1 turn_end。
    expect(entries).toHaveLength(3);
    expect(entries[0].type).toBe("text_output");
    expect(entries[0].label).toHaveLength(100);
    expect(entries[1].type).toBe("text_output");
    expect(entries[1].label).toHaveLength(100);
    expect(entries[2].type).toBe("turn_end");
    expect(entries[2].label).toHaveLength(0);
  });

  it("text remainder carries over to next delta (FR-1.1b, W2)", () => {
    const s = makeWidgetState();
    // 150 字符：切片 100（label）+ 余 50。50 < 100 不再切。
    updateWidgetFromEvent(s, { type: "text_delta", delta: "x".repeat(150) }, Date.now());
    // 再 60 字符：50+60=110 ≥ 100 → 切 100，余 10
    updateWidgetFromEvent(s, { type: "text_delta", delta: "y".repeat(60) }, Date.now());
    updateWidgetFromEvent(s, { type: "turn_end" }, Date.now());
    const entries = s.eventLog ?? [];
    // 2 条 text_output（150 切 1 条，余 50；+60=110 切 1 条，余 10）+ turn_end flush 余 10 + turn_end summary
    const textOutputs = entries.filter((e) => e.type === "text_output");
    expect(textOutputs.length).toBe(3); // 150切片 + 110切片 + turn_end flush 余10
    // 验证每条 label 长度（确保余数正确保留，非丢弃）
    expect(textOutputs[0].label).toHaveLength(100); // 150 的前 100
    expect(textOutputs[1].label).toHaveLength(100); // 余 50 + 60 = 110 的前 100
    expect(textOutputs[2].label).toHaveLength(10);  // turn_end flush 剩余 10
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

describe("updateWidgetFromEvent — text_output + thinking slicing (FR-1.1b/1.1a)", () => {
  it("emits text_output entry when accumulated text reaches TEXT_OUTPUT_CHUNK", () => {
    const s = makeWidgetState();
    updateWidgetFromEvent(s, { type: "text_delta", delta: "x".repeat(TEXT_OUTPUT_CHUNK) }, Date.now());
    const entries = (s.eventLog ?? []).filter((e) => e.type === "text_output");
    expect(entries).toHaveLength(1);
    expect(entries[0].label.length).toBeLessThanOrEqual(100);
  });

  it("does NOT emit text_output before reaching TEXT_OUTPUT_CHUNK (throttled)", () => {
    const s = makeWidgetState();
    updateWidgetFromEvent(s, { type: "text_delta", delta: "x".repeat(TEXT_OUTPUT_CHUNK - 1) }, Date.now());
    const entries = (s.eventLog ?? []).filter((e) => e.type === "text_output");
    expect(entries).toHaveLength(0);
  });

  it("emits thinking entry when accumulated thinking reaches THINKING_CHUNK", () => {
    const s = makeWidgetState();
    updateWidgetFromEvent(s, { type: "thinking_delta", delta: "y".repeat(THINKING_CHUNK) }, Date.now());
    const entries = (s.eventLog ?? []).filter((e) => e.type === "thinking");
    expect(entries).toHaveLength(1);
  });

  it("flushes residual text_output on turn_end", () => {
    const s = makeWidgetState();
    updateWidgetFromEvent(s, { type: "text_delta", delta: "short partial" }, Date.now());
    updateWidgetFromEvent(s, { type: "turn_end" }, Date.now());
    const entries = (s.eventLog ?? []).filter((e) => e.type === "text_output");
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it("flushes residual thinking on turn_end", () => {
    const s = makeWidgetState();
    updateWidgetFromEvent(s, { type: "thinking_delta", delta: "partial thought" }, Date.now());
    updateWidgetFromEvent(s, { type: "turn_end" }, Date.now());
    const entries = (s.eventLog ?? []).filter((e) => e.type === "thinking");
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it("resets _currentThinking after flush", () => {
    const s = makeWidgetState();
    updateWidgetFromEvent(s, { type: "thinking_delta", delta: "partial thought" }, Date.now());
    updateWidgetFromEvent(s, { type: "turn_end" }, Date.now());
    expect(s._currentThinking).toBe("");
  });
});
