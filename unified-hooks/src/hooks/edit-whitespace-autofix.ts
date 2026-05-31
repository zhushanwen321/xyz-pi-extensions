/**
 * Edit Whitespace Autofix Hook
 *
 * When edit tool fails due to whitespace mismatch, inject a steering message
 * that tells the AI to fix whitespace and retry.
 *
 * Uses pi.sendUserMessage() (top-level API) instead of ctx.sendUserMessage()
 * because ExtensionContext does not have sendUserMessage — only
 * ExtensionCommandContext does.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const WHITESPACE_ERROR_PATTERNS = [
  "Could not find the exact text",
  "oldText must match exactly",
  "Could not find edits[",
];

function isEditWhitespaceError(toolName: string, isError: boolean, result: unknown): boolean {
  if (toolName !== "edit" || !isError) return false;

  const resultStr = typeof result === "string"
    ? result
    : JSON.stringify(result);

  return WHITESPACE_ERROR_PATTERNS.some((p) => resultStr.includes(p));
}

export function setupEditWhitespaceAutofix(pi: ExtensionAPI): void {
  pi.on("tool_execution_end", async (event) => {
    if (!isEditWhitespaceError(event.toolName, event.isError, event.result)) return;

    const input = event.args as Record<string, unknown> | undefined;
    const filePath = input?.path;
    if (typeof filePath !== "string") return;

    console.log(`[unified-hooks] edit whitespace mismatch detected: ${filePath}`);

    // Inject steering message — AI will see this and auto-fix + retry
    pi.sendUserMessage(
      `Edit failed due to whitespace mismatch in ${filePath}. ` +
        `Run \`python3 ~/.agents/skills/whitespace-fixer/scripts/fix_whitespace.py --fix ${filePath}\` ` +
        `to fix whitespace, then immediately retry the edit.`,
      { deliverAs: "steer" }
    );
  });
}
