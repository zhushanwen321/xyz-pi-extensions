// src/registry/builtin-agents.ts
import * as fs from "node:fs";
import * as path from "node:path";

import type { AgentConfig } from "../types.ts";
import { parseAgentFrontmatter } from "./frontmatter.ts";

/**
 * FR-2.2: 内置 agent 的 .md 文件目录（相对于包根）。
 * 这些 .md 文件是 agent prompt 的"权威源"——用户可编辑、覆盖、
 * 通过 .pi/agents/ 同名文件覆盖。builtin-agents.ts 在启动时从
 * 此目录加载，若文件不可读则 fallback 到硬编码默认。
 *
 * 设计参考 tintinweb/pi-subagents 的 default-agents.ts + agents/*.md 双层模式。
 */
const BUILTIN_AGENTS_DIR = path.resolve(
  // 从 src/registry/ 向上两级到包根（extensions/subagents/），再进 agents/
  import.meta.dirname ?? __dirname ?? "",
  "..",
  "..",
  "agents",
);

/** Agent 名 → builtin 默认 category（.md frontmatter 未指定 category 时用） */
const BUILTIN_DEFAULT_CATEGORY: Record<string, string> = {
  worker: "coding",
  reviewer: "coding",
  researcher: "research",
  scout: "research",
  planner: "planning",
  oracle: "planning",
  "context-builder": "planning",
};

/** 硬编码 fallback（当 agents/*.md 不可读时使用，如测试环境无 fs 访问） */
const FALLBACK_AGENTS: readonly AgentConfig[] = [
  {
    name: "worker",
    source: "builtin",
    systemPrompt: "You are a coding agent. Complete the task precisely.",
    description: "通用执行 agent（编码、修复、文件操作）",
    extensions: true,
    builtinTools: undefined,
    category: "coding",
  },
  {
    name: "reviewer",
    source: "builtin",
    systemPrompt: "You are a code reviewer. Find bugs, logic errors, and security issues.",
    description: "代码审查 agent",
    extensions: false,
    builtinTools: ["read"],
    category: "coding",
  },
  {
    name: "researcher",
    source: "builtin",
    systemPrompt: "You are a web researcher. Search, evaluate, and synthesize findings.",
    description: "网络调研 agent",
    extensions: false,
    builtinTools: ["read", "web_search"],
    category: "research",
  },
  {
    name: "scout",
    source: "builtin",
    systemPrompt: "You are a codebase recon agent. Explore structure and return compressed context.",
    description: "快速代码库侦查",
    extensions: false,
    builtinTools: ["read", "bash", "grep"],
    category: "research",
  },
  {
    name: "planner",
    source: "builtin",
    systemPrompt: "You are a planning agent. Break down tasks and create implementation plans.",
    description: "实施计划 agent",
    extensions: false,
    builtinTools: ["read"],
    category: "planning",
  },
  {
    name: "oracle",
    source: "builtin",
    systemPrompt: "You are a decision oracle. Protect inherited state and prevent drift.",
    description: "高上下文决策一致性守护",
    extensions: false,
    builtinTools: ["read"],
    category: "planning",
  },
  {
    name: "context-builder",
    source: "builtin",
    systemPrompt: "You are a context builder. Analyze requirements and generate meta-prompts.",
    description: "需求分析与元提示生成",
    extensions: false,
    builtinTools: ["read"],
    category: "planning",
  },
];

/**
 * 从 agents/*.md 加载内置 agent 配置。
 * 每个 .md 的 frontmatter（name/description/tools/extensions/category）+ body（systemPrompt）
 * 转换为 AgentConfig。文件不可读时 fallback 到 FALLBACK_AGENTS。
 */
function loadBuiltinAgents(): AgentConfig[] {
  const loaded: AgentConfig[] = [];

  try {
    const entries = fs.readdirSync(BUILTIN_AGENTS_DIR);
    for (const entry of entries) {
      if (!entry.endsWith(".md") || entry.startsWith("_")) continue;
      const filePath = path.join(BUILTIN_AGENTS_DIR, entry);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const parsed = parseAgentFrontmatter(content, entry);
        const name = parsed.name;
        loaded.push({
          name,
          systemPrompt: parsed.systemPrompt,
          model: parsed.model,
          description: parsed.description,
          builtinTools: parsed.tools,
          extensions: parsed.extensions,
          skills: parsed.skills,
          category: parsed.category ?? BUILTIN_DEFAULT_CATEGORY[name],
          source: "builtin",
          filePath,
        });
      // eslint-disable-next-line taste/no-silent-catch
      } catch (err) {
        // 单个文件读/解析失败，跳过（fallback 会补）
        console.warn(`[subagents] skipping builtin agent file ${entry}:`, err instanceof Error ? err.message : err);
      }
    }
  // eslint-disable-next-line taste/no-silent-catch
  } catch (err) {
    // agents/ 目录不存在 → 全部用 fallback
    console.warn("[subagents] builtin agents dir not found, using fallback:", err instanceof Error ? err.message : err);
  }

  // 如果 .md 加载不完整（某些 agent 缺失），用 fallback 补齐
  const loadedNames = new Set(loaded.map((a) => a.name));
  for (const fb of FALLBACK_AGENTS) {
    if (!loadedNames.has(fb.name)) {
      loaded.push({ ...fb });
    }
  }

  return loaded;
}

/** 内置 agent 列表（从 agents/*.md 加载，fallback 到硬编码） */
export const BUILTIN_AGENTS: readonly AgentConfig[] = loadBuiltinAgents();

/**
 * FR-2.2: BuiltinAgentRegistry 持有内置 + 第三方注册的 agent。
 * 允许第三方扩展在 session_start 时 register() 自定义 builtin。
 */
export class BuiltinAgentRegistry {
  private readonly agents = new Map<string, AgentConfig>();

  constructor() {
    for (const agent of BUILTIN_AGENTS) {
      this.agents.set(agent.name, { ...agent });
    }
  }

  /** 注册自定义 builtin agent。覆盖同名。 */
  register(config: AgentConfig): void {
    this.agents.set(config.name, { ...config, source: config.source ?? "builtin" });
  }

  get(name: string): AgentConfig | undefined {
    return this.agents.get(name);
  }

  list(): AgentConfig[] {
    return [...this.agents.values()];
  }
}
