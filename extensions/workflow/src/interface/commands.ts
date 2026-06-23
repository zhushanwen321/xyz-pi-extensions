/**
 * Workflow Extension — commands
 *
 * 仅注册 /workflows 命令（FR-6）——打开交互式 TUI 面板（WorkflowsView，三级导航
 * phase → agent → detail，UC-3）。
 *
 * 功能由 tool 承担，命令仅保留 /workflows 打开面板：
 * - /workflow run <name> → 用 workflow tool { action: "run" }
 * - /workflow list → 用 workflow tool { action: "status" }
 * - /workflow abort <run-id> → 用 workflow tool { action: "abort" }
 * - /workflow save <name> → 用 workflow-script tool { action: "save" }
 * - /workflow delete <name> → 用 workflow-script tool { action: "delete" }
 *
 * 层归属：Interface。依赖 Pi SDK + Engine lifecycle（pause/resume/abort，注入 ViewActions）
 * + WorkflowsView（读 WorkflowRun 聚合根）。
 *
 * 参考：
 * - domain-models.md §FR-6（command 收口仅 /workflows，打开交互式面板）
 * - spec.md UC-3（用户输入 /workflows，打开三级导航 TUI 面板）
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";

import type { LauncherDeps } from "../engine/launcher.js";
import { abortRun, pauseRun, resumeRun } from "../engine/lifecycle.js";
import type { WorkflowRun } from "../engine/models/workflow-run.js";
import { createWorkflowsView, type ViewActions } from "./views/WorkflowsView.js";

/** runId 截断长度（显示用）。 */
const RUNID_SHORT = 8;

/** status 显示顺序：running/paused 优先（活跃态在前），再 startedAt 倒序。 */
const STATUS_ORDER: Record<string, number> = {
  running: 0,
  paused: 1,
  done: 2,
};
/** 未知 status 的默认排序权重（排在已知 status 之后）。 */
const UNKNOWN_STATUS_WEIGHT = 9;

// ── /workflows command ───────────────────────────────────────

/**
 * 注册 /workflows command——打开 workflow 交互式 TUI 面板（FR-6, UC-3）。
 *
 * 行为：
 * - 无 UI（RPC/print/json 模式）→ notify 提示（降级，不打开 TUI）
 * - `/workflows <runId>` 或前缀匹配唯一 run → 直接打开该 run 的 view
 * - `/workflows`（无参）：
 * · 0 runs → notify "No workflows"
 * · 1 run → 直接打开
 * · 多 runs → select 选 → 打开选中 run 的 view
 *
 * ViewActions（pause/resume/abort）由本 command 注入——view 本身不持 lifecycle 依赖，
 * 只通过 actions 回调与 engine 交互（解耦，便于 view 单测）。
 *
 * @param api ExtensionAPI
 * @param getRuns 获取当前 session 的 runs（Map<runId, WorkflowRun>）
 * @param deps LauncherDeps（lifecycle pause/resume/abort 用）
 */
export function registerWorkflowsCommand(
  api: ExtensionAPI,
  getRuns: () => Map<string, WorkflowRun>,
  deps: LauncherDeps,
): void {
  api.registerCommand("workflows", {
    description: "Open workflow interactive panel. /workflows [runId] to open a specific run.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
 // RPC/print/json 模式无 TUI——降级提示
      if (!ctx.hasUI) {
        ctx.ui.notify("/workflows requires interactive mode", "error");
        return;
      }

 // 直接按 runId / 前缀匹配打开
      const directRunId = args.trim();
      if (directRunId) {
        const all = sortedRuns(getRuns());
 // 精确匹配优先
        const exact = all.find((r) => r.runId === directRunId);
        if (exact) {
          await openView(exact, ctx.ui.theme, ctx, deps);
          return;
        }
 // 前缀匹配
        const matched = all.filter((r) => r.runId.startsWith(directRunId));
        if (matched.length === 1) {
          await openView(matched[0], ctx.ui.theme, ctx, deps);
          return;
        }
        ctx.ui.notify(`Workflow '${directRunId}' not found`, "error");
        return;
      }

 // 无参——列表选择
      const all = sortedRuns(getRuns());
      if (all.length === 0) {
        ctx.ui.notify("No workflows in current session.", "info");
        return;
      }

 // 单 run 直开
      if (all.length === 1) {
        await openView(all[0], ctx.ui.theme, ctx, deps);
        return;
      }

 // 多 run——select 选择
      const entries = all.map(
        (r) => `${r.spec.scriptName} [${r.state.status}] (${r.runId.slice(0, RUNID_SHORT)})`,
      );
      const selected = await ctx.ui.select("Select workflow:", entries);
      if (!selected) return;
      const idx = entries.indexOf(selected);
      if (idx === -1) return;
      await openView(all[idx], ctx.ui.theme, ctx, deps);
    },
  });
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * 取 runs 按 status（running/paused 优先）+ startedAt 倒序排序。
 * 复用 main 的 UX 顺序（活跃态在前，新的在前）。
 */
function sortedRuns(runs: Map<string, WorkflowRun>): WorkflowRun[] {
  const arr = Array.from(runs.values());
  return arr.sort((a, b) => {
    const sa = STATUS_ORDER[a.state.status] ?? UNKNOWN_STATUS_WEIGHT;
    const sb = STATUS_ORDER[b.state.status] ?? UNKNOWN_STATUS_WEIGHT;
    if (sa !== sb) return sa - sb;
    const ta = a.meta.startedAt ? new Date(a.meta.startedAt).getTime() : 0;
    const tb = b.meta.startedAt ? new Date(b.meta.startedAt).getTime() : 0;
    return tb - ta;
  });
}

/**
 * 打开 WorkflowsView（三级导航 TUI），注入 lifecycle ViewActions。
 *
 * ViewActions 通过 deps 调 lifecycle（pause/resume/abort），与 view 解耦——
 * view 单测可注入 mock actions（见 workflows-view.test.ts）。
 */
async function openView(
  run: WorkflowRun,
  theme: Theme,
  ctx: ExtensionCommandContext,
  deps: LauncherDeps,
): Promise<void> {
  const actions: ViewActions = {
    pause: (runId: string) => pauseRun(runId, deps),
    resume: (runId: string) => resumeRun(runId, deps),
    abort: (runId: string) => abortRun(runId, deps),
  };
  await createWorkflowsView(run, theme, ctx, actions);
}
