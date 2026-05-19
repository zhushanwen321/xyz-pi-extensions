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

export interface GoalTask {
	id: number;
	description: string;
	completed: boolean;
	evidence?: string; // 完成时的证据描述
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
		tasks: state.tasks.map((t) => ({ ...t })),
		budget: { ...state.budget },
	};
}

export function deserializeState(data: GoalRuntimeState): GoalRuntimeState {
	return {
		...data,
		tasks: data.tasks.map((t) => ({ ...t })),
		budget: { ...data.budget },
	};
}

// ── 进度计算 ──────────────────────────────────────────

export function getCompletedCount(tasks: GoalTask[]): number {
	return tasks.filter((t) => t.completed).length;
}

export function getIncompleteTasks(tasks: GoalTask[]): GoalTask[] {
	return tasks.filter((t) => !t.completed);
}

export function getElapsedTimeSeconds(state: GoalRuntimeState): number {
	if (isTerminalStatus(state.status) || state.status === "paused") return state.timeUsedSeconds;
	return state.timeUsedSeconds + (Date.now() - state.timeStartedAt) / 1000;
}

export function getTokenUsagePercent(state: GoalRuntimeState): number {
	if (!state.budget.tokenBudget || state.budget.tokenBudget <= 0) return 0;
	return (state.tokensUsed / state.budget.tokenBudget) * 100;
}

export function getTimeUsagePercent(state: GoalRuntimeState): number {
	if (!state.budget.timeBudgetMinutes || state.budget.timeBudgetMinutes <= 0) return 0;
	const elapsed = getElapsedTimeSeconds(state);
	const budgetSeconds = state.budget.timeBudgetMinutes * 60;
	return (elapsed / budgetSeconds) * 100;
}
