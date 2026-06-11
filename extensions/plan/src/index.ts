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
  }).catch(() => { /* compact is optional at load time */ });

  // Reconstruct state on session start
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionId ?? "default";
    const state = reconstructPlanState(ctx);
    sessions.set(sessionId, state);
    updatePlanWidget(ctx, state);
  });

  // Clean up on session end
  pi.on("session_end", async (_event: unknown, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionId ?? "default";
    sessions.delete(sessionId);
  });
}
