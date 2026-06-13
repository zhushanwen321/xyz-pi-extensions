// src/registry/builtin-agents.ts
import type { AgentConfig } from "../types.ts";

/** FR-2.2: 内置 agent 定义。默认 model 为空（由 category 解析时填充）。 */
export const BUILTIN_AGENTS: readonly AgentConfig[] = [
  {
    name: "worker", source: "builtin",
    systemPrompt: "You are a coding agent. Complete the task precisely.",
    description: "通用执行 agent（编码、修复、文件操作）",
    extensions: true, builtinTools: undefined, // all
  },
  {
    name: "reviewer", source: "builtin",
    systemPrompt: "You are a code reviewer. Find bugs, logic errors, and security issues.",
    description: "代码审查 agent",
    extensions: false, builtinTools: ["read"],
  },
  {
    name: "researcher", source: "builtin",
    systemPrompt: "You are a web researcher. Search, evaluate, and synthesize findings.",
    description: "网络调研 agent",
    extensions: false, builtinTools: ["read", "web_search"],
  },
  {
    name: "scout", source: "builtin",
    systemPrompt: "You are a codebase recon agent. Explore structure and return compressed context.",
    description: "快速代码库侦查",
    extensions: false, builtinTools: ["read", "bash", "grep"],
  },
  {
    name: "planner", source: "builtin",
    systemPrompt: "You are a planning agent. Break down tasks and create implementation plans.",
    description: "实施计划 agent",
    extensions: false, builtinTools: ["read"],
  },
  {
    name: "oracle", source: "builtin",
    systemPrompt: "You are a decision oracle. Protect inherited state and prevent drift.",
    description: "高上下文决策一致性守护",
    extensions: false, builtinTools: ["read"],
  },
  {
    name: "context-builder", source: "builtin",
    systemPrompt: "You are a context builder. Analyze requirements and generate meta-prompts.",
    description: "需求分析与元提示生成",
    extensions: false, builtinTools: ["read"],
  },
];

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
