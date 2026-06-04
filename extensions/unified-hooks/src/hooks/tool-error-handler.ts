/**
 * Tool Error Handler Hook
 *
 * Logs tool execution errors for debugging. Can be extended to handle
 * specific error patterns with contextual recovery.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export function setupToolErrorHandler(pi: ExtensionAPI): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pi event types are typed as `any` in CI stubs
  pi.on("tool_execution_end", async (event: any) => {
    if (!event.isError) return;
    console.log(`[unified-hooks] ${event.toolName} error (callId=${event.toolCallId})`);
  });
}
