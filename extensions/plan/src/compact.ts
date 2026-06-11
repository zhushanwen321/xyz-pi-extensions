import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { PlanSessionMap, PlanState } from "./state.js";
import { getPlanState } from "./state.js";

type GoalInitFn = (
  objective: string,
  tasks: string[],
  budget?: { tokenBudget?: number; timeBudgetMinutes?: number; maxTurns?: number },
) => boolean;

export function registerPlanEventHandlers(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
): void {
  // session_before_compact: customize compaction summary
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pi as any).on("session_before_compact", async (event: { preparation?: { firstKeptEntryId?: string; tokensBefore?: number } }, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getPlanState(sessions, sessionId, ctx);
    if (!state.isActive || state.phase !== "complete") return {};

    const prep = (event as { preparation?: { firstKeptEntryId?: string; tokensBefore?: number } })?.preparation;
    return {
      compaction: {
        summary:
          `Plan mode completed. Plan file: ${state.planFilePath}\n\n` +
          `Next step: Read the plan file and execute the implementation.\n` +
          `Use /goal or start implementing directly.`,
        firstKeptEntryId: prep?.firstKeptEntryId,
        tokensBefore: prep?.tokensBefore,
      },
    };
  });

  // session_before_tree: customize tree summary
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pi as any).on("session_before_tree", async (_event: unknown, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getPlanState(sessions, sessionId, ctx);
    if (!state.isActive || state.phase !== "complete") return {};

    return {
      summary:
        `Plan mode completed. Plan file: ${state.planFilePath}\n\n` +
        `Next step: Read the plan file and execute the implementation.`,
    };
  });
}

export function handlePlanComplete(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PlanState,
  isolation: string,
): void {
  const steerMessage =
    `Plan complete. Plan file: ${state.planFilePath}\n\n` +
    `Read the plan file and start implementing.\n` +
    `Check for subagent capability and suggest goal + wave execution if available.`;

  switch (isolation) {
    case "compact": {
      // SDK compact() 用 IIFE 包裹 try/catch，错误只走 onError，不会向外抛出
      ctx.compact({
        customInstructions: `Plan file: ${state.planFilePath}. Read and execute.`,
        onComplete: () => {
          pi.sendUserMessage(steerMessage, { deliverAs: "steer" });
        },
        onError: (_error: Error) => {
          // Fallback to direct continue
          ctx.ui.notify("Compact failed, continuing without isolation.", "warning");
          pi.sendUserMessage(steerMessage, { deliverAs: "steer" });
        },
      });
      break;
    }

    case "tree": {
      // Tree case: only notify, don't inject steer (user manually navigates)
      ctx.ui.notify("Use /tree to manually navigate back. Plan file: " + state.planFilePath, "info");
      break;
    }

    case "direct":
    default: {
      pi.sendUserMessage(steerMessage, { deliverAs: "steer" });
      break;
    }
  }

  // Try to initialize goal (skip for tree — user manually controls when to start goal)
  if (isolation !== "tree") {
    try {
      const goalInit = (pi as unknown as Record<string, unknown>).__goalInit as GoalInitFn | undefined;
      if (goalInit) {
        goalInit(
          `Execute plan: ${state.planFilePath}`,
          ["Read plan file", "Execute implementation steps"],
        );
      }
    } catch (e) { ctx.ui.notify(`Goal init failed: ${e}`, "warning"); }
  }
}
