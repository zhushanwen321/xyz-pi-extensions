// src/core/agent-registry.ts
//
// agent .md 文件发现与解析。hot-reload：每次 runAgent 重新扫描。

import type { AgentConfig } from "./model-resolver.ts";

/** 内置 agent（代码硬编码，如 default worker）。 */
export interface BuiltinAgentRegistry {
  get(name: string): AgentConfig | undefined;
  list(): string[];
}

/** agent 注册表。发现 ~/.pi/agent/agents/*.md + 内置 agent。 */
export class AgentRegistry {
  constructor(private readonly agentDir: string) {
    //  存 agentDir（~/.pi/agent/agents），用于扫描 .md
    throw new Error("not implemented");
  }

  /** 扫描所有 .md + 内置 agent（hot-reload，每次调用重扫）。 */
  discoverAll(builtin: BuiltinAgentRegistry): void {
    //  1. 读 agentDir 下所有 *.md，解析 frontmatter + body
    //  2. 合并 builtin.list() 的内置 agent
    //  3. 写入内部 Map（name → AgentConfig）
    void builtin;
    throw new Error("not implemented");
  }

  /** 按 name 查找。require=false 时找不到返回 undefined；true 时抛错。 */
  get(name: string, require?: boolean): AgentConfig | undefined {
    //  1. Map.get(name)
    //  2. require && !found → throw Error(含已发现 agent 列表，供 fail-fast 提示)
    void name; void require;
    throw new Error("not implemented");
  }

  /** 列出所有已发现 agent 名（诊断/wizard 用）。 */
  list(): string[] {
    throw new Error("not implemented");
  }
}

/** 解析 .md frontmatter（name/tools/model/isolation 等）+ body（systemPrompt）。 */
export function parseAgentFrontmatter(filePath: string, content: string): AgentConfig {
  //  1. 分离 frontmatter（--- 之间）和 body
  //  2. YAML 解析 frontmatter → tools/model/thinkingLevel/defaultBackground/isolation
  //  3. body 作为 systemPrompt
  //  4. name = path.basename(filePath, ".md")
  void filePath; void content;
  throw new Error("not implemented");
}
