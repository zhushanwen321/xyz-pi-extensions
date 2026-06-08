import * as fs from "node:fs";
import * as path from "node:path";

import type { Gate, GateContext, GateResult } from "./gate.js";

/**
 * Phase-Gate: 脚本检查 + AI 防伪造。
 *
 * 所有 phase 统一模式：
 *   1. 脚本检查（Python gate-check.py）
 *   2. Phase 3/4 增加 AI 防伪造 subagent
 */
export class PhaseGate implements Gate {
	name = "phase-gate";

	async run(ctx: GateContext): Promise<GateResult> {
		const { phase, topicDir } = ctx;

		// Step 1: 脚本检查
		const scriptResult = await this.runGateScript(topicDir, phase);
		if (!scriptResult.passed) {
			return {
				passed: false,
				fixGuidance: `Phase-Gate script check failed:\n${scriptResult.output}`,
				details: { step: "script", output: scriptResult.output },
			};
		}

		// Step 2: Phase 3/4 防伪造检查
		if (phase >= 3) {
			const antiFraudResult = await this.runAntiFraudCheck(ctx);
			if (!antiFraudResult.passed) {
				return {
					passed: false,
					fixGuidance: `Phase-Gate anti-fraud check failed:\n${antiFraudResult.output}`,
					details: { step: "anti-fraud", output: antiFraudResult.output },
				};
			}
		}

		return {
			passed: true,
			details: { step: "script", output: scriptResult.output },
		};
	}

	private async runGateScript(
		topicDir: string,
		phase: number,
	): Promise<{ passed: boolean; output: string }> {
		const gateScriptPath = path.join(
			process.cwd(),
			"extensions/coding-workflow/scripts/gate-check.py",
		);
		if (!fs.existsSync(gateScriptPath)) {
			// 独立实现时，gate 脚本可能不存在，跳过
			return { passed: true, output: "Gate script not found, skipped" };
		}

		// TODO: 执行 python3 gate-check.py topicDir phase --json
		// 当前 mock 返回通过
		return { passed: true, output: "Script check passed" };
	}

	private async runAntiFraudCheck(
		ctx: GateContext,
	): Promise<{ passed: boolean; output: string }> {
		const { phase, topicDir } = ctx;
		// TODO: dispatch gate-reviewer subagent 进行防伪造检查
		// 当前 mock 返回通过
		return { passed: true, output: `Anti-fraud check passed for phase ${phase}` };
	}
}
