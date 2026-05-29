/**
 * Evolution Engine — 信号摘要器
 *
 * 将原始 Phase 2 报告（~745KB）压缩为 ~5KB 的 SignalReport，
 * 解决原始报告通过 CLI args 传给 pi 子进程导致 "Empty Judge output" 的问题。
 *
 * Pipeline: 原始报告 → extractMetricsSnapshot → detectAnomalies → computeTrends
 *           → buildEffectReview（如有历史）→ summarizeReport → stdin 传给 Judge
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
	MetricsSnapshot,
	Anomaly,
	TrendDelta,
	SignalReport,
	EffectReview,
} from "./types.js";
import { saveMetricsSnapshot } from "./state.js";

// ── 指标提取 ─────────────────────────────────────────

/** 安全提取数字值，缺失或非数字时返回默认值 */
function safeNum(value: unknown, fallback: number = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 从 report._meta 提取基础信息 */
function extractMetaInfo(report: Record<string, unknown>): { date: string; sessionCount: number } {
	const meta = report._meta as Record<string, unknown> | undefined;
	const sessionCount = safeNum(meta?.total_sessions);
	const analysisPeriod = meta?.analysis_period as Record<string, string> | undefined;
	const date = analysisPeriod?.until ?? new Date().toISOString().slice(0, 10);
	return { date, sessionCount };
}

/** 从 report 中提取 tool 和 error 相关指标 */
function extractToolMetrics(report: Record<string, unknown>): {
	totalToolCalls: number;
	editRetryRate: number;
	bashFailureRate: number;
	selfCorrectionRate: number;
	toolFailureRates: Record<string, number>;
} {
	const toolStats = report.tool_stats as Record<string, unknown> | undefined;
	const errorStats = report.error_stats as Record<string, unknown> | undefined;
	return {
		totalToolCalls: safeNum(toolStats?.total_calls),
		editRetryRate: safeNum(toolStats?.edit_retry_rate),
		bashFailureRate: safeNum(errorStats?.bash_failure_rate),
		selfCorrectionRate: safeNum(errorStats?.self_correction_rate),
		toolFailureRates: extractToolFailureRates(errorStats),
	};
}

/** 从 report 中提取 token 和 satisfaction 相关指标 */
function extractTokenAndSatisfactionMetrics(report: Record<string, unknown>): {
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCost: number;
	avgInputPerSession: number;
	avgOutputPerSession: number;
	singleTurnCompletionRate: number;
	avgTurnsPerSession: number;
	avgToolCallsPerSession: number;
	medianSessionMinutes: number;
} {
	const tokenStats = report.token_stats as Record<string, unknown> | undefined;
	const avgPerSession = tokenStats?.avg_per_session as Record<string, unknown> | undefined;
	const satisfaction = report.satisfaction as Record<string, unknown> | undefined;
	const durationStats = satisfaction?.session_duration_stats as Record<string, unknown> | undefined;
	return {
		totalInputTokens: safeNum(tokenStats?.total_input),
		totalOutputTokens: safeNum(tokenStats?.total_output),
		totalCost: safeNum(tokenStats?.cost_total),
		avgInputPerSession: safeNum(avgPerSession?.input),
		avgOutputPerSession: safeNum(avgPerSession?.output),
		singleTurnCompletionRate: safeNum(satisfaction?.single_turn_completion_rate),
		avgTurnsPerSession: safeNum(satisfaction?.avg_turns_per_session),
		avgToolCallsPerSession: safeNum(satisfaction?.avg_tool_calls_per_session),
		medianSessionMinutes: safeNum(durationStats?.median_minutes),
	};
}

/** 从 report 中提取 user 和 skill 相关指标 */
function extractUserAndSkillMetrics(report: Record<string, unknown>): {
	userCorrectionRate: number;
	repeatedRequestCount: number;
	activeSkillCount: number;
	dormantSkillCount: number;
	totalSkillFileSize: number;
} {
	const userPatterns = report.user_patterns as Record<string, unknown> | undefined;
	const corrections = userPatterns?.corrections as Record<string, unknown> | undefined;
	const repeatedRequests = userPatterns?.repeated_requests as unknown[] | undefined;
	const skillStats = report.skill_stats as Record<string, unknown> | undefined;
	const triggeredSkills = skillStats?.triggered_skills as Record<string, unknown> | undefined;
	const neverTriggered = skillStats?.never_triggered as unknown[] | undefined;
	const skillFileSizes = skillStats?.skill_file_sizes as Record<string, number> | undefined;
	return {
		userCorrectionRate: safeNum(corrections?.rate),
		repeatedRequestCount: Array.isArray(repeatedRequests) ? repeatedRequests.length : 0,
		activeSkillCount: triggeredSkills ? Object.keys(triggeredSkills).length : 0,
		dormantSkillCount: Array.isArray(neverTriggered) ? neverTriggered.length : 0,
		totalSkillFileSize: skillFileSizes
			? Object.values(skillFileSizes).reduce((sum, size) => sum + size, 0)
			: 0,
	};
}

/**
 * 从原始报告提取结构化指标快照。
 * 报告结构由 usage-tracker 的 session analyzer 产出。
 */
export function extractMetricsSnapshot(
	report: Record<string, unknown>,
): MetricsSnapshot {
	const meta = extractMetaInfo(report);
	const tool = extractToolMetrics(report);
	const tokenSat = extractTokenAndSatisfactionMetrics(report);
	const userSkill = extractUserAndSkillMetrics(report);

	return {
		date: meta.date,
		sessionCount: meta.sessionCount,
		totalToolCalls: tool.totalToolCalls,
		toolFailureRates: tool.toolFailureRates,
		editRetryRate: tool.editRetryRate,
		bashFailureRate: tool.bashFailureRate,
		singleTurnCompletionRate: tokenSat.singleTurnCompletionRate,
		avgTurnsPerSession: tokenSat.avgTurnsPerSession,
		avgToolCallsPerSession: tokenSat.avgToolCallsPerSession,
		selfCorrectionRate: tool.selfCorrectionRate,
		totalInputTokens: tokenSat.totalInputTokens,
		totalOutputTokens: tokenSat.totalOutputTokens,
		totalCost: tokenSat.totalCost,
		avgInputPerSession: tokenSat.avgInputPerSession,
		avgOutputPerSession: tokenSat.avgOutputPerSession,
		userCorrectionRate: userSkill.userCorrectionRate,
		repeatedRequestCount: userSkill.repeatedRequestCount,
		medianSessionMinutes: tokenSat.medianSessionMinutes,
		activeSkillCount: userSkill.activeSkillCount,
		dormantSkillCount: userSkill.dormantSkillCount,
		totalSkillFileSize: userSkill.totalSkillFileSize,
	};
}

/** 从 error_stats.by_tool 提取失败率 > 0.05 的工具 */
function extractToolFailureRates(
	errorStats: Record<string, unknown> | undefined,
): Record<string, number> {
	const rates: Record<string, number> = {};
	if (!errorStats || typeof errorStats.by_tool !== "object" || !errorStats.by_tool) {
		return rates;
	}

	const byTool = errorStats.by_tool as Record<string, Record<string, unknown>>;
	for (const [tool, data] of Object.entries(byTool)) {
		const errorRate = typeof data.error_rate === "number" ? data.error_rate : 0;
		// 只保留值得关注的高失败率工具
		if (errorRate > 0.05) {
			rates[tool] = errorRate;
		}
	}
	return rates;
}

// ── 压缩工具 ─────────────────────────────────────────

/** 保留 items 数组中前 N 项，丢弃其余 */
export function compressTopN(
	items: Array<Record<string, unknown>>,
	n: number,
): Array<Record<string, unknown>> {
	return items.slice(0, n);
}

/** 按 metricKey 降序排列后保留前 N 项 */
export function compressByProject(
	items: Array<Record<string, unknown>>,
	metricKey: string,
	topN: number,
): Array<Record<string, unknown>> {
	return [...items]
		.sort((a, b) => {
			const va = typeof a[metricKey] === "number" ? a[metricKey] as number : 0;
			const vb = typeof b[metricKey] === "number" ? b[metricKey] as number : 0;
			return vb - va;
		})
		.slice(0, topN);
}

// ── 异常检测 ─────────────────────────────────────────

/**
 * 从原始报告中检测异常信号。
 * 使用固定阈值，不依赖历史数据。
 */
export function detectAnomalies(
	report: Record<string, unknown>,
): Anomaly[] {
	const anomalies: Anomaly[] = [];

	// 工具失败率异常
	const errorStats = report.error_stats as Record<string, unknown> | undefined;
	const byTool = errorStats?.by_tool as Record<string, Record<string, unknown>> | undefined;
	if (byTool) {
		for (const [tool, data] of Object.entries(byTool)) {
			const rate = typeof data.error_rate === "number" ? data.error_rate : 0;
			if (rate >= 0.3) {
				anomalies.push({
					type: "tool_failure",
					detail: `Tool "${tool}" error rate ${(rate * 100).toFixed(1)}%`,
					severity: rate >= 0.5 ? "high" : "medium",
				});
			}
		}
	}

	// 沉睡 skill 异常
	const skillStats = report.skill_stats as Record<string, unknown> | undefined;
	const neverTriggered = skillStats?.never_triggered as string[] | undefined;
	if (Array.isArray(neverTriggered) && neverTriggered.length > 10) {
		anomalies.push({
			type: "dormant_skill",
			detail: `${neverTriggered.length} skills never triggered`,
			severity: neverTriggered.length > 20 ? "high" : "medium",
		});
	}

	// 用户纠正率异常
	const userPatterns = report.user_patterns as Record<string, unknown> | undefined;
	const corrections = userPatterns?.corrections as Record<string, unknown> | undefined;
	const correctionRate = typeof corrections?.rate === "number" ? corrections.rate : 0;
	if (correctionRate > 0.3) {
		anomalies.push({
			type: "user_correction",
			detail: `User correction rate ${(correctionRate * 100).toFixed(1)}%`,
			severity: correctionRate > 0.5 ? "high" : "medium",
		});
	}

	// Token 热点（单项目消耗异常高）
	const tokenStats = report.token_stats as Record<string, unknown> | undefined;
	const hotspots = tokenStats?.hotspots as Array<Record<string, unknown>> | undefined;
	if (Array.isArray(hotspots)) {
		for (const spot of hotspots.slice(0, 3)) {
			const input = typeof spot.input === "number" ? spot.input : 0;
			if (input > 5_000_000) {
				anomalies.push({
					type: "token_hotspot",
					detail: `Project "${spot.project ?? "unknown"}" consumed ${(input / 1_000_000).toFixed(1)}M input tokens`,
					severity: input > 20_000_000 ? "high" : "medium",
				});
			}
		}
	}

	return anomalies;
}

// ── 趋势计算 ─────────────────────────────────────────

/** 需要对比的数值字段及其合理范围 */
const COMPARABLE_FIELDS: Array<{ key: keyof MetricsSnapshot; direction: "lower_better" | "higher_better" }> = [
	{ key: "editRetryRate", direction: "lower_better" },
	{ key: "bashFailureRate", direction: "lower_better" },
	{ key: "singleTurnCompletionRate", direction: "higher_better" },
	{ key: "userCorrectionRate", direction: "lower_better" },
	{ key: "selfCorrectionRate", direction: "higher_better" },
	{ key: "avgTurnsPerSession", direction: "lower_better" },
];

/**
 * 对比当前与上一个 snapshot 的关键指标变化。
 * 只返回变化超过 10% 的指标。
 */
export function computeTrends(
	current: MetricsSnapshot,
	previous: MetricsSnapshot,
): TrendDelta[] {
	const deltas: TrendDelta[] = [];

	for (const { key } of COMPARABLE_FIELDS) {
		const prev = previous[key] as number;
		const curr = current[key] as number;
		if (prev === 0 && curr === 0) continue;

		const changePercent = prev === 0
			? (curr === 0 ? 0 : 100)
			: ((curr - prev) / prev) * 100;

		// 只关注变化超过 10% 的指标
		if (Math.abs(changePercent) >= 10) {
			deltas.push({
				field: key,
				previous: prev,
				current: curr,
				changePercent: Math.round(changePercent * 100) / 100,
			});
		}
	}

	return deltas;
}

// ── 原始报告压缩 ─────────────────────────────────────

/**
 * 从原始报告中提取 Judge 需要的关键子集。
 * 保留 actionable_issues 和 skill_health 的 top-N，
 * 保留 by_project 的 top-5，丢弃冗余的 raw 数据。
 */
function compressReport(report: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	// _meta 保留
	if (report._meta) result._meta = report._meta;

	// actionable_issues 保留前 5
	const issues = report.actionable_issues as Array<Record<string, unknown>> | undefined;
	if (Array.isArray(issues)) {
		result.actionable_issues = compressTopN(issues, 5);
	}

	// skill_health 保留前 10
	const skillHealth = report.skill_health as Array<Record<string, unknown>> | undefined;
	if (Array.isArray(skillHealth)) {
		result.skill_health = compressTopN(skillHealth, 10);
	}

	// satisfaction.by_project 保留 top-5 sessions
	const satisfaction = report.satisfaction as Record<string, unknown> | undefined;
	const byProject = satisfaction?.by_project as Array<Record<string, unknown>> | undefined;
	if (Array.isArray(byProject)) {
		result.satisfaction_top_projects = compressByProject(byProject, "sessions", 5);
	}

	// error_stats 的摘要（只保留聚合指标，去掉详细数据）
	if (report.error_stats && typeof report.error_stats === "object") {
		const {
			by_project: _bp,
			by_tool: _bt,
			top_error_patterns: _tep,
			...errorSummary
		} = report.error_stats as Record<string, unknown> & {
			by_project?: unknown;
			by_tool?: unknown;
			top_error_patterns?: unknown;
		};
		result.error_stats_summary = errorSummary;
	}

	// top_error_patterns 保留前 3
	const errorStats = report.error_stats as Record<string, unknown> | undefined;
	const topPatterns = errorStats?.top_error_patterns as unknown[] | undefined;
	if (Array.isArray(topPatterns)) {
		result.top_error_patterns = topPatterns.slice(0, 3);
	}

	return result;
}

// ── 主入口 ───────────────────────────────────────────

/**
 * 将原始报告压缩为 SignalReport 并持久化。
 * 返回 SignalReport 路径供 Judge stdin 消费。
 */
export function summarizeReport(
	report: Record<string, unknown>,
	metricsHistory: MetricsSnapshot[],
	evolutionDir: string,
	reportPath: string,
): SignalReport {
	// 1. 提取指标快照
	const snapshot = extractMetricsSnapshot(report);

	// 2. 检测异常
	const anomalies = detectAnomalies(report);

	// 3. 计算趋势（需要历史数据）
	let trends: TrendDelta[] = [];
	const previous = metricsHistory.length > 0
		? metricsHistory[metricsHistory.length - 1]
		: undefined;
	if (previous) {
		trends = computeTrends(snapshot, previous);
	}

	// 4. 效果回顾（由 commands.ts 在外部通过 effect-tracker.buildEffectReview 计算）
	const effectReview: EffectReview[] | undefined = undefined;

	// 5. 压缩原始报告
	const compressed = compressReport(report);

	// 6. 组装 SignalReport
	const signalReport: SignalReport = {
		generatedAt: new Date().toISOString(),
		reportPath,
		metricsSnapshot: snapshot,
		anomalies,
		trends,
		effectReview: effectReview,
		compressed,
	};

	// 7. 持久化 snapshot
	saveMetricsSnapshot(evolutionDir, snapshot);

	// 8. 写入信号文件
	const signalPath = join(
		evolutionDir,
		"signals",
		`signal-${snapshot.date}.json`,
	);
	writeFileSync(signalPath, JSON.stringify(signalReport, null, 2), "utf-8");

	return signalReport;
}

