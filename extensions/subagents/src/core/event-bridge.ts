// src/core/event-bridge.ts
import type { AgentEvent, ToolCallEntry } from "../types.ts";

/** SDK AgentSessionEvent 的最小可用子集（结构 duck-typed，避免强耦合 SDK 类型） */
type SdkEvent = {
  type: string;
  toolCallId?: string;
  toolName?: string;
  result?: { content: unknown[]; details?: unknown };
  isError?: boolean;
  message?: {
    usage?: {
      input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
      cost?: { total: number };
    };
    stopReason?: string;
    errorMessage?: string;
  };
  assistantMessageEvent?: { delta?: string; textDelta?: string };
  reason?: string;
};

/**
 * FR-8: 把 SDK AgentSessionEvent 转换为 subagents AgentEvent，并累计 turn/toolCall。
 * 返回的对象含 handle()（传给 session.subscribe）和只读累计器。
 */
export function createEventBridge(onEvent: (event: AgentEvent) => void) {
  let turnCount = 0;
  const toolCalls: ToolCallEntry[] = [];
  // FR-8.3: usage 累加器——累加所有 message_end 事件的 usage
  let usageAccum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  // I2: 记录 message_end 中 stopReason=error/aborted 的错误信息（供 runAgent 读取）
  let lastError: string | undefined;
  // 记录正在进行的 tool 名（toolCallId → toolName），用于 end 时补全
  const pendingTools = new Map<string, string>();

  function handle(raw: SdkEvent): void {
    switch (raw.type) {
      case "tool_execution_start": {
        const toolName = raw.toolName ?? "unknown";
        if (raw.toolCallId) pendingTools.set(raw.toolCallId, toolName);
        // FR-1.1a: 透传 args（SDK 原始事件携带 raw.args）
        const args = (raw as { args?: unknown }).args;
        onEvent({ type: "tool_start", toolName, args });
        break;
      }
      case "tool_execution_end": {
        const toolName = raw.toolName ?? pendingTools.get(raw.toolCallId ?? "") ?? "unknown";
        const result = raw.result as ToolCallEntry["result"] | undefined;
        const isError = raw.isError ?? false;
        toolCalls.push({ toolName, result, isError });
        onEvent({ type: "tool_end", toolName, result, isError });
        break;
      }
      case "message_update": {
        // SDK 无独立 text_delta 事件，从 assistantMessageEvent.delta 提取增量文本
        const delta = raw.assistantMessageEvent?.delta;
        if (delta) onEvent({ type: "text_delta", delta });
        break;
      }
      case "turn_end": {
        turnCount++;
        onEvent({ type: "turn_end" });
        break;
      }
      case "message_end": {
        const msg = raw.message;
        if (msg) {
          // 优先检查错误 stopReason
          if (msg.stopReason === "error" || msg.stopReason === "aborted") {
            lastError = msg.errorMessage ?? msg.stopReason;
            onEvent({ type: "error", error: lastError });
          }
          // usage 提取 + 累加（FR-8.3: 一次 run 可能有多个 message_end）
          if (msg.usage) {
            const u = msg.usage;
            usageAccum = {
              input: usageAccum.input + u.input,
              output: usageAccum.output + u.output,
              cacheRead: usageAccum.cacheRead + u.cacheRead,
              cacheWrite: usageAccum.cacheWrite + u.cacheWrite,
              cost: usageAccum.cost + (u.cost?.total ?? 0),
            };
            onEvent({
              type: "message_end",
              usage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost?.total ?? 0 },
            });
          }
        }
        break;
      }
      case "compaction_start": {
        onEvent({ type: "compaction" });
        break;
      }
      // agent_start / agent_end / message_start / tool_execution_update / queue_update 等：忽略
    }
  }

  return {
    handle,
    get turnCount() { return turnCount; },
    get toolCalls() { return toolCalls; },
    get usage() { return usageAccum; },
    get lastError() { return lastError; },
  };
}
