import * as fs from "node:fs";

import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent, SessionBeforeTreeEvent } from "@mariozechner/pi-coding-agent";

import type { PlanSessionMap, PlanState } from "./state.js";
import { getPlanState } from "./state.js";

export function registerPlanEventHandlers(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
): void {
  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getPlanState(sessions, sessionId, ctx);
    if (!state.isActive) return {};

    const prep = event.preparation;

    // Read plan file content for recovery after compact
    const planContent = readPlanFileSafe(state.planFilePath);

    // Include phase info for non-complete phases
    const phaseNote = state.phase !== "complete"
      ? `\nPhase: ${state.phase}. Plan was in progress — review and continue.`
      : "\nAwaiting user decision on execution. Do NOT auto-proceed.";

    return {
      compaction: {
        summary:
          `Plan mode active (${state.phase}). Plan file: ${state.planFilePath}\n\n` +
          `## Plan Content\n${planContent}\n\n` +
          `Requirement: ${state.requirement}` +
          phaseNote,
        firstKeptEntryId: prep?.firstKeptEntryId,
        tokensBefore: prep?.tokensBefore,
      },
    };
  });

  pi.on("session_before_tree", async (_event: SessionBeforeTreeEvent, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getPlanState(sessions, sessionId, ctx);
    if (!state.isActive) return {};

    const planContent = readPlanFileSafe(state.planFilePath);

    return {
      summary: {
        summary:
          `Plan mode active (${state.phase}). Plan file: ${state.planFilePath}\n\n` +
          `## Plan Content\n${planContent}\n\n` +
          `Read the plan file and execute the implementation.`,
      },
    };
  });
}

/** Read plan file, return content or error message */
function readPlanFileSafe(planFilePath: string): string {
  try {
    return fs.readFileSync(planFilePath, "utf-8");
  } catch {
    return "(plan file could not be read)";
  }
}

/** Detect whether goal extension is available via its programming interface */
export function detectGoalCapability(pi: ExtensionAPI): boolean {
  try {
    const api = pi as unknown as Record<string, unknown>;
    return typeof api.__goalInit === "function";
  } catch {
    return false;
  }
}

/** Try to initialize goal via programming interface */
function tryGoalInit(pi: ExtensionAPI, planFilePath: string, ctx: ExtensionContext): boolean {
  // Inline alias mirrors @zhushanwen/pi-goal's GoalInitFn (exported from goal/src/index.ts).
  // Kept inline due to optional duck-typed coupling (pi.__goalInit) — update both if signature changes.
  type GoalInitFn = (
    objective: string,
    budget: { tokenBudget?: number; timeBudgetMinutes?: number } | undefined,
    ctx: ExtensionContext,
  ) => boolean;

  try {
    const api = pi as unknown as Record<string, unknown>;
    const goalInit = api.__goalInit as GoalInitFn | undefined;
    if (typeof goalInit !== "function") return false;

    const planContent = readPlanFileSafe(planFilePath);
    if (planContent.startsWith("(")) return false; // read failed

    const objective = `Execute plan: ${planFilePath}`;
    const tasks = extractPlanSteps(planContent);
    if (tasks.length === 0) return false;

    return goalInit(objective, undefined, ctx);
  } catch {
    return false;
  }
}

/** Extract numbered steps from plan markdown */
export function extractPlanSteps(planContent: string): string[] {
  const steps: string[] = [];
  let inStepsSection = false;

  for (const line of planContent.split("\n")) {
    // Detect steps section headers
    if (/^##\s*(实现步骤|实施步骤|Implementation|Steps)/i.test(line)) {
      inStepsSection = true;
      continue;
    }
    // Exit on next ## header
    if (inStepsSection && /^##\s/.test(line)) {
      break;
    }
    // Collect numbered list items or checkbox items
    if (inStepsSection) {
      const match = line.match(/^\s*(?:\d+\.|- \[[ x]\])\s+(.+)/);
      if (match && match[1].trim()) {
        steps.push(match[1].trim());
      }
    }
  }

  // Fallback: if no steps section found, look for any numbered items (limit MAX_FALLBACK_STEPS)
  const MAX_FALLBACK_STEPS = 10;
  if (steps.length === 0) {
    for (const line of planContent.split("\n")) {
      const match = line.match(/^\s*\d+\.\s+(.+)/);
      if (match && match[1].trim()) {
        steps.push(match[1].trim());
        if (steps.length >= MAX_FALLBACK_STEPS) break;
      }
    }
  }

  return steps;
}


export function handlePlanComplete(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PlanState,
  isolation: string,
  execMode: string,
): void {
  const planFilePath = state.planFilePath;

  // Build mode-specific steer
  const modeMessages: Record<string, string> = {
    subagent: "Execute via subagent-driven development: delegate each task to an independent subagent for parallel execution.",
    goal: "Execute via /goal: set up tracked task decomposition with budget control using the goal extension.",
    "single-agent": "Execute step by step in the current session.",
  };
  const modeHint = modeMessages[execMode] ?? modeMessages["single-agent"];

  const executeMessage =
    `Plan approved by user. Plan file: ${planFilePath}\n\n` +
    `Execution mode: ${execMode}\n` +
    `${modeHint}\n\n` +
    `Read the plan file and start implementing.`;

  switch (isolation) {
    case "compact": {
      ctx.compact({
        customInstructions: `Plan file: ${planFilePath}. Read plan and execute implementation.`,
        onComplete: () => {
          pi.sendUserMessage(executeMessage, { deliverAs: "steer" });
          tryGoalInit(pi, planFilePath, ctx);
        },
        onError: (_error: Error) => {
          ctx.ui.notify("Compact failed, continuing without isolation.", "warning");
          pi.sendUserMessage(executeMessage, { deliverAs: "steer" });
          tryGoalInit(pi, planFilePath, ctx);
        },
      });
      break;
    }

    case "tree": {
      ctx.ui.notify("Use /tree to manually navigate back. Plan file: " + planFilePath, "info");
      break;
    }

    case "direct":
    default: {
      pi.sendUserMessage(executeMessage, { deliverAs: "steer" });
      tryGoalInit(pi, planFilePath, ctx);
      break;
    }
  }
}
