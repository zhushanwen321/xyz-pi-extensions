// src/core/output-collector.ts
//
// 结果收集器（逆向：BuiltSession + CollectResultArgs → AgentResult）。
// 与 session-factory 对称：factory 造 bundle，collector 拆 bundle。
//
// 基础层模块：依赖 event-bridge（读累积器）+ session-factory（AgentSessionLike）+ types。
// 字段来源契约见 docs/subagents/session-runner.md §4。

import type { AgentResult, AgentUsage, AgentUsageTotal, ToolCall, WorktreeOutcome } from "../types.ts";
import type { EventBridge } from "./event-bridge.ts";
import type { AgentSessionLike } from "./session-factory.ts";

// ============================================================
// Result 收集
// ============================================================

/** collectResult 的入参（字段来源明确，避免多处拼装）。 */
export interface CollectResultArgs {
  startTime: number;
  success: boolean;
  error: string | undefined;
  sessionId: string;
  sessionFile: string | undefined;
  turns: number;
  usage: AgentUsageTotal | undefined;
  toolCalls: ToolCall[];
  worktree?: WorktreeOutcome;
}

/**
 * 从 session + bridge 组装 AgentResult。每个字段来源单一：
 *   text ← session.messages 最后一条 assistant message 的 text 部分（倒序找）
 *   turns ← bridge.turnCount
 *   usage ← bridge.usage（全零则 undefined）
 *   toolCalls ← bridge.toolCalls
 *   parsedOutput ← toolCalls 找 toolName==="structured-output" 的 result.details
 *
 * success 双来源判定：
 *   ① session.prompt() 抛错 → args.success=false
 *   ② prompt 成功但 bridge.lastError 非空（message_end stopReason=error）→ success=false
 */
export function collectResult(
  session: AgentSessionLike,
  bridge: EventBridge,
  args: CollectResultArgs,
): AgentResult {
  //  1. text = collectResponseText(session.messages)
  //  2. parsedOutput = toolCalls 找 structured-output 的 result.details
  //  3. 组装 AgentResult（durationMs = Date.now() - args.startTime）
  void session; void bridge; void args;
  throw new Error("not implemented");
}

/** 从 session.messages 最后一条 assistant message 提取文本。 */
export function collectResponseText(
  messages: ReadonlyArray<{
    role: string;
    content?: ReadonlyArray<{ type: string; text?: string }>;
  }>,
): string {
  //  倒序找 role==="assistant" 的 message，拼接 content 中 type==="text" 的 text
  void messages;
  throw new Error("not implemented");
}

// ============================================================
// Usage 纯 helper
// ============================================================

/**
 * AgentUsage & {cost} → AgentUsageTotal（全零则 undefined）。
 * 纯函数：run/managed-session 在 collectResult 前用它规整 bridge.usage。
 */
export function toUsageTotal(
  usage: AgentUsage & { cost: number },
): AgentUsageTotal | undefined {
  //  total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  //  total === 0 → undefined : { ...usage, total }
  void usage;
  throw new Error("not implemented");
}
