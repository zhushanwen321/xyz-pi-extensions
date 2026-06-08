/**
 * coding-workflow — Pi extension for 5-phase coding workflow orchestration.
 *
 * Restricts AI visibility to only the current phase, automatically runs
 * gate checks → review → retrospect → compact → next phase.
 *
 * Tools: coding-workflow-gate, coding-workflow-phase-start
 * Commands: /coding-workflow, /coding-workflow-status, /coding-workflow-abort
 */

import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

import {
	DEFAULT_STATE,
	extractRecentUserMessages,
	FINAL_PHASE,
	MAX_SLUG_LENGTH,
	type PhaseConfig,
	REQUIREMENT_EXCERPT_LENGTH,
	type WorkflowState,
} from "./lib/helpers.js";
import { SkillResolver } from "./lib/skill-resolver.js";
import {
	type BeforeAgentStartEvent,
	buildBeforeAgentStartMessage,
	executeGateTool,
	executeInitTool,
	executePhaseStartTool,
	type HandlerContext,
	type RenderArgs,
	renderGateCall,
	renderInitCall,
	renderInitResult,
	renderPhaseStartCall,
	type RenderResultLike,
	renderToolResult,
	type ThemeLike,
	type ToolExecuteContext,
} from "./lib/tool-handlers.js";

// ─── Phase definitions ───────────────────────────────────

const PHASES: PhaseConfig[] = [
	{
		phase: 1, name: "Spec", skillName: "xyz-harness-brainstorming",
		reviewPrefix: "spec_review", retrospectPrefix: "spec_retrospect",
		deliverables: ["spec.md"],
		reviewMode: "Mode 1: Plan review (verify spec completeness)",
	},
	{
		phase: 2, name: "Plan", skillName: "xyz-harness-writing-plans",
		reviewPrefix: "plan_review", retrospectPrefix: "plan_retrospect",
		deliverables: ["plan.md", "e2e-test-plan.md", "test_cases_template.json", "use-cases.md", "non-functional-design.md"],
		reviewMode: "Mode 1: Plan review (verify plan feasibility)",
	},
	{
		phase: 3, name: "Dev", skillName: "xyz-harness-phase-dev",
		reviewPrefix: ["business_logic_review", "standards_review", "robustness_review", "integration_review", "ts_taste_review", "rust_taste_review", "taste_review"], retrospectPrefix: "dev_retrospect",
		deliverables: ["changes/evidence/test_results.md"],
		reviewMode: "Mode 2: Code review (verify implementation against spec)",
	},
	{
		phase: 4, name: "Test", skillName: "xyz-harness-phase-test",
		reviewPrefix: "", retrospectPrefix: "test_retrospect",
		deliverables: ["changes/evidence/test_execution.json"],
		reviewMode: "Mode 3: Test review (verify test coverage and quality)",
	},
	{
		phase: 5, name: "PR", skillName: "xyz-harness-phase-pr",
		reviewPrefix: "pr_review", retrospectPrefix: "overall_retrospect",
		deliverables: ["changes/evidence/pr_evidence.md", "changes/evidence/ci_results.md"],
		reviewMode: "Code review (verify PR completeness and CI results)",
	},
];

// Gate check script lives alongside this extension
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATE_SCRIPT_PATH = path.join(__dirname, "scripts", "gate-check.py");

// ─── State ───────────────────────────────────────────────

const MAX_GATE_RETRIES = 10;
const MAX_COMPACT_RETRIES = 3;

// ─── Widget ──────────────────────────────────────────────

function updateWidget(ctx: ExtensionContext, state: WorkflowState): void {
	if (!state.isActive) {
		ctx.ui.setWidget("coding-workflow", undefined);
		ctx.ui.setStatus("coding-workflow", undefined);
		return;
	}

	const th = ctx.ui.theme;
	const lines: string[] = [];
	lines.push(th.fg("accent", `Coding Workflow: ${state.topicName}`));

	for (const p of PHASES) {
		const passed = state.phaseResults[p.phase] === "passed";
		const current = p.phase === state.currentPhase;
		let icon: string;
		if (passed) icon = th.fg("success", "✓");
		else if (current) icon = th.fg("accent", "→");
		else icon = th.fg("dim", "☐");

		const name = passed
			? th.fg("dim", p.name)
			: current
				? th.fg("text", p.name)
				: th.fg("dim", p.name);
		lines.push(`  ${icon} Phase ${p.phase}: ${name}${current ? " (current)" : ""}`);
	}

	ctx.ui.setWidget("coding-workflow", lines);
	ctx.ui.setStatus(
		"coding-workflow",
		th.fg("accent", `Phase ${state.currentPhase}/${FINAL_PHASE}`),
	);
}

// ─── State persistence ───────────────────────────────────

function persistState(pi: ExtensionAPI, state: WorkflowState): void {
	pi.appendEntry("coding-workflow", {
		isActive: state.isActive,
		currentPhase: state.currentPhase,
		topicDir: state.topicDir,
		topicName: state.topicName,
		phaseResults: state.phaseResults,
		pendingInit: state.pendingInit,
		pendingRequirement: state.pendingRequirement,
		gateRetryCount: state.gateRetryCount,
		compactRetryCount: state.compactRetryCount,
	});
}

function reconstructState(ctx: ExtensionContext, state: WorkflowState): void {
	Object.assign(state, { ...DEFAULT_STATE });
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (
			entry.type === "custom" &&
			(entry as { customType: string }).customType === "coding-workflow"
		) {
			const data = (entry as { data: unknown }).data as WorkflowState | undefined;
			if (data) {
				state.isActive = data.isActive ?? false;
				state.currentPhase = data.currentPhase ?? 0;
				state.topicDir = data.topicDir ?? "";
				state.topicName = data.topicName ?? "";
				state.phaseResults = data.phaseResults ?? {};
				state.gateInProgress = false;
				state.gateRetryCount = data.gateRetryCount ?? 0;
				state.compactRetryCount = data.compactRetryCount ?? 0;
				state.pendingInit = data.pendingInit ?? false;
				state.pendingRequirement = data.pendingRequirement ?? "";
			}
			break;
		}
	}
	if (state.currentPhase < 0 || state.currentPhase > FINAL_PHASE) {
		state.currentPhase = 0;
	}
	if (state.isActive && (!state.topicDir || !fs.existsSync(state.topicDir))) {
		state.isActive = false;
		state.currentPhase = 0;
		state.phaseResults = {};
	}
	if (state.isActive && state.currentPhase > 1) {
		for (let p = 1; p < state.currentPhase; p++) {
			if (state.phaseResults[p] !== "passed") {
				state.currentPhase = p;
				for (const key of Object.keys(state.phaseResults)) {
					if (Number(key) >= p) delete state.phaseResults[Number(key)];
				}
				break;
			}
		}
	}
}

// ─── Extension entry ─────────────────────────────────────

export default function codingWorkflowExtension(pi: ExtensionAPI) {
	const state: WorkflowState = { ...DEFAULT_STATE };
	const activeSubprocesses: ChildProcess[] = [];
	let phase1SkillInjectedByInit = false;
	const skillResolver = new SkillResolver();

	const hctx: HandlerContext = {
		state,
		pi,
		skillResolver,
		activeSubprocesses,
		phase1SkillInjectedByInit,
		phases: PHASES,
		gateScriptPath: GATE_SCRIPT_PATH,
		maxGateRetries: MAX_GATE_RETRIES,
		maxCompactRetries: MAX_COMPACT_RETRIES,
		persistState,
		updateWidget,
	};

	function makeTctx(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: (partial: { content: Array<{ type: string; text: string }>; usage?: unknown }) => void,
		ctx: ExtensionContext,
	): ToolExecuteContext {
		return { toolCallId, params, signal, onUpdate, ctx };
	}

	// ── Tool: coding-workflow-gate ──────────────────────────

	pi.registerTool({
		name: "coding-workflow-gate",
		label: "Coding Workflow Gate",
		description:
			"Submit your phase deliverables for validation. " +
			"Returns either PASS (with next-step instructions) or FAIL (with specific items to fix). " +
			"Keep retrying until PASS.",
		parameters: Type.Object({
			phase: Type.Number({ description: "The phase token shown in your current instructions" }),
		}),
		promptSnippet: "Submit phase deliverables for gate check",
		promptGuidelines: [
			"Call coding-workflow-gate ONLY when your phase deliverables are complete",
			"Pass the phase token exactly as shown in your instructions",
			"If gate returns FAIL: read the failure items, fix them, then call coding-workflow-gate again",
			"If gate returns PASS: follow the next-step instructions in the gate result message",
			"Do NOT call any other tools between gate PASS and following the gate result instructions",
		],
		async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: (partial: { content: Array<{ type: string; text: string }>; usage?: unknown }) => void, ctx: ExtensionContext) {
			return executeGateTool(hctx, makeTctx(toolCallId, params, signal, onUpdate, ctx));
		},
		renderCall(args: RenderArgs, theme: ThemeLike) {
			return renderGateCall(args, theme, state.topicDir, PHASES);
		},
		renderResult(result: RenderResultLike, _opts: unknown, theme: ThemeLike) {
			return renderToolResult(result, theme);
		},
	});

	// ── Tool: coding-workflow-init ────────────────────────────

	pi.registerTool({
		name: "coding-workflow-init",
		label: "Coding Workflow Init",
		description:
			"Initialize the coding workflow with a generated slug. " +
			"Call this after reviewing the requirement and generating an appropriate short slug. " +
			"This creates the workspace directory and starts Phase 1.",
		parameters: Type.Object({
			slug: Type.String({
				description:
					"A short, descriptive, English slug for the topic (e.g. 'cart-coupon', 'user-auth'). " +
					"Lowercase, hyphen-separated, max 60 chars. " +
					"Must accurately summarize the core requirement.",
			}),
		}),
		promptSnippet: "Initialize workflow with generated slug",
		promptGuidelines: [
			"Call coding-workflow-init AFTER reviewing the requirement and generating a slug",
			"The slug must be English, lowercase, hyphen-separated, concise",
			"Do NOT include date prefix — it is added automatically",
		],
		async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: (partial: { content: Array<{ type: string; text: string }>; usage?: unknown }) => void, ctx: ExtensionContext) {
			return executeInitTool(hctx, makeTctx(toolCallId, params, signal, onUpdate, ctx));
		},
		renderCall(args: RenderArgs, theme: ThemeLike) {
			return renderInitCall(args, theme);
		},
		renderResult(result: RenderResultLike, _opts: unknown, theme: ThemeLike) {
			return renderInitResult(result, theme);
		},
	});

	// ── Tool: coding-workflow-phase-start ──────────────────

	pi.registerTool({
		name: "coding-workflow-phase-start",
		label: "Coding Workflow Phase Start",
		description:
			"Proceed after gate check passes. No parameters. " +
			"Call this ONLY when the gate result message explicitly tells you to.",
		parameters: Type.Object({}),
		promptSnippet: "Proceed after gate check passes",
		promptGuidelines: [
			"Call coding-workflow-phase-start ONLY when the gate result message says to do so",
			"No parameters needed",
			"Do NOT call this if gate returned FAIL — fix issues and retry gate instead",
		],
		async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: (partial: { content: Array<{ type: string; text: string }>; usage?: unknown }) => void, ctx: ExtensionContext) {
			return executePhaseStartTool(hctx, makeTctx(toolCallId, params, signal, onUpdate, ctx));
		},
		renderCall(_args: RenderArgs, theme: ThemeLike) {
			return renderPhaseStartCall(state.currentPhase, theme);
		},
		renderResult(result: RenderResultLike, _opts: unknown, theme: ThemeLike) {
			return renderToolResult(result, theme);
		},
	});

	// ── Command: /coding-workflow ──────────────────────────

	pi.registerCommand("coding-workflow", {
		description: "Start a coding workflow: /coding-workflow [requirement]. " +
			"With no args, extracts requirement from conversation context. " +
			"AI generates slug, then calls coding-workflow-init to finalize.",
		handler: async (args: string, ctx: ExtensionContext) => {
			if (state.isActive) {
				ctx.ui.notify(
					`Workflow "${state.topicName}" is already active (Phase ${state.currentPhase}/${FINAL_PHASE}). Use /coding-workflow-abort to cancel.`,
					"warning",
				);
				return;
			}
			if (state.pendingInit) {
				ctx.ui.notify("A workflow initialization is already pending. Generate a slug and call coding-workflow-init.", "warning");
				return;
			}

			const trimmed = args.trim();
			if (!trimmed) {
				const messages = extractRecentUserMessages(ctx);
				if (messages.length === 0) {
					ctx.ui.notify("No conversation context found. Provide a requirement: /coding-workflow <requirement>", "warning");
					return;
				}
			}

			state.pendingInit = true;
			state.pendingRequirement = trimmed || "(from conversation context)";
			persistState(pi, state);
			ctx.ui.notify("Coding workflow: requirement captured, waiting for slug generation.", "info");

			let requirementContext: string;
			if (trimmed) {
				requirementContext =
					`The user's requirement is as follows:\n\n---\n${trimmed}\n---\n\n` +
					`Based on the above requirement, generate a short English slug (lowercase, hyphen-separated, max ${MAX_SLUG_LENGTH} chars),\n` +
					`then call coding-workflow-init(slug="your-slug") to initialize.`;
			} else {
				const messages = extractRecentUserMessages(ctx);
				const recentContext = messages.length > 0
					? `\n\n---\nHere is a summary of recent user messages:\n${messages.map((m, i) => `[${i + 1}] ${m.slice(0, REQUIREMENT_EXCERPT_LENGTH)}`).join("\n")}\n---\n`
					: "";
				requirementContext = `Based on the previously discussed requirements, generate a short English slug.${recentContext}`;
			}

			pi.sendUserMessage(
				`[CODING WORKFLOW] Requirement recorded.\n\n` +
				requirementContext +
				`\n\nSlug requirements:\n` +
				`- Concisely and accurately summarize the core requirement\n` +
				`- English only, lowercase, hyphen-separated\n` +
				`- Examples: user-auth, cart-coupon, api-rate-limit\n` +
				`- Do not include a date prefix (added automatically)`,
			);
		},
	});

	// ── Command: /coding-workflow-status ───────────────────

	pi.registerCommand("coding-workflow-status", {
		description: "Show current coding workflow status",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (state.pendingInit) {
				ctx.ui.notify("Workflow pending initialization. Generate a slug and call coding-workflow-init.", "info");
				return;
			}
			if (!state.isActive) {
				ctx.ui.notify("No active coding workflow.", "info");
				return;
			}
			const passed = Object.keys(state.phaseResults).map(Number).sort();
			const lines = [
				`Workflow: ${state.topicName}`,
				`Current Phase: ${state.currentPhase}/${FINAL_PHASE} (${PHASES[state.currentPhase - 1]?.name ?? "?"})`,
				`Topic Dir: ${state.topicDir}`,
				`Passed Phases: ${passed.length > 0 ? passed.join(", ") : "none"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ── Command: /coding-workflow-abort ────────────────────

	pi.registerCommand("coding-workflow-abort", {
		description: "Abort current coding workflow, kill subprocesses, reset state",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (state.pendingInit) {
				state.pendingInit = false;
				state.pendingRequirement = "";
				persistState(pi, state);
				ctx.ui.notify("Pending workflow initialization cancelled.", "info");
				return;
			}
			if (!state.isActive) {
				ctx.ui.notify("No active coding workflow.", "info");
				return;
			}

			for (const proc of activeSubprocesses) {
				try { proc.kill("SIGTERM"); } catch { /* process already terminated */ void undefined; }
			}
			activeSubprocesses.length = 0;

			Object.assign(state, { ...DEFAULT_STATE });
			persistState(pi, state);
			updateWidget(ctx, state);
			ctx.ui.notify("Coding workflow aborted.", "info");
		},
	});

	// ── Event: before_agent_start ──────────────────────────

	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, _ctx: ExtensionContext) => {
		// Sync mutable flag back from closure
		hctx.phase1SkillInjectedByInit = phase1SkillInjectedByInit;
		const result = buildBeforeAgentStartMessage(hctx, event);
		// Sync back in case handler mutated it
		phase1SkillInjectedByInit = hctx.phase1SkillInjectedByInit;
		return result;
	});

	// ── Event: session_start ───────────────────────────────

	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		reconstructState(ctx, state);
		updateWidget(ctx, state);
	});

	// ── Event: session_tree ──────────────────────────────

	pi.on("session_tree", async (_event: unknown, ctx: ExtensionContext) => {
		// Kill any running subprocesses from the old branch
		for (const proc of activeSubprocesses) {
			try { proc.kill("SIGTERM"); } catch { /* process already terminated */ void undefined; }
		}
		activeSubprocesses.length = 0;
		// Clear in-flight state from the old branch
		state.gateInProgress = false;
		state.gateRetryCount = 0;
		state.pendingInit = false;
		persistState(pi, state);
		updateWidget(ctx, state);
	});

	// ── Event: turn_end ────────────────────────────────────

	pi.on("turn_end", async (_event: unknown, ctx: ExtensionContext) => {
		if (!state.isActive || state.pendingInit) return;
		updateWidget(ctx, state);
	});

	// ── Message renderer ───────────────────────────────────

	pi.registerMessageRenderer(
		"coding-workflow-context",
		(_message: unknown, _options: unknown, theme: ThemeLike) => {
			return new Text(
				theme.fg("accent", "[CODING WORKFLOW] ") +
				theme.fg("dim", "Phase instructions injected"),
				0, 0,
			);
		},
	);
}
