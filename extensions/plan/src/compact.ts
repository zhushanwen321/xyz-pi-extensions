import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { PlanSessionMap, PlanState } from "./state.js";
import { getPlanState } from "./state.js";
import * as fs from "node:fs";

export function registerPlanEventHandlers(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
): void {
  // session_before_compact: customize compaction summary with plan content
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pi as any).on("session_before_compact", async (event: { preparation?: { firstKeptEntryId?: string; tokensBefore?: number } }, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getPlanState(sessions, sessionId, ctx);
    if (!state.isActive || state.phase !== "complete") return {};

    const prep = (event as { preparation?: { firstKeptEntryId?: string; tokensBefore?: number } })?.preparation;

    // Read plan file content for recovery after compact
    let planContent = "";
    try {
      planContent = fs.readFileSync(state.planFilePath, "utf-8");
    } catch {
      planContent = "(plan file could not be read)";
    }

    return {
      compaction: {
        summary:
          `Plan mode completed. Plan file: ${state.planFilePath}\n\n` +
          `## Plan Content\n${planContent}\n\n` +
          `Awaiting user decision on execution. Do NOT auto-proceed.`,
        firstKeptEntryId: prep?.firstKeptEntryId,
        tokensBefore: prep?.tokensBefore,
      },
    };
  });

  // session_before_tree: customize tree summary with plan content
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pi as any).on("session_before_tree", async (_event: unknown, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getPlanState(sessions, sessionId, ctx);
    if (!state.isActive || state.phase !== "complete") return {};

    let planContent = "";
    try {
      planContent = fs.readFileSync(state.planFilePath, "utf-8");
    } catch {
      planContent = "(plan file could not be read)";
    }

    return {
      summary:
        `Plan mode completed. Plan file: ${state.planFilePath}\n\n` +
        `## Plan Content\n${planContent}\n\n` +
        `Read the plan file and execute the implementation.`,
    };
  });
}

/** Try to initialize goal via programming interface */
function tryGoalInit(pi: ExtensionAPI, planFilePath: string): boolean {
  type GoalInitFn = (
    objective: string,
    tasks: string[],
    budget?: { tokenBudget?: number; timeBudgetMinutes?: number; maxTurns?: number },
  ) => boolean;

  try {
    const api = pi as unknown as Record<string, unknown>;
    const goalInit = api.__goalInit as GoalInitFn | undefined;
    if (typeof goalInit !== "function") return false;

    // Read plan file and extract steps from "## 实现步骤" or "## 实施步骤" section
    let planContent = "";
    try {
      planContent = fs.readFileSync(planFilePath, "utf-8");
    } catch {
      return false;
    }

    const objective = `Execute plan: ${planFilePath}`;
    const tasks = extractPlanSteps(planContent);
    if (tasks.length === 0) return false;

    return goalInit(objective, tasks);
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

  // Fallback: if no steps section found, look for any numbered items
  if (steps.length === 0) {
    for (const line of planContent.split("\n")) {
      const match = line.match(/^\s*\d+\.\s+(.+)/);
      if (match && match[1].trim()) {
        steps.push(match[1].trim());
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
): void {
  const planFilePath = state.planFilePath;

  const executeMessage =
    `Plan approved by user. Plan file: ${planFilePath}\n\n` +
    `Read the plan file and start implementing.`;

  switch (isolation) {
    case "compact": {
      ctx.compact({
        customInstructions: `Plan file: ${planFilePath}. Read plan and execute implementation.`,
        onComplete: () => {
          pi.sendUserMessage(executeMessage, { deliverAs: "steer" });
          tryGoalInit(pi, planFilePath);
        },
        onError: (_error: Error) => {
          ctx.ui.notify("Compact failed, continuing without isolation.", "warning");
          pi.sendUserMessage(executeMessage, { deliverAs: "steer" });
          tryGoalInit(pi, planFilePath);
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
      tryGoalInit(pi, planFilePath);
      break;
    }
  }
}
