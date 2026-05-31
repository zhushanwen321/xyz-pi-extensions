/**
 * Unified Hooks Extension
 *
 * Collects scattered hooks in one place for easy maintenance.
 * Each hook is a self-contained module that can be enabled/disabled independently.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Re-export hook modules for easy access
export * from "./hooks/edit-whitespace-autofix";
export * from "./hooks/tool-error-handler";

/**
 * Extension factory - registers all unified hooks
 */
export default function unifiedHooksExtension(pi: ExtensionAPI): void {
  // Initialize hook registry
  const hooks: Array<{ name: string; enabled: boolean }> = [];

  // Register each hook
  const hookModules = [
    { name: "edit-whitespace-autofix", setup: setupEditWhitespaceAutofix },
    { name: "tool-error-handler", setup: setupToolErrorHandler },
  ];

  for (const hook of hookModules) {
    try {
      hook.setup(pi);
      hooks.push({ name: hook.name, enabled: true });
    } catch (err) {
      console.error(`[unified-hooks] Failed to setup ${hook.name}:`, err);
      hooks.push({ name: hook.name, enabled: false });
    }
  }

  // Log hook status on session start for debugging
  pi.on("session_start", () => {
    const enabled = hooks.filter((h) => h.enabled).map((h) => h.name);
    const disabled = hooks.filter((h) => !h.enabled).map((h) => h.name);
    console.log(
      `[unified-hooks] Loaded: ${enabled.join(", ") || "(none)"}${
        disabled.length ? ` | Failed: ${disabled.join(", ")}` : ""
      }`
    );
  });
}