/**
 * Unified Hooks Extension
 *
 * Collects scattered hooks in one place for easy maintenance.
 * Each hook is a self-contained module that can be enabled/disabled independently.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Re-export hook modules for easy access
export { setupToolErrorHandler } from "./hooks/tool-error-handler";
export { setupNetworkTimeoutGuard } from "./hooks/network-timeout-guard";
export { setupTestTimeoutGuard } from "./hooks/test-timeout-guard";

import { setupToolErrorHandler } from "./hooks/tool-error-handler";
import { setupNetworkTimeoutGuard } from "./hooks/network-timeout-guard";
import { setupTestTimeoutGuard } from "./hooks/test-timeout-guard";

/**
 * Extension factory - registers all unified hooks
 */
export default function unifiedHooksExtension(pi: ExtensionAPI): void {
  // Initialize hook registry
  const hooks: Array<{ name: string; enabled: boolean }> = [];

  // edit-stale-content-guard removed: pi-hashline-edit replaces built-in edit
  // with hash-anchor mode, making oldText-based guard unreachable
  const hookModules = [
    { name: "tool-error-handler", setup: setupToolErrorHandler },
    { name: "network-timeout-guard", setup: setupNetworkTimeoutGuard },
    { name: "test-timeout-guard", setup: setupTestTimeoutGuard },
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