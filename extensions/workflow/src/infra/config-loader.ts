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
import { access, readdir, readFile, stat } from "node:fs/promises";
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
 * 判断 dir 是否是 workspaceRoot 的直接子目录（一层深度）。
 * 用于 bare+worktree 结构里识别 worktree 根：worktree 通常是 workspace
 * 根的直接子目录（如 `<ws>/main`、`<ws>/fix-coding-workflow`）。
 */
function isDirectChildOfWorkspaceRoot(dir: string, workspaceRoot: string): boolean {
  return resolve(dir, "..") === workspaceRoot;
}

/**
 * Find the workspace root directory by walking up from cwd.
 *
 * In bare+worktree setups, cwd is a worktree subdirectory, not the
 * workspace root. We detect the root by looking for `.bare/` or
 * `.pi/` directories.
 *
 * Falls back to cwd if no marker is found.
 */
function findWorkspaceRoot(cwd?: string): string {
  const dir = cwd ?? process.cwd();
  const root = resolve("/");

  // Phase 1: bare repo 优先——先全路径扫一遍找 .bare（repo 根特有标记），
  // 避免 monorepo 子包的 .pi/.git 在中间层拦截（如 extensions/workflow/.pi）。
  let probe = dir;
  for (let i = 0; i < WORKSPACE_ROOT_MAX_DEPTH; i++) {
    if (fsSync.existsSync(resolve(probe, ".bare"))) {
      // bare+worktree 结构里，worktree 是 workspace 根（.bare 所在层）的
      // 直接子目录。若 cwd 自身就是这样一个 worktree 根且有 .pi/，应优先
      // 用 cwd——否则用户把 project 级 .pi/workflows 放在当前 worktree 内
      // 会被忽略，registry 反直觉地去 workspace 根找。仅当 cwd 自身有 .pi
      // 才介入，避免无 .pi 的 worktree 误判（此时退回 workspace 根，保持
      // 原行为，让 workspace 级共享脚本仍可发现）。
      if (probe !== dir && isDirectChildOfWorkspaceRoot(dir, probe) && fsSync.existsSync(resolve(dir, ".pi"))) {
        return dir;
      }
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

  return dir;
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
 *
 * manifest 条目既可以是文件（`./workflows/foo.js`）也可以是目录
 * （`./workflows`）。目录声明走 `scanDirectory`，文件声明走
 * `extractMetaViaRegex`——历史上后者是唯一支持的模式，但实际
 * 包（如 pi-coding-workflow）声明的就是目录，导致 manifest 模式
 * 对目录 `readFile` 抛 EISDIR 后空转且不 fallback。
 */
async function processNpmPackage(
  pkgDir: string,
): Promise<CachedWorkflowMeta[]> {
  const workflowPaths = await readNpmPackageManifest(pkgDir);

  // manifest 模式：按声明路径加载（支持文件与目录两种条目）
  if (workflowPaths) {
    const results: CachedWorkflowMeta[] = [];
    for (const relPath of workflowPaths) {
      const absPath = resolve(pkgDir, relPath);
      // 用 stat 区分文件/目录——access 对目录不抛错，无法区分
      const fileStat = await stat(absPath).catch(() => null);
      if (!fileStat) continue;

      if (fileStat.isDirectory()) {
        // 目录声明走 scanDirectory，与 fallback 行为一致
        results.push(...await scanDirectory(absPath, "saved"));
      } else if (fileStat.isFile()) {
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
    }
    // manifest 全失败时 fallback 到硬编码目录，避免 manifest 声明
    // 错误（如全部路径不存在）导致包内合法脚本被整体埋没
    if (results.length > 0) return results;
  }

  // fallback 模式：无 pi.workflows 声明、或 manifest 全失败时，
  // 扫描包内 workflows/ 目录（plan.md U2 要求）
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
  const scriptFiles: string[] = [];
  for (const e of entries) {
    if (!isScriptFile(e.name)) continue;
    const absPath = resolve(dirPath, e.name);
    // Dirent.isFile() 对 symlink 返回 false，会漏掉用 symlink 管理的
    // 脚本（dotfiles/多机同步常见）。对 symlink 调 stat（follow）确认
    // 指向的是普通文件才纳入——避免把指向目录的 symlink 当脚本。
    if (e.isFile()) {
      scriptFiles.push(absPath);
    } else if (e.isSymbolicLink()) {
      const targetStat = await stat(absPath).catch(() => null);
      if (targetStat?.isFile()) scriptFiles.push(absPath);
    }
  }

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
 * workflow 发现的扫描配置。每个字段显式声明一个扫描源目录。
 *
 * 生产环境用 defaultScanConfig() 构造默认值（全局 ~/.pi/agent/* 目录）。
 * 测试/隔离环境构造完整 config 指向 tmp 目录，完全不碰全局文件系统。
 */
export interface WorkflowScanConfig {
  /** 项目级脚本目录（workspaceRoot/.pi/workflows） */
  projectDir: string;
  /** user 级脚本目录（~/.pi/agent/workflows） */
  userDir: string;
  /** 临时脚本目录（workspaceRoot/.pi/workflows/.tmp） */
  tmpDir: string;
  /** npm 包扫描目录（~/.pi/agent/npm/node_modules 等） */
  npmDirs: string[];
}

/**
 * 生产默认扫描配置：从 cwd 推导 workspaceRoot，拼接标准目录。
 * 缺省 cwd 时用 process.cwd()。
 */
function defaultScanConfig(cwd?: string): WorkflowScanConfig {
  const workspaceRoot = findWorkspaceRoot(cwd);
  return {
    projectDir: resolve(workspaceRoot, ".pi/workflows"),
    tmpDir: resolve(workspaceRoot, ".pi/workflows/.tmp"),
    userDir: USER_DIR,
    // 扫两条路径：
    //   1. ~/.pi/agent/npm/node_modules — 正式 npm 安装的扩展（pi install npm:xxx）
    //   2. ~/.pi/agent/extensions/ — dev symlink 的扩展（本地开发模式）
    // 项目级 node_modules 是 pnpm workspace 依赖，不是 pi 扩展，不扫
    npmDirs: [
      resolve(homedir(), ".pi", "agent", "npm", "node_modules"),
      resolve(homedir(), ".pi", "agent", "extensions"),
    ],
  };
}

/**
 * 从指定 config 扫描所有 workflow 脚本，按 tmp>project>npm>user 优先级
 * 去重，60s TTL 缓存（按 workspaceRoot 分桶）。
 *
 * 这是生产/测试唯一的发现入口。传入完整 config 时只扫声明的目录；
 * 传部分 config 或空对象时，缺省字段用 defaultScanConfig(cwd) 补全。
 *
 * Never throws. 解析失败的脚本以 available=false 返回。
 *
 * @param configOrCwd 完整 WorkflowScanConfig（隔离用）、部分字段（覆盖默认）、
 *                   或省略（纯生产默认）。可选 cwd 用于推导 workspaceRoot。
 */
export async function discoverWorkflows(
  configOrCwd?: Partial<WorkflowScanConfig> & { cwd?: string },
): Promise<CachedWorkflowMeta[]> {
  const cwd = configOrCwd?.cwd;
  const defaults = defaultScanConfig(cwd);
  const config: WorkflowScanConfig = {
    projectDir: configOrCwd?.projectDir ?? defaults.projectDir,
    userDir: configOrCwd?.userDir ?? defaults.userDir,
    tmpDir: configOrCwd?.tmpDir ?? defaults.tmpDir,
    npmDirs: configOrCwd?.npmDirs ?? defaults.npmDirs,
  };

  // 缓存 bucket key：用 config 推导出的 workspaceRoot（与 projectDir 同源）
  const workspaceRoot = resolve(config.projectDir, "../..");

  // Number of non-npm scan results (project, user, tmp)
  const NON_NPM_RESULT_COUNT = 3;

  const results = await Promise.allSettled([
    scanDirectory(config.projectDir, "saved"),
    scanDirectory(config.userDir, "saved"),
    scanDirectory(config.tmpDir, "tmp"),
    ...config.npmDirs.map((dir) => scanNpmPackageWorkflows(dir)),
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
 * discoverWorkflows() 的生产 preset——用全局默认目录。
 *
 * Deduplicates by name — project-level workflows take priority over
 * user-level ones with the same name.
 *
 * Never throws. Failed imports are returned with available=false.
 */
export async function loadWorkflows(): Promise<CachedWorkflowMeta[]> {
  return discoverWorkflows();
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
