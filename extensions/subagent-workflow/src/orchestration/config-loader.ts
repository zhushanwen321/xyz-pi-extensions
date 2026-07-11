/**
 * Workflow Config Loader — 统一资源发现版（ADR-031）
 *
 * 扫描逻辑委托给 shared/resource-discovery（与 agent 发现共享同一套扫描源）。
 * 本文件只保留 workflow 专属的 meta 提取（regex）+ 60s TTL 缓存。
 *
 * Failed imports are marked available=false — the loader never throws.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// WorkflowMeta / WorkflowSource 的规范来源是 engine/models/workflow-script.ts
import type { WorkflowMeta, WorkflowSource } from "./models/workflow-script.ts";
export type { WorkflowMeta, WorkflowSource };

import { getAgentDir } from "@mariozechner/pi-coding-agent";

import {
  discoverResources,
  findWorkspaceRoot,
  type ResourceSource,
  type ScanConfig,
} from "../shared/resource-discovery.ts";

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

// ── Constants ─────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;

// ── Cache ─────────────────────────────────────────────────────

// Keyed by workspace root so that switching projects does not serve stale entries.
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

    const metaPattern = /(?:export\s+)?const\s+meta\s*=\s*(\{[^]*?\});?\s*$/m;
    const match = metaPattern.exec(content);
    if (!match) {
      return { success: false, error: "No 'const meta = { ... }' declaration found" };
    }

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
 */
function safeEvalObject(literal: string): Record<string, unknown> | undefined {
  try {
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

// ── ResourceSource → WorkflowSource 映射 ─────────────────────

/** 统一模块的 ResourceSource 映射为 workflow 的 saved/tmp 语义 */
function toWorkflowSource(source: ResourceSource): WorkflowSource {
  return source === "project-pi-tmp" ? "tmp" : "saved";
}

// ── 单文件 → CachedWorkflowMeta ───────────────────────────────

/** 提取单个文件的 meta，失败时标 available=false（与原行为一致） */
async function toCachedMeta(
  filePath: string,
  source: ResourceSource,
): Promise<CachedWorkflowMeta> {
  const fallbackName = stem(filePath);
  const result = await extractMetaViaRegex(filePath);
  const wfSource = toWorkflowSource(source);

  if (result.success && result.meta) {
    return {
      name: result.meta.name,
      description: result.meta.description,
      phases: result.meta.phases,
      path: filePath,
      available: true,
      source: wfSource,
    };
  }

  return {
    name: fallbackName,
    description: "",
    phases: [],
    path: filePath,
    available: false,
    source: wfSource,
  };
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
 * 把 WorkflowScanConfig 转为统一模块的 ScanConfig。
 *
 * 测试隔离场景下传入完整 config——此时按声明的 projectDir/tmpDir 反推
 * workspaceRoot（与原行为一致：resolve(config.projectDir, "../..")）。
 * 生产场景（省略或部分 config）走 findWorkspaceRoot(cwd)。
 */
function toScanConfig(
  configOrCwd: Partial<WorkflowScanConfig> & { cwd?: string } | undefined,
): ScanConfig {
  // 测试隔离：传入了 projectDir，直接反推 workspaceRoot
  if (configOrCwd?.projectDir) {
    const workspaceRoot = resolve(configOrCwd.projectDir, "../..");
    return {
      kind: "workflows",
      workspaceRoot,
      agentDir: "test-no-agent-dir",
      includeTmp: true,
    };
  }

  // 生产默认
  const cwd = configOrCwd?.cwd;
  const workspaceRoot = findWorkspaceRoot(cwd);
  return {
    kind: "workflows",
    workspaceRoot,
    agentDir: getAgentDir(),
    includeTmp: true,
  };
}

/**
 * 从指定 config 扫描所有 workflow 脚本，按 tmp>project>npm>user 优先级
 * 去重，60s TTL 缓存（按 workspaceRoot 分桶）。
 *
 * 扫描逻辑委托给 shared/resource-discovery（与 agent 发现共享同一套扫描源）。
 *
 * Never throws. 解析失败的脚本以 available=false 返回。
 *
 * @param configOrCwd 完整 WorkflowScanConfig（隔离用）、部分字段（覆盖默认）、
 *                   或省略（纯生产默认）。可选 cwd 用于推导 workspaceRoot。
 */
export async function discoverWorkflows(
  configOrCwd?: Partial<WorkflowScanConfig> & { cwd?: string },
): Promise<CachedWorkflowMeta[]> {
  const scanConfig = toScanConfig(configOrCwd);
  const workspaceRoot = scanConfig.workspaceRoot;

  // 统一发现：返回已去重的资源列表（按优先级合并）
  const resources = await discoverResources(scanConfig);

  // 提取 meta（逐文件）
  const mergedMap = new Map<string, CachedWorkflowMeta>();
  for (const resource of resources) {
    const cachedMeta = await toCachedMeta(resource.path, resource.source);
    // available=false 的不覆盖已有的 available=true（与统一模块逻辑一致）
    if (!cachedMeta.available && mergedMap.has(cachedMeta.name)) {
      continue;
    }
    mergedMap.set(cachedMeta.name, cachedMeta);
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
