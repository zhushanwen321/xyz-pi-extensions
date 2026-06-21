// src/__tests__/event-bridge.test.ts
import { describe, expect, it } from "vitest";

import { createEventBridge, isSdkEvent } from "../core/event-bridge.ts";
import type { SdkEvent } from "../core/event-bridge.ts";

/** 收集 onEvent 回调的 AgentEvent 序列。 */
function collect() {
  const events: unknown[] = [];
  const bridge = createEventBridge((e) => events.push(e));
  return { bridge, events };
}

describe("isSdkEvent", () => {
  it("accepts object with string type", () => {
    expect(isSdkEvent({ type: "message_end" })).toBe(true);
  });
  it("rejects non-object / missing type / wrong type", () => {
    expect(isSdkEvent(null)).toBe(false);
    expect(isSdkEvent("message_end")).toBe(false);
    expect(isSdkEvent({ type: 42 })).toBe(false);
    expect(isSdkEvent({})).toBe(false);
  });
});

describe("createEventBridge — tool mapping", () => {
  it("forwards tool_start / tool_end and accumulates toolCalls", () => {
    const { bridge, events } = collect();
    bridge.handle({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { cmd: "ls" } });
    bridge.handle({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "ok" }] },
      isError: false,
    });
    expect(bridge.toolCalls).toHaveLength(1);
    expect(bridge.toolCalls[0]).toMatchObject({ toolName: "bash", isError: false });
    // args 回填：end 未带 args 时从 pendingTools 取
    expect(bridge.toolCalls[0].args).toEqual({ cmd: "ls" });
    expect(events).toEqual([
      { type: "tool_start", toolName: "bash", args: { cmd: "ls" } },
      { type: "tool_end", toolName: "bash", args: { cmd: "ls" }, isError: false },
    ]);
  });

  it("prefers end-side args over pendingTools backfill", () => {
    const { bridge } = collect();
    bridge.handle({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { cmd: "old" } });
    bridge.handle({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", args: { cmd: "new" } });
    expect(bridge.toolCalls[0].args).toEqual({ cmd: "new" });
  });
});

describe("createEventBridge — message_update delta routing", () => {
  it("thinking_delta routes before text_delta", () => {
    const { bridge, events } = collect();
    bridge.handle({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "th" } });
    bridge.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "tx" } });
    bridge.handle({ type: "message_update", assistantMessageEvent: { delta: "raw" } });
    expect(events).toEqual([
      { type: "thinking_delta", delta: "th" },
      { type: "text_delta", delta: "tx" },
      { type: "text_delta", delta: "raw" },
    ]);
  });
});

describe("createEventBridge — turn/usage accumulation", () => {
  it("counts turns and sums usage across message_end", () => {
    const { bridge, events } = collect();
    bridge.handle({ type: "turn_end" });
    bridge.handle({ type: "turn_end" });
    bridge.handle({
      type: "message_end",
      message: { usage: { input: 10, output: 5, cost: { total: 0.01 } } },
    });
    bridge.handle({
      type: "message_end",
      message: { usage: { input: 20, output: 3, cacheRead: 7, cost: { total: 0.02 } } },
    });
    expect(bridge.turnCount).toBe(2);
    expect(bridge.usage).toEqual({ input: 30, output: 8, cacheRead: 7, cacheWrite: 0, cost: 0.03 });
    // message_end 转发携带本次 usage（非累加值）
    expect(events.filter((e) => (e as { type: string }).type === "message_end")).toHaveLength(2);
  });
});

describe("createEventBridge — MF1: usage + error are NOT mutually exclusive", () => {
  // [HISTORICAL] 旧实现 usage 分支命中后 return，跳过 error 检查 →
  // 携带 usage 的错误响应漏记 lastError → session-runner 误判 success=true。
  it("records lastError when message_end carries BOTH usage and stopReason=error", () => {
    const { bridge, events } = collect();
    bridge.handle({
      type: "message_end",
      message: {
        usage: { input: 100, output: 2, cost: { total: 0.05 } },
        stopReason: "error",
        errorMessage: "provider 500",
      },
    });
    // 两件事都必须发生：usage 被累加 AND lastError 被记录
    expect(bridge.usage.input).toBe(100);
    expect(bridge.usage.cost).toBe(0.05);
    expect(bridge.lastError).toBe("provider 500");
    expect(events).toContainEqual({ type: "message_end", usage: { input: 100, output: 2, cost: { total: 0.05 } } });
    expect(events).toContainEqual({ type: "error", message: "provider 500" });
  });

  it("records lastError with stopReason fallback when errorMessage missing", () => {
    const { bridge } = collect();
    bridge.handle({
      type: "message_end",
      message: { usage: { input: 1, output: 1 }, stopReason: "aborted" },
    });
    expect(bridge.lastError).toBe("aborted");
    expect(bridge.usage.input).toBe(1);
  });

  it("does not set lastError on clean completion with usage", () => {
    const { bridge } = collect();
    bridge.handle({
      type: "message_end",
      message: { usage: { input: 10, output: 5 }, stopReason: "end_turn" },
    });
    expect(bridge.lastError).toBeUndefined();
    expect(bridge.usage.input).toBe(10);
  });
});

describe("createEventBridge — unknown events ignored", () => {
  it("drops agent_start / message_start via default branch", () => {
    const { bridge, events } = collect();
    bridge.handle({ type: "agent_start" } as SdkEvent);
    bridge.handle({ type: "message_start" } as SdkEvent);
    bridge.handle({ type: "some_unknown_future_event" } as SdkEvent);
    expect(events).toEqual([]);
    expect(bridge.turnCount).toBe(0);
  });
});
