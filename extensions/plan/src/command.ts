import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { PlanSessionMap } from "./state.js";
import { getPlanState, persistPlanState, resetPlanState } from "./state.js";
import { updatePlanWidget } from "./widget.js";

const MAX_SLUG_LENGTH = 30;

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
      const sessionId = ctx.sessionManager.getSessionId();
      const state = getPlanState(sessions, sessionId, ctx);

      // Subcommand: abort
      if (trimmed === "abort") {
        await handleAbort(pi, sessions, sessionId, ctx, state);
        return;
      }

      // Subcommand: status
      if (trimmed === "status") {
        handleStatus(ctx, state);
        return;
      }

      // If already in plan mode with no args, show status
      if (state.isActive && !trimmed) {
        handleStatus(ctx, state);
        return;
      }

      // If already in plan mode with args, warn
      if (state.isActive && trimmed) {
        ctx.ui.notify("Plan mode is already active. Use /plan abort to cancel first.", "warning");
        return;
      }

      // Reentry: check for existing plan files in .xyz-harness/
      if (!state.isActive && !trimmed) {
        const projectDir = ctx.cwd;
        const harnessDir = path.join(projectDir, ".xyz-harness");
        const existingPlans = findExistingPlans(harnessDir);
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
      handleEnterPlanMode(pi, sessions, sessionId, ctx, state, trimmed);
    },
  });
}

/** Handle /plan abort subcommand */
async function handleAbort(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
  sessionId: string,
  ctx: ExtensionContext,
  state: PlanSessionMap extends Map<string, infer V> ? V : never,
): Promise<void> {
  if (!state.isActive) {
    ctx.ui.notify("No active plan mode.", "info");
    return;
  }
  const updatedState = resetPlanState(pi, sessions, sessionId, ctx);
  updatePlanWidget(ctx, updatedState);
  // Restore full tool set (SDK does NOT support undefined)
  pi.setActiveTools(pi.getAllTools().map((t: { name: string }) => t.name));
  ctx.ui.notify("Plan mode aborted.", "info");
}

/** Handle /plan status subcommand */
function handleStatus(
  ctx: ExtensionContext,
  state: PlanSessionMap extends Map<string, infer V> ? V : never,
): void {
  if (!state.isActive) {
    ctx.ui.notify("No active plan mode.", "info");
    return;
  }
  ctx.ui.notify(
    `Plan Mode: ${state.phase}\nPlan: ${state.planFilePath}\nTemplate: ${state.templateName || "(not selected)"}`,
    "info",
  );
}

/** Find existing plan.md files in .xyz-harness/ subdirectories */
function findExistingPlans(harnessDir: string): string[] {
  try {
    return fs.readdirSync(harnessDir)
      .filter((f) => {
        const subDir = path.join(harnessDir, f);
        return fs.statSync(subDir).isDirectory() && fs.existsSync(path.join(subDir, "plan.md"));
      })
      .map((f) => path.join(harnessDir, f, "plan.md"));
  } catch {
    return [];
  }
}

/** Handle entering plan mode */
function handleEnterPlanMode(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
  sessionId: string,
  ctx: ExtensionContext,
  state: PlanSessionMap extends Map<string, infer V> ? V : never,
  requirement: string,
): void {
  const slug = requirement
        ? requirement.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, MAX_SLUG_LENGTH)
    : "untitled";

  const projectDir = ctx.cwd;
  const planDir = path.join(projectDir, ".xyz-harness", slug);
  fs.mkdirSync(planDir, { recursive: true });
  const planFilePath = path.join(planDir, "plan.md");

  state.isActive = true;
  state.phase = "brainstorming";
  state.planFilePath = planFilePath;
  state.requirement = requirement;
  state.templateName = "";

  persistPlanState(pi, state);
  updatePlanWidget(ctx, state);

  // Restrict tools to read-only set during plan mode
  pi.setActiveTools(["read", "bash", "grep", "find", "ls", "plan"]);

  // Inject plan mode system prompt inline
  pi.sendUserMessage(
    `[PLAN MODE] Entered plan mode.\n\n` +
    `Requirement: ${requirement || "(from conversation context)"}\n` +
    `Plan file: ${planFilePath}\n\n` +
    `## Constraints\n` +
    `- READ-ONLY: Do NOT edit any files except the plan file (${planFilePath}).\n` +
    `- Do NOT run write commands (mkdir, echo, sed, etc.) on non-plan files.\n` +
    `- All plan content goes to the plan file only.\n\n` +
    `## Phase B: Brainstorming\n` +
    `1. **Quick Overview**: ls project root, read README, package.json — build context (< 30s).\n` +
    `2. **Explore before asking**: grep/read code first. Only ask user for preferences, not code-fact questions.\n` +
    `3. **Progressive questioning**: Ask 2-3 questions at a time. Use ask_user tool if available.\n` +
    `4. **Propose 2-3 approaches** with trade-offs + recommendation.\n` +
    `5. **Assumption audit**: Grep-verify interfaces/types exist. Mark [UNVERIFIED] what can't be verified.\n\n` +
    `## Phase C: Writing\n` +
    `1. Call plan tool (list-template) to show available templates.\n` +
    `2. After user selects template, call plan tool (select-template).\n` +
    `3. Write chapters in template order — do NOT skip unwritten chapters.\n` +
    `4. Write all chapters in one turn, then ask user to review.\n\n` +
    `## Phase D: Completion\n` +
    `1. Ask user to review the complete plan.\n` +
    `2. Call plan tool (complete) with isolation method (compact/tree/direct).\n` +
    `3. After plan complete: check subagent capability → suggest goal + wave or single-agent execution.`,
  );
}

/**
 * Programmatic entry to start plan mode (for `pi.__planStart`).
 *
 * Mirrors the `/plan` command's enter logic. Returns false if plan mode is
 * already active (caller can then surface a message or wait).
 *
 * @returns true if plan mode started; false if already active
 */
export function startPlanMode(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
  ctx: ExtensionContext,
  requirement: string,
): boolean {
  const sessionId = ctx.sessionManager.getSessionId();
  const state = getPlanState(sessions, sessionId, ctx);
  if (state.isActive) return false;
  handleEnterPlanMode(pi, sessions, sessionId, ctx, state, requirement);
  return true;
}
