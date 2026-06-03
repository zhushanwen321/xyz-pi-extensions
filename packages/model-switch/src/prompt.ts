/**
 * Model Switch — Context Prompt 注入格式化
 *
 * session_start：注入模型能力表（[Available Models]）
 * before_agent_start：注入数据+推荐（[Model Context]）
 */

import type { ModelPolicy, QuotaSnapshot, StickinessInfo, RecommendInfo, ModelCapability } from "./types";

// ── 时间常量 ────────────────────────────────────────────

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;

// ── 数据结构 ────────────────────────────────────────────

export interface ContextPromptData {
	currentModel: string;
	stickiness: StickinessInfo;
	snapshot: QuotaSnapshot;
	recommend: RecommendInfo;
	config: ModelPolicy;
	now: Date;
}

// ── session_start：模型能力表 ────────────────────────────

/**
 * 格式化 [Available Models] 表，session_start / resume 时注入。
 * 仅包含 config 中配置的模型。
 */
export function formatSessionModels(config: ModelPolicy): string {
	const lines: string[] = ["[Available Models]"];

	for (const [provider, pcfg] of Object.entries(config.models)) {
		for (const [alias, entry] of Object.entries(pcfg.models)) {
			const caps = entry.capabilities.join(", ");
			lines.push(`  ${alias} (${provider}) [${caps}]`);
		}
	}

	return lines.join("\n");
}

// ── before_agent_start：上下文注入 ───────────────────────

/**
 * 格式化上下文注入文本（每轮注入 ~180-220 tokens）。
 */
export function formatContextPrompt(data: ContextPromptData): string {
	const { currentModel, stickiness, snapshot, recommend, config, now } = data;
	const plan = findPrimaryPlanPeak(config);
	const isPeak = plan ? plan.start <= now.getHours() && now.getHours() < plan.end : false;
	const stickinessThresholds = resolveStickinessThresholds(config);

	const lines: string[] = [];
	lines.push("[Model Context]");
	lines.push(formatCurrentLine(currentModel, stickiness));
	lines.push(formatStickinessLine(stickiness, stickinessThresholds));
	lines.push(formatTimeLine(now, plan));
	lines.push(formatRecommendLine(recommend));

	// Quota lines — 每个有数据的 plan 一行
	const quotaLines = formatQuotaLines(snapshot);
	if (quotaLines.length > 0) lines.push(...quotaLines);

	lines.push(formatSceneLine(config));
	lines.push("Switch: use switch_model tool (takes effect next turn).");

	return lines.join("\n");
}

// ── 内部格式化 ──────────────────────────────────────────

function formatCurrentLine(model: string, stickiness: StickinessInfo): string {
	const inputK = Math.round(stickiness.inputTokens / 1000);
	return `Current: ${model} (${stickiness.turns} turns, ~${inputK}k input)`;
}

function resolveStickinessThresholds(config: ModelPolicy): { minTurns: number; minInputTokens: number } {
	return {
		minTurns: config.stickiness?.minTurns ?? 3,
		minInputTokens: config.stickiness?.minInputTokens ?? 20_000,
	};
}

function formatStickinessLine(
	stickiness: StickinessInfo,
	thresholds: { minTurns: number; minInputTokens: number },
): string {
	if (stickiness.justCompacted) return "Stickiness: Free switch (just compacted).";
	if (stickiness.turns >= thresholds.minTurns && stickiness.inputTokens >= thresholds.minInputTokens) return "Stickiness: Prefer staying (warm cache).";
	return "Stickiness: Switch OK (cold cache).";
}

function formatTimeLine(now: Date, plan: { start: number; end: number; multiplier: number } | undefined): string {
	const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
	if (!plan) return `Time: ${timeStr} | Off-peak`;
	const isPeak = plan.start <= now.getHours() && now.getHours() < plan.end;
	if (!isPeak) return `Time: ${timeStr} | Off-peak`;
	return `Time: ${timeStr} | Peak hours (${plan.start}-${plan.end}, ${plan.multiplier}x cost)`;
}

function formatRecommendLine(recommend: RecommendInfo): string {
	return `Recommend: ${recommend.result} (${recommend.reason})`;
}

function formatQuotaLines(snapshot: QuotaSnapshot): string[] {
	const entries = Object.entries(snapshot.plans);
	if (entries.length === 0) return [];

	return entries.map(([planName, quota]) => {
		const pct = quota.pct !== null ? `${Math.round(quota.pct)}%` : "?";
		const reset = quota.resetSec !== null ? `[reset ${formatResetSec(quota.resetSec)}]` : "";
		return `  ${planName}: ${pct}${reset ? " " + reset : ""}`;
	});
}

function formatSceneLine(config: ModelPolicy): string {
	const parts: string[] = [];
	for (const [scene, aliases] of Object.entries(config.scenes)) {
		if (aliases.length === 0) continue;
		parts.push(`${scene}→${aliases.join("/")}`);
	}
	return `Scene: ${parts.join(" | ")}`;
}

function findPrimaryPlanPeak(config: ModelPolicy): { start: number; end: number; multiplier: number } | undefined {
	const plans = Object.entries(config.plans)
		.filter(([, p]) => p.peak)
		.sort(([, a], [, b]) => a.priority - b.priority);
	return plans[0]?.[1]?.peak;
}

function formatResetSec(sec: number): string {
	if (sec <= 0) return "?";
	const h = Math.floor(sec / SECONDS_PER_HOUR);
	const m = Math.floor((sec % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
	if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m`;
	if (m > 0) return `${m}m`;
	return "<1m";
}
