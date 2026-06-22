/**
 * Goal 运行时组合状态类型 — engine 层共享类型定义
 *
 * 零 Pi 依赖。仅 import GoalTask from "./task"。
 *
 * FR-6.2 修复：预警 flag 按 token/time 维度独立（4 个独立 flag），
 * 取代旧版 budgetWarning70Sent/budgetWarning90Sent 共享 flag。
 */

import type { GoalTask } from "./task";

// ── Goal 状态枚举 ────────────────────────────────────

export type GoalStatus =
	| "active"
	| "paused"
	| "blocked"
	| "complete"
	| "budget_limited"
	| "time_limited"
	| "cancelled";

export const TERMINAL_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set([
	"complete",
	"budget_limited",
	"time_limited",
	"cancelled",
]);

// ── 预算配置 ────────────────────────────────────────

export interface BudgetConfig {
	tokenBudget?: number;
	timeBudgetMinutes?: number;
	maxStallTurns: number;
	maxTurns: number;
}

export const DEFAULT_BUDGET: BudgetConfig = {
	maxStallTurns: 5,
	maxTurns: 50,
};

// ── 运行时状态（也是持久化格式）─────────────────────

export interface GoalRuntimeState {
	goalId: string;
	objective: string;
	status: GoalStatus;
	tasks: GoalTask[];
	stallCount: number;
	tokensUsed: number;
	timeStartedAt: number;
	timeUsedSeconds: number;
	budget: BudgetConfig;
	lastProgressTurn: number;
	budgetLimitSteeringSent: boolean;
	objectiveUpdatedAt: number;
	lastBlockerReason: string | null;
	// FR-6.2: 4 个独立预警 flag
	tokenWarning70Sent: boolean;
	tokenWarning90Sent: boolean;
	timeWarning70Sent: boolean;
	timeWarning90Sent: boolean;
	lastTurnTokensUsed: number;
	currentTurnIndex: number;
	completedAtTurnIndex?: number;
}
