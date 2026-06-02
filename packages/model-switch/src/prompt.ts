/**
 * Model Switch — Context Prompt 注入格式化
 *
 * 将用量数据 + 粘性信息 + 行为规则格式化为 ~150-200 tokens 的注入文本。
 * 不包含推荐结果，由 AI 自主决策。
 */

import type { ModelPolicy, QuotaSnapshot, StickinessInfo } from "./types";

// ── 时间常量 ────────────────────────────────────────────

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;
const PAD_LENGTH = 2;

// ── 数据结构 ────────────────────────────────────────────

export interface ContextPromptData {
	currentModel: string;
	stickiness: StickinessInfo;
	snapshot: QuotaSnapshot;
	config: ModelPolicy;
	now: Date;
}

/** 粘性判断阈值 */
interface StickinessThresholds {
	minTurns: number;
	minInputTokens: number;
}

// ── 公共 API ────────────────────────────────────────────

/**
 * 格式化上下文注入文本。
 */
export function formatContextPrompt(data: ContextPromptData): string {
	const { currentModel, stickiness, snapshot, config, now } = data;
	const plan = findPrimaryPlanPeak(config);
	const isPeak = plan ? plan.start <= now.getHours() && now.getHours() < plan.end : false;
	const stickinessThresholds = resolveStickinessThresholds(config);

	const lines: string[] = [];
	lines.push("[Model Context]");
	lines.push(formatCurrentLine(currentModel, stickiness));
	lines.push(formatStickinessLine(stickiness, stickinessThresholds));
	lines.push(formatTimeLine(now, plan));
	if (snapshot.zai) lines.push(formatZaiLine(snapshot.zai));
	if (snapshot.ocg) lines.push(formatOcgLine(snapshot.ocg));
	lines.push(formatRuleLine(isPeak, config));
	lines.push(formatSceneLine(config));
	lines.push("Switch: use switch_model tool.");

	return lines.join("\n");
}

// ── 内部格式化 ──────────────────────────────────────────

function formatCurrentLine(model: string, stickiness: StickinessInfo): string {
	const inputK = Math.round(stickiness.inputTokens / 1000);
	return `Current: ${model} (${stickiness.turns} turns, ~${inputK}k input)`;
}

function resolveStickinessThresholds(config: ModelPolicy): StickinessThresholds {
	return {
		minTurns: config.stickiness?.minTurns ?? 3,
		minInputTokens: config.stickiness?.minInputTokens ?? 20_000,
	};
}

function formatStickinessLine(stickiness: StickinessInfo, thresholds: StickinessThresholds): string {
	if (stickiness.justCompacted) return "Stickiness: Free switch (just compacted).";
	if (stickiness.turns >= thresholds.minTurns && stickiness.inputTokens >= thresholds.minInputTokens) return "Stickiness: Prefer staying (warm cache).";
	return "Stickiness: Switch OK (cold cache).";
}

function formatTimeLine(now: Date, plan: { start: number; end: number; multiplier: number } | undefined): string {
	const h = now.getHours();
	const m = now.getMinutes();
	const timeStr = `${String(h).padStart(PAD_LENGTH, "0")}:${String(m).padStart(PAD_LENGTH, "0")}`;

	if (!plan) return `Time: ${timeStr} | Off-peak`;
	const isPeak = plan.start <= h && h < plan.end;
	if (!isPeak) return `Time: ${timeStr} | Off-peak`;
	return `Time: ${timeStr} | Peak hours (${plan.start}-${plan.end}, ${plan.multiplier}x Z.ai)`;
}

function formatZaiLine(zai: NonNullable<QuotaSnapshot["zai"]>): string {
	const resetStr = formatResetSec(zai.resetSec);
	return `Z.ai: ${Math.round(zai.pct)}% [5h, reset ${resetStr} | no week/month limit]`;
}

function formatOcgLine(ocg: NonNullable<QuotaSnapshot["ocg"]>): string {
	const rollingReset = formatResetSec(ocg.rollingResetSec);
	const weeklyReset = formatResetSec(ocg.weeklyResetSec);
	const monthlyReset = formatResetSec(ocg.monthlyResetSec);
	return `ocg: rolling ${Math.round(ocg.rollingPct)}% [reset ${rollingReset}], weekly ${Math.round(ocg.weeklyPct)}% [reset ${weeklyReset}], monthly ${Math.round(ocg.monthlyPct)}% [reset ${monthlyReset}]`;
}

function formatRuleLine(isPeak: boolean, config: ModelPolicy): string {
	if (!isPeak) {
		return "Rule: Off-peak: prefer zai (1x cost, no week/month limit). Switch to ocg only when zai rolling ≥95%. Switch takes effect next turn.";
	}

	const ocgPlan = config.plans["opencode-go"];
	const rollingLimit = ocgPlan?.thresholds?.rollingLimitPct ?? 80;
	return `Rule: Peak (3x zai cost). Prefer ocg unless: ocg near limit (≥${rollingLimit}%), or zai resetting soon (<1h), or zai underutilized (<20%). Switch takes effect next turn.`;
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
	if (h > 0) return `${h}h${m.toString().padStart(PAD_LENGTH, "0")}m`;
	if (m > 0) return `${m}m`;
	return "<1m";
}
