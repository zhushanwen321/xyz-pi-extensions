/**
 * Tool Error Handler Hook
 *
 * Logs tool execution errors for debugging. Can be extended to handle
 * specific error patterns with contextual recovery.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Subset of `ToolExecutionEndEvent` fields used by this hook.
 * Local interface because the SDK's full event type is not re-exported
 * by the CI ambient type stubs in `shared/types/mariozechner/index.d.ts`.
 */
interface ToolExecutionEndLikeEvent {
  isError: boolean;
  toolName: string;
  toolCallId: string;
}

export function setupToolErrorHandler(pi: ExtensionAPI): void {
  pi.on("tool_execution_end", async (event: unknown) => {
    const e = event as ToolExecutionEndLikeEvent;
    if (!e.isError) return;
    // Tool error diagnostics are internal — surfacing to the terminal
    // would leak to the input area. ctx.ui.notify is unnecessary because
    // tool errors are already surfaced by Pi's own error rendering.
    console.warn(`[unified-hooks] ${e.toolName} error (callId=${e.toolCallId})`);
  });
}
