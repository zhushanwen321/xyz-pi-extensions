/**
 * Evolution Engine — 效果追踪器
 *
 * 对比已应用建议前后的 metrics snapshot 变化，
 * 产出 EffectReview 供 Judge 在下次分析时参考。
 *
 * 匹配逻辑：启发式地将 suggestion title 中的关键词映射到 metric 字段名。
 * 无匹配 → 返回空数组，Judge 不会收到效果回顾。
 */

import type {
	HistoryEntry,
	MetricsSnapshot,
	EffectReview,
} from "./types.js";

// ── 关键词 → metric 字段映射 ─────────────────────────

/** suggestion title 中的关键词到 MetricsSnapshot 字段名的启发式映射 */
const KEYWORD_TO_METRIC: Array<{ keywords: string[]; field: keyof MetricsSnapshot }> = [
	{ keywords: ["edit", "retry", "匹配"], field: "editRetryRate" },
	{ keywords: ["bash", "failure", "失败"], field: "bashFailureRate" },
	{ keywords: ["single-turn", "单轮", "completion"], field: "singleTurnCompletionRate" },
	{ keywords: ["correction", "纠正", "用户纠正"], field: "userCorrectionRate" },
	{ keywords: ["self-correction", "自纠正", "self_correction"], field: "selfCorrectionRate" },
	{ keywords: ["turns", "轮次", "avg_turns"], field: "avgTurnsPerSession" },
	{ keywords: ["token", "input", "输入"], field: "totalInputTokens" },
	{ keywords: ["token", "output", "输出"], field: "totalOutputTokens" },
	{ keywords: ["cost", "成本", "花费"], field: "totalCost" },
	{ keywords: ["dormant", "沉睡", "未触发"], field: "dormantSkillCount" },
	{ keywords: ["skill", "技能"], field: "activeSkillCount" },
];

/** 从 suggestion title 中匹配最相关的 metric 字段 */
function matchMetricField(title: string): keyof MetricsSnapshot | null {
	const lower = title.toLowerCase();
	for (const mapping of KEYWORD_TO_METRIC) {
		// 所有关键词都出现在 title 中才算匹配
		if (mapping.keywords.every(kw => lower.includes(kw.toLowerCase()))) {
			return mapping.field;
		}
	}
	// 降级：任一关键词匹配
	for (const mapping of KEYWORD_TO_METRIC) {
		if (mapping.keywords.some(kw => lower.includes(kw.toLowerCase()))) {
			return mapping.field;
		}
	}
	return null;
}

// ── 时间窗口 ─────────────────────────────────────────

function isWithinDays(isoTimestamp: string, days: number): boolean {
	const then = new Date(isoTimestamp).getTime();
	if (Number.isNaN(then)) return false;
	return Date.now() - then < days * 24 * 60 * 60 * 1000;
}

// ── Snapshot 查找 ────────────────────────────────────

/**
 * 找到指定日期或之前最近的 snapshot。
 * metricsHistory 按 date 升序排列。
 */
function findSnapshotBefore(
	metricsHistory: MetricsSnapshot[],
	date: string,
): MetricsSnapshot | null {
	const target = new Date(date).getTime();
	if (Number.isNaN(target)) return null;

	let best: MetricsSnapshot | null = null;
	for (const snapshot of metricsHistory) {
		const t = new Date(snapshot.date).getTime();
		if (Number.isNaN(t)) continue;
		if (t <= target) {
			best = snapshot;
		} else {
			break;
		}
	}
	return best;
}

/** 找到最新的 snapshot */
function findLatestSnapshot(
	metricsHistory: MetricsSnapshot[],
): MetricsSnapshot | null {
	if (metricsHistory.length === 0) return null;
	return metricsHistory[metricsHistory.length - 1];
}

// ── 公共 API ─────────────────────────────────────────

/**
 * 为最近 7 天内的 apply 操作构建效果回顾。
 *
 * @param recentHistory - 最近的 history entries（建议调用方传最近 30 条）
 * @param metricsHistory - metrics 历史快照
 * @returns 效果回顾列表，无匹配时为空数组
 */
export function buildEffectReview(
	recentHistory: HistoryEntry[],
	metricsHistory: MetricsSnapshot[],
): EffectReview[] {
	if (metricsHistory.length === 0) return [];

	// 筛选最近 7 天的 apply 记录
	const recentApplies = recentHistory.filter(
		entry => entry.action === "apply" && isWithinDays(entry.timestamp, 7),
	);

	if (recentApplies.length === 0) return [];

	const latest = findLatestSnapshot(metricsHistory);
	if (!latest) return [];

	const reviews: EffectReview[] = [];

	for (const entry of recentApplies) {
		const field = matchMetricField(entry.title);
		if (!field) continue;

		// 找到 apply 之前的 snapshot
		const beforeSnapshot = entry.metricsSnapshotDate
			? findSnapshotBefore(metricsHistory, entry.metricsSnapshotDate)
			: findSnapshotBefore(metricsHistory, entry.timestamp);

		if (!beforeSnapshot) continue;

		const before = beforeSnapshot[field] as number;
		const after = latest[field] as number;

		if (typeof before !== "number" || typeof after !== "number") continue;
		if (before === 0 && after === 0) continue;

		const changePercent = before === 0
			? 100
			: Math.round(((after - before) / before) * 10000) / 100;

		reviews.push({
			suggestionTitle: entry.title,
			appliedAt: entry.timestamp,
			targetMetric: field,
			before,
			after,
			changePercent,
		});
	}

	return reviews;
}
