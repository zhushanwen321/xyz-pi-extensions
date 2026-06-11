import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { PlanSessionMap } from "./state.js";
import { getPlanState, persistPlanState } from "./state.js";
import { listTemplates, loadTemplate } from "./templates.js";
import { updatePlanWidget } from "./widget.js";
import * as fs from "node:fs";
import * as path from "node:path";

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

export function registerPlanTool(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pi as any).registerTool({
    name: "plan",
    label: "Plan Mode",
    description:
      "Plan mode tool for brainstorming and writing implementation plans. " +
      "Actions: list-template, select-template, create-template, complete, abort.",
    parameters: Type.Object({
      action: Type.String({ description: "Action to perform" }),
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

      switch (action) {
        case "list-template": {
          const templates = listTemplates();
          return {
            content: [{ type: "text" as const, text: JSON.stringify(templates, null, 2) }],
            details: { action, templates },
          };
        }

        case "select-template": {
          const templateName = params.templateName as string;
          if (!templateName) {
            throw new Error("templateName is required for select-template");
          }
          const content = loadTemplate(templateName);
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
          const projectDir = process.cwd();
          const templateDir = path.join(projectDir, ".pi", "plan-templates");
          fs.mkdirSync(templateDir, { recursive: true });
          fs.writeFileSync(path.join(templateDir, `${sanitizedName}.md`), templateContent);
          return {
            content: [{ type: "text" as const, text: `Template created: ${sanitizedName}` }],
            details: { action, templateName: sanitizedName },
          };
        }

        case "complete": {
          state.phase = "complete";
          persistPlanState(pi, state);
          const isolation = (params.isolation as string) ?? "direct";
          // Dynamic import: compact.ts is in BG2, tool.ts is in BG1
          const { handlePlanComplete } = await import("./compact.js");
          handlePlanComplete(pi, ctx, state, isolation);
          return {
            content: [{ type: "text" as const, text: "Plan complete. Switching to implementation..." }],
            details: { action, planFilePath: state.planFilePath, isolation },
          };
        }

        case "abort": {
          state.isActive = false;
          state.phase = "idle";
          state.planFilePath = "";
          state.requirement = "";
          state.templateName = "";
          persistPlanState(pi, state);
          sessions.delete(sessionId);
          updatePlanWidget(ctx, state);
          return {
            content: [{ type: "text" as const, text: "Plan mode aborted." }],
            details: { action },
          };
        }
      }
    },
  });
}
