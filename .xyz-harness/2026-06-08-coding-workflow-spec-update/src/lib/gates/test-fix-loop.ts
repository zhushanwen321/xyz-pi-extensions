import type { Gate, GateContext, GateResult } from "./gate.js";

import { WorkflowOrchestrator } from "@zhushanwen/pi-workflow";

/**
 * Test-Fix Loop Gate: 启动 Phase 4 Test-Fix Loop Workflow。
 */
export class TestFixLoopGate implements Gate {
	name = "test-fix-loop";

	async run(ctx: GateContext): Promise<GateResult> {
		const { topicDir, signal, pi, ctx: extCtx } = ctx;

		const orch = new WorkflowOrchestrator(pi, extCtx);
		const runId = await orch.run("phase4-test-fix-loop", { topicDir }, undefined, undefined, signal);

		// 轮询等待完成
		await this.waitForCompletion(orch, runId, signal);

		const instance = orch.getInstance(runId);
		const result = (instance?.scriptResult ?? {
			core: { passed: false, round: 0 },
			noncore: { passed: false, round: 0 },
		}) as TestFixLoopResult;

		if (result.core.passed && result.noncore.passed) {
			return {
				passed: true,
				details: {
					coreRounds: result.core.round,
					noncoreRounds: result.noncore.round,
				},
			};
		}

		return {
			passed: false,
			fixGuidance: `Test-Fix Loop failed. Core: ${result.core.passed ? "passed" : "failed"}, Non-core: ${result.noncore ? (result.noncore.passed ? "passed" : "failed") : "not run"}.`,
			details: result as unknown as Record<string, unknown>,
		};
	}

	private async waitForCompletion(
		orch: WorkflowOrchestrator,
		runId: string,
		signal?: AbortSignal,
		pollMs = 500,
		maxPolls = 1200,
	): Promise<void> {
		for (let i = 0; i < maxPolls; i++) {
			if (signal?.aborted) throw new Error("Test-Fix Loop aborted");
			const inst = orch.getInstance(runId);
			const status = (inst as { status?: string } | undefined)?.status;
			if (status === "completed" || status === "failed" || status === "aborted" || status === "budget_limited" || status === "time_limited") {
				return;
			}
			await new Promise((r) => setTimeout(r, pollMs));
		}
		throw new Error("Test-Fix Loop timed out waiting for workflow completion");
	}
}

interface TestFixLoopResult {
	core: { passed: boolean; round: number };
	noncore: { passed: boolean; round: number };
}
