// src/core/event-bridge.ts
//
// 事件翻译层 + 累积器。把 Pi SDK 的 SdkEvent 流转换成 subagents 内部的
// AgentEvent 流，并累计 turn/toolCall/usage/lastError。
//
// 这是 session-factory / output-collector / managed-session 共享的数据通路内核。
// 唯一依赖 types.ts（leaf）——可独立单测，无需 Pi SDK。
// 事件映射契约见 docs/subagents/session-runner.md §2。

import type {
  AgentEvent,
  AgentUsage,
  ToolCall,
  ToolCallResult,
} from "../types.ts";

// ============================================================
// SDK 事件 duck-type（订阅入口的最小可用子集）
// ============================================================

/** SDK AgentSessionEvent 的最小可用子集（duck-typed，避免强耦合 SDK 类型）。 */
export type SdkEvent = {
  type: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: ToolCallResult;
  isError?: boolean;
  message?: {
    usage?: AgentUsage & { cost?: { total: number } };
    stopReason?: string;
    errorMessage?: string;
  };
  assistantMessageEvent?: { type?: string; delta?: string };
  reason?: string;
};

/**
 * 运行时 guard：subscribe 回调收到的 event 形状未知，校验 type 字段后再交给 handle。
 * 防止 SDK 事件结构变化时 switch(raw.type) 静默失配（全走 default 不报错）。
 *
 *   ╔══════════════════════════════════════════════════════════════╗
 *   ║  typeof x === "object" && x !== null                          ║
 *   ║    && typeof (x as { type?: unknown }).type === "string"      ║
 *   ╚══════════════════════════════════════════════════════════════╝
 */
export function isSdkEvent(x: unknown): x is SdkEvent {
  void x;
  throw new Error("not implemented");
}

// ============================================================
// EventBridge（SDK 事件 → AgentEvent + 累积器）
// ============================================================

/**
 * 把 SDK AgentSessionEvent 转换为 subagents AgentEvent，并累计 turn/toolCall/usage。
 *
 *   ╔════════════════════════════════════════════════════════════════════╗
//   ║  事件映射（详见 docs/subagents/session-runner.md §2）：              ║
//   ║    tool_execution_start  → {tool_start, toolName, args}            ║
//   ║      └─ pendingTools.set(id, {toolName, args})                     ║
//   ║    tool_execution_end    → {tool_end, toolName, args, result, isError} ║
//   ║      └─ toolCalls.push + pendingTools.delete                       ║
//   ║    message_update(thinking_delta) → {thinking_delta, delta}        ║
//   ║      ⚠ 必须在 text_delta 之前判断（两者都带 delta 字段）           ║
//   ║    message_update(text)  → {text_delta, delta}                     ║
//   ║    turn_end              → {turn_end}  + turnCount++               ║
//   ║    message_end(usage)    → {message_end, usage} + usageAccum +=    ║
//   ║    message_end(error)    → {error, error} + lastError = msg        ║
//   ║    compaction_start      → {compaction}                            ║
//   ║    其他                  → 丢弃                                    ║
//   ╚════════════════════════════════════════════════════════════════════╝
 *
 * bridge 累积器（turnCount/toolCalls/usage/lastError）供 collectResult 构造 AgentResult；
 * 转发的 AgentEvent 供 updateFromEvent 更新 record——两套数据同源（handle 驱动）。
 */
export interface EventBridge {
  /** 传给 session.subscribe 的处理器。 */
  handle(raw: SdkEvent): void;
  /** 重置所有跨 prompt 累积状态（ManagedSession 每轮 prompt 前调）。 */
  resetForPrompt(): void;
  /** 已完成 turn 数（turn_end 累积）。 */
  readonly turnCount: number;
  /** 累积的 tool 调用（tool_execution_end 累积）。 */
  readonly toolCalls: ToolCall[];
  /** 累积的 usage（所有 message_end 求和）。 */
  readonly usage: AgentUsage & { cost: number };
  /** 最后一次 message_end 的 stopReason=error/aborted 错误信息。 */
  readonly lastError: string | undefined;
}

/** 创建 EventBridge 实例。onEvent 是调用方的 updateFromEvent wrapper。 */
export function createEventBridge(onEvent: (event: AgentEvent) => void): EventBridge {
  //  1. 初始化累积器：turnCount=0, toolCalls=[], usageAccum={0...}, lastError=undefined
  //  2. pendingTools = new Map<toolCallId, {toolName, args}>()
  //  3. handle(raw): switch(raw.type) 按映射表转换（thinking_delta 在 text_delta 之前）
  //  4. resetForPrompt(): 清零所有累积器（ManagedSession 跨轮复用 bridge 时调）
  void onEvent;
  throw new Error("not implemented");
}
