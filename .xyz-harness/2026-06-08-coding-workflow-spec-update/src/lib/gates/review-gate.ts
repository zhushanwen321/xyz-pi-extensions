import * as fs from "node:fs";
import * as path from "node:path";

import { WorkflowOrchestrator } from "@zhushanwen/pi-workflow";

import type { Gate, GateContext, GateResult } from "./gate.js";

interface ReviewGateState {
	phase: number;
	rounds: Array<{
		round: number;
		reviewer: string;
		mustFix: number;
		fixed: number;
	}>;
	status: "running" | "passed" | "failed";
	totalRounds: number;
}

/**
 * Review-Gate: 启动 workflow 脚本进行循环审查。
 */
export class ReviewGate implements Gate {
	name = "review-gate";

	async run(ctx: GateContext): Promise<GateResult> {
		const { phase, topicDir, signal, pi, ctx: extCtx } = ctx;

		// 确保交付物目录存在
		const reviewsDir = this.getReviewReportsDir(topicDir, phase);
		fs.mkdirSync(reviewsDir, { recursive: true });

		// workflow 名称按 phase 路由
		const workflowName = this.resolveWorkflowName(phase);

		// 构造 workflow 参数
		const args: Record<string, unknown> = {
			topicDir,
			phase,
		};

		const orch = new WorkflowOrchestrator(pi, extCtx);
		const runId = await orch.run(workflowName, args, undefined, undefined, signal);

		// 等待 workflow 完成（轮询）
		await this.waitForCompletion(orch, runId, signal);

		const instance = orch.getInstance(runId);
		const result = (instance?.scriptResult ?? { passed: false, rounds: 0, lastMustFix: -1, reviewPath: "" }) as ReviewGateResult;

		// 持久化状态文件
		this.persistState(topicDir, phase, result);

		if (result.passed) {
			return {
				passed: true,
				details: {
					rounds: result.rounds,
					reviewPath: result.reviewPath,
				},
			};
		}

		return {
			passed: false,
			fixGuidance: result.stagnation
				? `Review-Gate stagnated after ${result.rounds} rounds (must_fix did not decrease). Manual intervention required.`
				: `Review-Gate failed after ${result.rounds} rounds (must_fix=${result.lastMustFix}). Fix the issues and retry.`,
			details: {
				rounds: result.rounds,
				lastMustFix: result.lastMustFix,
				reviewPath: result.reviewPath,
				stagnation: result.stagnation,
			},
		};
	}

	private async waitForCompletion(
		orch: WorkflowOrchestrator,
		runId: string,
		signal?: AbortSignal,
		pollMs = 500,
		maxPolls = 600,
	): Promise<void> {
		for (let i = 0; i < maxPolls; i++) {
			if (signal?.aborted) throw new Error("Review-Gate aborted");
			const inst = orch.getInstance(runId);
			const status = (inst as { status?: string } | undefined)?.status;
			if (status === "completed" || status === "failed" || status === "aborted" || status === "budget_limited" || status === "time_limited") {
				return;
			}
			await new Promise((r) => setTimeout(r, pollMs));
		}
		throw new Error("Review-Gate timed out waiting for workflow completion");
	}

	private resolveWorkflowName(phase: number): string {
		switch (phase) {
			case 1: return "phase1-review-gate";
			case 2: return "phase2-review-gate";
			case 3: return "phase3-review-gate";
			default:
				throw new Error(`No review-gate workflow for phase ${phase}`);
		}
	}

	private getReviewReportsDir(topicDir: string, phase: number): string {
		return path.join(topicDir, "changes", "reviews", `phase-${phase}`);
	}

	private getReviewGateStatePath(topicDir: string, phase: number): string {
		return path.join(topicDir, `.review-gate-p${phase}.json`);
	}

	private persistState(
		topicDir: string,
		phase: number,
		result: ReviewGateResult,
	): void {
		const statePath = this.getReviewGateStatePath(topicDir, phase);
		const state: ReviewGateState = {
			phase,
			rounds: result.rounds > 0
				? [{ round: result.rounds, reviewer: "reviewer", mustFix: result.lastMustFix, fixed: 0 }]
				: [],
			status: result.passed ? "passed" : "failed",
			totalRounds: result.rounds,
		};
		fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
	}
}

interface ReviewGateResult {
	passed: boolean;
	rounds: number;
	lastMustFix: number;
	reviewPath: string;
	stagnation?: boolean;
}
