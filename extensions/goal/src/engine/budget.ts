/**
 * Budget 决策引擎 — 纯函数
 *
 * 零 Pi 依赖。import from "./types"。
 *
 * FR-6.5: tick 是纯函数（不调 Date.now，不查 status）
 * FR-6.2: checkBudgetOnTurnEnd 用 4 个独立 flag
 * FR-8.6: accumulateTokens token 累加算法
 */

import type { GoalRuntimeState } from "./types";

// ── 常量（engine 内部，保持自洽）──────────────────────

const RATIO_HIGH = 0.9;
const RATIO_LOW = 0.7;
const RATIO_TIGHT = 0.8;
const PERCENT_FACTOR = 100;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

// ── 类型 ────────────────────────────────────────────

export interface TokenUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	totalTokens?: number;
}

export interface TickResult {
	timeUsedSeconds: number;
	timeStartedAt: number;
}

export type BudgetDecision =
	| { type: "warning70"; dimension: "token" | "time" }
	| { type: "warning90"; dimension: "token" | "time" };

export interface BudgetCheckResult {
	terminal: { type: "exceeded"; dimension: "token" | "time" } | null;
	warnings: BudgetDecision[];
	shouldSendSteering: boolean;
}

export interface ProgressInput {
	/** 已完成项数（status === "completed"，FR-1 cancelled 非验证项也计为已解决） */
	completedCount: number;
	/** 总项数 */
	totalCount: number;
	/** 未完成项 id（用于 followUp 提示，#8 用） */
	incompleteIds: number[];
	/** 是否有未完成的验证任务（isVerification=true 且未 completed，FR-6 completion audit 用） */
	hasVerificationPending?: boolean;
}

export interface ProgressCheck {
	allTasksDone: boolean;
	noTasksCreated: boolean;
	isStalled: boolean;
	budgetTight: boolean;
	completedCount: number;
	totalCount: number;
}

// ── token 累加（FR-8.6）──────────────────────────────

export function accumulateTokens(currentTokensUsed: number, usage: TokenUsage): number {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	if (input > 0 || output > 0) {
		return currentTokensUsed + Math.max(input - cacheRead, 0) + output;
	}
	return currentTokensUsed + (usage.totalTokens ?? 0);
}

// ── 时间累计（FR-6.5 纯函数）──────────────────────────

export function tick(
	timeStartedAt: number,
	timeUsedSeconds: number,
	now: number,
	isRunning: boolean,
): TickResult {
	if (isRunning && timeStartedAt > 0) {
		const elapsed = (now - timeStartedAt) / MS_PER_SECOND;
		return { timeUsedSeconds: timeUsedSeconds + elapsed, timeStartedAt: now };
	}
	return { timeUsedSeconds, timeStartedAt: now };
}

// ── 百分比计算 ───────────────────────────────────────

export function getTokenUsagePercent(state: GoalRuntimeState): number {
	if (!state.budget.tokenBudget || state.budget.tokenBudget <= 0) return 0;
	return (state.tokensUsed / state.budget.tokenBudget) * PERCENT_FACTOR;
}

export function getTimeUsagePercent(state: GoalRuntimeState, timeUsedSeconds: number): number {
	if (!state.budget.timeBudgetMinutes || state.budget.timeBudgetMinutes <= 0) return 0;
	const budgetSeconds = state.budget.timeBudgetMinutes * SECONDS_PER_MINUTE;
	return (timeUsedSeconds / budgetSeconds) * PERCENT_FACTOR;
}

export function getBudgetColor(percent: number): "error" | "warning" | "muted" {
	if (percent >= RATIO_HIGH * PERCENT_FACTOR) return "error";
	if (percent >= RATIO_LOW * PERCENT_FACTOR) return "warning";
	return "muted";
}

// ── turn end 预算检查（FR-6.2 维度独立）───────────────

export function checkBudgetOnTurnEnd(state: GoalRuntimeState, timeUsedSeconds: number): BudgetCheckResult {
	const result: BudgetCheckResult = { terminal: null, warnings: [], shouldSendSteering: false };

	// token 维度
	if (state.budget.tokenBudget) {
		const tokenPct = state.tokensUsed / state.budget.tokenBudget;
		if (tokenPct >= 1 && state.budgetLimitSteeringSent) {
			result.terminal = { type: "exceeded", dimension: "token" };
			return result;
		}
		if (tokenPct >= RATIO_HIGH && !state.budgetLimitSteeringSent) {
			result.shouldSendSteering = true;
		} else if (tokenPct >= RATIO_HIGH && !state.tokenWarning90Sent) {
			result.warnings.push({ type: "warning90", dimension: "token" });
		} else if (tokenPct >= RATIO_LOW && !state.tokenWarning70Sent) {
			result.warnings.push({ type: "warning70", dimension: "token" });
		}
	}

	// time 维度（FR-6.2: 独立 flag，不被 token 吞）
	if (state.budget.timeBudgetMinutes) {
		const budgetSeconds = state.budget.timeBudgetMinutes * SECONDS_PER_MINUTE;
		if (timeUsedSeconds >= budgetSeconds) {
			result.terminal = { type: "exceeded", dimension: "time" };
			return result;
		}
		const timePct = timeUsedSeconds / budgetSeconds;
		if (timePct >= RATIO_HIGH && !state.timeWarning90Sent) {
			result.warnings.push({ type: "warning90", dimension: "time" });
		} else if (timePct >= RATIO_LOW && !state.timeWarning70Sent) {
			result.warnings.push({ type: "warning70", dimension: "time" });
		}
	}

	return result;
}

// ── resume 预算重检 ──────────────────────────────────

export function checkBudgetOnResume(state: GoalRuntimeState): { type: "exceeded"; dimension: "token" | "time" } | null {
	if (state.budget.tokenBudget && state.tokensUsed >= state.budget.tokenBudget) {
		return { type: "exceeded", dimension: "token" };
	}
	if (state.budget.timeBudgetMinutes) {
		if (state.timeUsedSeconds >= state.budget.timeBudgetMinutes * SECONDS_PER_MINUTE) {
			return { type: "exceeded", dimension: "time" };
		}
	}
	return null;
}

// ── 进度检查 ────────────────────────────────

/**
 * 进度检查（三阶段演进函数，D0）。
 *
 * - #1：去 task 依赖最小改动（task 字段暂置默认值）。
 * - #6（已完成）：删 maxTurnsReached 字段与计算。
 * - #7：改签名接收 ProgressInput，重填 task 相关字段。
 *   progress=undefined（todo 未加载）→ 降级：allTasksDone/noTasksCreated=false、计数为 0。
 *   isStalled 恒 false（#6 后 stall 概念已删，保留字段供 #8 基于 lastProgressTurn 判断）。
 */
export function checkProgress(state: GoalRuntimeState, progress?: ProgressInput): ProgressCheck {
	const completed = progress?.completedCount ?? 0;
	const total = progress?.totalCount ?? 0;
	return {
		allTasksDone: progress ? total > 0 && completed >= total : false,
		noTasksCreated: progress ? total === 0 : false,
		isStalled: false,
		budgetTight: Boolean(
			state.budget.tokenBudget && state.tokensUsed >= state.budget.tokenBudget * RATIO_TIGHT,
		),
		completedCount: completed,
		totalCount: total,
	};
}
