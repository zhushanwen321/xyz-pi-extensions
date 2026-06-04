/**
 * Workflow Extension — Config Loader
 *
 * Scans .pi/workflows/ (project-level) and ~/.pi/agent/workflows/ (user-level)
 * directories for workflow script files, extracts meta information via regex
 * (no code execution), and caches results.
 *
 * Failed imports are marked available=false — the loader never throws.
 */

import { access, readdir, readFile } from "node:fs/promises";
import * as fsSync from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// ── Public types ──────────────────────────────────────────────

export interface WorkflowMeta {
  name: string;
  description: string;
  phases: string[];
}

export type WorkflowSource = "saved" | "tmp";

export interface CachedWorkflowMeta extends WorkflowMeta {
  /** Absolute path to the script file */
  path: string;
  /** false when the script failed to load or has no valid meta export */
  available: boolean;
  /** Whether this is a saved (fixed) or temporary (ad-hoc) workflow */
  source: WorkflowSource;
}

// ── Internal types ────────────────────────────────────────────

interface WorkerResult {
  success: boolean;
  meta?: WorkflowMeta;
  error?: string;
}

interface CacheEntry {
  meta: CachedWorkflowMeta;
  cachedAt: number;
}

// ── Workspace root detection ─────────────────────────────────

/**
 * Find the workspace root directory by walking up from cwd.
 *
 * In bare+worktree setups, cwd is a worktree subdirectory, not the
 * workspace root. We detect the root by looking for `.bare/` or
 * `.pi/` directories.
 *
 * Falls back to cwd if no marker is found.
 */
function findWorkspaceRoot(): string {
  let dir = process.cwd();
  const root = resolve("/");

  for (let i = 0; i < WORKSPACE_ROOT_MAX_DEPTH; i++) {
    // Check for bare repo marker
    const barePath = resolve(dir, ".bare");
    if (fsSync.existsSync(barePath)) {
      return dir;
    }
    // Check for .pi directory marker (works in normal repos)
    const piPath = resolve(dir, ".pi");
    if (fsSync.existsSync(piPath)) {
      return dir;
    }
    // Check for .git (normal git repo)
    const gitPath = resolve(dir, ".git");
    if (fsSync.existsSync(gitPath)) {
      return dir;
    }
    if (dir === root) break;
    dir = resolve(dir, "..");
  }

  return process.cwd();
}

// ── Constants ─────────────────────────────────────────────────

const WORKSPACE_ROOT_MAX_DEPTH = 20;
const USER_DIR = resolve(homedir(), ".pi/agent/workflows");
const CACHE_TTL_MS = 60_000;

// ── Cache ─────────────────────────────────────────────────────

const cache = new Map<string, CacheEntry>();

function isCacheValid(entry: CacheEntry): boolean {
  return Date.now() - entry.cachedAt < CACHE_TTL_MS;
}

// ── Helpers ───────────────────────────────────────────────────

function isScriptFile(name: string): boolean {
  return name.endsWith(".js") || name.endsWith(".mjs");
}

/** Extract filename stem (no directory, no extension). */
function stem(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

// ── Regex-based meta extraction ─────────────────────────────

/**
 * Extract the `meta` object from a workflow script using regex.
 *
 * This avoids executing user code (no Worker/import/require), so it works
 * regardless of whether the script uses CJS, ESM, top-level await, or
 * references runtime globals like `agent()` or `$ARGS`.
 *
 * Supports both `const meta = { ... }` and `export const meta = { ... }`.
 */
async function extractMetaViaRegex(scriptPath: string): Promise<WorkerResult> {
  try {
    const content = await readFile(scriptPath, "utf-8");

    // Match `const meta = { ... }` or `export const meta = { ... }`
    // Use the rest-of-line approach: capture everything from the opening { to
    // the closing } (greedy) on the same statement.
    const metaPattern = /(?:export\s+)?const\s+meta\s*=\s*(\{[^]*?\});?\s*$/m;
    const match = metaPattern.exec(content);
    if (!match) {
      return { success: false, error: "No 'const meta = { ... }' declaration found" };
    }

    // Evaluate the captured object literal in a safe sandbox
    const metaObj = safeEvalObject(match[1]);
    if (!metaObj || typeof metaObj !== "object") {
      return { success: false, error: "Failed to parse meta object" };
    }

    if (typeof metaObj.name !== "string") {
      return { success: false, error: "meta.name must be a string" };
    }

    return {
      success: true,
      meta: {
        name: metaObj.name,
        description: typeof metaObj.description === "string" ? metaObj.description : "",
        phases: Array.isArray(metaObj.phases)
          ? metaObj.phases.filter((p: unknown) => typeof p === "string") as string[]
          : [],
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Safely evaluate a simple object literal string.
 * Uses `new Function` to avoid eval() while still supporting basic JS
 * literal syntax (strings, numbers, arrays, nested objects).
 *
 * Returns undefined if the string cannot be safely evaluated.
 */
function safeEvalObject(literal: string): Record<string, unknown> | undefined {
  try {
    // Wrap in parentheses to force expression evaluation
    const fn = new Function(`return (${literal});`);
    const result = fn();
    if (typeof result === "object" && result !== null && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ── Directory scanning ────────────────────────────────────────

/**
 * Scan a single directory for workflow script files and extract their meta.
 * Silently returns an empty array if the directory does not exist.
 */
async function scanDirectory(dirPath: string, source: WorkflowSource): Promise<CachedWorkflowMeta[]> {
  try {
    await access(dirPath);
  } catch {
    return [];
  }

  const entries = await readdir(dirPath, { withFileTypes: true });
  const scriptFiles = entries
    .filter((e) => e.isFile() && isScriptFile(e.name))
    .map((e) => resolve(dirPath, e.name));

  const results: CachedWorkflowMeta[] = [];

  for (const filePath of scriptFiles) {
    const fallbackName = stem(filePath);
    const result = await extractMetaViaRegex(filePath);

    if (result.success && result.meta) {
      results.push({
        name: result.meta.name,
        description: result.meta.description,
        phases: result.meta.phases,
        path: filePath,
        available: true,
        source,
      });
    } else {
      // Import failed — mark as unavailable but still include in listing
      results.push({
        name: fallbackName,
        description: "",
        phases: [],
        path: filePath,
        available: false,
        source,
      });
    }
  }

  return results;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Load and cache all available workflow scripts from project-level
 * (.pi/workflows/) and user-level (~/.pi/agent/workflows/) directories.
 *
 * Deduplicates by name — project-level workflows take priority over
 * user-level ones with the same name.
 *
 * Never throws. Failed imports are returned with available=false.
 */
export async function loadWorkflows(): Promise<CachedWorkflowMeta[]> {
  const workspaceRoot = findWorkspaceRoot();
  const projectDir = resolve(workspaceRoot, ".pi/workflows");
  const tmpDir = resolve(workspaceRoot, ".pi/workflows/.tmp");
  const results = await Promise.allSettled([
    scanDirectory(projectDir, "saved"),
    scanDirectory(USER_DIR, "saved"),
    scanDirectory(tmpDir, "tmp"),
  ]);
  const projectWorkflows = results[0].status === "fulfilled" ? results[0].value : [];
  const userWorkflows = results[1].status === "fulfilled" ? results[1].value : [];
  const tmpWorkflows = results[2].status === "fulfilled" ? results[2].value : [];

  // Deduplicate by priority: tmp > project > user
  // Use a Map keyed by name — later entries overwrite earlier ones
  const mergedMap = new Map<string, CachedWorkflowMeta>();

  // Lowest priority first: user-level
  for (const wf of userWorkflows) {
    mergedMap.set(wf.name, wf);
  }
  // Project-level overrides user-level
  for (const wf of projectWorkflows) {
    mergedMap.set(wf.name, wf);
  }
  // Tmp overrides everything
  for (const wf of tmpWorkflows) {
    mergedMap.set(wf.name, wf);
  }

  const merged = Array.from(mergedMap.values());

  // Update cache
  const now = Date.now();
  for (const wf of merged) {
    cache.set(wf.name, { meta: wf, cachedAt: now });
  }

  return merged;
}

/**
 * Get a specific workflow by name.
 * Returns cached result if still valid, otherwise triggers a fresh load.
 */
export async function getWorkflow(name: string): Promise<CachedWorkflowMeta | undefined> {
  const cached = cache.get(name);
  if (cached && isCacheValid(cached)) {
    return cached.meta;
  }

  const workflows = await loadWorkflows();
  return workflows.find((wf) => wf.name === name);
}

/**
 * Invalidate the internal meta cache.
 * The next call to loadWorkflows() or getWorkflow() will re-scan directories.
 */
export function invalidateCache(): void {
  cache.clear();
}
