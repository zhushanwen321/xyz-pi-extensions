/**
 * Skill path discovery — resolve a skill name to its directory or SKILL.md path.
 *
 * Symmetric to agent-discovery.ts (which discovers agents): this module owns
 * the resource-discovery concern for skills across project / user / npm sources.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
  } catch { /* npm dir not found — no npm skills available */ void undefined; }
  skillCandidatesCache.set(npmSkillsDir, candidates);
  return candidates;
}

/**
 * Resolve a skill name to its directory or SKILL.md path.
 * Search order:
 * 1. Project-level: .agents/skills/<name>/
 * 2. Global: ~/.pi/agent/skills/<name>/
 * 3. npm packages: ~/.pi/agent/npm/node_modules/<pkg>/skills/<name>/
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
