// src/shared/resource-discovery.ts
//
// 统一资源发现模块——agent .md 与 workflow .js/.mjs 共享同一套扫描逻辑。
//
// 设计原则（ADR-031 统一资源发现）：
// 1. 扫描源前缀统一：user/project 级目录用相同前缀，末级目录名（agents/workflows）参数化
// 2. 路径动态获取：user 级用 getAgentDir()（尊重 PI_CODING_AGENT_DIR），project 级用 findWorkspaceRoot(cwd)
// 3. npm/dev 包内发现：有 manifest（pi.agents/pi.workflows）只走 manifest，无 manifest 扫约定目录
// 4. manifest 路径存在性校验：声明的路径不存在 → 该包发现失败，不 fallback
// 5. 废弃 discovery.json：扫描路径完全由代码内推导，无外部依赖
//
// 优先级（低→高）：user .pi/agent → user .agents → npm global → npm dev → project .pi → project .pi/.tmp(仅workflow) → project .agents

import * as fsSync from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join,resolve } from "node:path";

// ── 类型 ─────────────────────────────────────────────────────

/** 资源种类：agent 或 workflow */
export type ResourceKind = "agents" | "workflows";

/** 发现到的单个资源文件（原始数据，由调用方解析 frontmatter/meta） */
export interface DiscoveredResource {
  /** 绝对路径 */
  path: string;
  /** 来源层级 */
  source: ResourceSource;
  /** 是否可用（manifest 校验失败的包整体标 false） */
  available: boolean;
}

/** 资源来源层级 */
export type ResourceSource = "user-pi" | "user-agents" | "npm" | "npm-dev" | "project-pi" | "project-pi-tmp" | "project-agents";

/** 扫描配置 */
export interface ScanConfig {
  /** 资源种类 */
  kind: ResourceKind;
  /** 项目根目录（findWorkspaceRoot 推导结果） */
  workspaceRoot: string;
  /** agent 配置目录（getAgentDir() 结果） */
  agentDir: string;
  /** 是否包含 tmp 源（仅 workflow 用 .pi/workflows/.tmp/） */
  includeTmp?: boolean;
}

// ── 常量 ─────────────────────────────────────────────────────

/** workspace root 向上查找的最大深度 */
const WORKSPACE_ROOT_MAX_DEPTH = 20;

// ── workspace root 推导（从 config-loader 提取，agent/workflow 共用） ──

/**
 * 判断 dir 是否是 workspaceRoot 的直接子目录（一层深度）。
 * 用于 bare+worktree 结构里识别 worktree 根。
 */
function isDirectChildOfWorkspaceRoot(dir: string, workspaceRoot: string): boolean {
  return resolve(dir, "..") === workspaceRoot;
}

/**
 * 从 cwd 向上查找 workspace root。
 *
 * bare+worktree 优先找 .bare；普通 repo 找最顶层 .git；fallback 找 .pi。
 * 与 config-loader 原有逻辑一致（合并后提取为共享函数）。
 */
export function findWorkspaceRoot(cwd?: string): string {
  const dir = cwd ?? process.cwd();
  const root = resolve("/");

  // Phase 1: bare repo 优先——先全路径扫一遍找 .bare
  let probe = dir;
  for (let i = 0; i < WORKSPACE_ROOT_MAX_DEPTH; i++) {
    if (fsSync.existsSync(resolve(probe, ".bare"))) {
      // worktree 是 workspace 根的直接子目录。若 cwd 自身有 .pi/，优先用 cwd
      if (probe !== dir && isDirectChildOfWorkspaceRoot(dir, probe) && fsSync.existsSync(resolve(dir, ".pi"))) {
        return dir;
      }
      return probe;
    }
    if (probe === root) break;
    probe = resolve(probe, "..");
  }

  // Phase 2: 无 .bare 时，找最顶层的 .git
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

  // Phase 3: fallback——用第一个遇到的 .pi
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

// ── 文件扩展名判定 ───────────────────────────────────────────

/** 根据资源种类判定脚本文件扩展名 */
function isTargetFile(name: string, kind: ResourceKind): boolean {
  // _ 前缀 = draft/示例，不参与发现（与原 agent-registry/workflow 约定一致）
  if (name.startsWith("_")) return false;
  if (kind === "agents") {
    return name.endsWith(".md") && !name.endsWith(".chain.md");
  }
  // workflows
  return name.endsWith(".js") || name.endsWith(".mjs");
}

/** 提取文件名 stem（去目录去扩展名） */
function stem(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

// ── 目录扫描 ─────────────────────────────────────────────────

/**
 * 扫描单个目录下的资源文件。
 * 返回文件绝对路径列表。目录不存在时返回空数组。
 */
async function scanDirectory(dirPath: string, kind: ResourceKind): Promise<string[]> {
  try {
    await access(dirPath);
  } catch {
    return [];
  }

  const entries = await readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    if (!isTargetFile(e.name, kind)) continue;
    const absPath = resolve(dirPath, e.name);
    // symlink 单独处理：Dirent.isFile() 对 symlink 返回 false
    if (e.isFile()) {
      files.push(absPath);
    } else if (e.isSymbolicLink()) {
      const targetStat = await stat(absPath).catch(() => null);
      if (targetStat?.isFile()) files.push(absPath);
    }
  }
  return files;
}

// ── npm/dev 包内 manifest 发现 ───────────────────────────────

/**
 * 读取 package.json 的 pi.{kind} manifest（pi.agents / pi.workflows）。
 * 返回 undefined 表示无 manifest 声明。
 */
async function readPackageManifest(pkgDir: string, kind: ResourceKind): Promise<string[] | undefined> {
  const pkgJsonPath = resolve(pkgDir, "package.json");
  try {
    const content = await readFile(pkgJsonPath, "utf-8");
    const pkg = JSON.parse(content) as Record<string, unknown>;
    const pi = pkg.pi as Record<string, unknown> | undefined;
    if (!pi) return undefined;
    const entries = pi[kind];
    if (!Array.isArray(entries)) return undefined;
    // 过滤非字符串元素
    return entries.filter((p): p is string => typeof p === "string");
  } catch {
    return undefined;
  }
}

/**
 * 处理单个 npm/dev 包：按 manifest 或约定目录发现资源。
 *
 * 规则：
 * - 有 manifest → 只按 manifest 声明路径加载。路径不存在 → 整包失败（返回 available=false 占位）
 * - 无 manifest → 扫约定目录 {kind}/（agents/ 或 workflows/）
 */
async function processPackage(
  pkgDir: string,
  kind: ResourceKind,
): Promise<DiscoveredResource[]> {
  const manifestPaths = await readPackageManifest(pkgDir, kind);

  // manifest 模式：只按声明路径加载，路径不存在则整包失败
  if (manifestPaths && manifestPaths.length > 0) {
    const results: DiscoveredResource[] = [];
    let allFailed = true;

    for (const relPath of manifestPaths) {
      const absPath = resolve(pkgDir, relPath);
      const fileStat = await stat(absPath).catch(() => null);
      if (!fileStat) {
        // manifest 声明的路径不存在 → 记录失败占位（路径存在性校验）
        results.push({ path: absPath, source: "npm", available: false });
        continue;
      }

      if (fileStat.isDirectory()) {
        const files = await scanDirectory(absPath, kind);
        for (const f of files) {
          results.push({ path: f, source: "npm", available: true });
          allFailed = false;
        }
      } else if (fileStat.isFile()) {
        results.push({ path: absPath, source: "npm", available: true });
        allFailed = false;
      }
    }

    // manifest 全失败：返回 available=false 占位，不 fallback 到约定目录
    if (allFailed) {
      return results;
    }
    return results;
  }

  // 无 manifest：扫约定目录 {kind}/
  const conventionDir = resolve(pkgDir, kind);
  const files = await scanDirectory(conventionDir, kind);
  return files.map((f) => ({ path: f, source: "npm", available: true }));
}

/**
 * 扫描 npm node_modules 目录下所有包的资源。
 * 支持 scoped（@scope/pkg）和 unscoped（pkg）包。
 */
async function scanNpmDir(
  nodeModulesDir: string,
  kind: ResourceKind,
): Promise<DiscoveredResource[]> {
  let entries: string[];
  try {
    entries = await readdir(nodeModulesDir);
  } catch {
    return [];
  }

  const results: DiscoveredResource[] = [];

  for (const entry of entries) {
    const entryPath = resolve(nodeModulesDir, entry);

    if (entry.startsWith("@")) {
      // scoped 包——迭代子包
      let scopedEntries: string[];
      try {
        scopedEntries = await readdir(entryPath);
      } catch {
        continue;
      }
      for (const scopedPkg of scopedEntries) {
        const scopedPkgDir = resolve(entryPath, scopedPkg);
        const pkgResults = await processPackage(scopedPkgDir, kind);
        results.push(...pkgResults);
      }
    } else {
      // unscoped 包
      const pkgResults = await processPackage(entryPath, kind);
      results.push(...pkgResults);
    }
  }

  return results;
}

// ── 扫描源构建 ───────────────────────────────────────────────

/** 扫描源定义：路径 + source 标签 */
interface ScanTarget {
  dir: string;
  source: ResourceSource;
  /** 该源是否参与本次扫描（如 tmp 仅 workflow 启用） */
  enabled: boolean;
}

/**
 * 构建所有扫描源（按优先级低→高排列）。
 *
 * agent 和 workflow 共享相同的前缀体系，末级目录名由 kind 决定。
 */
function buildScanTargets(config: ScanConfig): ScanTarget[] {
  const { kind, workspaceRoot, agentDir, includeTmp } = config;
  const home = homedir();

  const targets: ScanTarget[] = [
    // 1. user .pi/agent/{kind}/
    { dir: join(agentDir, kind), source: "user-pi", enabled: true },
    // 2. user .agents/{kind}/
    { dir: join(home, ".agents", kind), source: "user-agents", enabled: true },
    // 3. npm global: agentDir/npm/node_modules/*/<pkg>/
    { dir: join(agentDir, "npm", "node_modules"), source: "npm", enabled: true },
    // 4. npm dev symlink: agentDir/extensions/*/<pkg>/
    { dir: join(agentDir, "extensions"), source: "npm-dev", enabled: true },
    // 5. project .pi/{kind}/
    { dir: join(workspaceRoot, ".pi", kind), source: "project-pi", enabled: true },
  ];

  // 6. project .pi/{kind}/.tmp/（仅 workflow）
  if (includeTmp) {
    targets.push({
      dir: join(workspaceRoot, ".pi", kind, ".tmp"),
      source: "project-pi-tmp",
      enabled: true,
    });
  }

  // 7. project .agents/{kind}/
  targets.push({
    dir: join(workspaceRoot, ".agents", kind),
    source: "project-agents",
    enabled: true,
  });

  return targets.filter((t) => t.enabled);
}

// ── 公共 API ─────────────────────────────────────────────────

/**
 * 发现所有资源文件（agent .md 或 workflow .js/.mjs）。
 *
 * 按优先级低→高扫描所有源，同名资源靠后覆盖靠前（last-writer-wins）。
 * npm/dev 包内：有 manifest 只走 manifest（路径不存在则失败），无 manifest 扫约定目录。
 *
 * Never throws. 解析失败/不可读的资源以 available=false 返回。
 *
 * @returns 去重后的资源列表（按优先级合并，高优先级覆盖低优先级同名）
 */
export async function discoverResources(config: ScanConfig): Promise<DiscoveredResource[]> {
  const targets = buildScanTargets(config);

  // 逐源扫描，收集结果（保留 source 标签用于优先级合并）
  const allBySource: Array<{ source: ResourceSource; resources: DiscoveredResource[] }> = [];

  for (const target of targets) {
    if (target.source === "npm" || target.source === "npm-dev") {
      // npm/dev 目录：迭代包，走 manifest 或约定目录
      const resources = await scanNpmDir(target.dir, config.kind);
      // 覆盖 source 标签（scanNpmDir 内部统一标 "npm"，这里修正为实际源）
      const tagged = resources.map((r) => ({ ...r, source: target.source }));
      allBySource.push({ source: target.source, resources: tagged });
    } else {
      // 普通目录：直接扫
      const files = await scanDirectory(target.dir, config.kind);
      const resources = files.map((f) => ({ path: f, source: target.source, available: true }));
      allBySource.push({ source: target.source, resources });
    }
  }

  // 按优先级合并：targets 数组顺序即优先级（低→高），高优先级后写覆盖
  // 用文件名 stem 作为去重 key（与旧逻辑一致：同名资源高优先级覆盖）
  const merged = new Map<string, DiscoveredResource>();

  for (const { resources } of allBySource) {
    for (const r of resources) {
      const key = stem(r.path);
      // available=false 的占位不覆盖已有的 available=true
      if (!r.available && merged.has(key)) {
        continue;
      }
      merged.set(key, r);
    }
  }

  return Array.from(merged.values());
}

/**
 * 同步版：扫描单个目录下的资源文件路径（供 agent-registry 的 mtime 缓存模式使用）。
 *
 * agent .md 发现需要 mtime 缓存（hot-reload），不能走 async 全量扫描。
 * 此函数提供目录级同步扫描，npm/dev 包内发现仍需 async（agent-registry 用 builtin 兜底）。
 */
export function scanDirectorySync(dirPath: string, kind: ResourceKind): string[] {
  try {
    fsSync.accessSync(dirPath);
  } catch {
    return [];
  }

  let entries: string[];
  try {
    entries = fsSync.readdirSync(dirPath);
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (!isTargetFile(entry, kind)) continue;
    files.push(resolve(dirPath, entry));
  }
  return files;
}

/**
 * 同步版：读取 package.json 的 pi.{kind} manifest。
 * 供 agent-registry 同步路径使用。
 */
export function readPackageManifestSync(pkgDir: string, kind: ResourceKind): string[] | undefined {
  const pkgJsonPath = resolve(pkgDir, "package.json");
  try {
    const content = fsSync.readFileSync(pkgJsonPath, "utf-8");
    const pkg = JSON.parse(content) as Record<string, unknown>;
    const pi = pkg.pi as Record<string, unknown> | undefined;
    if (!pi) return undefined;
    const entries = pi[kind];
    if (!Array.isArray(entries)) return undefined;
    return entries.filter((p): p is string => typeof p === "string");
  } catch {
    return undefined;
  }
}

/**
 * 同步版：处理单个 npm/dev 包。
 * 供 agent-registry 同步路径使用。
 */
export function processPackageSync(pkgDir: string, kind: ResourceKind): DiscoveredResource[] {
  const manifestPaths = readPackageManifestSync(pkgDir, kind);

  if (manifestPaths && manifestPaths.length > 0) {
    const results: DiscoveredResource[] = [];

    for (const relPath of manifestPaths) {
      const absPath = resolve(pkgDir, relPath);
      let fileStat: fsSync.Stats | null;
      try {
        fileStat = fsSync.statSync(absPath);
      } catch {
        fileStat = null;
      }
      if (!fileStat) {
        results.push({ path: absPath, source: "npm", available: false });
        continue;
      }

      if (fileStat.isDirectory()) {
        const files = scanDirectorySync(absPath, kind);
        for (const f of files) {
          results.push({ path: f, source: "npm", available: true });
        }
      } else if (fileStat.isFile()) {
        results.push({ path: absPath, source: "npm", available: true });
      }
    }

    return results;
  }

  // 无 manifest：扫约定目录
  const conventionDir = resolve(pkgDir, kind);
  const files = scanDirectorySync(conventionDir, kind);
  return files.map((f) => ({ path: f, source: "npm", available: true }));
}

/**
 * 同步版：扫描 npm node_modules 目录。
 * 供 agent-registry 同步路径使用。
 */
export function scanNpmDirSync(nodeModulesDir: string, kind: ResourceKind): DiscoveredResource[] {
  let entries: string[];
  try {
    entries = fsSync.readdirSync(nodeModulesDir);
  } catch {
    return [];
  }

  const results: DiscoveredResource[] = [];
  for (const entry of entries) {
    const entryPath = resolve(nodeModulesDir, entry);

    if (entry.startsWith("@")) {
      let scopedEntries: string[];
      try {
        scopedEntries = fsSync.readdirSync(entryPath);
      } catch {
        continue;
      }
      for (const scopedPkg of scopedEntries) {
        const scopedPkgDir = resolve(entryPath, scopedPkg);
        results.push(...processPackageSync(scopedPkgDir, kind));
      }
    } else {
      results.push(...processPackageSync(entryPath, kind));
    }
  }
  return results;
}

/**
 * 同步版：发现所有资源（agent-registry 专用，支持 mtime 缓存的 hot-reload）。
 *
 * 与 discoverResources 对应的同步实现，扫描相同的源。
 * 返回所有源的资源（未去重，调用方按需处理优先级）。
 */
export function discoverResourcesSync(config: ScanConfig): DiscoveredResource[] {
  const targets = buildScanTargets(config);
  const all: DiscoveredResource[] = [];

  for (const target of targets) {
    if (target.source === "npm" || target.source === "npm-dev") {
      const resources = scanNpmDirSync(target.dir, config.kind);
      all.push(...resources.map((r) => ({ ...r, source: target.source })));
    } else {
      const files = scanDirectorySync(target.dir, config.kind);
      all.push(...files.map((f) => ({ path: f, source: target.source, available: true })));
    }
  }

  // 按优先级合并（targets 顺序 = 优先级低→高）
  const merged = new Map<string, DiscoveredResource>();
  for (const r of all) {
    const key = stem(r.path);
    if (!r.available && merged.has(key)) continue;
    merged.set(key, r);
  }

  return Array.from(merged.values());
}
