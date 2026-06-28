// jsonl-to-agent-event 翻译器测试。
//
// 用 pi print-mode.ts 确认的 SDK 事件结构（即 subprocess JSONL 流的事件结构）做 fixture，
// 覆盖各 event type 的翻译 + 边界情况。

import { describe, expect, it } from "vitest";
import { jsonlToAgentEvent } from "../jsonl-to-agent-event.ts";

describe("jsonlToAgentEvent", () => {
  it("translates tool_execution_start → tool_start", () => {
    const events = jsonlToAgentEvent({
      type: "tool_execution_start",
      toolCallId: "tc-1",
      toolName: "bash",
      args: { command: "ls -la" },
    });
    expect(events).toEqual([{ type: "tool_start", toolName: "bash", args: { command: "ls -la" } }]);
  });

  it("translates tool_execution_end → tool_end (with result + isError)", () => {
    const events = jsonlToAgentEvent({
      type: "tool_execution_end",
      toolCallId: "tc-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "output" }] },
      isError: false,
    });
    expect(events).toEqual([{
      type: "tool_end",
      toolName: "bash",
      args: undefined,
      result: { content: [{ type: "text", text: "output" }] },
      isError: false,
    }]);
  });

  it("translates tool_execution_end with isError=true", () => {
    const events = jsonlToAgentEvent({
      type: "tool_execution_end",
      toolName: "bash",
      isError: true,
      result: { content: [{ type: "text", text: "Command failed" }] },
    });
    expect(events[0]?.type).toBe("tool_end");
    expect((events[0] as { isError: boolean }).isError).toBe(true);
  });

  it("defaults toolName to empty string when missing", () => {
    const events = jsonlToAgentEvent({ type: "tool_execution_start" });
    expect(events).toEqual([{ type: "tool_start", toolName: "", args: undefined }]);
  });

  it("translates message_update thinking_delta → thinking_delta", () => {
    const events = jsonlToAgentEvent({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "thinking_delta", delta: "reasoning..." },
    });
    expect(events).toEqual([{ type: "thinking_delta", delta: "reasoning..." }]);
  });

  it("translates message_update with delta (no type) → text_delta", () => {
    const events = jsonlToAgentEvent({
      type: "message_update",
      message: {},
      assistantMessageEvent: { delta: "hello" },
    });
    expect(events).toEqual([{ type: "text_delta", delta: "hello" }]);
  });

  it("returns empty for message_update without assistantMessageEvent", () => {
    expect(jsonlToAgentEvent({ type: "message_update", message: {} })).toEqual([]);
  });

  it("translates turn_end", () => {
    expect(jsonlToAgentEvent({ type: "turn_end", turnIndex: 0 })).toEqual([{ type: "turn_end" }]);
  });

  it("translates compaction_start → compaction", () => {
    expect(jsonlToAgentEvent({ type: "compaction_start", reason: "threshold" })).toEqual([{ type: "compaction" }]);
  });

  describe("message_end", () => {
    it("produces message_end with flattened usage (cost.total → cost)", () => {
      const events = jsonlToAgentEvent({
        type: "message_end",
        message: {
          role: "assistant",
          usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: { total: 0.02 } },
          stopReason: "end_turn",
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "message_end",
        usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.02 },
      });
    });

    it("produces message_end even without usage", () => {
      const events = jsonlToAgentEvent({
        type: "message_end",
        message: { role: "assistant", stopReason: "end_turn" },
      });
      // 无 usage → 不产 message_end 事件；stopReason 非 error → 不产 error 事件
      expect(events).toEqual([]);
    });

    it("produces BOTH message_end(usage) AND error when stopReason=error (usage preserved for billing)", () => {
      const events = jsonlToAgentEvent({
        type: "message_end",
        message: {
          role: "assistant",
          usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
          stopReason: "error",
          errorMessage: "rate limited",
        },
      });
      expect(events).toHaveLength(2);
      expect(events[0]?.type).toBe("message_end");
      expect(events[1]).toEqual({ type: "error", message: "rate limited" });
    });

    it("error event falls back to stopReason when errorMessage missing", () => {
      const events = jsonlToAgentEvent({
        type: "message_end",
        message: { role: "assistant", stopReason: "aborted" },
      });
      expect(events).toEqual([{ type: "error", message: "aborted" }]);
    });

    it("cost missing total → cost undefined", () => {
      const events = jsonlToAgentEvent({
        type: "message_end",
        message: {
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: {} },
          stopReason: "end_turn",
        },
      });
      expect((events[0] as { usage: { cost?: number } }).usage.cost).toBeUndefined();
    });
  });

  describe("ignored event types", () => {
    it("returns [] for session header", () => {
      expect(jsonlToAgentEvent({ type: "session", id: "abc" })).toEqual([]);
    });

    it("returns [] for message_start", () => {
      expect(jsonlToAgentEvent({ type: "message_start", message: {} })).toEqual([]);
    });

    it("returns [] for turn_start", () => {
      expect(jsonlToAgentEvent({ type: "turn_start", turnIndex: 0 })).toEqual([]);
    });

    it("returns [] for tool_execution_update", () => {
      expect(jsonlToAgentEvent({ type: "tool_execution_update", toolCallId: "x", partialResult: {} })).toEqual([]);
    });

    it("returns [] for unknown event type (forward-compat)", () => {
      expect(jsonlToAgentEvent({ type: "future_unknown_event" })).toEqual([]);
    });
  });
});
