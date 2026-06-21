// src/core/event-bridge.ts
//
// 事件翻译层 + 累积器。把 Pi SDK 的 SdkEvent 流转换成 subagents 内部的
// AgentEvent 流，并累计 turn/toolCall/usage/lastError。
//
// 这是 session-factory / output-collector 共享的数据通路内核。
// 唯一依赖 types.ts（leaf）——可独立单测，无需 Pi SDK。
// 事件映射契约见 docs/extensions/subagents/session-runner.md §2。

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
 */
export function isSdkEvent(x: unknown): x is SdkEvent {
  if (typeof x !== "object" || x === null) return false;
  if (!("type" in x)) return false;
  return typeof (x as SdkEvent).type === "string";
}

// ============================================================
// EventBridge（SDK 事件 → AgentEvent + 累积器）
// ============================================================

/**
 * 把 SDK AgentSessionEvent 转换为 subagents AgentEvent，并累计 turn/toolCall/usage。
 *
 * bridge 累积器（turnCount/toolCalls/usage/lastError）供 collectResult 构造 AgentResult；
 * 转发的 AgentEvent 供 updateFromEvent 更新 record——两套数据同源（handle 驱动）。
 * 事件映射表见 docs/extensions/subagents/session-runner.md §2。
 */
export interface EventBridge {
  /** 传给 session.subscribe 的处理器。 */
  handle(raw: SdkEvent): void;
  /** 已完成 turn 数（turn_end 累积）。 */
  readonly turnCount: number;
  /** 累积的 tool 调用（tool_execution_end 累积）。 */
  readonly toolCalls: ToolCall[];
  /** 累积的 usage（所有 message_end 求和）。 */
  readonly usage: AgentUsage & { cost: number };
  /** 最后一次 message_end 的 stopReason=error/aborted 错误信息。 */
  readonly lastError: string | undefined;
}

/** 空累积器的统一初值。 */
function zeroUsage(): AgentUsage & { cost: number } {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/** 创建 EventBridge 实例。onEvent 是调用方的 updateFromEvent wrapper。 */
export function createEventBridge(onEvent: (event: AgentEvent) => void): EventBridge {
  let turnCount = 0;
  const toolCalls: ToolCall[] = [];
  let usage = zeroUsage();
  let lastError: string | undefined;
  // toolCallId → {toolName, args}：tool_end 取回 args（SDK end 不一定带）
  const pendingTools = new Map<string, { toolName: string; args?: unknown }>();

  // ── message_end 的 usage 累积 + error 判定 ──
  // 独立函数：降低 handle 的圈复杂度，并集中保护「usage 与 error 不互斥」契约。
  // LLM provider 常在错误响应里也携带 usage（计费需如此）。必须先累积 usage，
  // 再独立判断 error/aborted，否则携带 usage 的错误响应会跳过 lastError 设置，
  // 导致 session-runner 把 errored session 误判为 success=true。[HISTORICAL]
  const accumulateMessageEnd = (raw: SdkEvent): void => {
    const msg = raw.message;
    if (msg?.usage) {
      const u = msg.usage;
      usage = {
        input: usage.input + (u.input ?? 0),
        output: usage.output + (u.output ?? 0),
        cacheRead: usage.cacheRead + (u.cacheRead ?? 0),
        cacheWrite: usage.cacheWrite + (u.cacheWrite ?? 0),
        cost: usage.cost + (u.cost?.total ?? 0),
      };
      onEvent({ type: "message_end", usage: u });
    }
    // error/aborted：lastError 记录，转发 error 事件（与上面的 usage 累积独立）
    const stopReason = msg?.stopReason;
    if (stopReason === "error" || stopReason === "aborted") {
      const errMsg = msg?.errorMessage ?? raw.reason ?? stopReason;
      lastError = errMsg;
      onEvent({ type: "error", message: errMsg });
    }
  };

  const handle = (raw: SdkEvent): void => {
    switch (raw.type) {
      // ── tool ──────────────────────────────────────────
      case "tool_execution_start": {
        const toolName = raw.toolName ?? "";
        if (raw.toolCallId) {
          pendingTools.set(raw.toolCallId, { toolName, args: raw.args });
        }
        onEvent({ type: "tool_start", toolName, args: raw.args });
        return;
      }
      case "tool_execution_end": {
        const toolName = raw.toolName ?? "";
        // args 优先取本事件的；缺失则从 pendingTools 回填（见 §2 易错点②）
        let args = raw.args;
        if (raw.toolCallId) {
          const pending = pendingTools.get(raw.toolCallId);
          if (pending) {
            if (args === undefined) args = pending.args;
            pendingTools.delete(raw.toolCallId);
          }
        }
        toolCalls.push({
          toolName,
          args,
          result: raw.result,
          isError: raw.isError,
        });
        onEvent({
          type: "tool_end",
          toolName,
          args,
          isError: raw.isError,
        });
        return;
      }

      // ── message 流（thinking 必须在 text 之前判断，见 §2 易错点①）──
      case "message_update": {
        const ame = raw.assistantMessageEvent;
        if (ame?.type === "thinking_delta") {
          onEvent({ type: "thinking_delta", delta: ame.delta ?? "" });
        } else if (ame?.delta !== undefined) {
          onEvent({ type: "text_delta", delta: ame.delta });
        }
        return;
      }

      // ── turn / message 终态 ──────────────────────────
      case "turn_end": {
        turnCount += 1;
        onEvent({ type: "turn_end" });
        return;
      }
      case "message_end": {
        accumulateMessageEnd(raw);
        return;
      }

      // ── compaction ──────────────────────────────────
      case "compaction_start": {
        onEvent({ type: "compaction" });
        return;
      }

      default:
        // agent_start / message_start 等其他事件丢弃（见 §2 映射表末行）
        return;
    }
  };

  return {
    handle,
    get turnCount(): number {
      return turnCount;
    },
    get toolCalls(): ToolCall[] {
      return toolCalls;
    },
    get usage(): AgentUsage & { cost: number } {
      return usage;
    },
    get lastError(): string | undefined {
      return lastError;
    },
  };
}
