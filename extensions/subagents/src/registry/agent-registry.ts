// src/registry/agent-registry.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentConfig, AgentSource } from "../types.ts";
import type { BuiltinAgentRegistry } from "./builtin-agents.ts";
import { parseAgentFrontmatter } from "./frontmatter.ts";

/**
 * FR-2.1 / FR-2.3: 扫描文件系统发现 agent + builtin，按优先级合并。
 * 优先级：project > user > package > local > builtin（last writer wins）。
 */
export class AgentRegistry {
  private readonly cache = new Map<string, AgentConfig>();

  constructor(
    private readonly cwd: string,
    private readonly homeDir: string = os.homedir(),
  ) {}

  /** 扫描所有路径 + 合并 builtin。清空缓存后重新填充。 */
  discoverAll(builtins: BuiltinAgentRegistry): void {
    this.cache.clear();

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
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const parsed = parseAgentFrontmatter(content, entry);
        this.cache.set(parsed.name, {
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
        });
      // eslint-disable-next-line taste/no-silent-catch
      } catch { /* 文件不可读，跳过 */ }
    }
  }
}
