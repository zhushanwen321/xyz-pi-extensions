// src/registry/agent-registry.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentConfig, AgentSource } from "../types.ts";
import type { BuiltinAgentRegistry } from "./builtin-agents.ts";
import { parseAgentFrontmatter } from "./frontmatter.ts";

/** P0: 文件级 mtime 缓存条目。跨 discoverAll 保留，靠 mtime 判失效。 */
interface FileCacheEntry {
  mtimeMs: number;
  config: AgentConfig;
}

/**
 * FR-2.1 / FR-2.3: 扫描文件系统发现 agent + builtin，按优先级合并。
 * 优先级：project > user > package > local > builtin（last writer wins）。
 *
 * P0 优化：fileCache 按「绝对路径 → {mtimeMs, config}」缓存已解析的 .md。
 * discoverAll 仍 readdirSync 列目录（新文件靠 readdir 发现，与 mtime 无关），
 * 但对每个文件先 stat 拿 mtimeMs，未变则复用缓存跳过 read+parse。
 * 结束时按本轮扫描到的路径集清理 fileCache 中的陈旧条目（文件被删除）。
 */
export class AgentRegistry {
  private readonly cache = new Map<string, AgentConfig>();
  /** P0: 文件级 mtime 缓存。key=绝对路径，跨 discoverAll 保留。 */
  private readonly fileCache = new Map<string, FileCacheEntry>();
  /** 本轮 discoverAll 扫描到的文件路径集合（用于清理已删除文件的缓存）。 */
  private currentScanPaths = new Set<string>();

  constructor(
    private readonly cwd: string,
    private readonly homeDir: string = os.homedir(),
  ) {}

  /** 扫描所有路径 + 合并 builtin。name→config 缓存每轮清空重建；
   *  文件级 mtime 缓存跨轮保留（失效靠 mtime 判定）。 */
  discoverAll(builtins: BuiltinAgentRegistry): void {
    this.cache.clear();
    this.currentScanPaths = new Set();

    const home = this.homeDir;
    // 低→高优先级扫描（Map.set 覆盖）
    const targets: Array<{ dir: string; source: AgentSource; kind: "direct" | "extensions" | "npm" }> = [
      { dir: path.join(this.cwd, "extensions"), source: "local", kind: "extensions" },
      { dir: path.join(this.cwd, ".pi", "npm", "node_modules"), source: "package", kind: "npm" },
      { dir: path.join(home, ".pi", "agent", "npm", "node_modules"), source: "package", kind: "npm" },
      { dir: path.join(home, ".agents", "agents"), source: "user", kind: "direct" },
      { dir: path.join(home, ".pi", "agent", "agents"), source: "user", kind: "direct" },
      { dir: path.join(this.cwd, ".agents", "agents"), source: "project", kind: "direct" },
      { dir: path.join(this.cwd, ".pi", "agents"), source: "project", kind: "direct" },
    ];

    for (const t of targets) {
      if (t.kind === "extensions") this.scanExtensionsDir(t.dir, t.source);
      else if (t.kind === "npm") this.scanNpmDir(t.dir, t.source);
      else this.scanDir(t.dir, t.source);
    }

    // builtin 优先级最低（先写入，被文件 agent 覆盖）
    for (const agent of builtins.list()) {
      if (!this.cache.has(agent.name)) {
        this.cache.set(agent.name, agent);
      }
    }

    // P0: 清理本轮未扫描到的文件缓存条目（文件被删除/移走）。
    // 本轮 cache 已重建，删除 fileCache 条目不影响 cache 中对象的可达性
    // （若某 config 仍被 cache 引用，对象不会被 GC；若不被引用，说明该文件确实没了）。
    for (const cachedPath of this.fileCache.keys()) {
      if (!this.currentScanPaths.has(cachedPath)) {
        this.fileCache.delete(cachedPath);
      }
    }
  }

  /**
   * FR-2.3: 按名查找。优先级已在 discoverAll 中通过 last-writer-wins 体现。
   * throwOnMissing=true 时找不到抛错。
   */
  get(name: string, throwOnMissing: boolean = false): AgentConfig | undefined {
    const config = this.cache.get(name);
    if (!config && throwOnMissing) {
      throw new Error(`Agent "${name}" not found. Discovered: ${[...this.cache.keys()].join(", ") || "(none)"}`);
    }
    return config;
  }

  list(): AgentConfig[] {
    return [...this.cache.values()];
  }

  // ── 扫描 helpers（迁移自 workflow agent-discovery.ts）────────

  private scanExtensionsDir(extensionsDir: string, source: AgentSource): void {
    let entries: string[];
    try { entries = fs.readdirSync(extensionsDir); } catch { return; }
    for (const entry of entries) {
      this.scanDir(path.join(extensionsDir, entry, "agents"), source);
    }
  }

  private scanNpmDir(nodeModulesDir: string, source: AgentSource): void {
    let entries: string[];
    try { entries = fs.readdirSync(nodeModulesDir); } catch { return; }
    for (const entry of entries) {
      const entryPath = path.join(nodeModulesDir, entry);
      if (entry.startsWith("@")) {
        let scoped: string[];
        try { scoped = fs.readdirSync(entryPath); } catch { continue; }
        for (const pkg of scoped) {
          this.scanDir(path.join(entryPath, pkg, "agents"), source);
        }
      } else {
        this.scanDir(path.join(entryPath, "agents"), source);
      }
    }
  }

  private scanDir(dir: string, source: AgentSource): void {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (!entry.endsWith(".md") || entry.startsWith("_") || entry.endsWith(".chain.md")) continue;
      const filePath = path.join(dir, entry);
      this.currentScanPaths.add(filePath);
      try {
        const config = this.loadWithMtimeCache(filePath, entry, source);
        if (config) this.cache.set(config.name, config);
      // eslint-disable-next-line taste/no-silent-catch
      } catch { /* 文件不可读，跳过 */ }
    }
  }

  /** P0: 带 mtime 缓存的单文件加载。mtime 未变复用缓存，否则 read+parse 更新缓存。 */
  private loadWithMtimeCache(
    filePath: string,
    fileName: string,
    source: AgentSource,
  ): AgentConfig | undefined {
    const stat = fs.statSync(filePath);
    const mtimeMs = stat.mtimeMs;
    const cached = this.fileCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) {
      // mtime 未变：复用缓存，但 source/filePath 按本轮扫描目录重新打标
      // （同一文件可能被多个目录扫描到，优先级靠 cache.set 覆盖体现）。
      return { ...cached.config, source, filePath };
    }
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = parseAgentFrontmatter(content, fileName);
    const config: AgentConfig = {
      name: parsed.name,
      systemPrompt: parsed.systemPrompt,
      model: parsed.model,
      description: parsed.description,
      builtinTools: parsed.tools,
      extensions: parsed.extensions,
      skills: parsed.skills,
      category: parsed.category,
      extSelectors: parsed.extSelectors,
      isolation: parsed.isolation,
      defaultBackground: parsed.defaultBackground,
      source,
      filePath,
    };
    this.fileCache.set(filePath, { mtimeMs, config });
    return config;
  }
}
