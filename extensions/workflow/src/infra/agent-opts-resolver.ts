/**
 * Agent options resolver — builds RunAgentOptions for @zhushanwen/pi-subagents.
 *
 * 改造前：写 temp file（systemPrompt + schema instruction）供 spawn pi --append-system-prompt 使用。
 * 改造后：直接构建 appendSystemPrompt 字符串数组 + schema 对象，传给 subagents runAgent()。
 * temp file 逻辑完全删除。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentCallOpts } from "./agent-pool.js";

export interface ResolveResult {
  opts: AgentCallOpts;
  error?: string;
}

/** AgentRegistry 的最小接口（subagents AgentRegistry 满足此契约） */
export interface AgentRegistryLike {
  resolve(name: string): { systemPrompt: string; model?: string } | undefined;
}

/**
 * 解析 agent name → systemPrompt 内容字符串；skill → skillPath。
 * 不再写 temp file。systemPrompt 直接放入 opts.appendSystemPrompt。
 * schema 直接保留在 opts.schema（subagents runAgent 内部拼入 task）。
 */
export function resolveAgentOpts(
  opts: AgentCallOpts,
  agentRegistry: AgentRegistryLike,
): ResolveResult {
  let appendSystemPrompt: string[] | undefined;

  // 解析 agent systemPrompt（直接读取内容，不写 temp file）
  if (opts.agent) {
    const discovered = agentRegistry.resolve(opts.agent);
    if (!discovered) return { opts, error: `Agent not found: ${opts.agent}` };

    if (discovered.systemPrompt.trim().length > 0) {
      appendSystemPrompt = [discovered.systemPrompt];
    }

    opts = { ...opts, model: opts.model || discovered.model };
  }

  // 解析 skill name → skillPath
  if (opts.skill) {
    const skillPath = resolveSkillPath(opts.skill);
    if (!skillPath) {
      return { opts, error: `Skill not found: ${opts.skill}. Searched .agents/skills/ and ~/.pi/agent/skills/` };
    }
    opts = { ...opts, skillPath };
  }

  // schema 不再写 temp file、不设 schemaEnv。
  // schema 对象直接保留在 opts.schema，由 subagents runAgent() 内部拼入 task 末尾。

  return {
    opts: { ...opts, ...(appendSystemPrompt ? { appendSystemPrompt } : {}) },
  };
}

// ── Skill path resolution（不变，保留原逻辑）─────────────────────

const skillCandidatesCache = new Map<string, string[]>();

function getNpmSkillCandidates(npmSkillsDir: string): string[] {
  const cached = skillCandidatesCache.get(npmSkillsDir);
  if (cached) return cached;
  const candidates: string[] = [];
  try {
    for (const pkg of fs.readdirSync(npmSkillsDir)) {
      candidates.push(path.join(npmSkillsDir, pkg, "skills"));
    }
  } catch { /* npm dir not found */ }
  skillCandidatesCache.set(npmSkillsDir, candidates);
  return candidates;
}

export function resolveSkillPath(skillName: string): string | undefined {
  const candidates = [
    path.resolve(process.cwd(), ".agents/skills", skillName),
    path.join(os.homedir(), ".pi/agent/skills", skillName),
  ];
  const npmSkillsDir = path.join(os.homedir(), ".pi/agent/npm/node_modules");
  for (const pkgSkillsBase of getNpmSkillCandidates(npmSkillsDir)) {
    candidates.push(path.join(pkgSkillsBase, skillName));
  }
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return undefined;
}
