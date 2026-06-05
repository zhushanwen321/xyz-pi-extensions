/**
 * Shared helpers extracted from index.ts to reduce function/file size.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import * as yaml from "js-yaml";

// ─── Stale context detection ────────────────────────────

const STALE_CONTEXT_PATTERNS = ["aborted", "context canceled", "stale context", "stalecontext"];

/** Check if an error indicates a stale / canceled context (e.g. after compact). */
export function isStaleContextError(error: Error): boolean {
	const msg = error.message.toLowerCase();
	return STALE_CONTEXT_PATTERNS.some((p) => msg.includes(p));
}

// ─── Types ────────────────────────────────────────────────

export interface PhaseConfig {
	phase: number;
	name: string;
	skillName: string;
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

/** Default initial state for a coding workflow session. */
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

// ─── Constants ────────────────────────────────────────────

/** Phase number where review files become mandatory for prior phases. */
export const REVIEW_MANDATORY_FROM_PHASE = 3;
/** Final (PR) phase number. */
export const FINAL_PHASE = 5;
/** Maximum number of user messages to extract from session. */
const MAX_RECENT_MESSAGES = 5;
/** Maximum character length for a requirement excerpt shown to AI. */
export const REQUIREMENT_EXCERPT_LENGTH = 500;
/** Maximum characters of review content to include in gate error message. */
export const REVIEW_PREVIEW_LENGTH = 4000;
/** Maximum characters for a slug. */
export const MAX_SLUG_LENGTH = 60;
/** Minimum characters for a valid slug after normalization. */
export const MIN_SLUG_LENGTH = 2;
/** YAML frontmatter delimiter offset for slicing content after "---". */
const YAML_DELIMITER_OFFSET = 3;
/** Max lines to preview in tool result rendering. */
export const RESULT_PREVIEW_LINES = 10;

// ─── Parse review verdict ────────────────────────────────

export function parseReviewVerdict(reviewPath: string): {
	verdict: string;
	mustFix: number;
} {
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
		const data = yaml.load(yamlText) as Record<string, unknown>;
		if (!data || typeof data !== "object") {
			return { verdict: "fail", mustFix: -1 };
		}

		let verdict: string | undefined;
		if (typeof data.verdict === "string") {
			verdict = data.verdict;
		} else if (
			typeof data.review === "object" && data.review !== null &&
			typeof (data.review as Record<string, unknown>).verdict === "string"
		) {
			verdict = (data.review as Record<string, unknown>).verdict as string;
		}

		let mustFix: number | undefined;
		if (typeof data.must_fix === "number") {
			mustFix = data.must_fix;
		} else if (
			typeof data.statistics === "object" && data.statistics !== null &&
			typeof (data.statistics as Record<string, unknown>).must_fix === "number"
		) {
			mustFix = (data.statistics as Record<string, unknown>).must_fix as number;
		}

		return {
			verdict: verdict ?? "fail",
			mustFix: mustFix ?? -1,
		};
	} catch {
		return { verdict: "fail", mustFix: -1 };
	}
}

// ─── Check YAML frontmatter verdict ─────────────────────

export function hasValidYamlVerdict(content: string): boolean {
	const fmFirst = content.indexOf("---");
	const fmSecond = content.indexOf("---", fmFirst + YAML_DELIMITER_OFFSET);
	if (fmFirst < 0 || fmSecond < 0) return false;
	try {
		const fmData = yaml.load(content.slice(fmFirst + YAML_DELIMITER_OFFSET, fmSecond)) as Record<string, unknown>;
		return typeof fmData?.verdict === "string";
	} catch {
		return false;
	}
}

// ─── Extract recent user messages ────────────────────────

export function extractRecentUserMessages(ctx: {
	sessionManager: { getBranch(): unknown[] };
}): string[] {
	const branch = ctx.sessionManager.getBranch() as Array<{
		type: string;
		message?: {
			role: string;
			content: string | Array<{ type: string; text: string }>;
		};
	}>;
	const userMessages: string[] = [];

	for (const entry of branch) {
		if (entry.type === "message" && entry.message?.role === "user") {
			const content = entry.message.content;
			if (typeof content === "string") {
				userMessages.push(content);
			} else if (Array.isArray(content)) {
				const texts = content
					.filter((c) => c.type === "text")
					.map((c) => c.text);
				if (texts.length > 0) {
					userMessages.push(texts.join("\n"));
				}
			}
		}
	}

	// branch returns leaf→root, reverse to get chronological, take last N
	userMessages.reverse();
	return userMessages.slice(-MAX_RECENT_MESSAGES);
}

// ─── Check missing retrospects ───────────────────────────

export function checkMissingRetrospects(
	phases: PhaseConfig[],
	upToPhase: number,
	topicDir: string,
): string[] {
	const missing: string[] = [];
	for (let p = 1; p < upToPhase; p++) {
		const prevConfig = phases[p - 1]!;
		const retrospectPath = path.join(
			topicDir, "changes", "reviews",
			`${prevConfig.retrospectPrefix}.md`,
		);
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

// ─── Check missing reviews ───────────────────────────────

export function checkMissingReviews(
	phases: PhaseConfig[],
	upToPhase: number,
	topicDir: string,
): string[] {
	const missing: string[] = [];
	for (let p = 1; p < upToPhase; p++) {
		const prevConfig = phases[p - 1]!;
		const prefixes = Array.isArray(prevConfig.reviewPrefix)
			? prevConfig.reviewPrefix
			: prevConfig.reviewPrefix ? [prevConfig.reviewPrefix] : [];
		if (prefixes.length > 0) {
			const reviewsDir = path.join(topicDir, "changes", "reviews");
			if (fs.existsSync(reviewsDir)) {
				const files = fs.readdirSync(reviewsDir);
				for (const prefix of prefixes) {
					const hasReview = files.some(f =>
						f.startsWith(prefix + "_v") && f.endsWith(".md"),
					);
					if (!hasReview) {
						missing.push(`Phase ${p} (${prevConfig.name}): no ${prefix}_v*.md found`);
					}
				}
			} else {
				missing.push(`Phase ${p} (${prevConfig.name}): reviews/ directory not found`);
			}
		}
	}
	return missing;
}

// ─── Project protection check ────────────────────────────

export function checkProjectProtection(projectRoot: string): string[] {
	const warnings: string[] = [];

	if (!projectRoot || !fs.existsSync(projectRoot)) return warnings;

	// Check TypeScript strict
	const tsconfigPath = path.join(projectRoot, "tsconfig.json");
	if (fs.existsSync(tsconfigPath)) {
		try {
			const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf-8"));
			if (!tsconfig.compilerOptions?.strict) {
				warnings.push("tsconfig.json does not have strict mode enabled");
			}
		} catch { /* malformed tsconfig is not actionable */ void undefined; }
	}

	// Check ESLint (TS project)
	const hasEslint =
		fs.existsSync(path.join(projectRoot, "eslint.config.mjs")) ||
		fs.existsSync(path.join(projectRoot, "eslint.config.js")) ||
		fs.existsSync(path.join(projectRoot, ".eslintrc.json"));
	if (!hasEslint) {
		const pkgPath = path.join(projectRoot, "package.json");
		if (fs.existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
				const deps = { ...pkg.devDependencies, ...pkg.dependencies } as Record<string, string>;
				if (!deps.eslint) warnings.push("ESLint is not installed or not configured");
			} catch { /* malformed package.json is not actionable */ void undefined; }
		}
	}

	// Check Ruff (Python project)
	const pyprojPath = path.join(projectRoot, "pyproject.toml");
	if (fs.existsSync(pyprojPath)) {
		try {
			const pyContent = fs.readFileSync(pyprojPath, "utf-8");
			if (!pyContent.includes("[tool.ruff]")) {
				warnings.push("pyproject.toml missing [tool.ruff] configuration");
			}
		} catch { /* malformed pyproject.toml is not actionable */ void undefined; }
	}

	// Check git hook
	const hookPath = path.join(projectRoot, ".git", "hooks", "pre-commit");
	if (!fs.existsSync(hookPath)) {
		warnings.push("Git pre-commit hook not installed");
	}

	// Check CI
	const workflowsDir = path.join(projectRoot, ".github", "workflows");
	if (!fs.existsSync(workflowsDir) || fs.readdirSync(workflowsDir).length === 0) {
		warnings.push("CI pipeline not configured (.github/workflows/)");
	}

	return warnings;
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
		`- After completing each phase, commit and push all code and docs (especially .xyz-harness/ and docs/). Ensure 'git status --short' shows no untracked files before committing\n\n` +
		`--- Skill Instructions ---\n${skillContent}\n--- End Skill Instructions ---`
	);
}
