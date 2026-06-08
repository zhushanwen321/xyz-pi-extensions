/**
 * Review-Gate — P1 实现。
 * 优先使用 pi.__workflowRun 驱动 workflow 脚本（phase1-review-gate / phase2-review-gate），
 * 不可用时降级到 runSingleAgent（P0 逻辑）。
 */

// fallow-ignore-file — implements Gate interface members consumed via polymorphism

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { Gate, GateContext, GateResult } from "./gate.js";
import { getReviewGateStatePath } from "../helpers.js";
import { runReviewGateLoop, type ReviewGateResult } from "../review-gate-impl.js";

// ─── Types ────────────────────────────────────────────────

/** Return type from pi.__workflowRun when calling review-gate workflows. */
interface WorkflowReviewResult {
	passed: boolean;
	rounds: number;
	lastMustFix: number;
	/** Stagnation: must_fix did not decrease for 2 consecutive rounds */
	stagnation?: boolean;
	/** Max rounds reached without passing */
	maxRounds?: boolean;
	/** Review file path (Phase 1 only) */
	reviewPath?: string;
}

/** Signature of pi.__workflowRun exposed by workflow extension. */
type WorkflowRunFn = (
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
	timeoutMs?: number,
) => Promise<{ status: string; scriptResult?: unknown; error?: string; runId: string }>;

/** Type adapter: GateContext.onUpdate has UsageStats, runReviewGateLoop expects unknown. */
type RunReviewGateLoopOnUpdate = (partial: { content: Array<{ type: string; text: string }>; usage?: unknown }) => void;

// ─── ReviewGate ───────────────────────────────────────────

export class ReviewGate implements Gate {
	readonly name = "review-gate" as const;

	/** Review-Gate workflow timeout: 15 minutes (longer reviews need more time). */
	private static readonly WORKFLOW_TIMEOUT_MS = 15 * 60_000;
	/** Maximum rounds for review-gate loop. */
	private static readonly MAX_ROUNDS = 3;
	/** Phase 2 complexity routing. */
	private static readonly COMPLEXITY_ROUTING_PHASE = 2;
	/** Stagnation threshold: rounds without must_fix decrease. */
	private static readonly STAGNATION_THRESHOLD = 2;
	/** JSON.stringify indentation. */
	private static readonly JSON_INDENT = 2;

	async run(ctx: GateContext): Promise<GateResult> {
		const workflowRun = this.getWorkflowRun(ctx.pi);
		if (workflowRun) {
			return this.runViaWorkflow(workflowRun, ctx);
		}
		return this.runFallback(ctx);
	}

	// ── Workflow path (pi.__workflowRun) ────────────────────

	private async runViaWorkflow(workflowRun: WorkflowRunFn, ctx: GateContext): Promise<GateResult> {
		const workflowName = `phase${ctx.phase}-review-gate`;
		const args = this.buildWorkflowArgs(ctx);

		const wfResult = await workflowRun(workflowName, args, ctx.signal, ReviewGate.WORKFLOW_TIMEOUT_MS);

		if (wfResult.status !== "completed" || wfResult.error) {
			return {
				passed: false,
				fixGuidance: `Review-Gate workflow '${workflowName}' failed (status=${wfResult.status}): ${wfResult.error ?? "unknown error"}. Fix the issues, then call coding-workflow-gate(phase=${ctx.phase}) again.`,
				details: { status: wfResult.status, runId: wfResult.runId, source: "workflow" },
			};
		}

		const data = wfResult.scriptResult as WorkflowReviewResult | undefined;
		if (!data) {
			return {
				passed: false,
				fixGuidance: `Review-Gate workflow '${workflowName}' returned no result. Fix the issues, then call coding-workflow-gate(phase=${ctx.phase}) again.`,
				details: { status: wfResult.status, source: "workflow" },
			};
		}

		// Persist review-gate state
		await this.persistState(ctx.topicDir, ctx.phase, data);

		if (!data.passed) {
			const reason = data.stagnation
				? `Stagnation: must_fix did not decrease for ${ReviewGate.STAGNATION_THRESHOLD} consecutive rounds (last=${data.lastMustFix}).`
				: data.maxRounds
					? `Max rounds (${data.rounds}) reached (last must_fix=${data.lastMustFix}).`
					: `Failed after ${data.rounds} rounds (last must_fix=${data.lastMustFix}).`;

			return {
				passed: false,
				fixGuidance: `Review-Gate FAILED. ${reason}\n\nFix the issues, then call coding-workflow-gate(phase=${ctx.phase}) again.`,
				details: {
					rounds: data.rounds,
					lastMustFix: data.lastMustFix,
					stagnation: data.stagnation ?? false,
					reviewPath: data.reviewPath,
					source: "workflow",
				},
			};
		}

		return {
			passed: true,
			details: {
				rounds: data.rounds,
				reviewPath: data.reviewPath,
				source: "workflow",
			},
		};
	}

	// ── Fallback path (runSingleAgent) ──────────────────────

	private async runFallback(ctx: GateContext): Promise<GateResult> {
		const result: ReviewGateResult = await runReviewGateLoop(
			ctx.phaseConfig,
			ctx.topicDir,
			ctx.skillResolver,
			ctx.signal,
			ctx.onUpdate as RunReviewGateLoopOnUpdate | undefined,
			ctx.processRegistry,
		);

		if (!result.passed) {
			return {
				passed: false,
				fixGuidance:
					`Review-Gate FAILED after ${result.rounds} rounds (last must_fix=${result.lastMustFix}).\n\n${result.summary}\n\nFix the issues above, then call coding-workflow-gate(phase=${ctx.phase}) again.`,
				details: {
					rounds: result.rounds,
					lastMustFix: result.lastMustFix,
					reviewPath: result.reviewPath,
					source: "fallback",
				},
			};
		}

		return {
			passed: true,
			details: {
				rounds: result.rounds,
				reviewPath: result.reviewPath,
				summary: result.summary,
				source: "fallback",
			},
		};
	}

	// ── Helpers ─────────────────────────────────────────────

	private getWorkflowRun(pi: ExtensionAPI): WorkflowRunFn | undefined {
		const api = pi as unknown as Record<string, unknown>;
		if (typeof api.__workflowRun === "function") {
			return api.__workflowRun as WorkflowRunFn;
		}
		return undefined;
	}

	private buildWorkflowArgs(ctx: GateContext): Record<string, unknown> {
		const args: Record<string, unknown> = {
			topicDir: ctx.topicDir,
			phase: ctx.phase,
			maxRounds: ReviewGate.MAX_ROUNDS,
		};

		// Phase 2: pass complexity for L1/L2 routing
		if (ctx.phase === ReviewGate.COMPLEXITY_ROUTING_PHASE) {
			args.complexity = this.resolveComplexity(ctx.topicDir);
		}

		return args;
	}

	/** Read plan.md frontmatter for complexity level. Default L1. */
	private resolveComplexity(topicDir: string): string {
		const planPath = path.join(topicDir, "plan.md");
		try {
			const content = fs.readFileSync(planPath, "utf8");
			const match = content.match(/^---[\s\S]*?complexity:\s*(L[12])\b/m);
			return match?.[1] ?? "L1";
		} catch {
			return "L1";
		}
	}

	/** Write .review-gate-p{N}.json state file for post-hoc inspection. */
	private async persistState(topicDir: string, phase: number, data: WorkflowReviewResult): Promise<void> {
		const statePath = getReviewGateStatePath(topicDir, phase);
		try {
			await fs.promises.writeFile(statePath, JSON.stringify(data, null, ReviewGate.JSON_INDENT));
		} catch (err) {
			console.error(`[coding-workflow] Failed to persist review-gate state to ${statePath}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
