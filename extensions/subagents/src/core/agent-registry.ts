// src/core/agent-registry.ts
//
// agent .md 文件发现与解析。hot-reload：每次调用重扫（mtime 缓存跳过未变文件）。

import * as fs from "node:fs";
import * as path from "node:path";

import type { AgentConfig } from "./model-resolver.ts";

/** 内置 agent（代码硬编码，如 default worker）。 */
export interface BuiltinAgentRegistry {
  get(name: string): AgentConfig | undefined;
  list(): string[];
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
 * agent 注册表。发现多个 agentDirs 下 *.md + 内置 agent。
 * hot-reload：每次 discoverAll 重扫，mtime 未变的文件跳过 read+parse。
 *
 * 多目录优先级：agentDirs 数组顺序即优先级，靠前覆盖靠后。
 * 实现上逆序扫描（先扫低优先级目录，后扫高优先级目录覆盖同名）。
 * 详见 ADR-025。
 */
export class AgentRegistry {
  private readonly cache = new Map<string, AgentConfig>();
  /** 文件级 mtime 缓存（key=绝对路径，跨 discoverAll 保留）。 */
  private readonly fileCache = new Map<string, FileCacheEntry>();
  /** 本轮扫描到的路径集（清理已删除文件的缓存）。 */
  private currentScanPaths = new Set<string>();

  constructor(private readonly agentDirs: string[]) {}

  /** 扫描所有 agentDirs 下 *.md + 合并 builtin（hot-reload，每次重扫）。 */
  discoverAll(builtin: BuiltinAgentRegistry): void {
    this.cache.clear();
    this.currentScanPaths = new Set();

    // 逆序扫描：靠前目录（高优先级）后写，覆盖靠后目录（低优先级）的同名 agent
    for (let i = this.agentDirs.length - 1; i >= 0; i--) {
      this.scanDir(this.agentDirs[i]!);
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

  /** 扫描单个目录下的 .md 文件（mtime 缓存加速）。 */
  private scanDir(dir: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return; // 目录不存在 / 不可读
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md") || entry.startsWith("_")) continue;
      const filePath = path.join(dir, entry);
      this.currentScanPaths.add(filePath);
      try {
        const config = this.loadWithMtimeCache(filePath);
        if (config) this.cache.set(config.name, config);
      } catch (_err) {
        // 有意吞掉：文件不可读/解析失败 → 跳过（不阻断其他 agent 发现）
        void _err;
      }
    }
  }

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
