/**
 * Agent options resolver — resolves agent name and schema to system prompt files.
 *
 * Extracted from orchestrator.ts to keep file size under 1000 lines.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AgentRegistry } from "./agent-discovery.js";
import type { AgentCallOpts } from "./agent-pool.js";

const UUID_SLICE_LEN = 8;

export interface ResolveResult {
  opts: AgentCallOpts;
  error?: string;
}

/**
 * Resolve agent name and schema into systemPromptFiles.
 *
 * - Agent systemPrompt -> temp file via --append-system-prompt
 * - Schema JSON -> temp file with structured-output instruction
 *
 * Returns the enriched opts and any temp files created.
 * Caller is responsible for cleaning up files via cleanupTempFile().
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
    const discovered = agentRegistry.resolve(opts.agent);
    if (!discovered) return { opts, error: `Agent not found: ${opts.agent}` };

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

    opts = { ...opts, model: opts.model || discovered.model };
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

/** Remove a temp file and unregister it from the active set. */
export function cleanupTempFile(filePath: string, activeTempFiles: Set<string>): void {
  try { fs.unlinkSync(filePath); } catch { /* already deleted */ void undefined; }
  activeTempFiles.delete(filePath);
}

/** Remove all remaining active temp files. */
export function cleanupAllTempFiles(activeTempFiles: Set<string>): void {
  for (const fp of activeTempFiles) {
    try { fs.unlinkSync(fp); } catch { /* already deleted */ void undefined; }
  }
  activeTempFiles.clear();
}

// ── Skill path resolution (with npm dir cache) ─────────────────────

const skillCandidatesCache = new Map<string, string[]>();

/** List npm skill candidate paths — cached per npmSkillsDir. */
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

/**
 * Resolve a skill name to its directory or SKILL.md path.
 * Search order:
 *   1. Project-level: .agents/skills/<name>/
 *   2. Global: ~/.pi/agent/skills/<name>/
 *   3. npm packages: ~/.pi/agent/npm/node_modules/<pkg>/skills/<name>/
 * Returns the directory path if found, undefined otherwise.
 */
export function resolveSkillPath(skillName: string): string | undefined {
  const candidates = [
    // Project-level
    path.resolve(process.cwd(), ".agents/skills", skillName),
    // Global user skills
    path.join(os.homedir(), ".pi/agent/skills", skillName),
  ];

  // npm package skills (cached)
  const npmSkillsDir = path.join(os.homedir(), ".pi/agent/npm/node_modules");
  for (const pkgSkillsBase of getNpmSkillCandidates(npmSkillsDir)) {
    candidates.push(path.join(pkgSkillsBase, skillName));
  }

  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      return dir;
    }
  }

  return undefined;
}
