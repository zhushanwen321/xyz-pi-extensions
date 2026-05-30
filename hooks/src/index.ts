import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";

const STATUS_KEY = "last-activity";

function formatElapsed(now: number, last: number): string {
  const diff = now - last;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m ago`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

const CWD_DEPENDENT_TOOLS = new Set(["bash", "grep", "find", "ls"]);

/**
 * Detect bare-repo workspace by checking if ../.bare exists relative to cwd.
 * Returns the workspace root path, or undefined if not a bare-repo layout.
 */
function detectWorkspaceRoot(cwd: string): string | undefined {
  const parent = dirname(cwd);
  if (existsSync(`${parent}/.bare`)) return parent;
  return undefined;
}

/**
 * List existing worktrees in a bare-repo workspace via `git worktree list`.
 * Uses pi.exec() which has its own cwd parameter, independent of the deleted cwd.
 */
async function listWorktrees(pi: ExtensionAPI, workspaceRoot: string): Promise<string | undefined> {
  try {
    const result = await pi.exec("git", [
      "--git-dir", `${workspaceRoot}/.bare`, "worktree", "list",
    ], { cwd: workspaceRoot, timeout: 3000 });
    if (result.code !== 0) return undefined;
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

// ============================================================================
// CWD Deletion Pre-guard
// ============================================================================

/** Bash command patterns that indicate directory deletion. */
const DELETE_PATTERNS = [
  /\brm\s+(-\w*[rf]\w*\s|--recursive\s)/,  // rm -rf, rm -r, rm --recursive
  /\bmerge-and-publish\.sh\b/,                // merge-worktree skill (phase 6 cleanup)
  /\bgit\s+worktree\s+remove\b/,              // git worktree remove
  /\bremove[-_]worktree\b/,                    // remove-worktree skill/script
];

/** Cache: cwd → timestamp of last warning. */
const deletionWarnCache = new Map<string, number>();
const DELETION_WARN_TTL_MS = 60 * 60 * 1000; // 1 hour

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Heuristic: does this command reference the session cwd and contain deletion patterns?
 * False negatives are acceptable (miss some edge cases); false positives should be rare.
 */
function wouldDeleteCwd(command: string, cwd: string): boolean {
  const cwdName = basename(cwd);
  // Command must mention cwd (full path or basename as standalone token)
  const mentionsCwd = command.includes(cwd) ||
    new RegExp(`(?:\\s|/|^|=)${escapeRegex(cwdName)}(?:\\s|/|$)`, "u").test(command);
  if (!mentionsCwd) return false;
  return DELETE_PATTERNS.some((p) => p.test(command));
}

function cwdDeletionGuard(pi: ExtensionAPI) {
  pi.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | undefined> => {
    if (event.toolName !== "bash") return undefined;
    const command = (event.input as { command: string }).command;
    if (!command) return undefined;
    if (!wouldDeleteCwd(command, ctx.cwd)) return undefined;

    // Already warned within TTL → allow
    const lastWarn = deletionWarnCache.get(ctx.cwd);
    if (lastWarn && Date.now() - lastWarn < DELETION_WARN_TTL_MS) {
      return undefined;
    }

    // First warning → block and inject prompt
    deletionWarnCache.set(ctx.cwd, Date.now());

    const parts: string[] = [
      `WARNING: This command may delete your current working directory: ${ctx.cwd}`,
      "",
      "After deletion, the following tools become UNUSABLE in this session:",
      "  - bash (cannot spawn shell without cwd)",
      "  - grep, find, ls (resolve relative paths against cwd)",
      "Still available: read, write, edit (use absolute paths only).",
      "",
      "Before proceeding, consider:",
      "  - Is there any unfinished work to save or summarize?",
      "  - If this is merge-worktree cleanup, the merge and release are already done.",
      "    You can safely proceed. Start a new session in another worktree to continue.",
      "",
      "If intentional, re-execute the same command to proceed.",
      "This warning will not repeat for 1 hour.",
    ];

    return { block: true, reason: parts.join("\n") };
  });
}

// ============================================================================
// CWD Post-deletion Guard
// ============================================================================

function cwdGuard(pi: ExtensionAPI) {
  pi.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | undefined> => {
    if (!CWD_DEPENDENT_TOOLS.has(event.toolName)) return undefined;
    if (existsSync(ctx.cwd)) return undefined;

    const parts: string[] = [
      `Working directory has been deleted by another process: ${ctx.cwd}`,
      `Tool "${event.toolName}" cannot execute because it depends on cwd.`,
      "",
      "Still available: read, write, edit (use absolute paths).",
    ];

    // Provide worktree alternatives if this is a bare-repo workspace
    const workspaceRoot = detectWorkspaceRoot(ctx.cwd);
    if (workspaceRoot) {
      const worktreeList = await listWorktrees(pi, workspaceRoot);
      if (worktreeList) {
        parts.push("");
        parts.push(`Workspace: ${workspaceRoot}`);
        parts.push("Existing worktrees:");
        for (const line of worktreeList.split("\n")) {
          parts.push(`  ${line}`);
        }
        parts.push("");
        parts.push("To continue working, the user can:");
        parts.push("  1. Exit pi and restart in an existing worktree directory (e.g., cd workspace/main && pi)");
        parts.push("  2. Or use /newSession command to start a fresh session in a different directory");
      }
    } else {
      parts.push("");
      parts.push("To continue working, restart pi in an existing directory.");
    }

    return { block: true, reason: parts.join("\n") };
  });
}

export default function hooksExtension(pi: ExtensionAPI) {
  cwdDeletionGuard(pi);
  cwdGuard(pi);
  let lastTimestamp = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  pi.on("agent_end", async (_event, ctx) => {
    lastTimestamp = Date.now();
    ctx.ui.setStatus(
      STATUS_KEY,
      ctx.ui.theme.fg("dim", `last ${formatTime(lastTimestamp)}`),
    );
  });

  pi.on("session_start", async (_event, ctx) => {
    if (timer) clearInterval(timer);

    timer = setInterval(() => {
      if (lastTimestamp === 0) return;
      ctx.ui.setStatus(
        STATUS_KEY,
        ctx.ui.theme.fg("dim", `last ${formatTime(lastTimestamp)} (${formatElapsed(Date.now(), lastTimestamp)})`),
      );
    }, 10_000);
  });

  pi.on("session_shutdown", async () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  });
}
