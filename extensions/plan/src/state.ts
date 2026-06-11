import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export type PlanPhase = "idle" | "brainstorming" | "writing" | "complete";

export interface PlanState {
  isActive: boolean;
  phase: PlanPhase;
  planFilePath: string;
  requirement: string;
  templateName: string;
}

export const DEFAULT_PLAN_STATE: PlanState = {
  isActive: false,
  phase: "idle",
  planFilePath: "",
  requirement: "",
  templateName: "",
};

/** Per-session state cache. Keyed by sessionId. */
export type PlanSessionMap = Map<string, PlanState>;

/**
 * Get plan state for a session. Returns cached state if available,
 * otherwise reconstructs from sessionManager and caches it.
 */
export function getPlanState(
  sessions: PlanSessionMap,
  sessionId: string,
  ctx: ExtensionContext,
): PlanState {
  const cached = sessions.get(sessionId);
  if (cached) return cached;

  const reconstructed = reconstructPlanState(ctx);
  sessions.set(sessionId, reconstructed);
  return reconstructed;
}

export function persistPlanState(pi: ExtensionAPI, state: PlanState): void {
  pi.appendEntry("plan-state", {
    isActive: state.isActive,
    phase: state.phase,
    planFilePath: state.planFilePath,
    requirement: state.requirement,
    templateName: state.templateName,
  });
}

function isPlanStateEntry(entry: unknown): entry is { type: "custom"; customType: "plan-state"; data: Partial<PlanState> } {
  const e = entry as Record<string, unknown>;
  return e.type === "custom" && e.customType === "plan-state" && typeof e.data === "object" && e.data !== null;
}

export function reconstructPlanState(ctx: ExtensionContext): PlanState {
  const state = { ...DEFAULT_PLAN_STATE };
  const entries = ctx.sessionManager.getEntries();

  for (let i = entries.length - 1; i >= 0; i--) {
    if (isPlanStateEntry(entries[i])) {
      const data = entries[i].data;
      state.isActive = data.isActive ?? false;
      state.phase = data.phase ?? "idle";
      state.planFilePath = data.planFilePath ?? "";
      state.requirement = data.requirement ?? "";
      state.templateName = data.templateName ?? "";
      break;
    }
  }

  return state;
}
