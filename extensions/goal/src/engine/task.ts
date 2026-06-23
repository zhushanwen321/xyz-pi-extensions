/**
 * Task 聚合 — 纯状态机 + 双维度投影
 *
 * 零 Pi 依赖（engine 层地基）。
 *
 * 关键约束：validateTaskTransition 只看 status，不看 verification。
 * `completed && !verification` 的全锁逻辑在 service 层实现（见 service.ts complete_goal）。
 */

// ── 状态枚举 ────────────────────────────────────────

export type TaskStatus = "pending" | "in_progress" | "completed" | "verified" | "cancelled";

export type SubtaskStatus = "pending" | "in_progress" | "completed";

export const TASK_STATUSES: readonly TaskStatus[] = [
	"pending",
	"in_progress",
	"completed",
	"verified",
	"cancelled",
] as const;

export const SUBTASK_STATUSES: readonly SubtaskStatus[] = [
	"pending",
	"in_progress",
	"completed",
] as const;

// ── 数据结构 ────────────────────────────────────────

export interface TaskVerification {
	method: string;
	expected: string;
	actual?: string;
}

export interface Subtask {
	id: number;
	text: string;
	status: SubtaskStatus;
	lastUpdatedTurn: number;
}

export interface GoalTask {
	id: number;
	description: string;
	status: TaskStatus;
	evidence?: string;
	verification?: TaskVerification;
	subtasks?: Subtask[];
	lastUpdatedTurn: number;
}

// ── 双维度投影类型 ──────────────────────────────────

export type CompletionState = "not_done" | "done";

export type VerificationState =
	| "no_verification"
	| "pending_verification"
	| "verified";

// ── status 级转换表 ──────────────────────────────────

const LEGAL_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
	pending: ["in_progress", "cancelled"],
	in_progress: ["completed", "cancelled"],
	completed: ["verified"],
	verified: [],
	cancelled: [],
};

const TRANSITION_HINTS: Readonly<Record<TaskStatus, string>> = {
	pending: "allowed: in_progress or cancelled",
	in_progress: "allowed: completed or cancelled",
	completed: "allowed: verified (only if task has verification config)",
	verified: "terminal state, no transitions allowed",
	cancelled: "terminal state, no transitions allowed",
};

// ── 终态判定 ────────────────────────────────────────

export function isTerminalTaskStatus(status: TaskStatus): boolean {
	return status === "verified" || status === "cancelled";
}

// ── 业务语义完成判定 ────────────────────────────────

export function isTaskDone(task: GoalTask): boolean {
	if (task.status === "cancelled") return true;
	if (task.status === "verified") return true;
	if (task.status === "completed" && !task.verification) return true;
	return false;
}

// ── 双维度投影 ──────────────────────────────────────

export function getCompletionState(task: GoalTask): CompletionState {
	if (task.status === "completed" || task.status === "verified" || task.status === "cancelled") {
		return "done";
	}
	return "not_done";
}

export function getVerificationState(task: GoalTask): VerificationState {
	if (task.status === "verified") return "verified";
	if (task.status === "completed" && task.verification) return "pending_verification";
	return "no_verification";
}

// ── 转换合法性校验（纯 status 级）────────────────────

/**
 * 校验 status 级转换合法性。
 * 只看 status，不看 verification。completed→verified 在 status 级合法。
 * `completed && !verification` 全锁由 service 层处理。
 *
 * @returns 错误消息字符串（非法）或 null（合法）
 */
export function validateTaskTransition(from: TaskStatus, to: TaskStatus): string | null {
	const allowed = LEGAL_TRANSITIONS[from];
	if (!allowed || !allowed.includes(to)) {
		const hint = TRANSITION_HINTS[from] ?? "no transitions allowed";
		return `invalid transition ${from} → ${to}. From ${from}, ${hint}`;
	}
	return null;
}

// ── 进度辅助函数（供 service/projection 使用）─────────

/** completed + verified 计数（widget/history 口径） */
export function getCompletedCount(tasks: GoalTask[]): number {
	return tasks.filter((t) => t.status === "completed" || t.status === "verified").length;
}

/** 未完成任务列表（isTaskDone 反向） */
export function getIncompleteTasks(tasks: GoalTask[]): GoalTask[] {
	return tasks.filter((t) => !isTaskDone(t));
}

/** 下一个可用 task id */
export function getNextTaskId(tasks: GoalTask[]): number {
	return tasks.length > 0 ? Math.max(...tasks.map((t) => t.id)) + 1 : 1;
}
