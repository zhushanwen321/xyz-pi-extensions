// src/__tests__/event-bridge.test.ts
import { describe, expect,it } from "vitest";

import { createEventBridge } from "../core/event-bridge.ts";
import type { AgentEvent } from "../types.ts";

describe("createEventBridge", () => {
  it("maps tool_execution_start → tool_start", () => {
    const events: AgentEvent[] = [];
    const bridge = createEventBridge((e) => events.push(e));
    bridge.handle({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} } as never);
    expect(events).toEqual([{ type: "tool_start", toolName: "read", args: {} }]);
  });

  it("maps tool_execution_end → tool_end with result and isError", () => {
    const events: AgentEvent[] = [];
    const bridge = createEventBridge((e) => events.push(e));
    bridge.handle({
      type: "tool_execution_end",
      toolCallId: "1", toolName: "structured-output",
      result: { content: [{ type: "text", text: "done" }], details: { output: 42 } },
      isError: false,
    } as never);
    expect(events).toEqual([{
      type: "tool_end", toolName: "structured-output",
      result: { content: [{ type: "text", text: "done" }], details: { output: 42 } },
      isError: false,
    }]);
  });

  it("maps turn_end and increments turn counter", () => {
    const events: AgentEvent[] = [];
    const bridge = createEventBridge((e) => events.push(e));
    bridge.handle({ type: "turn_end", message: {} as never, toolResults: [] } as never);
    bridge.handle({ type: "turn_end", message: {} as never, toolResults: [] } as never);
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(2);
    expect(bridge.turnCount).toBe(2);
  });

  it("maps message_end and extracts usage from message.usage", () => {
    const events: AgentEvent[] = [];
    const bridge = createEventBridge((e) => events.push(e));
    bridge.handle({
      type: "message_end",
      message: {
        usage: {
          input: 100, output: 200, cacheRead: 10, cacheWrite: 5, totalTokens: 315,
          cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.05, total: 3.15 },
        },
      } as never,
    });
    const me = events.find((e) => e.type === "message_end");
    expect(me).toEqual({
      type: "message_end",
      usage: { input: 100, output: 200, cacheRead: 10, cacheWrite: 5, cost: 3.15 },
    });
  });

  it("maps message_end with stopReason error → error event", () => {
    const events: AgentEvent[] = [];
    const bridge = createEventBridge((e) => events.push(e));
    bridge.handle({
      type: "message_end",
      message: { stopReason: "error", errorMessage: "rate limited", usage: null } as never,
    });
    expect(events.find((e) => e.type === "error")).toEqual({ type: "error", error: "rate limited" });
  });

  it("maps compaction_start → compaction", () => {
    const events: AgentEvent[] = [];
    const bridge = createEventBridge((e) => events.push(e));
    bridge.handle({ type: "compaction_start", reason: "threshold" } as never);
    expect(events.find((e) => e.type === "compaction")).toBeDefined();
  });

  it("accumulates tool call records", () => {
    const bridge = createEventBridge(() => {});
    bridge.handle({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} } as never);
    bridge.handle({
      type: "tool_execution_end", toolCallId: "1", toolName: "read",
      result: { content: [{ type: "text", text: "file" }] }, isError: false,
    } as never);
    expect(bridge.toolCalls).toEqual([{
      toolName: "read",
      result: { content: [{ type: "text", text: "file" }] },
      isError: false,
    }]);
  });

  it("passes args through to tool_start event (FR-1.1a)", () => {
    const events: AgentEvent[] = [];
    const bridge = createEventBridge((e) => events.push(e));
    const args = { path: "extensions/subagents/src/runtime.ts" };
    bridge.handle({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args } as never);
    expect(events).toEqual([{ type: "tool_start", toolName: "read", args }]);
  });
});
