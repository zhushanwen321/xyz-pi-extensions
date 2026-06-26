/**
 * 纯文本渲染 — tool.ts / cli.ts 共用，输出一致。
 *
 * 零 Pi 依赖（纯函数 + model 类型），CLI 和 tool 调同一批渲染函数。
 */

import type { GateResult } from "./gate.ts";
import {
	completionRatio,
	currentPhase,
	type DesignStatus,
	openGapCount,
	type Phase,
	PHASE_ORDER,
} from "./model.ts";

const STATUS_ICON: Record<string, string> = {
	not_started: "⬜",
	in_progress: "🔄",
	under_review: "🔍",
	completed: "✅",
};

/** 全流程概览（7 阶段状态 + 进度 + open gaps）。 */
export function renderOverview(status: DesignStatus): string {
	const { done, total } = completionRatio(status);
	const cur = currentPhase(status);
	const openGaps = openGapCount(status);
	const lines: string[] = [
		`Design workflow — ${status.topic}`,
		`进度：${done}/${total} 阶段 completed${cur ? `｜当前：${cur}（${status.phases[cur].status}）` : "｜无 active 阶段"}`,
		`Open gaps：${openGaps}`,
		"",
		"阶段状态：",
	];
	for (const p of PHASE_ORDER) {
		const ps = status.phases[p];
		const stepInfo = ps.currentStep ? ` Step ${ps.currentStep}` : "";
		const roundInfo = ps.loopRound > 0 ? ` r${ps.loopRound}` : "";
		lines.push(`  ${STATUS_ICON[ps.status]} ${p}${stepInfo}${roundInfo} — ${ps.status}`);
	}
	return lines.join("\n");
}

/** 单阶段详情（step/round/gaps/gate 检查结果）。 */
export function renderPhaseDetail(status: DesignStatus, phase: Phase, gateResult: GateResult): string {
	const ps = status.phases[phase];
	const gaps = status.gaps.filter((g) => g.phase === phase);
	const lines: string[] = [
		`阶段 ${phase} — ${ps.status}`,
		`当前 Step：${ps.currentStep ?? "(未开始)"}｜轮次：${ps.loopRound}`,
		`开始：${ps.startedAt ?? "(未开始)"}｜完成：${ps.completedAt ?? "(未完成)"}`,
	];
	if (gaps.length > 0) {
		lines.push("", `Gaps（${gaps.length}）：`);
		for (const g of gaps) {
			lines.push(`  [${g.classification}] ${g.id}: ${g.description} — ${g.status}`);
		}
	}
	lines.push("", "Gate 校验（交付物派生）：");
	if (gateResult.ok) {
		lines.push("  ✅ PASS — 交付物齐备，可 complete_phase");
	} else {
		lines.push("  ❌ 未通过：");
		for (const m of gateResult.missing) lines.push(`    - ${m}`);
	}
	return lines.join("\n");
}
