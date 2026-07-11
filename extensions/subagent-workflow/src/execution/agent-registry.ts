// src/execution/agent-registry.ts
//
// agent .md 文件发现与解析。
//
// 发现逻辑统一走 shared/resource-discovery（ADR-031），与 workflow 共享同一套
// 扫描源前缀 + manifest 校验。hot-reload：每次调用重扫（mtime 缓存跳过未变文件）。
//
// builtin agent（包内 agents/*.md）走 pi.agents manifest（与 npm 包内发现规则一致）。

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type DiscoveredResource,
  discoverResourcesSync,
  type ScanConfig,
} from "../shared/resource-discovery.ts";
import type { AgentConfig } from "./model-resolver.ts";

/** 内置 agent（代码硬编码，如 default worker）。 */
export interface BuiltinAgentRegistry {
  get(name: string): AgentConfig | undefined;
  list(): string[];
}

/**
 * 包内自带 agents（与 src/ 同级的 agents/ 目录）。
 *
 * 走 pi.agents manifest（package.json 的 pi.agents 字段），与 npm 包内发现规则一致。
 * manifest 缺失时 fallback 扫约定目录 agents/。
 *
 * [HISTORICAL] 此前 discoverAll 从未被调用，agentRegistry 永远为空——包内
 * agents/*.md（worker/reviewer/scout 等）pi install 后开箱不可用。修复：构造时扫描
 * 包内 agents/ 作为 builtin（优先级最低，被用户同名文件覆盖）。
 */
export function createPackageBuiltinRegistry(): BuiltinAgentRegistry {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  const cache = new Map<string, AgentConfig>();
  try {
    const config = discoverPackageAgentsSync(packageRoot);
    for (const resource of config) {
      if (!resource.available) continue;
      try {
        const raw = fs.readFileSync(resource.path, "utf-8");
        const agentConfig = parseAgentFrontmatter(resource.path, raw);
        if (agentConfig) cache.set(agentConfig.name, agentConfig);
      } catch (err) {
        // 单个 builtin agent 文件损坏不影响其他——降级跳过该文件。
        void err;
        console.warn(`[subagents] skip malformed builtin agent: ${resource.path}`, err);
      }
    }
  } catch (err) {
    // agents/ 目录不存在（打包遗漏）→ 空 builtin，不崩。
    void err;
    console.warn("[subagents] builtin agents/ directory unreadable, falling back to empty set:", err);
  }
  return {
    get: (name) => cache.get(name),
    list: () => [...cache.keys()],
  };
}

/** mtime 缓存条目（跨 discoverAll 保留，靠 mtime 判失效）。 */
interface FileCacheEntry {
  mtimeMs: number;
  config: AgentConfig;
}

// ============================================================
// frontmatter 解析
// ============================================================

/** frontmatter 分隔符。 */
const FM_DELIM = "---";

/**
 * 解析 .md frontmatter（name/tools/model/thinkingLevel/defaultBackground）+ body（systemPrompt）。
 * 兼容简单 YAML（key: value 单行格式）。body 作为 systemPrompt。
 */
export function parseAgentFrontmatter(filePath: string, content: string): AgentConfig {
  const name = path.basename(filePath, ".md");

  // 无 frontmatter → 整个内容作为 systemPrompt
  if (!content.startsWith(FM_DELIM)) {
    return { name, systemPrompt: content.trim() };
  }

  const closeIdx = content.indexOf(FM_DELIM, FM_DELIM.length);
  if (closeIdx === -1) {
    // 未闭合 frontmatter：提取 name，其余作为 systemPrompt
    const yamlBlock = content.slice(FM_DELIM.length);
    return {
      name: extractYamlField(yamlBlock, "name") ?? name,
      systemPrompt: content.trim(),
    };
  }

  const yamlBlock = content.slice(FM_DELIM.length, closeIdx);
  const body = content.slice(closeIdx + FM_DELIM.length).trim();

  const toolsRaw = extractYamlField(yamlBlock, "tools");
  const tools = toolsRaw
    ? toolsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  const defaultBackgroundRaw = extractYamlField(yamlBlock, "defaultBackground");

  return {
    name: extractYamlField(yamlBlock, "name") ?? name,
    systemPrompt: body,
    model: extractYamlField(yamlBlock, "model") ?? undefined,
    thinkingLevel: extractYamlField(yamlBlock, "thinkingLevel") ?? undefined,
    tools: tools && tools.length > 0 ? tools : undefined,
    defaultBackground: defaultBackgroundRaw === "true" ? true : undefined,
  };
}

/** 提取简单 `key: value` 字段，剥离引号。 */
function extractYamlField(yaml: string, key: string): string | undefined {
  const regex = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const match = yaml.match(regex);
  if (!match) return undefined;
  let value = match[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value || undefined;
}

// ============================================================
// AgentRegistry
// ============================================================

/**
 * 发现配置：用于统一资源发现的扫描参数。
 */
export interface AgentDiscoveryConfig {
  /** 项目根目录（findWorkspaceRoot 推导结果） */
  workspaceRoot: string;
  /** agent 配置目录（getAgentDir() 结果） */
  agentDir: string;
}

/**
 * agent 注册表。通过统一资源发现（shared/resource-discovery）扫描所有源。
 * hot-reload：每次 discoverAll 重扫，mtime 未变的文件跳过 read+parse。
 *
 * 优先级（低→高）：user .pi/agent → user .agents → npm global → npm dev →
 * project .pi → project .agents。builtin（包内）优先级最低。
 * 详见 ADR-031。
 */
export class AgentRegistry {
  private readonly cache = new Map<string, AgentConfig>();
  /** 文件级 mtime 缓存（key=绝对路径，跨 discoverAll 保留）。 */
  private readonly fileCache = new Map<string, FileCacheEntry>();
  /** 本轮扫描到的路径集（清理已删除文件的缓存）。 */
  private currentScanPaths = new Set<string>();

  constructor(private readonly discoveryConfig: AgentDiscoveryConfig) {}

  /** 扫描所有源 + 合并 builtin（hot-reload，每次重扫）。 */
  discoverAll(builtin: BuiltinAgentRegistry): void {
    this.cache.clear();
    this.currentScanPaths = new Set();

    const scanConfig: ScanConfig = {
      kind: "agents",
      workspaceRoot: this.discoveryConfig.workspaceRoot,
      agentDir: this.discoveryConfig.agentDir,
    };
    const resources = discoverResourcesSync(scanConfig);

    for (const resource of resources) {
      if (!resource.available) continue;
      this.currentScanPaths.add(resource.path);
      try {
        const config = this.loadWithMtimeCache(resource.path);
        if (config) this.cache.set(config.name, config);
      } catch (_err) {
        // 有意吞掉：文件不可读/解析失败 → 跳过（不阻断其他 agent 发现）
        void _err;
      }
    }

    // builtin 优先级最低（先写入，被文件 agent 覆盖）
    for (const agentName of builtin.list()) {
      if (!this.cache.has(agentName)) {
        const config = builtin.get(agentName);
        if (config) this.cache.set(agentName, config);
      }
    }

    // 清理本轮未扫描到的文件缓存条目（文件被删除/移走）
    for (const cachedPath of this.fileCache.keys()) {
      if (!this.currentScanPaths.has(cachedPath)) {
        this.fileCache.delete(cachedPath);
      }
    }
  }

  /** 按 name 查找。require=false 时找不到返回 undefined；true 时抛错。 */
  get(name: string, require?: boolean): AgentConfig | undefined {
    const config = this.cache.get(name);
    if (!config && require) {
      throw new Error(
        `Agent "${name}" not found. Discovered: ${[...this.cache.keys()].join(", ") || "(none)"}`,
      );
    }
    return config;
  }

  /** 列出所有已发现 agent 名（诊断/wizard 用）。 */
  list(): string[] {
    return [...this.cache.keys()];
  }

  // ── 内部 ──────────────────────────────────────────────────

  /** 带 mtime 缓存的单文件加载。mtime 未变复用缓存，否则 read+parse。 */
  private loadWithMtimeCache(filePath: string): AgentConfig | undefined {
    const stat = fs.statSync(filePath);
    const mtimeMs = stat.mtimeMs;
    const cached = this.fileCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.config;
    }
    const content = fs.readFileSync(filePath, "utf-8");
    const config = parseAgentFrontmatter(filePath, content);
    this.fileCache.set(filePath, { mtimeMs, config });
    return config;
  }
}

// ============================================================
// 包内 agent 发现（builtin 用，走 pi.agents manifest）
// ============================================================

import { processPackageSync } from "../shared/resource-discovery.ts";

/**
 * 发现包内 agent 文件（走 pi.agents manifest 或约定目录 agents/）。
 * builtin 专用——不参与优先级合并，优先级最低。
 */
function discoverPackageAgentsSync(packageRoot: string): DiscoveredResource[] {
  return processPackageSync(packageRoot, "agents");
}
