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
  assistantMessageEvent?: { type?: string; delta?: string; textDelta?: string };
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
  // 记录正在进行的 tool（toolCallId → { toolName, args }），用于 end 时补全
  const pendingTools = new Map<string, { toolName: string; args?: unknown }>();

  function handle(raw: SdkEvent): void {
    switch (raw.type) {
      case "tool_execution_start": {
        const toolName = raw.toolName ?? "unknown";
        // FR-1.1a: 透传 args（SDK 原始事件携带 raw.args）
        const args = (raw as { args?: unknown }).args;
        if (raw.toolCallId) pendingTools.set(raw.toolCallId, { toolName, args });
        onEvent({ type: "tool_start", toolName, args });
        break;
      }
      case "tool_execution_end": {
        const pending = raw.toolCallId ? pendingTools.get(raw.toolCallId) : undefined;
        const toolName = raw.toolName ?? pending?.toolName ?? "unknown";
        const args = pending?.args;
        const result = raw.result as ToolCallEntry["result"] | undefined;
        const isError = raw.isError ?? false;
        toolCalls.push({ toolName, args, result, isError });
        onEvent({ type: "tool_end", toolName, result, isError });
        // 清理 pendingTools：tool 完成后从进行中集合移除，防止跨 prompt 累积脏数据
        if (raw.toolCallId) pendingTools.delete(raw.toolCallId);
        break;
      }
      case "message_update": {
        const ame = raw.assistantMessageEvent;
        // FR-1.1a: thinking_delta —— SDK 独立事件类型（pi-ai types.d.ts:209），
        // 必须在提取 text_delta 之前判断：thinking_delta 的 delta 字段也带内容，
        // 若先无条件提取 ame.delta 会把 thinking 内容误当成 text。
        if (ame?.type === "thinking_delta" && typeof ame.delta === "string") {
          onEvent({ type: "thinking_delta", delta: ame.delta });
          break;
        }
        // text_delta：从 AssistantMessageEvent.delta 提取
        const delta = ame?.delta;
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

  /**
   * 重置所有跨 prompt 累积的状态。ManagedSession 在每次 prompt() 调用 sess.prompt 之前
   * 调用此方法，确保 turn 限制、错误判定、usage 统计都基于当前 prompt 的相对计数，
   * 而不是从历史 prompt 残留的累计值。
   *
   * 不重置会导致：
   *   - 第二次 prompt 的 turn limit 从上次累计值开始计算（错误触发 soft limit/abort）
   *   - 上次 prompt 的 lastError 永久残留（后续 prompt 即使成功也返回失败）
   *   - toolCalls / usage 跨 prompt 累加（污染 AgentResult）
   */
  function resetForPrompt(): void {
    turnCount = 0;
    toolCalls.length = 0;
    usageAccum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    lastError = undefined;
    pendingTools.clear();
  }

  return {
    handle,
    resetForPrompt,
    get turnCount() { return turnCount; },
    get toolCalls() { return toolCalls; },
    get usage() { return usageAccum; },
    get lastError() { return lastError; },
  };
}
