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
      args: {},
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

  it("propagates args from tool_execution_start into toolCalls record (FR-1.1a)", () => {
    // 验证：start 时缓存的 args 会在 end 时写入 ToolCallEntry.args，
    // 供下游（如 workflow agent-pool）作为调用参数预览使用。
    const args = { path: "/some/file.ts", limit: 50 };
    const bridge = createEventBridge(() => {});
    bridge.handle({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args } as never);
    bridge.handle({
      type: "tool_execution_end", toolCallId: "1", toolName: "read",
      result: { content: [{ type: "text", text: "file" }] }, isError: false,
    } as never);
    expect(bridge.toolCalls).toEqual([{
      toolName: "read",
      args,
      result: { content: [{ type: "text", text: "file" }] },
      isError: false,
    }]);
  });

  it("falls back to pending toolName when end event omits it", () => {
    // 验证：end 事件未携带 toolName 时，从 pendingTools 补全（args 也应随之带回）。
    const args = { query: "SELECT 1" };
    const bridge = createEventBridge(() => {});
    bridge.handle({ type: "tool_execution_start", toolCallId: "9", toolName: "bash", args } as never);
    bridge.handle({
      type: "tool_execution_end", toolCallId: "9",
      result: { content: [{ type: "text", text: "ok" }] }, isError: false,
    } as never);
    expect(bridge.toolCalls[0].toolName).toBe("bash");
    expect(bridge.toolCalls[0].args).toBe(args);
  });

  it("maps message_update with thinking_delta assistantMessageEvent → thinking_delta (FR-1.1a)", () => {
    const events: AgentEvent[] = [];
    const bridge = createEventBridge((e) => events.push(e));
    bridge.handle({
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "analyzing the problem",
        partial: {},
      },
    } as never);
    expect(events).toContainEqual({ type: "thinking_delta", delta: "analyzing the problem" });
  });
});
