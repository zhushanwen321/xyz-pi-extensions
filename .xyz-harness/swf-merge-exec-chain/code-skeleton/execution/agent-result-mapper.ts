// code-skeleton/execution/agent-result-mapper.ts
//
// 【新模块骨架】合并到 extensions/subagents-workflow/src/execution/agent-result-mapper.ts
//
// 接线层级：[模块内直调] —— 纯 DTO 映射（D-A10）。叶子映射函数，映射体可写。
//
// 设计基线：D-A10/D-007 —— executeAndAwait 返回 workflow 侧 AgentResult（content 字段），
//   内部从 subagents 形状（text/success）转换。workflow 下游消费者零改动
//   （worker-script-builder.ts:120 parsedOutput ?? content）。

import type { AgentResult as WorkflowAgentResult, AgentUsage as WorkflowAgentUsage, ToolCallEntry } from "../orchestration/models/types.ts";
import type { AgentResult as SubagentsAgentResult, AgentUsageTotal, ToolCall } from "../types.ts";

/**
 * D-A10: subagents AgentResult → workflow AgentResult 映射。
 *
 * 字段映射表：
 *   subagents                         → workflow
 *   ─────────────────────────────────────────────
 *   text                              → content
 *   parsedOutput                      → parsedOutput（structured-output 契约，BC-8）
 *   !success && error                 → error（失败时填，成功时 undefined）
 *   durationMs                        → durationMs
 *   sessionId                         → sessionId
 *   usage (AgentUsageTotal)           → usage (AgentUsage: input/output/cacheRead/cacheWrite/cost/contextTokens/turns)
 *   toolCalls (ToolCall[])            → toolCalls (ToolCallEntry[]: name/input)
 *
 * @param r subagents 管道产出的 AgentResult（runSpawn/collectResult 出口形状）
 * @returns workflow 编排层消费的 AgentResult（executeAgentCall/finalizeCall 入参形状）
 */
export function mapToWorkflowAgentResult(
  r: SubagentsAgentResult,
): WorkflowAgentResult {
  return {
    // text → content（核心字段映射，D-007）
    content: r.text,
    // parsedOutput 透传（structured-output tool 的 result.details，schema 校验后的数据对象）
    parsedOutput: r.parsedOutput,
    // 失败映射：success=false 且有 error → error 字段；成功或无 error → undefined
    error: r.success ? undefined : r.error,
    durationMs: r.durationMs,
    sessionId: r.sessionId,
    // usage 映射：AgentUsageTotal → AgentUsage（字段形状转换）
    usage: r.usage ? mapUsage(r.usage, r.turns) : undefined,
    // toolCalls 映射：ToolCall → ToolCallEntry（name/input 形状）
    toolCalls: r.toolCalls ? mapToolCalls(r.toolCalls) : undefined,
  };
}

/**
 * AgentUsageTotal（subagents）→ AgentUsage（workflow）映射。
 *
 * subagents AgentUsageTotal: { input, output, cacheRead, cacheWrite, total, cost }
 * workflow AgentUsage:       { input, output, cacheRead, cacheWrite, cost, contextTokens, turns }
 *
 * contextTokens ≈ total（subagents 的四项之和，近似上下文 token 量）。
 * turns 来自 AgentResult.turns（非 usage 内字段）。
 */
function mapUsage(u: AgentUsageTotal, turns: number): WorkflowAgentUsage {
  return {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    cost: u.cost,
    // contextTokens 用 total（AgentUsageTotal 已聚合四项 input+output+cacheRead+cacheWrite）
    contextTokens: u.total,
    turns,
  };
}

/**
 * ToolCall（subagents）→ ToolCallEntry（workflow）映射。
 *
 * subagents ToolCall:     { toolName, args?, result?, isError? }
 * workflow ToolCallEntry: { name, input }
 */
function mapToolCalls(calls: ToolCall[]): ToolCallEntry[] {
  return calls.map((c) => ({
    name: c.toolName,
    // input 是 args 的字符串预览（与旧 SAR pipeline.toolCalls 格式对齐——JSON.stringify）
    input: c.args === undefined ? "" : safeStringify(c.args),
  }));
}

/** 安全序列化（args 可能含循环引用或大对象，截断防 OOM）。叶子实现。 */
function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    // 截断长 args（与旧 pipeline 行为对齐，防 trace 膨胀）
    return s.length > 500 ? `${s.slice(0, 500)}...` : s;
  } catch {
    return String(value);
  }
}
