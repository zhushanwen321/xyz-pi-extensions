/**
 * Goal 聚合状态机 — 纯函数
 *
 * 零 Pi 依赖。import from "./types"。
 */

import type { BudgetConfig, GoalRuntimeState, GoalStatus } from "./types";
import { DEFAULT_BUDGET, TERMINAL_GOAL_STATUSES } from "./types";

export function isTerminalStatus(status: GoalStatus): boolean {
	return TERMINAL_GOAL_STATUSES.has(status);
}

export function isActiveStatus(status: GoalStatus): boolean {
	return status === "active";
}

/**
 * 安全的状态转换。终态不可被覆盖（G-016 保持宽松）。
 */
export function transitionStatus(current: GoalStatus, next: GoalStatus): GoalStatus {
	if (TERMINAL_GOAL_STATUSES.has(current)) return current;
	return next;
}

/**
 * 创建初始 GoalRuntimeState。纯数据构造，无副作用。
 */
export function createGoalState(
	objective: string,
	budgetOverrides?: Partial<BudgetConfig>,
): GoalRuntimeState {
	const now = Date.now();
	return {
		goalId: crypto.randomUUID(),
		objective,
		status: "active",
		tasks: [],
		stallCount: 0,
		tokensUsed: 0,
		timeStartedAt: now,
		timeUsedSeconds: 0,
		budget: { ...DEFAULT_BUDGET, ...budgetOverrides },
		lastProgressTurn: 0,
		budgetLimitSteeringSent: false,
		objectiveUpdatedAt: now,
		lastBlockerReason: null,
		tokenWarning70Sent: false,
		tokenWarning90Sent: false,
		timeWarning70Sent: false,
		timeWarning90Sent: false,
		lastTurnTokensUsed: 0,
		currentTurnIndex: 0,
	};
}
