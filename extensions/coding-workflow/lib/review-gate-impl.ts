/**
 * Review-Gate implementation: standard loop, Phase 3 three-stage, Phase 4 Test-Fix Loop.
 * Extracted from tool-handlers.ts to keep file sizes under 1000 lines.
 */

import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { parseReviewVerdict } from "./helpers.js";
// SkillResolver used in parameter types for future agent resolution
import type { SkillResolver } from "./skill-resolver.js";
import { runSingleAgent } from "./subagent.js";

// ─── Types ────────────────────────────────────────────────

export interface ReviewGateResult {
	passed: boolean;
	rounds: number;
	lastMustFix: number;
	summary: string;
	reviewPath: string;
}

interface ToolExecuteContextLike {
	signal?: AbortSignal;
	onUpdate?: (partial: { content: Array<{ type: string; text: string }>; usage?: unknown }) => void;
}

// ─── Shared constants & helpers ───────────────────────────

const REVIEW_GATE_MAX_ROUNDS = 3;
const REVIEW_GATE_STAGNATION_THRESHOLD = 2;

function autoGitAdd(cwd: string, filePath: string): void {
	if (fs.existsSync(filePath)) {
		try { execFileSync("git", ["add", filePath], { cwd, timeout: 10_000 }); } catch { void undefined; }
	}
}

// ─── Standard Review-Gate loop (Phase 1/2) ────────────────

function buildReviewGatePrompt(
	phaseConfig: { phase: number; name: string; deliverables: string[]; reviewMode: string },
	topicDir: string,
	version: number,
): string {
	const reviewPrefix = "review"; // simplified
	const reviewsDir = path.join(topicDir, "changes", "reviews");
	const reviewFileName = `${reviewPrefix}_v${version}.md`;
	const reviewPath = path.join(reviewsDir, reviewFileName);

	const deliverableFiles = phaseConfig.deliverables
		.map((d) => `   - ${path.join(topicDir, d)}`)
		.join("\n");

	return [
		`You are a content quality reviewer for Phase ${phaseConfig.phase} (${phaseConfig.name}).`,
		`Review mode: ${phaseConfig.reviewMode}`,
		"",
		"Steps:",
		"1. Read each deliverable:",
		deliverableFiles,
		"2. Evaluate quality against the review mode criteria above",
		"3. You may read referenced files (spec.md, plan.md) for cross-checking",
		"4. Write your review to:",
		`   ${reviewPath}`,
		"5. YAML frontmatter must include (at the top level):",
		'   - verdict: "pass" or "fail"',
		"   - must_fix: <number of blocking issues>",
		"",
		"If verdict=pass and must_fix=0, the review-gate passes.",
		"If must_fix > 0, list each MUST_FIX issue with file path and description.",
	].join("\n");
}

export async function runReviewGateLoop(
	phaseConfig: {
		phase: number; name: string; reviewPrefix: string | string[];
		deliverables: string[]; reviewMode: string;
	},
	topicDir: string,
	skillResolver: SkillResolver,
	signal: AbortSignal | undefined,
	onUpdate: ToolExecuteContextLike["onUpdate"],
	processRegistry: ChildProcess[] | undefined,
): Promise<ReviewGateResult> {
	// Phase 4 has Test-Fix Loop instead of review-gate
	if (phaseConfig.phase === 4) {
		return runTestFixLoop(topicDir, signal, onUpdate, processRegistry);
	}
	// Phase 3 has a special three-stage review-gate
	if (phaseConfig.phase === 3) {
		return runPhase3ReviewGate(topicDir, skillResolver, signal, onUpdate, processRegistry);
	}
	// Phase 5 (PR) doesn't need review-gate
	if (phaseConfig.phase >= 5) {
		return { passed: true, rounds: 0, lastMustFix: 0, summary: "Review-Gate skipped", reviewPath: "" };
	}

	const reviewPrefix = Array.isArray(phaseConfig.reviewPrefix) ? phaseConfig.reviewPrefix[0] : phaseConfig.reviewPrefix;
	if (!reviewPrefix) {
		return { passed: true, rounds: 0, lastMustFix: 0, summary: "No review prefix", reviewPath: "" };
	}

	let lastMustFix = -1;
	let stagnationCount = 0;
	const summaries: string[] = [];

	for (let round = 1; round <= REVIEW_GATE_MAX_ROUNDS; round++) {
		const taskPrompt = buildReviewGatePrompt(phaseConfig, topicDir, round);
		const systemPrompt = `You are an expert code reviewer. Be thorough but fair. Focus on actionable findings.`;

		const result = await runSingleAgent({
			task: taskPrompt,
			systemPrompt,
			cwd: topicDir,
			signal,
			onUpdate,
			processRegistry,
		});

		if (result.exitCode !== 0) {
			return {
				passed: false, rounds: round, lastMustFix: -1,
				summary: `Review agent failed (exit=${result.exitCode}): ${result.stderr}`,
				reviewPath: "",
			};
		}

		// Parse verdict from the review file
		const reviewsDir = path.join(topicDir, "changes", "reviews");
		const reviewPath = path.join(reviewsDir, `${reviewPrefix}_v${round}.md`);
		const { verdict, mustFix } = parseReviewVerdict(reviewPath);

		autoGitAdd(topicDir, reviewPath);

		summaries.push(`Round ${round}: verdict=${verdict}, must_fix=${mustFix}`);

		if (mustFix <= 0 && verdict === "pass") {
			return { passed: true, rounds: round, lastMustFix: 0, summary: summaries.join("\n"), reviewPath };
		}

		// Stagnation check
		if (lastMustFix >= 0 && mustFix >= lastMustFix) {
			stagnationCount++;
			if (stagnationCount >= REVIEW_GATE_STAGNATION_THRESHOLD) {
				return {
					passed: false, rounds: round, lastMustFix: mustFix,
					summary: `${summaries.join("\n")}\n\nStagnation: must_fix did not decrease for ${stagnationCount} consecutive rounds.`,
					reviewPath,
				};
			}
		} else {
			stagnationCount = 0;
		}
		lastMustFix = mustFix;
	}

	return {
		passed: false, rounds: REVIEW_GATE_MAX_ROUNDS, lastMustFix,
		summary: `${summaries.join("\n")}\n\nMax rounds (${REVIEW_GATE_MAX_ROUNDS}) reached.`,
		reviewPath: path.join(topicDir, "changes", "reviews", `${reviewPrefix}_v${REVIEW_GATE_MAX_ROUNDS}.md`),
	};
}

// ─── Phase 3 three-stage Review-Gate ──────────────────────

const PHASE3_OUTER_MAX = 3;

async function runPhase3ReviewGate(
	topicDir: string,
	skillResolver: SkillResolver,
	signal: AbortSignal | undefined,
	onUpdate: ToolExecuteContextLike["onUpdate"],
	processRegistry: ChildProcess[] | undefined,
): Promise<ReviewGateResult> {
	const reviewsDir = path.join(topicDir, "changes", "reviews");
	const summaries: string[] = [];

	for (let outerRound = 1; outerRound <= PHASE3_OUTER_MAX; outerRound++) {
		// Stage 1: Spec-plan conformance (single, no loop)
		const stage1Path = path.join(reviewsDir, `spec_conformance_v${outerRound}.md`);
		const stage1Prompt = [
			"Stage 1: Spec-plan conformance review.",
			"Read spec.md, plan.md, and source code.",
			"Check every spec requirement has implementation.",
			`Write review to: ${stage1Path}`,
			"YAML frontmatter: verdict (pass/fail), must_fix (count of missing features)",
		].join("\n");

		const stage1Result = await runSingleAgent({
			task: stage1Prompt, systemPrompt: "Expert spec-plan conformance reviewer.",
			cwd: topicDir, signal, onUpdate, processRegistry,
		});
		if (stage1Result.exitCode !== 0) {
			return { passed: false, rounds: outerRound, lastMustFix: -1, summary: `Stage 1 failed: ${stage1Result.stderr}`, reviewPath: "" };
		}
		const { verdict: s1v, mustFix: s1m } = parseReviewVerdict(stage1Path);
		autoGitAdd(topicDir, stage1Path);
		summaries.push(`[Outer ${outerRound}] Stage 1: verdict=${s1v}, must_fix=${s1m}`);

		if (s1m > 0 || s1v !== "pass") {
			return { passed: false, rounds: outerRound, lastMustFix: s1m,
				summary: `${summaries.join("\n")}\nStage 1 FAILED. Re-code and resubmit.`, reviewPath: stage1Path };
		}

		// Stage 2: Code quality review (loop, max 3 rounds)
		const reviewers = ["standards_review", "robustness_review", "integration_review"];
		let lastMustFix = -1;
		let stagCount = 0;
		let s2Pass = false;

		for (let inner = 1; inner <= REVIEW_GATE_MAX_ROUNDS; inner++) {
			let totalMustFix = 0;
			for (const pfx of reviewers) {
				const rPath = path.join(reviewsDir, `${pfx}_v${outerRound}-${inner}.md`);
				const prompt = [
					`Code quality review: ${pfx.replace(/_/g, " ")}.`,
					"Read source files. Evaluate quality.",
					`Write review to: ${rPath}`,
					"YAML: verdict, must_fix",
				].join("\n");
				const res = await runSingleAgent({
					task: prompt, systemPrompt: "Expert code reviewer.",
					cwd: topicDir, signal, onUpdate, processRegistry,
				});
				if (res.exitCode === 0) {
					const { mustFix } = parseReviewVerdict(rPath);
					totalMustFix += mustFix;
					autoGitAdd(topicDir, rPath);
				}
			}
			summaries.push(`[Outer ${outerRound}] Stage 2 Round ${inner}: total must_fix=${totalMustFix}`);
			if (totalMustFix <= 0) { s2Pass = true; break; }
			if (lastMustFix >= 0 && totalMustFix >= lastMustFix) {
				stagCount++;
				if (stagCount >= REVIEW_GATE_STAGNATION_THRESHOLD) { break; }
			} else { stagCount = 0; }
			lastMustFix = totalMustFix;
		}

		if (s2Pass) {
			return { passed: true, rounds: outerRound, lastMustFix: 0, summary: summaries.join("\n"), reviewPath: "" };
		}
	}

	return { passed: false, rounds: PHASE3_OUTER_MAX, lastMustFix: -1,
		summary: `${summaries.join("\n")}\nMax outer rounds reached.`, reviewPath: "" };
}

// ─── Phase 4 Test-Fix Loop ────────────────────────────────

const TEST_FIX_MAX_ROUNDS = 10;
const TEST_FIX_STAGNATION = 3;

interface TestFixSummary {
	total: number;
	passed: number;
	failed: number;
	skipped: number;
	fixed: number;
}

async function runTestFixLoop(
	topicDir: string,
	signal: AbortSignal | undefined,
	onUpdate: ToolExecuteContextLike["onUpdate"],
	processRegistry: ChildProcess[] | undefined,
): Promise<ReviewGateResult> {
	const summaries: string[] = [];

	for (const wf of ["core", "noncore"] as const) {
		let lastFailed = -1;
		let stagCount = 0;

		for (let round = 1; round <= TEST_FIX_MAX_ROUNDS; round++) {
			const stateFile = path.join(topicDir, "changes", "reviews", "phase-4", `test-execute-v${round}-${wf}.json`);
			const templatePath = path.join(topicDir, "test_cases_template.json");
			const prompt = [
				`Test-Fix Loop — ${wf} test cases (version ${round}).`,
				"",
				`1. Read test case template: ${templatePath}`,
				`2. Filter for phase=4 cases${wf === "core" ? " tagged as core" : " tagged as non-core"}`,
				"3. Execute each test case using bash (curl, httpx, vitest, etc.)",
				"4. Record results in JSON:",
				`   ${stateFile}`,
				"5. JSON format: { version, workflow, timestamp, summary: { total, passed, failed, skipped, fixed }, cases: [{ id, name, status, evidence }] }",
				...(round > 1 && lastFailed > 0
					? ["", "Previous round had failures. Fix the failed cases:", "6. Analyze root cause, fix code or test", "7. Mark fixed cases as status='fixed'", "8. git commit any code fixes"]
					: []),
			].join("\n");

			const result = await runSingleAgent({
				task: prompt,
				systemPrompt: "You are a test engineer. Execute tests precisely and report results honestly.",
				cwd: topicDir, signal, onUpdate, processRegistry,
			});

			if (result.exitCode !== 0) {
				summaries.push(`[${wf}] Round ${round}: agent failed (${result.stderr.slice(0, 100)})`);
				continue;
			}

			let failed = 0;
			let passed = 0;
			try {
				const content = fs.readFileSync(stateFile, "utf8");
				const data = JSON.parse(content) as { summary?: TestFixSummary };
				failed = data.summary?.failed ?? 0;
				passed = data.summary?.passed ?? 0;
			} catch {
				summaries.push(`[${wf}] Round ${round}: could not parse state file`);
				continue;
			}

			autoGitAdd(topicDir, stateFile);
			summaries.push(`[${wf}] Round ${round}: passed=${passed}, failed=${failed}`);

			if (failed === 0) {
				summaries.push(`[${wf}] All tests passed!`);
				break;
			}

			if (lastFailed >= 0 && failed >= lastFailed) {
				stagCount++;
				if (stagCount >= TEST_FIX_STAGNATION) {
					summaries.push(`[${wf}] Stagnation: ${stagCount} rounds with no improvement.`);
					break;
				}
			} else {
				stagCount = 0;
			}
			lastFailed = failed;
		}
	}

	const hasActiveFailures = summaries.some((s) => /failed=[1-9]/.test(s) && !s.includes("All tests passed"));
	return {
		passed: !hasActiveFailures,
		rounds: summaries.length,
		lastMustFix: hasActiveFailures ? -1 : 0,
		summary: summaries.join("\n"),
		reviewPath: "",
	};
}
