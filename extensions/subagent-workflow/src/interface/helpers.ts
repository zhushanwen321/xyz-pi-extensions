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
  type GuiRenderResult,
  guiResult,
  isGuiCapable,
} from "@xyz-agent/extension-protocol";
import { mapRunIcon, mapRunStatus } from "./gui-mappers.ts";

// ── 常量 ─────────────────────────────────────────────────────

const JSON_INDENT = 2;
const MAX_RESULT_LENGTH = 8000;

/** runId 前 8 字符用于显示（与 buildWorkflowGui 的 label 格式一致）。 */
const RUN_ID_DISPLAY_LENGTH = 8;

/**
 * notifyDone 的 details 结构（通过 pi.sendMessage 透传给前端）。
 *
 * 抽取为显式接口替代裸 Record<string, unknown>，明确 __gui__ 契约，
 * 便于其他 notify 路径复用（S#7）。
 */
export interface WorkflowNotifyDetails {
  runId: string;
  name: string;
  status: string;
  reason: string | undefined;
  traceLength: number;
  __gui__?: GuiRenderResult;
}

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

 // 终止性原因（非正常完成）追加防偷懒收尾指令——budget/time 耗尽或 abort 不是任务完成，
 // 模型可能把 "done" 当成功汇报（F3 偷懒完成）。收尾三步骤与 turn-limiter WRAP_UP_MESSAGE 对齐。
  const TERMINAL_REASONS = new Set(["budget_limited", "time_limited", "aborted", "failed", "circular"]);
  if (run.state.reason && TERMINAL_REASONS.has(run.state.reason)) {
    parts.push("");
    parts.push(
      "This is NOT task completion. Summarize what was DONE and VERIFIED, list what remains " +
      "NOT DONE, and give the user the single most important next step.",
    );
  }

  if (run.state.scriptResult !== undefined && run.state.scriptResult !== null) {
    // M10: scriptResult 来自 worker 脚本返回值（用户可控），可能含循环引用导致 JSON.stringify 抛 TypeError
    let serialized: string;
    try {
      serialized = JSON.stringify(run.state.scriptResult, null, JSON_INDENT);
    } catch {
      serialized = String(run.state.scriptResult);
    }
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
  const details: WorkflowNotifyDetails = {
    runId,
    name,
    status: run.state.status,
    reason: run.state.reason,
    traceLength: traceNodes.length,
  };

  // GUI 协议：RPC 模式下附加结构化渲染数据
  if (ctx && isGuiCapable(ctx)) {
    const reason = run.state.reason;
    const statusStr = `${run.state.status}${reason ? ` (${reason})` : ""}`;
    // label 对齐 buildWorkflowGui 的格式：name + slug + runId 前 8 字符（I#3）
    const slug = run.spec.slug;
    const label = [name, slug, runId.slice(0, RUN_ID_DISPLAY_LENGTH)]
      .filter(Boolean)
      .join(" ");
    details.__gui__ = guiResult(
      guiComponent("list-tree", {
        items: [{
          label,
          status: mapRunStatus(statusStr),
          icon: mapRunIcon(statusStr),
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
