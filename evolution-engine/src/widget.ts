/**
 * Evolution Engine — TUI 渲染函数
 *
 * 4 个纯函数，被 index.ts 的 renderCall/renderResult 调用。
 * 只负责文本格式化，不涉及 I/O。
 */

import type { EvolutionSuggestion, HistoryEntry, StatsData, AutoTriggerFlag } from "./types";

// ── renderSuggestionCard ─────────────────────────────

/**
 * 渲染单条建议卡片，用于 evolve 工具的结果展示。
 */
export function renderSuggestionCard(
	suggestion: EvolutionSuggestion,
	index: number,
	_total: number,
): string {
	const severity = suggestion.severity.toUpperCase();
	const conf = suggestion.confidence.toFixed(2);
	const header = `#[${index}] [${severity} conf:${conf}] ${suggestion.targetPath}`;

	// instruction 预览：只取前 10 行
	const instructionLines = suggestion.instruction.split("\n").slice(0, 10);
	const instructionPreview = instructionLines.join("\n");

	const lines = [
		header,
		suggestion.title,
		// 原因摘要：取第一行或截断
		suggestion.rationale.split("\n")[0],
		"---",
		instructionPreview,
		"Use: /evolve-apply action=apply index=<N> or action=skip index=<N>",
	];

	return lines.join("\n");
}

/**
 * 渲染全部建议的摘要。
 */
export function renderSuggestionSummary(suggestions: EvolutionSuggestion[]): string {
	if (suggestions.length === 0) {
		return "No evolution suggestions generated.";
	}

	const lines = [`Evolution suggestions (${suggestions.length}):`];

	for (let i = 0; i < suggestions.length; i++) {
		const s = suggestions[i];
		const severity = s.severity.toUpperCase();
		const conf = s.confidence.toFixed(2);
		lines.push(
			`  #${i} [${severity} conf:${conf}] ${s.title}`,
			`       target: ${s.targetPath}`,
		);
	}

	lines.push("");
	lines.push("Use /evolve-apply action=list to review details.");
	lines.push("Then /evolve-apply action=apply index=<N> or action=skip index=<N> per suggestion.");

	return lines.join("\n");
}

// ── renderStatsDashboard ─────────────────────────────

/**
 * 渲染统计仪表盘。
 */
export function renderStatsDashboard(stats: StatsData): string {
	const lines: string[] = [];

	lines.push("=== Evolution Stats (last 7 days) ===");
	lines.push("");
	lines.push(`Tool calls: ${stats.toolCalls}`);
	lines.push(`Tokens: ${stats.tokenInput.toLocaleString()} in / ${stats.tokenOutput.toLocaleString()} out`);
	lines.push("");

	if (stats.topSkills.length > 0) {
		lines.push("Top Skills:");
		for (const s of stats.topSkills) {
			lines.push(`  ${s.name}: ${s.count}`);
		}
		lines.push("");
	}

	if (stats.topFailures.length > 0) {
		lines.push("High Failure Rate Tools:");
		for (const f of stats.topFailures) {
			lines.push(`  ${f.tool}: ${(f.rate * 100).toFixed(1)}%`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

// ── renderRollbackList ────────────────────────────────

/**
 * 渲染可回滚操作列表。
 */
export function renderRollbackList(history: HistoryEntry[]): string {
	if (history.length === 0) {
		return "No evolution history found.";
	}

	const lines = ["Evolution History (recent):"];

	for (let i = 0; i < history.length; i++) {
		const h = history[i];
		const ts = h.timestamp.replace("T", " ").slice(0, 19);
		const action = h.action === "apply" ? "APPLY  " : "ROLLBACK";
		lines.push(
			`  #${i + 1} ${ts} | ${action} | ${h.title}`,
			`       ${h.targetPath}`,
		);
	}

	return lines.join("\n");
}

// ── renderAutoTriggerHint ────────────────────────────

/**
 * 渲染自动触发提示。空数组返回空字符串。
 */
export function renderAutoTriggerHint(flags: AutoTriggerFlag[]): string {
	if (flags.length === 0) return "";

	const lines = [
		"Evolution auto-trigger detected:",
	];

	for (const flag of flags) {
		lines.push(`  [${flag.rule}] ${flag.detail}`);
	}

	lines.push("");
	lines.push("Consider running /evolve to analyze and suggest improvements.");

	return lines.join("\n");
}
