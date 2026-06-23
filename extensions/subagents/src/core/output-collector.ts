// src/core/output-collector.ts
//
// 结果收集器（Record + CollectResultArgs → AgentResult）。
//
// 收口设计（2026-06-22）：collectResult 全部从 record 读——
//   text ← getFullText(record)（聚合 turns[].text，不再读 session.messages）
//   turns ← record.turnCount
//   toolCalls ← getAllToolCalls(record)（扁平化 turns[].toolCalls）
//   usage ← getTotalUsage(record)（聚合 turns[].usageDelta）
//
// 基础层模块：依赖 execution-record（派生函数）+ types。

import type {
  AgentResult,
  ExecutionRecord,
  ToolCall,
} from "../types.ts";
import {
  getAllToolCalls,
  getFullText,
  getTotalUsage,
} from "./execution-record.ts";

// ============================================================
// Result 收集
// ============================================================

/** collectResult 的入参（session 身份 + 执行控制字段，执行内容从 record 读）。 */
export interface CollectResultArgs {
  startTime: number;
  success: boolean;
  error: string | undefined;
  sessionId: string;
  sessionFile: string | undefined;
}

/** structured-output tool 名（与 structured-output 扩展 TOOL_NAME 一致，见 session-runner.ts）。 */
const STRUCTURED_OUTPUT_TOOL = "structured-output";

/**
 * 从 toolCalls 提取 structured-output 的 result.details（schema 模式产出）。
 * schema enforcement 保证 agent 调过该 tool（漏调会 steer 重试）；这里只做逆向提取。
 * 未调或无 details 返回 undefined。
 *
 * 导出以便直接单测（纯函数契约）。
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
 * 从 record + args 组装 AgentResult。每个字段来源单一且收口于 record：
 *   text      ← getFullText(record)（聚合 turns[].text，单一数据源）
 *   turns     ← record.turnCount
 *   toolCalls ← getAllToolCalls(record)（扁平化 turns[].toolCalls）
 *   usage     ← getTotalUsage(record)（聚合 turns[].usageDelta，全零则 undefined）
 *   parsedOutput ← extractParsedOutput(toolCalls)
 *
 * startTime 算 durationMs。
 *
 * success 双来源判定（调用方传入）：
 *   ① session.prompt() 抛错 → args.success=false
 *   ② prompt 成功但 record.lastError 非空（message_end stopReason=error）→ success=false
 */
export function collectResult(
  record: ExecutionRecord,
  args: CollectResultArgs,
): AgentResult {
  const toolCalls = getAllToolCalls(record);
  return {
    text: getFullText(record),
    turns: record.turnCount,
    durationMs: Date.now() - args.startTime,
    success: args.success,
    error: args.error,
    sessionId: args.sessionId,
    toolCalls,
    usage: getTotalUsage(record),
    sessionFile: args.sessionFile,
    parsedOutput: extractParsedOutput(toolCalls),
  };
}
