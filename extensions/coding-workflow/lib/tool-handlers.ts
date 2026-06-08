/**
 * Tool execute handler bodies extracted from index.ts.
 *
 * Each handler receives a typed context object with all closure variables needed.
 * This extraction keeps the main extension factory function under 300 lines.
 */

import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { Gate } from "./gates/index.js";
import { PhaseGate, ReviewGate, TestFixLoopGate } from "./gates/index.js";
import {
	buildSkillInjection,
	checkMissingRetrospects,
	checkMissingReviews,
	checkProjectProtection,
	DEFAULT_STATE,
	FINAL_PHASE,
	hasValidYamlVerdict,
	isStaleContextError,
	MAX_SLUG_LENGTH,
	MIN_SLUG_LENGTH,
	parseReviewVerdict,
	type PhaseConfig,
} from "./helpers.js";
import {
	REVIEW_MANDATORY_FROM_PHASE,
	REVIEW_PREVIEW_LENGTH,
	type WorkflowState,
} from "./helpers.js";
import { buildRetrospectFollowUp, dispatchReviewSubagent } from "./review-dispatcher.js";
import { SkillResolver } from "./skill-resolver.js";
import { formatUsageStats } from "./subagent.js";

// ─── Goal task helpers ────────────────────────────────────

/** Max description length for goal_manager.create_tasks (60 chars). */
const GOAL_TASK_DESC_MAX = 60;

/** Parse plan.md Execution Groups / Tasks into goal task descriptions. */
function buildDevGoalTasks(planPath: string): string[] {
	if (!fs.existsSync(planPath)) return [];
	const content = fs.readFileSync(planPath, "utf8");
	const tasks: string[] = [];

	// Primary: ### Task N: {title} or ### Task N.M: {title}
	const taskRegex = /^###\s+Task\s+\d+(?:\.\d+)?\s*[:：]\s*(.+)$/gm;
	let match: RegExpExecArray | null;
	while ((match = taskRegex.exec(content)) !== null) {
		const desc = match[1]!.trim();
		if (desc) tasks.push(desc.slice(0, GOAL_TASK_DESC_MAX));
	}

	// Fallback: ### BG{N}: {title} or ### Execution Group N: {title}
	if (tasks.length === 0) {
		const egRegex = /^###\s+(?:BG\d+|Execution\s+Group\s+\d+)\s*[:\-]\s*(.+)$/gm;
		while ((match = egRegex.exec(content)) !== null) {
			const desc = match[1]!.trim();
			if (desc) tasks.push(desc.slice(0, GOAL_TASK_DESC_MAX));
		}
	}

	return tasks;
}

// ─── Shared types ────────────────────────────────────────

/** Pi tool execute parameter types (any-free wrappers). */
export interface ToolExecuteParams {
	phase?: number;
	slug?: string;
}

export interface ToolExecuteContext {
	toolCallId: string;
	params: ToolExecuteParams;
	signal: AbortSignal;
	onUpdate: (partial: { content: Array<{ type: string; text: string }>; usage?: unknown }) => void;
	ctx: ExtensionContext;
}

/** Closure context shared across all tool handlers. */
export interface HandlerContext {
	state: WorkflowState;
	pi: ExtensionAPI;
	skillResolver: SkillResolver;
	activeSubprocesses: ChildProcess[];
	phase1SkillInjectedByInit: boolean;
	phases: PhaseConfig[];
	gateScriptPath: string;
	maxGateRetries: number;
	maxCompactRetries: number;
	persistState: (pi: ExtensionAPI, state: WorkflowState) => void;
	updateWidget: (ctx: ExtensionContext, state: WorkflowState) => void;
}

// ─── Gate tool handler ────────────────────────────────────

export async function executeGateTool(hctx: HandlerContext, tctx: ToolExecuteContext) {
	const { state, pi, skillResolver, activeSubprocesses, phases, gateScriptPath, maxGateRetries } = hctx;
	const { params, signal, onUpdate, ctx } = tctx;
	const phase = params.phase ?? 0;

	if (state.pendingInit) {
		return {
			content: [{ type: "text", text: "Workflow is pending initialization. Call coding-workflow-init first to set the slug." }],
			isError: true,
		};
	}
	if (!state.isActive) {
		return {
			content: [{ type: "text", text: "No active workflow. Say /coding-workflow <topic> to start one." }],
			isError: true,
		};
	}
	if (phase !== state.currentPhase) {
		return {
			content: [{ type: "text", text: "Wrong phase token. Use the phase token from your current instructions." }],
			isError: true,
		};
	}

	// Verify ALL prior phases have passed
	for (let p = 1; p < state.currentPhase; p++) {
		if (state.phaseResults[p] !== "passed") {
			return {
				content: [{ type: "text", text: `BLOCKED: Phase ${p} (${phases[p - 1]!.name}) has not passed yet. All prior phases must pass before this gate.` }],
				isError: true,
			};
		}
	}

	// Verify ALL prior phases have review files
	if (state.currentPhase >= REVIEW_MANDATORY_FROM_PHASE) {
		const missingReviews = checkMissingReviews(phases, state.currentPhase, state.topicDir);
		if (missingReviews.length > 0) {
			const fixInstructions = missingReviews.map((m) => `  - ${m}`).join("\n");
			return {
				content: [{
					type: "text",
					text:
						`BLOCKED: Reviews are mandatory and cannot be skipped.\n\n` +
						`Missing reviews:\n${fixInstructions}\n\n` +
						`All prior phases must have review files before proceeding.`,
				}],
				isError: true,
			};
		}
	}

	if (state.gateInProgress) {
		return {
			content: [{ type: "text", text: "Gate check is already in progress. Wait for it to finish before retrying." }],
			isError: true,
		};
	}

	if (state.gateRetryCount >= maxGateRetries) {
		return {
			content: [{
				type: "text",
				text:
					`Gate retry limit reached (${maxGateRetries}) for Phase ${phase}. ` +
					`This usually means there are persistent issues that need manual intervention.\n\n` +
					`Options:\n` +
					`1. Use /coding-workflow-abort to cancel and start over\n` +
					`2. Manually inspect the deliverables and fix the root cause`,
			}],
			isError: true,
		};
	}

	// Idempotency: if gate already passed, check retrospect status
	if (state.phaseResults[phase] === "passed") {
		const phaseConfig = phases[phase - 1]!;
		const retrospectPath = path.join(
			state.topicDir, "changes", "reviews",
			`${phaseConfig.retrospectPrefix}.md`,
		);
		const retrospectExists = fs.existsSync(retrospectPath) && (() => {
			const fileContent = fs.readFileSync(retrospectPath, "utf8");
			return hasValidYamlVerdict(fileContent);
		})();

		if (retrospectExists) {
			return {
				content: [{ type: "text", text: `Gate passed, retrospect already exists (${retrospectPath}). Call coding-workflow-phase-start() to proceed to the next phase.` }],
			};
		} else {
			const retrospectFollowUp = buildRetrospectFollowUp(phaseConfig, state.topicDir, skillResolver, phases);
			pi.sendUserMessage(retrospectFollowUp, { deliverAs: "steer" });
			return {
				content: [{ type: "text", text: "Gate passed, but retrospect is missing. Write the retrospect per the steer instructions, then call coding-workflow-phase-start()." }],
			};
		}
	}

	state.gateInProgress = true;
	state.gateRetryCount += 1;
	hctx.persistState(pi, state);

	const phaseConfig = phases[phase - 1];

	// ── Gate Pipeline: execute configured gate chain ────────
	const gateRegistry: Record<string, Gate> = {
		"review-gate": new ReviewGate(),
		"phase-gate": new PhaseGate(gateScriptPath),
		"test-fix-loop": new TestFixLoopGate(),
	};

	for (const gateName of phaseConfig.gates) {
		const gate = gateRegistry[gateName];
		if (!gate) continue; // unknown gate — skip
		const result = await gate.run({
			phase,
			topicDir: state.topicDir,
			state,
			phaseConfig,
			pi,
			skillResolver,
			signal,
			onUpdate,
			processRegistry: activeSubprocesses,
		});
		if (!result.passed) {
			state.gateInProgress = false;
			hctx.persistState(pi, state);
			return {
				content: [{
					type: "text",
					text: result.fixGuidance ?? `Gate '${gateName}' failed. Fix the issues, then call coding-workflow-gate(phase=${phase}) again.`,
				}],
				isError: true,
			};
		}
	}

	// 2. Dispatch review subagent
	let reviewResult;
	try {
		reviewResult = await dispatchReviewSubagent(
			phaseConfig, state.topicDir,
			skillResolver, signal, onUpdate,
			activeSubprocesses,
		);

		// Auto git-add review artifacts to prevent untracked-file gate failures
		if (reviewResult.success && fs.existsSync(reviewResult.reviewPath)) {
			try {
				execFileSync("git", ["add", reviewResult.reviewPath], { cwd: state.topicDir, timeout: 10_000 });
			} catch { /* git add failure is non-critical */ void undefined; }
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		state.gateInProgress = false;
		hctx.persistState(pi, state);
		return {
			content: [{ type: "text", text: `Failed to dispatch review subagent: ${msg}\n\nGate script passed. You can retry by calling coding-workflow-gate(phase=${phase}) again.` }],
			isError: true,
		};
	}

	if (!reviewResult.success) {
		state.gateInProgress = false;
		hctx.persistState(pi, state);
		return {
			content: [{ type: "text", text: `Review subagent failed: ${reviewResult.error}\n\nGate script passed. You can retry by calling coding-workflow-gate(phase=${phase}) again.` }],
			isError: true,
		};
	}

	// 3. Parse review verdict
	const { verdict, mustFix } = parseReviewVerdict(reviewResult.reviewPath);
	if (mustFix > 0 || verdict !== "pass") {
		let reviewContent = "";
		try {
			reviewContent = fs.readFileSync(reviewResult.reviewPath, "utf8");
		} catch { /* review file read failure is not actionable here */ void undefined; }
		state.gateInProgress = false;
		hctx.persistState(pi, state);
		return {
			content: [{
				type: "text",
				text: `Gate PASSED. Review found issues (verdict=${verdict}, must_fix=${mustFix}).\n\nReview file: ${reviewResult.reviewPath}\n\n${reviewContent.slice(0, REVIEW_PREVIEW_LENGTH)}\n\nFix the MUST_FIX issues above, then call coding-workflow-gate(phase=${phase}) again.`,
			}],
			isError: true,
		};
	}

	// Guard: abort may have reset state during async operations
	if (!state.isActive) {
		state.gateInProgress = false;
		hctx.persistState(pi, state);
		return {
			content: [{ type: "text", text: "Workflow was aborted during gate check." }],
			isError: true,
		};
	}

	// Update state — reset retry counters on success
	state.gateInProgress = false;
	state.gateRetryCount = 0;
	state.phaseResults[phase] = "passed";
	hctx.persistState(pi, state);
	hctx.updateWidget(ctx, state);

	const usageLine = reviewResult.result
		? formatUsageStats(reviewResult.result.usage, reviewResult.result.model)
		: "";

	// Build retrospect steer — failures here must not cause gate to return error
	// since state is already persisted as passed.
	let retrospectFollowUp = "";
	try {
		retrospectFollowUp = buildRetrospectFollowUp(phaseConfig, state.topicDir, skillResolver, phases);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[coding-workflow] Failed to build retrospect follow-up: ${msg}`);
	}

	const baseMessage = `Gate PASSED. Review: verdict=pass, must_fix=0.${usageLine ? ` ${usageLine}` : ""}`;
	const retrospectInstruction = "\n\nIMPORTANT: Write the retrospect per the steer instructions, then call coding-workflow-phase-start() to proceed to the next phase.";

	if (phase >= FINAL_PHASE) {
		try {
			pi.sendUserMessage(
				retrospectFollowUp + "\n\nThis is the final phase. After writing the retrospect, the workflow ends.",
				{ deliverAs: "steer" },
			);
		} catch { /* steer delivery failure is non-critical */ void undefined; }
		return {
			content: [{ type: "text", text: `${baseMessage}\n\nWrite the retrospect per the steer instructions, then the workflow ends.` }],
		};
	}

	try {
		if (retrospectFollowUp) {
			pi.sendUserMessage(retrospectFollowUp, { deliverAs: "steer" });
		}
	} catch { /* steer delivery failure is non-critical */ void undefined; }
	return {
		content: [{
			type: "text",
			text: `${baseMessage}${retrospectInstruction}`,
		}],
	};
}

// ─── Init tool handler ───────────────────────────────────

export async function executeInitTool(hctx: HandlerContext, tctx: ToolExecuteContext) {
	const { state, pi, skillResolver, phases } = hctx;
	const { params, ctx } = tctx;

	if (!state.pendingInit) {
		return {
			content: [{ type: "text", text: "No pending workflow initialization. Use /coding-workflow to start one." }],
			isError: true,
		};
	}

	const slug = (params.slug ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, MAX_SLUG_LENGTH);

	if (!slug || slug.length < MIN_SLUG_LENGTH) {
		return {
			content: [{ type: "text", text: "Slug is too short or empty after normalization. Provide a meaningful English slug." }],
			isError: true,
		};
	}

	const ISO_DATE_LENGTH = 10; // YYYY-MM-DD format
	const today = new Date().toISOString().slice(0, ISO_DATE_LENGTH);
	const topicName = `${today}-${slug}`;
	const topicDir = path.join(process.cwd(), ".xyz-harness", topicName);

	if (fs.existsSync(topicDir)) {
		return {
			content: [{ type: "text", text: `Directory already exists: ${topicDir}. Choose a different slug.` }],
			isError: true,
		};
	}

	try {
		fs.mkdirSync(path.join(topicDir, "changes", "reviews"), { recursive: true });
		fs.mkdirSync(path.join(topicDir, "changes", "evidence"), { recursive: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			content: [{ type: "text", text: `Failed to create topic directory: ${msg}` }],
			isError: true,
		};
	}

	state.pendingInit = false;
	state.pendingRequirement = "";
	state.isActive = true;
	state.currentPhase = 1;
	state.topicDir = topicDir;
	state.topicName = topicName;
	state.phaseResults = {};
	hctx.persistState(pi, state);
	hctx.updateWidget(ctx, state);

	// Inject Phase 1 skill via steer
	let skillInjected = false;
	try {
		const phaseConfig = phases[0]!;
		const skillContent = skillResolver.resolve(phaseConfig.skillName);
		const injection = buildSkillInjection(phaseConfig.name, topicDir, 1, skillContent);
		pi.sendUserMessage(injection, { deliverAs: "steer" });
		skillInjected = true;
		hctx.phase1SkillInjectedByInit = true;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[coding-workflow] Failed to inject Phase 1 skill in init: ${msg}`);
	}

	ctx.ui.notify(`Coding workflow initialized: ${topicName}`, "info");

	const resultText = skillInjected
		? `Workflow initialized: ${topicName}\nWorkspace: ${topicDir}\n\nPhase 1 (Spec) skill injected. Produce spec.md per the steer instructions, then call coding-workflow-gate(phase=1).`
		: `Workflow initialized: ${topicName}\nWorkspace: ${topicDir}\n\nPhase 1 skill injection deferred to before_agent_start on the next turn.`;

	return { content: [{ type: "text", text: resultText }] };
}

// ─── Phase-start tool handler ────────────────────────────

export async function executePhaseStartTool(hctx: HandlerContext, tctx: ToolExecuteContext) {
	const { state, pi, phases, maxCompactRetries } = hctx;
	const { ctx } = tctx;

	if (state.pendingInit) {
		return {
			content: [{ type: "text", text: "Workflow is pending initialization. Call coding-workflow-init first to set the slug." }],
			isError: true,
		};
	}
	if (!state.isActive) {
		return { content: [{ type: "text", text: "No active workflow." }], isError: true };
	}

	if (state.phaseResults[state.currentPhase] !== "passed") {
		return {
			content: [{ type: "text", text: `Gate check has not passed yet. Call coding-workflow-gate(phase=${state.currentPhase}) first.` }],
			isError: true,
		};
	}

	// Safety net: check ALL prior phases' retrospect files
	const missingRetrospects = checkMissingRetrospects(phases, state.currentPhase, state.topicDir);
	if (missingRetrospects.length > 0) {
		const fixInstructions = missingRetrospects.map((m) => `  - ${m}`).join("\n");
		return {
			content: [{
				type: "text",
				text:
					`BLOCKED: Retrospect check failed. Missing or invalid:\n\n` +
					`${fixInstructions}\n\n` +
					`Read xyz-harness-retrospect skill, write the missing retrospects, then call coding-workflow-phase-start() again.`,
			}],
			isError: true,
		};
	}

	if (state.compactRetryCount >= maxCompactRetries) {
		return {
			content: [{
				type: "text",
				text:
					`Phase-start retry limit reached (${maxCompactRetries}). ` +
					`Compact keeps failing, context isolation cannot be guaranteed.\n\n` +
					`Options:\n` +
					`1. Use /coding-workflow-abort to cancel\n` +
					`2. Restart the Pi session manually and resume the workflow`,
			}],
			isError: true,
		};
	}

	state.compactRetryCount += 1;
	state.currentPhase += 1;
	hctx.persistState(pi, state);
	hctx.updateWidget(ctx, state);

	/** Phase number where goal extension initializes with default L1 tasks */
	const PHASE_GOAL_INIT = 2;

	// Initialize goal for Phase 2 (L1 default tasks)
	if (state.currentPhase === PHASE_GOAL_INIT) {
		try {
			// Type matches goal extension's GoalExternalInit (see extensions/goal/src/state.ts)
			type GoalInitFn = (objective: string, tasks: string[], budget?: Record<string, unknown>) => boolean;
			const goalInit = (pi as unknown as Record<string, unknown>).__goalInit as GoalInitFn | undefined;
			if (goalInit) {
				goalInit(
					"Phase 2: Complete plan phase deliverables",
					[
						"Write plan.md (with Execution Groups)",
						"Write e2e-test-plan.md",
						"Write test_cases_template.json",
						"Write use-cases.md",
						"Write non-functional-design.md",
					],
				);
			}
		} catch { /* goal init failure is non-blocking */ void undefined; }
	}

	// Phase 3: Dynamic goal tasks from plan.md Execution Groups
	const PHASE_DEV_GOAL_INIT = 3;
	if (state.currentPhase === PHASE_DEV_GOAL_INIT) {
		try {
			type GoalInitFn = (objective: string, tasks: string[], budget?: Record<string, unknown>) => boolean;
			const goalInit = (pi as unknown as Record<string, unknown>).__goalInit as GoalInitFn | undefined;
			if (goalInit) {
				const planPath = path.join(state.topicDir, "plan.md");
				const taskList = buildDevGoalTasks(planPath);
				if (taskList.length > 0) {
					goalInit("Phase 3: Dev coding implementation", taskList);
				}
			}
		} catch { /* goal init failure is non-blocking */ void undefined; }
	}

	if (state.currentPhase > FINAL_PHASE) {
		state.isActive = false;
		state.currentPhase = 0;
		state.phaseResults = {};
		state.gateInProgress = false;
		state.gateRetryCount = 0;
		state.compactRetryCount = 0;
		hctx.persistState(pi, state);
		hctx.updateWidget(ctx, state);
		return { content: [{ type: "text", text: "Workflow complete. No further action needed." }] };
	}

	const nextPhaseConfig = phases[state.currentPhase - 1];
	const customInstructions =
		`Transitioning to Phase ${state.currentPhase}: ${nextPhaseConfig.name}. ` +
		`Topic directory: ${state.topicDir}. ` +
		`Previous phase deliverables are in ${state.topicDir}.`;

	ctx.compact({
		customInstructions,
		onComplete: () => {
			state.compactRetryCount = 0;
			hctx.persistState(pi, state);
			pi.sendUserMessage(
				`New task instructions injected. Read them, produce deliverables, then call coding-workflow-gate(phase=${state.currentPhase}).`,
				{ deliverAs: "steer" },
			);
		},
		onError: (error: Error) => {
			if (isStaleContextError(error)) {
				// State is no longer trustworthy — abort the workflow
				Object.assign(state, { ...DEFAULT_STATE });
				hctx.persistState(pi, state);
				hctx.updateWidget(ctx, state);
				ctx.ui.notify("Workflow aborted: stale context after compact.", "warning");
				return;
			}
			console.warn(`[coding-workflow] Compact failed: ${error.message}`);
			state.currentPhase -= 1;
			state.compactRetryCount -= 1;
			if (state.compactRetryCount < 0) state.compactRetryCount = 0;
			hctx.persistState(pi, state);
			hctx.updateWidget(ctx, state);
			pi.sendUserMessage(
				`Compact failed (attempt ${state.compactRetryCount}/${maxCompactRetries}): ${error.message}\n\n` +
				`Gate passed, retrospect completed. Just call coding-workflow-phase-start() to retry after compact.\n` +
				`No need to redo phase work or re-run gate.`,
				{ deliverAs: "steer" },
			);
		},
	});

	return { content: [{ type: "text", text: "Proceeding to next task. New instructions will arrive shortly." }] };
}

// ─── before_agent_start handler ──────────────────────────

export interface BeforeAgentStartEvent {
	systemPromptOptions?: {
		skills?: Array<{ name: string; filePath: string }>;
	};
}

export function buildBeforeAgentStartMessage(hctx: HandlerContext, event: BeforeAgentStartEvent) {
	const { state, skillResolver, phases } = hctx;

	if (!state.isActive || state.pendingInit) return undefined;

	const phaseConfig = phases[state.currentPhase - 1];
	if (!phaseConfig) return undefined;

	const loadedSkills = (event.systemPromptOptions?.skills ?? []) as Array<{
		name: string;
		filePath: string;
	}>;
	skillResolver.setSkills(loadedSkills);

	if (hctx.phase1SkillInjectedByInit && state.currentPhase === 1) {
		hctx.phase1SkillInjectedByInit = false;
		return undefined;
	}

	if (state.phaseResults[state.currentPhase] === "passed") {
		return {
			message: {
				customType: "coding-workflow-context",
				content:
					`[CODING WORKFLOW — WAITING]\n\n` +
					`Phase ${state.currentPhase} (${phaseConfig.name}) gate passed.\n` +
					`Current objective: call coding-workflow-phase-start() to proceed to the next phase.\n\n` +
					`Nothing else to do.`,
				display: true,
			},
		};
	}

	// Check ALL prior phases' retrospects
	const missingRetrospects = checkMissingRetrospects(phases, state.currentPhase, state.topicDir);
	if (missingRetrospects.length > 0) {
		const retrospectSkillPath = skillResolver.resolvePath("xyz-harness-retrospect");
		const fixInstructions = missingRetrospects.map((m) => `  - ${m}`).join("\n");
		return {
			message: {
				customType: "coding-workflow-context",
				content:
					`[CODING WORKFLOW BLOCKED]\n\n` +
					`Phase ${state.currentPhase} (${phaseConfig.name}) cannot start. The following prerequisite phase retrospects are missing or incomplete:\n\n` +
					`${fixInstructions}\n\n` +
					`Retrospects are mandatory and cannot be skipped. Complete them as follows:\n` +
					`1. read ${retrospectSkillPath} to get the retrospect methodology\n` +
					`2. For each missing retrospect, write it based on that phase's deliverable files\n` +
					`3. YAML frontmatter must include a verdict field\n` +
					`4. After all retrospects are complete, restart the current turn (status will be auto-rechecked)`,
				display: true,
			},
		};
	}

	let skillContent: string;
	try {
		skillContent = skillResolver.resolve(phaseConfig.skillName);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			message: {
				customType: "coding-workflow-context",
				content: `[CODING WORKFLOW ERROR] Cannot load skill "${phaseConfig.skillName}": ${msg}. Check skill installation.`,
				display: false,
			},
		};
	}

	let injection = buildSkillInjection(phaseConfig.name, state.topicDir, state.currentPhase, skillContent);

	if (state.currentPhase === FINAL_PHASE) {
		injection += "\n\nCRITICAL RULE:\n- You MUST NOT merge the PR. Create it, verify CI, produce evidence — nothing more.";
	}

	if (state.currentPhase === REVIEW_MANDATORY_FROM_PHASE) {
		const projectRoot = path.resolve(state.topicDir, "..", "..");
		const protectionWarnings = checkProjectProtection(projectRoot);
		if (protectionWarnings.length > 0) {
			injection +=
				"\n\n⚠ PROJECT PROTECTION CHECK:\n" +
				"The following safeguards are not in place, which may cause code non-compliance or CI failures:\n" +
				protectionWarnings.map((w) => `  - ${w}`).join("\n") +
				"\nRecommendation: establish basic safeguards before coding — see the xyz-harness-code-standard-protection skill.";
		}
	}

	return {
		message: {
			customType: "coding-workflow-context",
			content: injection,
			display: false,
		},
	};
}

// persistState and updateWidget are provided via HandlerContext
