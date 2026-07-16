/**
 * Agent options resolver — resolves agent name / skill / schema to system
 * prompt files + env vars on every dispatch (BL-1).
 *
 * BL-1：解析 workflow 脚本里 `agent({agent,skill,schema})` 的 inline override，
 * 否则 pi 子进程只收到原始 prompt，没有 --append-system-prompt / --skill /
 * PI_WORKFLOW_SCHEMA。AgentCallOpts 从 engine/models/types 引入。
 *
 * 调用方：engine/error-recovery.ts dispatchAgentCall（每次 agent-call 消息）。
 * - agent → AgentRegistry.resolve → systemPrompt 写临时文件 → systemPromptFiles（--append-system-prompt）
 * - skill → resolveSkillPath → skillPath（--skill）
 * - schema → 结构化输出指令写临时文件 → systemPromptFiles + schemaEnv（PI_WORKFLOW_SCHEMA）
 *
 * 临时文件在 activeTempFiles 集合注册，session_shutdown 时由 cleanupAllTempFiles 统一回收。
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { AgentCallOpts } from "./models/types.ts";
import type { AgentRegistry } from "../execution/agent-registry.ts";  // type-only（本文件不 new，只接收实例参数）
import { resolveSkillPath } from "./skill-discovery.ts";

const UUID_SLICE_LEN = 8;

export interface ResolveResult {
  opts: AgentCallOpts;
  error?: string;
}

/**
 * Resolve agent name and schema into systemPromptFiles + skillPath + schemaEnv.
 *
 * - Agent systemPrompt -> temp file via --append-system-prompt
 * - Skill name -> resolved SKILL.md dir path via --skill
 * - Schema JSON -> temp file with structured-output instruction + PI_WORKFLOW_SCHEMA env
 *
 * Returns the enriched opts and any temp files created (registered in activeTempFiles).
 * Caller is responsible for cleaning up files via cleanupAllTempFiles (session-scoped).
 */
export function resolveAgentOpts(
  opts: AgentCallOpts,
  agentRegistry: AgentRegistry,
  sessionDir: string,
  activeTempFiles: Set<string>,
): ResolveResult {
  const systemPromptFiles: string[] = [];

 // Resolve agent system prompt
  if (opts.agent) {
    const discovered = agentRegistry.get(opts.agent);  // 新 API: get() 替代 resolve()，返回 AgentConfig（含 systemPrompt+model）
    if (!discovered) {
      const available = agentRegistry.list().join(", ");
      return { opts, error: `Agent not found: ${opts.agent}. Available: ${available || "(none)"}` };
    }

    const hasSystemPrompt = discovered.systemPrompt.trim().length > 0;
    if (hasSystemPrompt) {
      try {
        const tmpDir = path.join(sessionDir, "workflow-tmp");
        fs.mkdirSync(tmpDir, { recursive: true });
        const tmpFile = path.join(tmpDir, `agent-prompt-${randomUUID()}.md`);
        fs.writeFileSync(tmpFile, discovered.systemPrompt, "utf-8");
        activeTempFiles.add(tmpFile);
        systemPromptFiles.push(tmpFile);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { opts, error: `Temp file write error: ${msg}` };
      }
    }

    // M3: 用 === undefined 而非 ||，避免空串被当 falsy 替换成 frontmatter model
    opts = {
      ...opts,
      model: opts.model === undefined ? discovered.model : opts.model,
      // M2: 传播 agent .md frontmatter 的 thinkingLevel（之前 AgentCallOpts 无此字段导致丢失）
      thinkingLevel: opts.thinkingLevel ?? discovered.thinkingLevel,
    };
  }

 // Resolve skill name to SKILL.md path
  if (opts.skill) {
    const skillPath = resolveSkillPath(opts.skill);
    if (!skillPath) {
      return { opts, error: `Skill not found: ${opts.skill}. Searched .agents/skills/ and ~/.pi/agent/skills/` };
    }
    opts = { ...opts, skillPath };
  }

 // Inject schema as structured-output instruction via --append-system-prompt
 // and set environment variable for conditional tool + hook activation.
  if (opts.schema) {
    try {
      const tmpDir = path.join(sessionDir, "workflow-tmp");
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, `so-${randomUUID().slice(0, UUID_SLICE_LEN)}.txt`);
      const schemaJson = JSON.stringify(opts.schema);
      const content = [
        "## MANDATORY: Structured Output Requirement",
        "",
        "This task requires structured output.",
        "Your FINAL action must be calling the `structured-output` tool.",
        "",
        `structured-output parameters:`,
        `  schema = ${schemaJson}`,
        `  data = <your result conforming to the schema above>`,
        "",
        "Rules:",
        "- Do NOT output JSON in your text response — use the structured-output tool.",
        "- Do NOT skip this step. The structured-output call IS your result.",
        "- Complete all other work FIRST, then call structured-output as the last action.",
      ].join("\n");
      fs.writeFileSync(tmpFile, content, "utf-8");
      activeTempFiles.add(tmpFile);
      systemPromptFiles.push(tmpFile);

 // Set env var for structured-output extension to activate tool + hook
      opts = { ...opts, schemaEnv: schemaJson };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { opts, error: `Schema temp file write error: ${msg}` };
    }
  }

  return {
    opts: { ...opts, ...(systemPromptFiles.length > 0 ? { systemPromptFiles } : {}) },
  };
}

/** Remove all remaining active temp files (called from session_shutdown). */
export function cleanupAllTempFiles(activeTempFiles: Set<string>): void {
  for (const fp of activeTempFiles) {
    try { fs.unlinkSync(fp); } catch { /* already deleted */ void undefined; }
  }
  activeTempFiles.clear();
}
