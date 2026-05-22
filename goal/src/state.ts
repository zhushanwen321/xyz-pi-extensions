/**
 * Goal 状态定义和管理
 *
 * 状态机参考 Codex /goal 的 6 种状态：
 *   Active → Paused (用户暂停)
 *   Active → Blocked (连续 stall)
 *   Active → Complete (目标达成)
 *   Active → BudgetLimited (token 预算耗尽)
 *   Active → TimeLimited (时间预算耗尽)
 *   Active → Cancelled (用户清除)
 *
 * 终态（不可被任何状态覆盖）：Complete, BudgetLimited, TimeLimited, Cancelled
 * Paused/Blocked 可被 Active 覆盖（用户 resume）
 */

import { MS_PER_SECOND } from "./constants";

// ── Goal 状态枚举 ──────────────────────────────────────

export type GoalStatus =
	| "active"
	| "paused"
	| "blocked"
	| "complete"
	| "budget_limited"
	| "time_limited"
	| "cancelled";

// 终态：不可被其他状态覆盖
const TERMINAL_STATUSES: ReadonlySet<GoalStatus> = new Set([
	"complete",
	"budget_limited",
	"time_limited",
	"cancelled",
]);

// ── 任务数据结构 ──────────────────────────────────────

export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

export type SubTodoStatus = "pending" | "in_progress" | "completed";

export const SUB_TODO_STATUSES: readonly SubTodoStatus[] = [
	"pending",
	"in_progress",
	"completed",
] as const;

export interface SubTodo {
	id: number;
	text: string;
	status: SubTodoStatus;
}

export const GOAL_TASK_STATUSES: readonly TaskStatus[] = [
	"pending",
	"in_progress",
	"completed",
	"cancelled",
] as const;

export function isTerminalTaskStatus(status: TaskStatus): boolean {
	return status === "completed" || status === "cancelled";
}

export interface GoalTask {
	id: number;
	description: string;
	status: TaskStatus;
	evidence?: string; // 完成时的证据描述
	subTodos?: SubTodo[];
}

// ── 预算配置 ──────────────────────────────────────────

export interface BudgetConfig {
	tokenBudget?: number; // token 预算上限 (undefined = 不限制)
	timeBudgetMinutes?: number; // 时间预算 (分钟, undefined = 不限制)
	maxStallTurns: number; // 连续无进展轮数阈值，触发 blocked
	maxTurns: number; // 最大 turn 数上限
}

// ── 运行时状态（也是持久化数据格式，保持统一）─────────────

export interface GoalRuntimeState {
	goalId: string;
	objective: string;
	status: GoalStatus;
	tasks: GoalTask[];
	turnCount: number;
	stallCount: number;
	tokensUsed: number;
	timeStartedAt: number; // Date.now() timestamp
	timeUsedSeconds: number; // 累计使用秒数（不含当前活跃段）
	budget: BudgetConfig;
	lastProgressTurn: number; // 上次有进展的 turn number
	budgetLimitSteeringSent: boolean; // 是否已发送预算耗尽 steering
	objectiveUpdatedAt: number; // objective 最后更新时间
	lastBlockerReason: string | null; // 上次 report_blocked 的原因，resume 时注入
	budgetWarning70Sent: boolean; // 70% 预算预警已发送（token 或时间任一达 70%）
	budgetWarning90Sent: boolean; // 90% 预算预警已发送
	lastTurnTokensUsed: number; // 上一 turn 结束时的 tokensUsed，用于去抖检测
}

// ── 默认值 ────────────────────────────────────────────

export const DEFAULT_BUDGET: BudgetConfig = {
	maxStallTurns: 5,
	maxTurns: 50,
};

export function createInitialState(objective: string, budget: Partial<BudgetConfig> = {}): GoalRuntimeState {
	return {
		goalId: crypto.randomUUID(),
		objective,
		status: "active",
		tasks: [],
		turnCount: 0,
		stallCount: 0,
		tokensUsed: 0,
		timeStartedAt: Date.now(),
		timeUsedSeconds: 0,
		budget: { ...DEFAULT_BUDGET, ...budget },
		lastProgressTurn: 0,
		budgetLimitSteeringSent: false,
		objectiveUpdatedAt: Date.now(),
		lastBlockerReason: null,
		budgetWarning70Sent: false,
		budgetWarning90Sent: false,
		lastTurnTokensUsed: 0,
	};
}

// ── 状态转换 ──────────────────────────────────────────

/**
 * 安全的状态转换。终态不可被覆盖。
 */
export function transitionStatus(current: GoalStatus, next: GoalStatus): GoalStatus {
	if (TERMINAL_STATUSES.has(current)) return current;
	return next;
}

export function isTerminalStatus(status: GoalStatus): boolean {
	return TERMINAL_STATUSES.has(status);
}

export function isActiveStatus(status: GoalStatus): boolean {
	return status === "active";
}

// ── 序列化（直接用相同类型，避免维护两个相同接口）──────

export function serializeState(state: GoalRuntimeState): GoalRuntimeState {
	return {
		...state,
		tasks: state.tasks.map((t) => ({
			...t,
			subTodos: t.subTodos?.map((s) => ({ ...s })),
		})),
		budget: { ...state.budget },
	};
}

/**
 * 反序列化，补全缺失字段的默认值（向后兼容旧格式数据）
 */
export function deserializeState(data: Record<string, unknown>): GoalRuntimeState {
	return {
		goalId: (data.goalId as string) ?? "",
		objective: (data.objective as string) ?? "",
		status: (data.status as GoalStatus) ?? "active",
		tasks: ((data.tasks as Record<string, unknown>[]) ?? []).map((t: Record<string, unknown>) => {
		if (!("status" in t)) {
			throw new Error("Legacy goal-state format detected, session reset required");
		}
		const rawSubTodos = t.subTodos as Record<string, unknown>[] | undefined;
		const subTodos = Array.isArray(rawSubTodos)
			? rawSubTodos
					.filter((s) => typeof s.id === "number" && typeof s.text === "string" && typeof s.status === "string")
					.map((s) => ({ id: s.id as number, text: s.text as string, status: s.status as SubTodoStatus }))
			: undefined;
		return { ...t, subTodos } as unknown as GoalTask;
	}),
		turnCount: (data.turnCount as number) ?? 0,
		stallCount: (data.stallCount as number) ?? 0,
		tokensUsed: (data.tokensUsed as number) ?? 0,
		timeStartedAt: (data.timeStartedAt as number) ?? Date.now(),
		timeUsedSeconds: (data.timeUsedSeconds as number) ?? 0,
		budget: { ...DEFAULT_BUDGET, ...((data.budget as Partial<BudgetConfig>) ?? {}) },
		lastProgressTurn: (data.lastProgressTurn as number) ?? 0,
		budgetLimitSteeringSent: (data.budgetLimitSteeringSent as boolean) ?? false,
		objectiveUpdatedAt: (data.objectiveUpdatedAt as number) ?? Date.now(),
		lastBlockerReason: (data.lastBlockerReason as string | null) ?? null,
		budgetWarning70Sent: (data.budgetWarning70Sent as boolean) ?? false,
		budgetWarning90Sent: (data.budgetWarning90Sent as boolean) ?? false,
		lastTurnTokensUsed: (data.lastTurnTokensUsed as number) ?? 0,
	};
}

// ── 进度计算 ──────────────────────────────────────────

export function getCompletedCount(tasks: GoalTask[]): number {
	return tasks.filter((t) => t.status === "completed").length;
}

export function getIncompleteTasks(tasks: GoalTask[]): GoalTask[] {
	return tasks.filter((t) => !isTerminalTaskStatus(t.status));
}

export function getElapsedTimeSeconds(state: GoalRuntimeState): number {
	if (isTerminalStatus(state.status) || state.status === "paused") return state.timeUsedSeconds;
	return state.timeUsedSeconds + (Date.now() - state.timeStartedAt) / MS_PER_SECOND;
}

// getTokenUsagePercent 和 getTimeUsagePercent 已移至 budget.ts
// 保留 re-export 以便渐进迁移
export { getTokenUsagePercent, getTimeUsagePercent } from "./budget.js";
