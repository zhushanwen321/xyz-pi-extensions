/**
 * Workflow Extension — Interface helpers
 *
 * notifyDone(pi, runId, run, notified) — run 完成时发 completion notification。
 *
 * 层归属：Interface（依赖 Pi SDK + Engine WorkflowRun 模型）。
 *
 * 参考：domain-models.md §D-12。
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { WorkflowRun } from "../orchestration/models/workflow-run.ts";
import {
  guiComponent,
  type GuiContext,
  guiResult,
  isGuiCapable,
} from "./gui-adapter.ts";

// ── 常量 ─────────────────────────────────────────────────────

const JSON_INDENT = 2;
const MAX_RESULT_LENGTH = 8000;

/**
 * workflow 到达 done 终态时发送完成通知。
 *
 * 通过 pi.sendMessage 注入结果消息（含 __gui__ 结构化渲染数据），
 * triggerTurn:true 唤醒 parent agent 处理结果。
 *
 * **去重**：notifiedRunIds Set 由调用方（factory/extension instance）持有，
 * 同一 runId 只通知一次（跨 session_shutdown 等边界防重复）。
 *
 * @param pi ExtensionAPI（调 sendMessage）
 * @param runId run 标识
 * @param run WorkflowRun 聚合根（读 spec.scriptName + state.status + trace + scriptResult）
 * @param notifiedRunIds 去重 Set（调用方持有，scope 到 factory 实例）
 */
export function notifyDone(
  pi: ExtensionAPI,
  runId: string,
  run: WorkflowRun,
  notifiedRunIds: Set<string>,
  ctx?: GuiContext,
): void {
  if (notifiedRunIds.has(runId)) return;
  notifiedRunIds.add(runId);

  const traceNodes = run.state.trace.toArray();
  const name = run.spec.scriptName;
  const status = `${run.state.status}${run.state.reason ? ` (${run.state.reason})` : ""}`;

 // 构建消息内容
  const parts: string[] = [];
  parts.push(`Workflow '${name}' done: ${status}`);

  if (run.state.scriptResult !== undefined && run.state.scriptResult !== null) {
    const serialized = JSON.stringify(run.state.scriptResult, null, JSON_INDENT);
    const truncated =
      serialized.length > MAX_RESULT_LENGTH
        ? serialized.slice(0, MAX_RESULT_LENGTH) + "\n... (truncated)"
        : serialized;
    parts.push("");
    parts.push("--- Script Result ---");
    parts.push(truncated);
  }

  parts.push("");
  parts.push("--- Agent Trace ---");
  for (const node of traceNodes) {
    parts.push(`[${node.stepIndex}] ${node.agent}: ${node.status}`);
  }

  const content = parts.join("\n");

 // deliverAs:"steer" + triggerTurn:true —— workflow 完成作为 steering 消息注入
 // 并立即唤醒 parent agent 处理结果（与 subagent 的 followUp+triggerTurn 对称）
  const details: Record<string, unknown> = {
    runId,
    name,
    status: run.state.status,
    reason: run.state.reason,
    traceLength: traceNodes.length,
  };

  // GUI 协议：RPC 模式下附加结构化渲染数据
  if (ctx && isGuiCapable(ctx)) {
    details.__gui__ = guiResult(
      guiComponent("workflow-runs", {
        runs: [{
          runId,
          name,
          status: run.state.status,
          reason: run.state.reason,
        }],
      }),
    );
  }

  pi.sendMessage(
    {
      customType: "workflow-result",
      content,
      display: true,
      details,
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}
