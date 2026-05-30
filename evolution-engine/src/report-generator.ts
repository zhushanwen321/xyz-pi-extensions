/**
 * Evolution Engine — 每日报告生成器
 *
 * 将 SignalReport + Suggestions + EffectReview 转换为人类可读的 Markdown 报告。
 */

import type { SignalReport, EvolutionSuggestion, EffectReview } from "./types";

// ── 公共 API ─────────────────────────────────────────

/**
 * 生成每日分析报告的 Markdown 文本。
 * 报告结构：数据概览 → 异常信号 → 趋势变化 → 改进建议 → 效果回顾（条件章节）
 */
export function generateDailyReport(
	signalReport: SignalReport,
	suggestions: EvolutionSuggestion[],
	effectReview?: EffectReview[],
): string {
	const date = new Date(signalReport.generatedAt).toISOString().slice(0, 10);
	const snapshot = signalReport.metricsSnapshot;
	const hasData = snapshot.sessionCount > 0;

	const sections: string[] = [
		`# Evolution Daily Report — ${date}`,
		"",
		"## 数据概览",
		...buildOverview(snapshot, hasData),
		"",
		"## 异常信号",
		...buildAnomalies(signalReport.anomalies),
		"",
		"## 趋势变化",
		...buildTrends(signalReport.trends),
		"",
		"## 改进建议",
		...buildSuggestions(suggestions),
	];

	// 效果回顾：仅有数据时追加
	if (effectReview && effectReview.length > 0) {
		sections.push("", "## 效果回顾", ...buildEffectReview(effectReview));
	}

	return sections.join("\n");
}

// ── 内部格式化函数 ───────────────────────────────────

function buildOverview(
	snapshot: { sessionCount: number; totalToolCalls: number; totalInputTokens: number; totalOutputTokens: number; avgTurnsPerSession: number },
	hasData: boolean,
): string[] {
	if (!hasData) {
		return [
			"- Session 数量：无数据",
			"- 工具调用总数：无数据",
			"- Token 消耗：无数据",
			"- 平均每 session 轮次：无数据",
		];
	}

	return [
		`- Session 数量：${snapshot.sessionCount}`,
		`- 工具调用总数：${snapshot.totalToolCalls}`,
		`- Token 消耗：input ${snapshot.totalInputTokens.toLocaleString()} / output ${snapshot.totalOutputTokens.toLocaleString()}`,
		`- 平均每 session 轮次：${formatNum(snapshot.avgTurnsPerSession)}`,
	];
}

function buildAnomalies(anomalies: Array<{ severity: string; detail: string }>): string[] {
	if (anomalies.length === 0) {
		return ["无异常"];
	}

	return anomalies.map(a => `- [${a.severity.toUpperCase()}] ${a.detail}`);
}

function buildTrends(trends: Array<{ field: string; previous: number; current: number; changePercent: number }>): string[] {
	if (trends.length === 0) {
		return ["无显著变化"];
	}

	return trends.map(t => {
		const sign = t.changePercent >= 0 ? "+" : "";
		return `- ${t.field}: ${formatNum(t.previous)} → ${formatNum(t.current)} (${sign}${formatNum(t.changePercent)}%)`;
	});
}

function buildSuggestions(suggestions: EvolutionSuggestion[]): string[] {
	if (suggestions.length === 0) {
		return ["系统运行良好，无需调整"];
	}

	const lines: string[] = [];
	for (let i = 0; i < suggestions.length; i++) {
		const s = suggestions[i];
		if (i > 0) lines.push("");
		lines.push(`### #${i} [${s.severity.toUpperCase()}] ${s.title}`);
		if (s.description) lines.push(`- 描述：${s.description}`);
		if (s.rationale) lines.push(`- 依据：${s.rationale}`);
		if (s.targetPath) lines.push(`- 修改目标：${s.targetPath}`);
		if (s.instruction) lines.push(`- 修改指令：${s.instruction}`);
	}
	return lines;
}

function buildEffectReview(reviews: EffectReview[]): string[] {
	return reviews.map(r => {
		const sign = r.changePercent >= 0 ? "+" : "";
		return `- ${r.suggestionTitle}: ${r.targetMetric} ${formatNum(r.before)} → ${formatNum(r.after)} (${sign}${formatNum(r.changePercent)}%)`;
	});
}

/** 格式化数字：整数直接显示，浮点保留 2 位，Infinity/NaN 显示为 "N/A" */
function formatNum(n: number): string {
	if (!Number.isFinite(n)) return "N/A";
	return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
