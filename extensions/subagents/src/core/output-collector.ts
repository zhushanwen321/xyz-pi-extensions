// src/core/output-collector.ts
//
// 结果收集器（逆向：BuiltSession + CollectResultArgs → AgentResult）。
// 与 session-factory 对称：factory 造 bundle，collector 拆 bundle。
//
// 基础层模块：依赖 event-bridge（读累积器）+ session-factory（AgentSessionLike）+ types。
// 字段来源契约见 docs/subagents/session-runner.md §4。

import type { AgentResult, AgentUsage, AgentUsageTotal, ToolCall } from "../types.ts";
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
}

/** structured-output tool 名（与 structured-output 扩展 TOOL_NAME 一致，见 session-runner.ts）。 */
const STRUCTURED_OUTPUT_TOOL = "structured-output";

/**
 * 从 toolCalls 提取 structured-output 的 result.details（schema 模式产出）。
 * schema enforcement 保证 agent 调过该 tool（漏调会 steer 重试）；这里只做逆向提取。
 * 未调或无 details 返回 undefined。
 *
 * 导出以便直接单测（与 toUsageTotal/collectResponseText 一致，三者同属决定
 * AgentResult 字段来源的纯函数契约）。
 */
export function extractParsedOutput(toolCalls: ToolCall[]): unknown {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const tc = toolCalls[i]!;
    if (tc.toolName === STRUCTURED_OUTPUT_TOOL && tc.result?.details !== undefined) {
      return tc.result.details;
    }
  }
  return undefined;
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
  void bridge; // bridge 累积器已在调用方（run）经 toUsageTotal/slice 提取后传入 args
  return {
    text: collectResponseText(session.messages),
    turns: args.turns,
    durationMs: Date.now() - args.startTime,
    success: args.success,
    error: args.error,
    sessionId: args.sessionId,
    toolCalls: args.toolCalls,
    usage: args.usage,
    sessionFile: args.sessionFile,
    parsedOutput: extractParsedOutput(args.toolCalls),
  };
}

/** 从 session.messages 最后一条 assistant message 提取文本。 */
export function collectResponseText(
  messages: ReadonlyArray<{
    role: string;
    content?: ReadonlyArray<{ type: string; text?: string }>;
  }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const parts = msg.content ?? [];
    let text = "";
    for (const part of parts) {
      if (part.type === "text" && typeof part.text === "string") {
        text += part.text;
      }
    }
    return text;
  }
  return "";
}

// ============================================================
// Usage 纯 helper
// ============================================================

/**
 * AgentUsage & {cost} → AgentUsageTotal（全零则 undefined）。
 * 纯函数：run 在 collectResult 前用它规整 bridge.usage。
 */
export function toUsageTotal(
  usage: AgentUsage & { cost: number },
): AgentUsageTotal | undefined {
  const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  if (total === 0 && usage.cost === 0) return undefined;
  return { ...usage, total };
}
