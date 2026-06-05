/**
 * ReviewDispatcher — dispatches gate anti-fraud review subagent and builds retrospect steer.
 *
 * Gate review verifies deliverables are genuine (not fabricated by AI).
 * Content quality review is done by expert-reviewer during phase execution.
 */

import type { ChildProcess } from "node:child_process";
import * as path from "node:path";

import type { SkillResolver } from "./skill-resolver.js";
import {
	cleanupOldTempFiles,
	getFinalOutput,
	type OnUpdateCallback,
	runSingleAgent,
	type SingleResult,
} from "./subagent.js";

/** Phase number for the final (PR) phase. */
const FINAL_PHASE = 5;

/** Minimal phase config needed by review dispatcher. */
export interface PhaseConfigForReview {
	phase: number;
	name: string;
	reviewPrefix: string | string[];
	retrospectPrefix: string;
	deliverables: string[];
	reviewMode: string;
}

export interface ReviewDispatchResult {
	success: boolean;
	reviewPath: string;
	result?: SingleResult;
	error?: string;
}

// ─── Helpers ──────────────────────────────────────────────

// gate review uses fixed filename (gate_review_{phase}.md), no version tracking needed

function buildGateReviewTaskPrompt(
	phaseConfig: PhaseConfigForReview,
	topicDir: string,
	skillPath: string,
): string {
	const reviewPath = path.join(
		topicDir, "changes", "reviews",
		`gate_review_${phaseConfig.phase}.md`,
	);
	const deliverableList = phaseConfig.deliverables
		.map((d) => `   - ${path.join(topicDir, d)}`)
		.join("\n");

	return [
		`You are a Gate anti-fraud reviewer. Your responsibility is to verify that deliverables are genuine and trustworthy, not to review content quality.`,
		``,
		`1. read \`${skillPath}\`, find the 'Phase ${phaseConfig.phase} — ${phaseConfig.name}' section`,
		`2. read the following deliverable files:`,
		deliverableList,
		`3. Check each deliverable against the fraud signals in the methodology`,
		`4. You may use the bash tool to verify file existence, git log, etc.`,
		`5. Write the review results to:`,
		`   ${reviewPath}`,
		`6. YAML frontmatter must include (at the top level, not nested):`,
		`   - verdict: "pass" or "fail"`,
		`   - must_fix: number (confirmed fraudulent or critically missing issues)`,
	].join("\n");
}

// ─── Retrospect followUp ──────────────────────────────────

export function buildRetrospectFollowUp(
	phaseConfig: PhaseConfigForReview,
	topicDir: string,
	skillResolver: SkillResolver,
	allPhases: PhaseConfigForReview[], // for overall retrospect (phase 5)
): string {
	const retrospectPath = path.join(
		topicDir, "changes", "reviews",
		`${phaseConfig.retrospectPrefix}.md`,
	);
	const isOverall = phaseConfig.phase === FINAL_PHASE;
	const retrospectSkillPath = skillResolver.resolvePath("harness-retrospect");

	const parts = [
		`Now execute the ${isOverall ? "overall " : ""}retrospect for Phase ${phaseConfig.phase} (${phaseConfig.name}).`,
		``,
		`Steps:`,
		`1. read ${retrospectSkillPath} to get the retrospect methodology`,
		`2. Based on your complete experience in this phase, cover both dimensions per the methodology (Phase execution quality + Harness usability)`,
	];

	if (isOverall) {
		const prevRetrospects = allPhases
			.filter((p) => p.phase < FINAL_PHASE)
			.map((p) => `   - ${path.join(topicDir, "changes", "reviews", `${p.retrospectPrefix}.md`)}`)
			.join("\n");
		parts.push(
			`3. read previous phase retrospect records (if they exist):`,
			prevRetrospects,
		);
	}

	parts.push(
		`4. Write the retrospect to: ${retrospectPath}`,
		`5. YAML frontmatter: \`phase: ${phaseConfig.name.toLowerCase()}\`, \`verdict: pass\``,
		``,
		`After completion, call coding-workflow-phase-start() to proceed to the next phase.`,
	);

	return parts.join("\n");
}

// ─── Review dispatch ──────────────────────────────────────

export async function dispatchReviewSubagent(
	phaseConfig: PhaseConfigForReview,
	topicDir: string,
	skillResolver: SkillResolver,
	signal?: AbortSignal,
	onUpdate?: OnUpdateCallback,
	processRegistry?: ChildProcess[],
): Promise<ReviewDispatchResult> {
	const systemPrompt = skillResolver.resolve("xyz-harness-gate-reviewer");
	const skillPath = skillResolver.resolvePath("xyz-harness-gate-reviewer");
	const reviewPath = path.join(
		topicDir, "changes", "reviews",
		`gate_review_${phaseConfig.phase}.md`,
	);
	const taskPrompt = buildGateReviewTaskPrompt(phaseConfig, topicDir, skillPath);

	cleanupOldTempFiles();
	const result = await runSingleAgent({
		task: taskPrompt,
		systemPrompt,
		cwd: topicDir,
		signal,
		onUpdate,
		processRegistry,
	});

	if (result.exitCode !== 0) {
		const errMsg = result.stderr || getFinalOutput(result.messages) || "Unknown error";
		return { success: false, reviewPath, error: `Review subagent failed: ${errMsg}` };
	}

	return { success: true, reviewPath, result };
}
