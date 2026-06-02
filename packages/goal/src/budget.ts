/**
 * Goal 预算策略 — 阈值、计算、检查
 *
 * 集中管理 token 和时间预算的所有决策逻辑。
 * 调用者（handleAgentEnd、resume）通过 checkBudget() 获取决策结果，
 * 不再需要了解阈值细节。
 */

import type { GoalRuntimeState } from "./state";
import { getElapsedTimeSeconds } from "./state";
import {
	SECONDS_PER_MINUTE,
	PERCENT_FACTOR,
	BUDGET_RATIO_HIGH,
	BUDGET_RATIO_LOW,
	BUDGET_RATIO_TIGHT,
	BUDGET_PERCENT_HIGH,
	BUDGET_PERCENT_LOW,
} from "./constants";

// ── 决策类型 ────────────────────────────────────────

export type BudgetDecision =
	| { type: "ok" }
	| { type: "warning70"; dimension: "token" | "time" }
	| { type: "warning90"; dimension: "token" | "time" }
	| { type: "steer_limit"; dimension: "token" | "time" }
	| { type: "exceeded"; dimension: "token" | "time" };

// ── 百分比计算（供 widget 使用）──────────────────────

export function getTokenUsagePercent(state: GoalRuntimeState): number {
	if (!state.budget.tokenBudget || state.budget.tokenBudget <= 0) return 0;
	return (state.tokensUsed / state.budget.tokenBudget) * PERCENT_FACTOR;
}

export function getTimeUsagePercent(state: GoalRuntimeState): number {
	if (!state.budget.timeBudgetMinutes || state.budget.timeBudgetMinutes <= 0) return 0;
	const elapsed = getElapsedTimeSeconds(state);
	const budgetSeconds = state.budget.timeBudgetMinutes * SECONDS_PER_MINUTE;
	return (elapsed / budgetSeconds) * PERCENT_FACTOR;
}

// ── Widget 颜色阈值（供 widget.ts 使用）──────────────

export function getBudgetColor(percent: number): "error" | "warning" | "muted" {
	if (percent >= BUDGET_PERCENT_HIGH) return "error";
	if (percent >= BUDGET_PERCENT_LOW) return "warning";
	return "muted";
}

// ── Resume 时的预算检查 ──────────────────────────────

export function checkBudgetOnResume(state: GoalRuntimeState): { type: "exceeded"; dimension: "token" | "time" } | null {
	if (state.budget.tokenBudget && state.tokensUsed >= state.budget.tokenBudget) {
		return { type: "exceeded", dimension: "token" };
	}
	if (state.budget.timeBudgetMinutes) {
		const elapsed = getElapsedTimeSeconds(state);
		if (elapsed >= state.budget.timeBudgetMinutes * SECONDS_PER_MINUTE) {
			return { type: "exceeded", dimension: "time" };
		}
	}
	return null;
}

// ── Agent turn 结束时的预算检查 ─────────────────────

export interface BudgetCheckResult {
	/** 终止性决策（预算耗尽时只返回一个，优先 token） */
	terminal: { type: "exceeded"; dimension: "token" | "time" } | null;
	/** 需要发送的预警（70%/90%） */
	warnings: BudgetDecision[];
	/** 是否已发送过 steering（90% token 收尾） */
	shouldSendSteering: boolean;
}

export function checkBudgetOnTurnEnd(state: GoalRuntimeState): BudgetCheckResult {
	const result: BudgetCheckResult = {
		terminal: null,
		warnings: [],
		shouldSendSteering: false,
	};

	// Token 预算检查
	if (state.budget.tokenBudget) {
		const tokenPct = state.tokensUsed / state.budget.tokenBudget;

		// 100% 耗尽 + 已发过 steering → 终止
		if (tokenPct >= 1 && state.budgetLimitSteeringSent) {
			result.terminal = { type: "exceeded", dimension: "token" };
			return result;
		}

		// 90% + 未发 steering → 发 steer
		if (tokenPct >= BUDGET_RATIO_HIGH && !state.budgetLimitSteeringSent) {
			result.shouldSendSteering = true;
			return result;
		}

		// 90% 预警（未发过）
		if (tokenPct >= BUDGET_RATIO_HIGH && !state.budgetWarning90Sent) {
			result.warnings.push({ type: "warning90", dimension: "token" });
		} else if (tokenPct >= BUDGET_RATIO_LOW && !state.budgetWarning70Sent) {
			result.warnings.push({ type: "warning70", dimension: "token" });
		}
	}

	// 时间预算检查
	if (state.budget.timeBudgetMinutes) {
		const elapsed = getElapsedTimeSeconds(state);
		const timePct = elapsed / (state.budget.timeBudgetMinutes * SECONDS_PER_MINUTE);

		if (elapsed >= state.budget.timeBudgetMinutes * SECONDS_PER_MINUTE) {
			result.terminal = { type: "exceeded", dimension: "time" };
			return result;
		}

		if (timePct >= BUDGET_RATIO_HIGH && !state.budgetWarning90Sent) {
			result.warnings.push({ type: "warning90", dimension: "time" });
		} else if (timePct >= BUDGET_RATIO_LOW && !state.budgetWarning70Sent) {
			result.warnings.push({ type: "warning70", dimension: "time" });
		}
	}

	return result;
}

// ── 进展评估 ────────────────────────────────────────

export interface ProgressCheck {
	allTasksDone: boolean;
	noTasksCreated: boolean;
	maxTurnsReached: boolean;
	isStalled: boolean;
	budgetTight: boolean;
	completedCount: number;
	totalCount: number;
}

export function checkProgress(state: GoalRuntimeState, tasksCompletedAtStart: number): ProgressCheck {
	const incomplete = state.tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
	const completedCount = state.tasks.filter((t) => t.status === "completed").length;
	const totalCount = state.tasks.length;
	const progressThisRound = completedCount - tasksCompletedAtStart;

	return {
		allTasksDone: totalCount > 0 && incomplete.length === 0 && completedCount > 0,
		noTasksCreated: totalCount === 0,
		maxTurnsReached: state.turnCount >= state.budget.maxTurns,
		isStalled: progressThisRound === 0,
		budgetTight: Boolean(
			state.budget.tokenBudget &&
			state.tokensUsed >= state.budget.tokenBudget * BUDGET_RATIO_TIGHT,
		),
		completedCount,
		totalCount,
	};
}
