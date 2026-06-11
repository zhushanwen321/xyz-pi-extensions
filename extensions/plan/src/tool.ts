import * as fs from "node:fs";
import * as path from "node:path";

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import type { PlanSessionMap } from "./state.js";
import { getPlanState, persistPlanState, resetPlanState } from "./state.js";
import { listTemplates, loadTemplate } from "./templates.js";
import { updatePlanWidget } from "./widget.js";

const JSON_INDENT = 2;

export const PLAN_ACTIONS = [
  "list-template",
  "select-template",
  "create-template",
  "complete",
  "abort",
] as const;

export type PlanAction = (typeof PLAN_ACTIONS)[number];

export function validateAction(action: string): action is PlanAction {
  return (PLAN_ACTIONS as readonly string[]).includes(action);
}

/** Restore the default full tool set after exiting plan mode. */
function restoreFullToolSet(pi: ExtensionAPI): void {
  pi.setActiveTools(undefined);
}

export function registerPlanTool(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
): void {
  pi.registerTool({
    name: "plan",
    label: "Plan Mode",
    description:
      "Plan mode tool for brainstorming and writing implementation plans. " +
      "Actions: list-template, select-template, create-template, complete, abort.",
    parameters: Type.Object({
      action: StringEnum(PLAN_ACTIONS, { description: "Action to perform" }),
      templateName: Type.Optional(Type.String({ description: "Template name (for select-template)" })),
      templateContent: Type.Optional(Type.String({ description: "Template content (for create-template)" })),
      isolation: Type.Optional(StringEnum(["compact", "tree", "direct"])),
    }),
    promptSnippet: "Use plan tool for plan mode operations",
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const action = params.action as string;
      if (!validateAction(action)) {
        throw new Error(`Unknown plan action: ${action}. Valid actions: ${PLAN_ACTIONS.join(", ")}`);
      }

      const sessionId = ctx.sessionManager.getSessionId();
      const state = getPlanState(sessions, sessionId, ctx);
      const projectDir = ctx.cwd;

      switch (action) {
        case "list-template": {
          const templates = listTemplates(projectDir);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(templates, null, JSON_INDENT) }],
            details: { action, templates },
          };
        }

        case "select-template": {
          const templateName = params.templateName as string;
          if (!templateName) {
            throw new Error("templateName is required for select-template");
          }
          const content = loadTemplate(templateName, projectDir);
          if (!content) {
            throw new Error(`Template not found: ${templateName}`);
          }
          state.templateName = templateName;
          state.phase = "writing";
          persistPlanState(pi, state);
          return {
            content: [{ type: "text" as const, text: `Template selected: ${templateName}` }],
            details: { action, templateName, content },
          };
        }

        case "create-template": {
          const templateName = params.templateName as string;
          const templateContent = params.templateContent as string;
          if (!templateName || !templateContent) {
            throw new Error("templateName and templateContent are required for create-template");
          }
          const sanitizedName = templateName.replace(/[^a-zA-Z0-9_-]/g, "");
          if (!sanitizedName) {
            throw new Error("Invalid template name: must contain alphanumeric characters");
          }
          const templateDir = path.join(projectDir, ".pi", "plan-templates");
          fs.mkdirSync(templateDir, { recursive: true });
          fs.writeFileSync(path.join(templateDir, `${sanitizedName}.md`), templateContent);
          return {
            content: [{ type: "text" as const, text: `Template created: ${sanitizedName}` }],
            details: { action, templateName: sanitizedName },
          };
        }

        case "complete": {
          // P0: User confirmation gate — AI cannot auto-proceed
          if (typeof ctx.ui.select === "function") {
            const choice = await ctx.ui.select(
              "Plan is ready. What next?",
              ["Execute the plan", "Modify the plan first", "Save for later"],
            );
            if (choice !== "Execute the plan") {
              return {
                content: [{ type: "text" as const, text: `User chose: ${choice ?? "cancelled"}. Staying in plan mode.` }],
                details: { action: "complete-cancelled", reason: choice ?? "cancelled" },
              };
            }
          }

          state.phase = "complete";
          persistPlanState(pi, state);

          // Restore full tool set before execution
          restoreFullToolSet(pi);

          const isolation = (params.isolation as string) ?? "direct";
          const { handlePlanComplete } = await import("./compact.js");
          handlePlanComplete(pi, ctx, state, isolation);
          return {
            content: [{ type: "text" as const, text: "Plan approved. Starting execution..." }],
            details: { action, planFilePath: state.planFilePath, isolation },
          };
        }

        case "abort": {
          const updatedState = resetPlanState(pi, sessions, sessionId, ctx);
          updatePlanWidget(ctx, updatedState);
          restoreFullToolSet(pi);
          return {
            content: [{ type: "text" as const, text: "Plan mode aborted. Full tool access restored." }],
            details: { action },
          };
        }
      }
    },
  });
}
