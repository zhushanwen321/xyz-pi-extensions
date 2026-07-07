/**
 * Workflow Extension — Config Loader
 *
 * Scans .pi/workflows/ (project-level) and ~/.pi/agent/workflows/ (user-level)
 * directories for workflow script files, extracts meta information via regex
 * (no code execution), and caches results.
 *
 * Failed imports are marked available=false — the loader never throws.
 */

import * as fsSync from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

// WorkflowMeta / WorkflowSource 的规范来源是 engine/models/workflow-script.ts
// （实体持有 meta）。infra 这里 re-export 是为了保持 loadWorkflows/getWorkflow
// 调用方的现有 import 路径不变（registry-impl、workflow-files、tests）。
import type { WorkflowMeta, WorkflowSource } from "../engine/models/workflow-script.js";
export type { WorkflowMeta, WorkflowSource };

// ── Public types ──────────────────────────────────────────────

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
  const dir = process.cwd();
  const root = resolve("/");

  // Phase 1: bare repo 优先——先全路径扫一遍找 .bare（repo 根特有标记），
  // 避免 monorepo 子包的 .pi/.git 在中间层拦截（如 extensions/workflow/.pi）。
  let probe = dir;
  for (let i = 0; i < WORKSPACE_ROOT_MAX_DEPTH; i++) {
    if (fsSync.existsSync(resolve(probe, ".bare"))) {
      return probe;
    }
    if (probe === root) break;
    probe = resolve(probe, "..");
  }

  // Phase 2: 无 .bare 时，找最顶层的 .git（普通 repo 根），而非第一个 .git。
  // 这样 monorepo 子包的 .pi 不会在中间层误停。
  let topLevel = dir;
  probe = dir;
  for (let i = 0; i < WORKSPACE_ROOT_MAX_DEPTH; i++) {
    if (fsSync.existsSync(resolve(probe, ".git"))) {
      topLevel = probe;
    }
    if (probe === root) break;
    probe = resolve(probe, "..");
  }
  if (topLevel !== dir) {
    return topLevel;
  }

  // Phase 3: fallback——用第一个遇到的 .pi（保留原行为，兼容非 git 项目）
  probe = dir;
  for (let i = 0; i < WORKSPACE_ROOT_MAX_DEPTH; i++) {
    if (fsSync.existsSync(resolve(probe, ".pi"))) {
      return probe;
    }
    if (probe === root) break;
    probe = resolve(probe, "..");
  }

  return process.cwd();
}

// ── Constants ─────────────────────────────────────────────────

const WORKSPACE_ROOT_MAX_DEPTH = 20;
const USER_DIR = resolve(homedir(), ".pi/agent/workflows");
const CACHE_TTL_MS = 60_000;

// ── Cache ─────────────────────────────────────────────────────

// P1-4: Keyed by workspace root so that switching projects does not
// serve stale entries. A single module-level Map is now segmented by
// `workspaceRoot`. invalidateCache clears all workspaces' entries.
const cache = new Map<string, Map<string, CacheEntry>>();

function getCacheBucket(workspaceRoot: string): Map<string, CacheEntry> {
  let bucket = cache.get(workspaceRoot);
  if (!bucket) {
    bucket = new Map<string, CacheEntry>();
    cache.set(workspaceRoot, bucket);
  }
  return bucket;
}

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
 * references runtime globals like `agent` or `$ARGS`.
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
          ? metaObj.phases.filter(
              (p: unknown) => typeof p === "string" || (typeof p === "object" && p !== null && "title" in p),
            ) as (string | { title: string; detail?: string })[]
          : [],
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Safely evaluate a simple object literal string.
 * Uses `new Function` to avoid eval while still supporting basic JS
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

// ── npm package manifest discovery ───────────────────────────

/**
 * Read and parse a package.json file, returning the pi.workflows array.
 * Returns undefined if the file doesn't exist or has no valid pi.workflows.
 */
async function readNpmPackageManifest(
  pkgDir: string,
): Promise<string[] | undefined> {
  const pkgJsonPath = resolve(pkgDir, "package.json");
  try {
    const content = await readFile(pkgJsonPath, "utf-8");
    const pkg = JSON.parse(content) as Record<string, unknown>;
    const pi = pkg.pi as Record<string, unknown> | undefined;
    if (!pi || !Array.isArray(pi.workflows)) {
      return undefined;
    }
    // 过滤非字符串元素（防 [123, null] 等畸形声明，review must_fix #3）
    return pi.workflows.filter((p): p is string => typeof p === "string");
  } catch {
    return undefined;
  }
}

/**
 * Scan npm packages in a node_modules directory for workflow scripts
 * declared in their pi.workflows manifest.
 *
 * Handles both scoped (@scope/pkg) and unscoped packages.
 * Returns workflows with source="saved".
 */
async function scanNpmPackageWorkflows(
  nodeModulesDir: string,
): Promise<CachedWorkflowMeta[]> {
  let entries: string[];
  try {
    entries = await readdir(nodeModulesDir);
  } catch {
    return [];
  }

  const results: CachedWorkflowMeta[] = [];

  for (const entry of entries) {
    const entryPath = resolve(nodeModulesDir, entry);

    if (entry.startsWith("@")) {
 // Scoped package — iterate children
      let scopedEntries: string[];
      try {
        scopedEntries = await readdir(entryPath);
      } catch {
        continue;
      }

      for (const scopedPkg of scopedEntries) {
        const scopedPkgDir = resolve(entryPath, scopedPkg);
        const workflows = await processNpmPackage(scopedPkgDir);
        results.push(...workflows);
      }
    } else {
 // Unscoped package
      const workflows = await processNpmPackage(entryPath);
      results.push(...workflows);
    }
  }

  return results;
}

/**
 * Process a single npm package: read its pi.workflows manifest and
 * load workflow scripts from the declared paths.
 */
async function processNpmPackage(
  pkgDir: string,
): Promise<CachedWorkflowMeta[]> {
  const workflowPaths = await readNpmPackageManifest(pkgDir);

  // manifest 模式：按声明路径加载
  if (workflowPaths) {
    const results: CachedWorkflowMeta[] = [];
    for (const relPath of workflowPaths) {
      const absPath = resolve(pkgDir, relPath);
      try {
        await access(absPath);
      } catch {
        continue;
      }
      const result = await extractMetaViaRegex(absPath);
      if (result.success && result.meta) {
        results.push({
          name: result.meta.name,
          description: result.meta.description,
          phases: result.meta.phases,
          path: absPath,
          available: true,
          source: "saved",
        });
      }
    }
    return results;
  }

  // fallback 模式：无 pi.workflows 声明时，扫描包内 workflows/ 目录（plan.md U2 要求）
  const fallbackDir = resolve(pkgDir, "workflows");
  return scanDirectory(fallbackDir, "saved");
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
 * 内部实现：从指定目录集加载 workflow，供测试注入 npmDirs。
 * 生产环境用 loadWorkflows()（固定全局目录）。
 */
async function loadWorkflowsFromDirs(options?: {
  npmDirs?: string[];
}): Promise<CachedWorkflowMeta[]> {
  const workspaceRoot = findWorkspaceRoot();
  const projectDir = resolve(workspaceRoot, ".pi/workflows");
  const tmpDir = resolve(workspaceRoot, ".pi/workflows/.tmp");

 // npm package locations to scan for pi.workflows manifest
  // 只扫全局 pi 扩展目录（Pi 扩展安装红线：npm install 只进 ~/.pi/agent/npm/node_modules）
  // 项目级 node_modules 是 pnpm workspace 依赖，不是 pi 扩展，不扫
  // 测试可通过 options.npmDirs 注入临时目录
  const npmDirs = options?.npmDirs ?? [
    resolve(homedir(), ".pi", "agent", "npm", "node_modules"),
  ];

 // Number of non-npm scan results (project, user, tmp)
  const NON_NPM_RESULT_COUNT = 3;

  const results = await Promise.allSettled([
    scanDirectory(projectDir, "saved"),
    scanDirectory(USER_DIR, "saved"),
    scanDirectory(tmpDir, "tmp"),
    ...npmDirs.map((dir) => scanNpmPackageWorkflows(dir)),
  ]);
  const projectWorkflows = results[0].status === "fulfilled" ? results[0].value : [];
  const userWorkflows = results[1].status === "fulfilled" ? results[1].value : [];
  const tmpWorkflows = results[2].status === "fulfilled" ? results[2].value : [];
  const npmWorkflows = results.slice(NON_NPM_RESULT_COUNT).flatMap((r) =>
    r.status === "fulfilled" ? r.value : [],
  );

 // Deduplicate by priority: tmp > project > npm > user
 // Use a Map keyed by name — later entries overwrite earlier ones
  const mergedMap = new Map<string, CachedWorkflowMeta>();

 // Lowest priority first: user-level
  for (const wf of userWorkflows) {
    mergedMap.set(wf.name, wf);
  }
 // npm package workflows override user-level
  for (const wf of npmWorkflows) {
    mergedMap.set(wf.name, wf);
  }
 // Project-level overrides npm
  for (const wf of projectWorkflows) {
    mergedMap.set(wf.name, wf);
  }
 // Tmp overrides everything
  for (const wf of tmpWorkflows) {
    mergedMap.set(wf.name, wf);
  }

  const merged = Array.from(mergedMap.values());

 // Update cache (scoped to current workspace root)
  const bucket = getCacheBucket(workspaceRoot);
  const now = Date.now();
  for (const wf of merged) {
    bucket.set(wf.name, { meta: wf, cachedAt: now });
  }

  return merged;
}

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
  return loadWorkflowsFromDirs();
}

/** 测试专用：注入 npmDirs 以隔离全局目录 */
export async function loadWorkflowsForTest(npmDirs: string[]): Promise<CachedWorkflowMeta[]> {
  return loadWorkflowsFromDirs({ npmDirs });
}

/**
 * Get a specific workflow by name.
 * Returns cached result if still valid, otherwise triggers a fresh load.
 */
export async function getWorkflow(name: string): Promise<CachedWorkflowMeta | undefined> {
  const workspaceRoot = findWorkspaceRoot();
  const bucket = getCacheBucket(workspaceRoot);
  const cached = bucket.get(name);
  if (cached && isCacheValid(cached)) {
    return cached.meta;
  }

  const workflows = await loadWorkflows();
  return workflows.find((wf) => wf.name === name);
}

/**
 * Invalidate the internal meta cache.
 * The next call to loadWorkflows or getWorkflow will re-scan directories.
 */
export function invalidateCache(): void {
  cache.clear();
}
