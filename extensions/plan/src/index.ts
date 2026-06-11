import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type PlanSessionMap, reconstructPlanState } from "./state.js";
import { registerPlanTool } from "./tool.js";
import { registerPlanCommand } from "./command.js";
import { updatePlanWidget } from "./widget.js";

export default function planExtension(pi: ExtensionAPI) {
  // Per-session state cache — keyed by sessionId
  const sessions: PlanSessionMap = new Map();

  // Register tool and command (BG1)
  registerPlanTool(pi, sessions);
  registerPlanCommand(pi, sessions);

  // Dynamic import compact handlers (BG2) — avoids cross-group static import
  import("./compact.js").then(({ registerPlanEventHandlers }) => {
    registerPlanEventHandlers(pi, sessions);
  }).catch((_e: unknown) => { /* compact.ts missing — extension works without it */ });

  // Reconstruct state on session start
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pi as any).on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = reconstructPlanState(ctx);
    sessions.set(sessionId, state);
    updatePlanWidget(ctx, state);
  });
}
