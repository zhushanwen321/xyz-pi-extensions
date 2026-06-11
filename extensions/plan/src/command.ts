import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { PlanSessionMap } from "./state.js";
import { getPlanState, persistPlanState } from "./state.js";
import { updatePlanWidget } from "./widget.js";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

export function registerPlanCommand(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
): void {
  pi.registerCommand("plan", {
    description:
      "Enter plan mode: /plan [description]. " +
      "Subcommands: /plan abort, /plan status. " +
      "With no args, show status or detect existing plan.",
    handler: async (args: string, ctx: ExtensionContext) => {
      const trimmed = args.trim();
      const sessionId = ctx.sessionId ?? "default";
      const state = getPlanState(sessions, sessionId, ctx);

      // Subcommand: abort
      if (trimmed === "abort") {
        if (!state.isActive) {
          ctx.ui.notify("No active plan mode.", "info");
          return;
        }
        state.isActive = false;
        state.phase = "idle";
        state.planFilePath = "";
        state.requirement = "";
        state.templateName = "";
        persistPlanState(pi, state);
        sessions.delete(sessionId);
        updatePlanWidget(ctx, state);
        ctx.ui.notify("Plan mode aborted.", "info");
        return;
      }

      // Subcommand: status
      if (trimmed === "status") {
        if (!state.isActive) {
          ctx.ui.notify("No active plan mode.", "info");
          return;
        }
        ctx.ui.notify(
          `Plan Mode: ${state.phase}\nPlan: ${state.planFilePath}\nTemplate: ${state.templateName || "(not selected)"}`,
          "info",
        );
        return;
      }

      // If already in plan mode with no args, show status
      if (state.isActive && !trimmed) {
        ctx.ui.notify(
          `Plan Mode: ${state.phase}\nPlan: ${state.planFilePath}`,
          "info",
        );
        return;
      }

      // If already in plan mode with args, warn
      if (state.isActive && trimmed) {
        ctx.ui.notify("Plan mode is already active. Use /plan abort to cancel first.", "warning");
        return;
      }

      // Reentry: check for existing plan files in /tmp
      if (!state.isActive && !trimmed) {
        const tmpDir = os.tmpdir();
        let existingPlans: string[] = [];
        try {
          existingPlans = fs.readdirSync(tmpDir)
            .filter((f) => f.startsWith("plan-") && f.endsWith(".md"))
            .map((f) => path.join(tmpDir, f));
        } catch { /* /tmp read failed — proceed as no existing plans */ }

        if (existingPlans.length > 0) {
          pi.sendUserMessage(
            `[PLAN MODE] Found existing plan files:\n${existingPlans.map((p, i) => `  ${i + 1}. ${p}`).join("\n")}\n\n` +
            `Choose an option:\n` +
            `  a) Continue existing plan\n` +
            `  b) Implement existing plan\n` +
            `  c) Create new plan\n` +
            `  d) Cancel`,
          );
          return;
        }
      }

      // Enter plan mode
      const slug = trimmed
        ? trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30)
        : "untitled";

      // 注意：/tmp 是 OS 级共享路径，不同项目的 plan 文件会混在一起
      // spec v1 设计选择，接受跨项目泄漏风险（reentry 扫描会误捡其他项目的 plan）
      const planFilePath = path.join(os.tmpdir(), `plan-${slug}.md`);

      state.isActive = true;
      state.phase = "brainstorming";
      state.planFilePath = planFilePath;
      state.requirement = trimmed;
      state.templateName = "";

      persistPlanState(pi, state);
      updatePlanWidget(ctx, state);

      // Inject skill context
      pi.sendUserMessage(
        `[PLAN MODE] Entered plan mode.\n\n` +
        `Requirement: ${trimmed || "(from conversation context)"}\n` +
        `Plan file: ${planFilePath}\n\n` +
        `Follow the plan-mode skill instructions to begin brainstorming.`,
      );
    },
  });
}
