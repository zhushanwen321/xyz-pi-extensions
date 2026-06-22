/**
 * Workflow Extension — commands（W4-T27，瘦身）
 *
 * 仅注册 /workflows 打开 WorkflowsView（FR-6）。
 *
 * 移除的旧子命令（FR-6）：
 *   - /workflow run <name>     → 用 workflow tool { action: "run" }
 *   - /workflow list           → 用 workflow tool { action: "status" }
 *   - /workflow abort <run-id> → 用 workflow tool { action: "abort" }
 *   - /workflow save <name>    → 用 workflow-script tool { action: "save" }
 *   - /workflow delete <name>  → 用 workflow-script tool { action: "delete" }
 *
 * 旧 sendCompletionNotification 移到 T23 helpers（notifyDone）。
 * 旧 /workflow 子命令在 commands.legacy.ts（W5 T29 删）。
 *
 * 层归属：Interface。依赖 Pi SDK。
 *
 * 注意：WorkflowsView 的 WorkflowRun 适配（T26）推迟到 W5 T31。
 * 此过渡期 /workflows 暂用 status 文本输出（view 适配后切回 createWorkflowsView）。
 *
 * 参考：
 *   - domain-models.md §FR-6（command 收口仅 /workflows）
 *   - 旧 interface/commands.ts registerWorkflowCommands（瘦身来源）
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import type { WorkflowRun } from "../engine/models/workflow-run.js";

/** runId 截断长度（显示用）。 */
const RUNID_SHORT = 8;

// ── /workflows command ───────────────────────────────────────

/**
 * 注册 /workflows command——列出当前 session 的 workflow runs。
 *
 * FR-6：仅保留 /workflows（移除 /workflow run|list|abort|save|delete 子命令，
 * 它们已收口到 workflow / workflow-script 两个 tool）。
 *
 * T26 WorkflowsView 适配推迟到 W5 T31。此过渡期 /workflows 输出 status 文本。
 *
 * @param api      ExtensionAPI
 * @param getRuns  获取当前 session 的 runs（Map<runId, WorkflowRun>）
 */
export function registerWorkflowsCommand(
  api: ExtensionAPI,
  getRuns: () => Map<string, WorkflowRun>,
): void {
  api.registerCommand("workflows", {
    description: "List workflow runs in current session (interactive panel coming in T31).",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const runs = Array.from(getRuns().values());
      if (runs.length === 0) {
        ctx.ui.notify("No workflows in current session.", "info");
        return;
      }
      const lines = runs.map((run) => {
        const reasonSuffix = run.state.reason ? ` (${run.state.reason})` : "";
        return `[${run.state.status}${reasonSuffix}] ${run.spec.scriptName} (${run.runId.slice(0, RUNID_SHORT)})`;
      });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
