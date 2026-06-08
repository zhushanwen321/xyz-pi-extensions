import * as fs from "node:fs";
import * as path from "node:path";

// ─── Stale context detection ────────────────────────────

const STALE_CONTEXT_PATTERNS = ["aborted", "context canceled", "stale context", "stalecontext"];

export function isStaleContextError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return STALE_CONTEXT_PATTERNS.some((p) => msg.includes(p));
}

// ─── Types ────────────────────────────────────────────────

export interface PhaseConfig {
  phase: number;
  name: string;
  skillName: string;
  gates: string[];
  reviewPrefix: string | string[];
  retrospectPrefix: string;
  deliverables: string[];
  reviewMode: string;
}

export interface WorkflowState {
  isActive: boolean;
  currentPhase: number;
  topicDir: string;
  topicName: string;
  phaseResults: Record<number, "passed">;
  gateInProgress: boolean;
  gateRetryCount: number;
  compactRetryCount: number;
  pendingInit: boolean;
  pendingRequirement: string;
}

export const DEFAULT_STATE: WorkflowState = {
  isActive: false,
  currentPhase: 0,
  topicDir: "",
  topicName: "",
  phaseResults: {},
  gateInProgress: false,
  gateRetryCount: 0,
  compactRetryCount: 0,
  pendingInit: false,
  pendingRequirement: "",
};

export const REVIEW_MANDATORY_FROM_PHASE = 3;
export const FINAL_PHASE = 5;
export const MAX_SLUG_LENGTH = 60;
export const MIN_SLUG_LENGTH = 2;
export const REQUIREMENT_EXCERPT_LENGTH = 500;
export const RESULT_PREVIEW_LINES = 10;

// ─── Parse review verdict ────────────────────────────────

const YAML_DELIMITER_OFFSET = 3;

export function parseReviewVerdict(reviewPath: string): { verdict: string; mustFix: number } {
  if (!fs.existsSync(reviewPath)) {
    return { verdict: "fail", mustFix: -1 };
  }
  const content = fs.readFileSync(reviewPath, "utf8");
  const first = content.indexOf("---");
  const second = content.indexOf("---", first + YAML_DELIMITER_OFFSET);
  if (first === -1 || second === -1) {
    return { verdict: "fail", mustFix: -1 };
  }
  const yamlText = content.slice(first + YAML_DELIMITER_OFFSET, second).trim();
  try {
    // Simple regex-based YAML parsing for frontmatter
    const getField = (key: string): string | undefined => {
      const regex = new RegExp(`^${key}:\\s*(.+)$`, "m");
      const match = yamlText.match(regex);
      return match?.[1]?.trim();
    };
    const verdict = getField("verdict") || "fail";
    const mustFixStr = getField("must_fix");
    const mustFix = mustFixStr ? parseInt(mustFixStr, 10) : -1;
    return { verdict, mustFix: Number.isNaN(mustFix) ? -1 : mustFix };
  } catch {
    return { verdict: "fail", mustFix: -1 };
  }
}

// ─── Check YAML frontmatter verdict ─────────────────────

export function hasValidYamlVerdict(content: string): boolean {
  const fmFirst = content.indexOf("---");
  const fmSecond = content.indexOf("---", fmFirst + YAML_DELIMITER_OFFSET);
  if (fmFirst < 0 || fmSecond < 0) return false;
  const yamlBlock = content.slice(fmFirst + YAML_DELIMITER_OFFSET, fmSecond);
  return /^verdict:\s*\S+/m.test(yamlBlock);
}

// ─── Review-Gate state paths ───────────────────────────

export function getReviewGateStatePath(topicDir: string, phase: number): string {
  return path.join(topicDir, `.review-gate-p${phase}.json`);
}

export function getReviewReportsDir(topicDir: string, phase: number): string {
  return path.join(topicDir, "changes", "reviews", `phase-${phase}`);
}

// ─── Check missing retrospects ───────────────────────────

export function checkMissingRetrospects(
  phases: PhaseConfig[],
  upToPhase: number,
  topicDir: string,
): string[] {
  const missing: string[] = [];
  for (let p = 1; p < upToPhase; p++) {
    const prevConfig = phases[p - 1];
    if (!prevConfig) continue;
    const retrospectPath = path.join(topicDir, "changes", "reviews", `${prevConfig.retrospectPrefix}.md`);
    if (!fs.existsSync(retrospectPath)) {
      missing.push(`Phase ${p} (${prevConfig.name}): ${retrospectPath}`);
    } else {
      const content = fs.readFileSync(retrospectPath, "utf8");
      if (!hasValidYamlVerdict(content)) {
        missing.push(`Phase ${p} (${prevConfig.name}): frontmatter missing verdict — ${retrospectPath}`);
      }
    }
  }
  return missing;
}

// ─── Build skill injection prompt ────────────────────────

export function buildSkillInjection(
  phaseName: string,
  topicDir: string,
  currentPhase: number,
  skillContent: string,
): string {
  return (
    `[CODING WORKFLOW]\n\n` +
    `Current Task: ${phaseName}\n` +
    `Workspace: ${topicDir}\n\n` +
    `YOUR GOAL:\n` +
    `1. Read the skill instructions below carefully\n` +
    `2. Produce all required deliverables\n` +
    `3. Call coding-workflow-gate(phase=${currentPhase}) to submit\n\n` +
    `RULES:\n` +
    `- ONLY do what the skill below tells you to do\n` +
    `- Do NOT skip ahead, plan ahead, or do anything outside the skill scope\n` +
    `- If gate returns FAIL: fix the specific items listed, then retry\n` +
    `- If gate returns PASS: follow the instructions in the gate result message exactly\n` +
    `- After completing each phase, commit and push all code and docs\n\n` +
    `--- Skill Instructions ---\n${skillContent}\n--- End Skill Instructions ---`
  );
}
