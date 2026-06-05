/**
 * Model Switch — Context Prompt 注入格式化
 *
 * session_start：注入模型能力表（[Available Models]）→ systemPrompt（静态，仅首次）
 * before_agent_start：注入数据+推荐（[Model Context]）→ custom message（动态，每轮）
 *
 * 设计原则：每行自解释，避免缩写标签，让 AI 不需要猜测字段含义。
 *
 * KV cache 注意：
 *   formatSessionModels 的输出在 session 期间固定不变（注入 systemPrompt）。
 *   formatContextPrompt 的输出每轮变化（注入 message），不影响 prefix cache。
 */

import type { ModelPolicy, QuotaSnapshot, RecommendInfo,StickinessInfo } from "./types";

// ── 时间常量 ────────────────────────────────────────────

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;

// ── 格式化常量 ──────────────────────────────────────────

/** token 数转 k 单位的除数 */
const TOKENS_PER_K = 1000;

/** 时间字符串最小位数（"09" 格式） */
const TIME_DIGIT_COUNT = 2;

/** 粘性阈值默认值 */
const DEFAULT_STICKINESS_MIN_TURNS = 3;
const DEFAULT_STICKINESS_MIN_INPUT_TOKENS = 20_000;

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
 * 格式化 [Available Models] 表，session_start / resume 时注入一次。
 * AI 应参考此列表识别用户请求的模型是否能满足需求（如图片处理需 image 能力）。
 */
export function formatSessionModels(config: ModelPolicy): string {
	const lines: string[] = [
		"[Available Models — models you can switch to via switch_model tool]",
	];

	for (const [provider, pcfg] of Object.entries(config.models)) {
		for (const [alias, entry] of Object.entries(pcfg.models)) {
			const caps = entry.capabilities.join(", ");
			lines.push(`  ${alias} (${provider}) [${caps}]`);
		}
	}

	lines.push("Switch to the best model for each task. Check capabilities above for image/text support.");

	return lines.join("\n");
}

// ── before_agent_start：上下文注入 ───────────────────────

/**
 * 格式化上下文注入文本（每轮注入）。
 *
 * 行说明：
 *   [Model Context] — 本段描述模型切换所需的当前运行时环境。AI 应据此决定是否需要切换。
 *   Model — 当前正在使用的模型 + 上下文占用（turns=input轮次, tokens=已消耗输入token数）
 *   Context warmth — 上下文是否"温热"：warm 意味着切换会丢失已缓存的 token，cold 意味着切换代价低
 *   Time — 当前时间 + 高峰期标记（zhipu 在 peak 时段 3x 计费）
 *   Advice — 基于用量+时间计算的推荐：ok to use（可用）/ avoid（建议避免）
 *   usage — 各套餐用量：百分比 + 窗口重置倒计时
 *   Scenes — 使用场景→可用模型映射
 *   Action — 执行切换的方法
 */
export function formatContextPrompt(data: ContextPromptData): string {
	const { currentModel, stickiness, snapshot, recommend, config, now } = data;
	const plan = findPrimaryPlanPeak(config);
	const stickinessThresholds = resolveStickinessThresholds(config);

	const lines: string[] = [];
	lines.push("[Model Context — switch models based on this data]");
	lines.push(formatModelLine(currentModel, stickiness));
	lines.push(formatWarmthLine(stickiness, stickinessThresholds));
	lines.push(formatTimeLine(now, plan));
	lines.push(formatAdviceLine(recommend));

	// Quota lines — 每个有数据的 plan 一行
	const quotaLines = formatQuotaLines(snapshot);
	if (quotaLines.length > 0) lines.push(...quotaLines);

	lines.push(formatSceneLine(config));
	lines.push(formatActionLine(recommend, snapshot, config));

	return lines.join("\n");
}

// ── 内部格式化 ──────────────────────────────────────────

function formatModelLine(model: string, stickiness: StickinessInfo): string {
	const inputK = Math.round(stickiness.inputTokens / TOKENS_PER_K);
	return `Model: ${model} (${stickiness.turns} conversation turns, ~${inputK}k input tokens in context)`;
}

function resolveStickinessThresholds(config: ModelPolicy): { minTurns: number; minInputTokens: number } {
	return {
		minTurns: config.stickiness?.minTurns ?? DEFAULT_STICKINESS_MIN_TURNS,
		minInputTokens: config.stickiness?.minInputTokens ?? DEFAULT_STICKINESS_MIN_INPUT_TOKENS,
	};
}

function formatWarmthLine(
	stickiness: StickinessInfo,
	thresholds: { minTurns: number; minInputTokens: number },
): string {
	if (stickiness.justCompacted) return "Context warmth: Cold (conversation was just compressed — no cost to switch).";
	if (stickiness.turns >= thresholds.minTurns && stickiness.inputTokens >= thresholds.minInputTokens) {
		return `Context warmth: Warm (${stickiness.turns} turns, ~${Math.round(stickiness.inputTokens / TOKENS_PER_K)}k tokens cached — switching loses this cache)`;
	}
	return "Context warmth: Cold (few turns or tokens — switching loses little).";
}

function formatTimeLine(now: Date, plan: { start: number; end: number; multiplier: number } | undefined): string {
	const timeStr = `${String(now.getHours()).padStart(TIME_DIGIT_COUNT, "0")}:${String(now.getMinutes()).padStart(TIME_DIGIT_COUNT, "0")}`;
	if (!plan) return `Time: ${timeStr} | Off-peak`;
	const isPeak = plan.start <= now.getHours() && now.getHours() < plan.end;
	if (!isPeak) return `Time: ${timeStr} | Off-peak`;
	return `Time: ${timeStr} | Peak hours (${plan.start}:00-${plan.end}:00, zhipu tokens cost ${plan.multiplier}x normal)`;
}

function formatAdviceLine(recommend: RecommendInfo): string {
	if (recommend.result === "ok") {
		return `Advice: zhipu is ok to use (${recommend.reason})`;
	}
	return `Advice: avoid zhipu if possible (${recommend.reason})`;
}

function formatQuotaLines(snapshot: QuotaSnapshot): string[] {
	const entries = Object.entries(snapshot.plans);
	if (entries.length === 0) return [];

	const lines: string[] = [];
	for (const [planName, quota] of entries) {
		const pctText = quota.pct !== null ? `${Math.round(quota.pct)}% of window used` : "usage data unavailable";
		const resetText = quota.resetSec !== null ? `resets in ${formatResetSec(quota.resetSec)}` : "";
		lines.push(`  ${planName}: ${pctText}${resetText ? ", " + resetText : ""}`);
	}
	return lines;
}

function formatSceneLine(config: ModelPolicy): string {
	const parts: string[] = [];
	for (const [scene, aliases] of Object.entries(config.scenes)) {
		if (aliases.length === 0) continue;
		parts.push(`${scene}→${aliases.join("/")}`);
	}
	return `Scenes: ${parts.join(" | ")}`;
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
	if (h > 0) return `${h}h${m.toString().padStart(TIME_DIGIT_COUNT, "0")}m`;
	if (m > 0) return `${m}m`;
	return "<1m";
}

/** 根据推荐结果生成明确的行动指令 */
function formatActionLine(recommend: RecommendInfo, snapshot: QuotaSnapshot, config: ModelPolicy): string {
	if (recommend.result === "ok") {
		return "Action: current model is fine. Switch if task complexity changes (switch_model tool).";
	}

	// recommend === "avoid": 找到一个非 peak avoid 的替代模型
	const alternative = findCheapestAlternative(snapshot, config);
	if (alternative) {
		return `Action: RECOMMENDED — switch to ${alternative.alias} (${alternative.provider}/${alternative.modelId}) to save quota. Call: switch_model(action="switch", query="${alternative.alias}").`;
	}

	return `Action: consider switching to a cheaper model. Call: switch_model(action="switch", query="...").`;
}

interface AlternativeModel {
	alias: string;
	provider: string;
	modelId: string;
}

/** 找到用量最低的可用替代模型 */
function findCheapestAlternative(snapshot: QuotaSnapshot, config: ModelPolicy): AlternativeModel | null {
	// 收集所有非 peak plan 的模型
	const candidates: Array<AlternativeModel & { usage: number | null }> = [];

	for (const [provider, pcfg] of Object.entries(config.models)) {
		const planCfg = config.plans[pcfg.plan];
		// 跳过有 peak 且当前建议 avoid 的 plan
		if (planCfg?.peak) continue;

		const quota = snapshot.plans[pcfg.plan];
		const usage = quota?.pct ?? null;

		for (const [alias, entry] of Object.entries(pcfg.models)) {
			candidates.push({ alias, provider, modelId: entry.modelId, usage });
		}
	}

	if (candidates.length === 0) return null;

	// 优先选用量最低的
	candidates.sort((a, b) => {
		const aU = a.usage ?? Number.MAX_SAFE_INTEGER;
		const bU = b.usage ?? Number.MAX_SAFE_INTEGER;
		return aU - bU;
	});

	return candidates[0] ?? null;
}
