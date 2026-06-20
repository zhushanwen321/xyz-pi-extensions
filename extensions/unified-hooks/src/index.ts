/**
 * Unified Hooks Extension
 *
 * Collects scattered hooks in one place for easy maintenance.
 * Each hook is a self-contained module that can be enabled/disabled independently.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Re-export hook modules for easy access

import { setupNetworkTimeoutGuard } from "./hooks/network-timeout-guard";
import { setupSubagentListInjector } from "./hooks/subagent-list-injector";
import { setupTestTimeoutGuard } from "./hooks/test-timeout-guard";
import { type HookContext, setupToolErrorHandler } from "./hooks/tool-error-handler";

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
    { name: "subagent-list-injector", setup: setupSubagentListInjector },
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

  // Hook status surfaced via TUI notify (走通知区，不泄漏到 input area）
  // + appendEntry 持久化供事后排查。禁止用 console.warn（raw stderr 在 TUI
  // alternate screen 下会越过渲染层污染 input 区）。
  pi.on("session_start", (_event: unknown, ctx: HookContext) => {
    const enabled = hooks.filter((h) => h.enabled).map((h) => h.name);
    const disabled = hooks.filter((h) => !h.enabled).map((h) => h.name);
    const msg = `[unified-hooks] Loaded: ${enabled.join(", ") || "(none)"}${
      disabled.length ? ` | Failed: ${disabled.join(", ")}` : ""
    }`;
    ctx.ui?.notify(msg, disabled.length ? "warn" : "info");
    pi.appendEntry("unified-hooks:loaded", { enabled, disabled });
  });
}
