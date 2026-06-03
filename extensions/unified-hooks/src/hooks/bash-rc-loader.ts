/**
 * Bash RC Loader Hook
 *
 * Pi's bash tool spawns non-interactive shells (`bash -c`) which do not source
 * ~/.bashrc automatically. This hook ensures shell functions (proxy/noproxy etc.)
 * are available:
 *
 * - AI bash tool calls: inject `source ~/.bashrc` only on the first call per session
 *   (subsequent calls are new processes but the AI knows to chain proxy && cmd itself)
 * - User `!` commands: inject `source ~/.bashrc` on every call via custom operations
 *   (each `!` is a separate process, +130ms overhead is acceptable for manual use)
 *
 * The tool_call flag is reset on session_start.
 */

import { type ExtensionAPI, createLocalBashOperations } from "@mariozechner/pi-coding-agent";

let toolCallSourced = false;

export function setupBashRcLoader(pi: ExtensionAPI): void {
  // AI bash tool calls: inject source only once per session
  pi.on("tool_call", async (event: any) => {
    if (event.toolName !== "bash" || toolCallSourced) return;
    const input = event.input as { command: string };
    input.command = `source ~/.bashrc 2>/dev/null\n${input.command}`;
    toolCallSourced = true;
  });

  // User `!` commands: inject source every time via custom operations
  pi.on("user_bash", async (_event: any) => {
    const localOps = createLocalBashOperations();
    return {
      operations: {
        exec: (
          command: string,
          cwd: string,
          opts: any,
        ) => localOps.exec(`source ~/.bashrc 2>/dev/null\n${command}`, cwd, opts),
      },
    };
  });

  pi.on("session_start", () => {
    toolCallSourced = false;
  });
}
