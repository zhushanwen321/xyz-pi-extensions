/**
 * goal_manager tool 的 action 处理子函数
 *
 * 每个 action 一个 ≤60 行的子函数，由 executeGoalAction 调度。
 * 解决了 P1-6: executeGoalAction ~260 行超过 80 行限制。
 *
 * 行为完全不变 —— 仅做代码组织重构。
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Static } from "typebox";

import { SECONDS_PER_MINUTE } from "./constants";
import {
	getCompletedCount,
	getElapsedTimeSeconds,
	getIncompleteTasks,
	type GoalRuntimeState,
	type GoalTask,
	isTerminalStatus,
	isTerminalTaskStatus,
	type Subtask,
	transitionStatus,
} from "./state";
import { formatTaskList } from "./templates";
import {
	clearGoalSession,
	errorResult,
	type GoalManagerDetails,
	GoalManagerParams,
	type GoalSession,
	makeGoalResult,
	persistGoalState,
	writeGoalHistoryEntry,
} from "./tool-handler";

/** action 处理器签名：所有处理器返回 ToolResult（成功或 errorResult） */
type ActionResult = ReturnType<typeof makeGoalResult> | {
	content: Array<{ type: "text"; text: string }>;
	details: GoalManagerDetails;
};
type ActionContext = {
	pi: ExtensionAPI;
	session: GoalSession;
	state: GoalRuntimeState;
	params: Static<typeof GoalManagerParams>;
	ctx: ExtensionContext;
};
type ActionHandler = (ctx: ActionContext) => ActionResult;

// ── create_tasks ──────────────────────────────────────

export const handleCreateTasks: ActionHandler = ({ state, params, pi, session, ctx }) => {
	if (!params.tasks || params.tasks.length === 0) {
		return errorResult("create_tasks requires a non-empty tasks array");
	}
	const existingIncomplete = getIncompleteTasks(state.tasks);
	if (state.tasks.length > 0 && existingIncomplete.length > 0) {
		return errorResult(
			`Already has ${state.tasks.length} tasks (${existingIncomplete.length} incomplete). Use add_tasks to append, or /goal update to re-plan.`,
		);
	}
	state.tasks = params.tasks.map((desc: string, i: number) => ({
		id: i + 1,
		description: normalizeDescription(desc),
		status: "pending" as const,
		lastUpdatedTurn: state.currentTurnIndex,
	}));
	persistGoalState(pi, session, ctx);
	return makeGoalResult(session,
		`Created ${state.tasks.length} tasks:\n${state.tasks.map((t) => `  #${t.id}: ${t.description}`).join("\n")}`,
	);
};

// ── add_tasks ─────────────────────────────────────────

export const handleAddTasks: ActionHandler = ({ state, params, pi, session, ctx }) => {
	if (!params.tasks || params.tasks.length === 0) {
		return errorResult("add_tasks requires a non-empty tasks array");
	}
	const startId = state.tasks.length > 0
		? Math.max(...state.tasks.map((t) => t.id)) + 1
		: 1;
	const newTasks: GoalTask[] = params.tasks.map((desc: string, i: number) => ({
		id: startId + i,
		description: normalizeDescription(desc),
		status: "pending" as const,
		lastUpdatedTurn: state.currentTurnIndex,
	}));
	state.tasks.push(...newTasks);
	persistGoalState(pi, session, ctx);
	return makeGoalResult(session,
		`Appended ${newTasks.length} tasks:\n${newTasks.map((t) => `  #${t.id}: ${t.description}`).join("\n")}`,
	);
};

// ── update_tasks ──────────────────────────────────────

export const handleUpdateTasks: ActionHandler = ({ state, params, pi, session, ctx }) => {
	if (!params.updates || params.updates.length === 0) {
		return errorResult("update_tasks requires a non-empty updates array");
	}
	const validationErr = validateUpdateTasks(state, params.updates);
	if (validationErr) return validationErr;
	const results: string[] = [];
	for (const u of params.updates) {
		const task = state.tasks.find((t) => t.id === u.taskId)!;
		const prev = task.status;
		task.lastUpdatedTurn = state.currentTurnIndex;
		if (u.status === "completed") {
			task.status = "completed";
			task.evidence = u.evidence;
			results.push(`#${task.id}: ${prev} → completed (${u.evidence})`);
		} else {
			task.status = u.status;
			results.push(`#${task.id}: ${prev} → ${u.status}`);
		}
	}
	persistGoalState(pi, session, ctx);
	return makeGoalResult(session, `Updated ${results.length} tasks:\n${results.join("\n")}`);
};

/** 验证 update_tasks 的所有更新项；返回首个错误或 null。 */
function validateUpdateTasks(state: GoalRuntimeState, updates: NonNullable<Static<typeof GoalManagerParams>["updates"]>) {
	const taskIds = updates.map((u: { taskId: number }) => u.taskId);
	const duplicateIds = taskIds.filter((id: number, i: number) => taskIds.indexOf(id) !== i);
	if (duplicateIds.length > 0) {
		return errorResult(`Duplicate taskIds: ${[...new Set(duplicateIds)].join(", ")}`);
	}
	for (const u of updates) {
		const task = state.tasks.find((t) => t.id === u.taskId);
		if (!task) return errorResult(`Task #${u.taskId} not found`);
		if (isTerminalTaskStatus(task.status)) {
			return errorResult(`Task #${task.id} already in terminal state (${task.status}), cannot be changed`);
		}
		if (u.status === "completed" && (!u.evidence || u.evidence.trim() === "")) {
			return errorResult(`Task #${task.id}: completed requires evidence`);
		}
	}
	return null;
}

// ── list_tasks ────────────────────────────────────────

export const handleListTasks: ActionHandler = ({ state, session }) => {
	return makeGoalResult(session, formatTaskList(state.tasks));
};

// ── complete_goal ─────────────────────────────────────

export const handleCompleteGoal: ActionHandler = ({ state, params, pi, session, ctx }) => {
	if (!params.evidence || params.evidence.trim() === "") {
		return errorResult("complete_goal requires evidence — provide concrete proof that the objective has been achieved");
	}
	if (state.tasks.length === 0) {
		return errorResult("Create a task list with create_tasks before completing the goal.");
	}
	const incomplete = getIncompleteTasks(state.tasks);
	if (incomplete.length > 0) {
		return errorResult(
			`${incomplete.length} tasks still incomplete: ${incomplete.map((t) => `#${t.id}`).join(", ")}. Complete them first or explain why they don't need completion.`,
		);
	}
	if (getCompletedCount(state.tasks) === 0) {
		return errorResult("At least one task must be completed. All-cancelled does not count.");
	}
	state.status = transitionStatus(state.status, "complete");
	state.completedAtTurnIndex = state.currentTurnIndex;
	writeGoalHistoryEntry(pi, session);
	persistGoalState(pi, session, ctx);
	const budgetReport = buildBudgetReport(state);
	return makeGoalResult(session,
		`Objective completed!\nEvidence: ${params.evidence}\n\n--- Budget Report ---\n${budgetReport.join("\n")}`,
	);
};

function buildBudgetReport(state: GoalRuntimeState): string[] {
	const lines: string[] = [];
	lines.push(`Total turns: ${state.currentTurnIndex}`);
	lines.push(`Tasks completed: ${getCompletedCount(state.tasks)}/${state.tasks.length}`);
	if (state.budget.tokenBudget) {
		lines.push(`Token usage: ${state.tokensUsed}/${state.budget.tokenBudget}`);
	}
	const elapsed = getElapsedTimeSeconds(state);
	lines.push(`Duration: ${Math.floor(elapsed / SECONDS_PER_MINUTE)}m${Math.floor(elapsed % SECONDS_PER_MINUTE)}s`);
	return lines;
}

// ── report_blocked ────────────────────────────────────

export const handleReportBlocked: ActionHandler = ({ state, params, pi, session, ctx }) => {
	if (!params.reason || params.reason.trim() === "") {
		return errorResult("report_blocked requires reason — describe what is blocking you");
	}
	state.lastBlockerReason = params.reason;
	state.status = transitionStatus(state.status, "blocked");
	persistGoalState(pi, session, ctx);
	return makeGoalResult(session, `Blocked reported. Reason: ${params.reason}`);
};

// ── cancel_goal ───────────────────────────────────────

export const handleCancelGoal: ActionHandler = ({ state, params, pi, session, ctx }) => {
	if (isTerminalStatus(state.status)) {
		return errorResult(`Goal is already in terminal state (${state.status}).`);
	}
	const reason = params.cancelReason ?? "User requested cancellation";
	const goalId = state.goalId;
	state.status = "cancelled";
	state.completedAtTurnIndex = state.currentTurnIndex;
	writeGoalHistoryEntry(pi, session);
	persistGoalState(pi, session, ctx);
	clearGoalSession(session, ctx);
	const cancelDetails: GoalManagerDetails = {
		action: "cancel",
		tasks: [] as GoalTask[],
		goalId,
		status: "cancelled",
		_render: {
			type: "task-list" as const,
			summary: "Cancelled",
			data: { items: [], meta: {} },
		},
	};
	return {
		content: [{ type: "text" as const, text: `Goal cancelled: ${reason}` }],
		details: cancelDetails,
	};
};

// ── add_subtasks ──────────────────────────────────────

export const handleAddSubtasks: ActionHandler = ({ state, params, pi, session, ctx }) => {
	if (params.taskId === undefined) return errorResult("add_subtasks requires taskId");
	if (!params.texts || params.texts.length === 0) {
		return errorResult("add_subtasks requires a non-empty texts array");
	}
	const parentTask = state.tasks.find((t) => t.id === params.taskId);
	if (!parentTask) return errorResult(`Task #${params.taskId} not found`);
	if (isTerminalTaskStatus(parentTask.status)) {
		return errorResult(`Task #${parentTask.id} already in terminal state (${parentTask.status}), cannot add subtask`);
	}
	const subtasks = parentTask.subtasks ?? [];
	const startId = subtasks.length > 0 ? Math.max(...subtasks.map((s) => s.id)) + 1 : 1;
	const trimmed = params.texts.map((t: string) => t.trim()).filter((t: string) => t.length > 0);
	if (trimmed.length === 0) return errorResult("texts requires at least one non-empty string");
	const newSubtasks: Subtask[] = trimmed.map((text: string, i: number) => ({
		id: startId + i,
		text,
		status: "pending" as const,
		lastUpdatedTurn: state.currentTurnIndex,
	}));
	parentTask.subtasks = [...subtasks, ...newSubtasks];
	persistGoalState(pi, session, ctx);
	return makeGoalResult(session,
		`Added ${newSubtasks.length} subtasks to Task #${parentTask.id}:\n` +
		newSubtasks.map((s) => `  - #${parentTask.id}.${s.id}: ${s.text}`).join("\n"),
	);
};

// ── update_subtasks ───────────────────────────────────

export const handleUpdateSubtasks: ActionHandler = ({ state, params, pi, session, ctx }) => {
	if (params.taskId === undefined) return errorResult("update_subtasks requires taskId");
	if (!params.subUpdates || params.subUpdates.length === 0) {
		return errorResult("update_subtasks requires a non-empty subUpdates array");
	}
	const targetTask = state.tasks.find((t) => t.id === params.taskId);
	if (!targetTask) return errorResult(`Task #${params.taskId} not found`);
	if (!targetTask.subtasks || targetTask.subtasks.length === 0) {
		return errorResult(`Task #${params.taskId} has no subtasks`);
	}
	const results: string[] = [];
	for (const u of params.subUpdates) {
		const sub = targetTask.subtasks.find((s) => s.id === u.subId);
		if (!sub) return errorResult(`Subtask #${params.taskId}.${u.subId} not found`);
		if (sub.status === "completed") {
			return errorResult(`Subtask #${params.taskId}.${sub.id} already completed, cannot be changed`);
		}
		const prev = sub.status;
		sub.status = u.status;
		sub.lastUpdatedTurn = state.currentTurnIndex;
		results.push(`#${params.taskId}.${sub.id}: ${prev} → ${u.status}`);
	}
	persistGoalState(pi, session, ctx);
	return makeGoalResult(session, `Updated ${results.length} subtasks:\n${results.join("\n")}`);
};

// ── delete_subtasks ───────────────────────────────────

export const handleDeleteSubtasks: ActionHandler = ({ state, params, pi, session, ctx }) => {
	if (params.taskId === undefined) return errorResult("delete_subtasks requires taskId");
	if (!params.subIds || params.subIds.length === 0) {
		return errorResult("delete_subtasks requires a non-empty subIds array");
	}
	const delTask = state.tasks.find((t) => t.id === params.taskId);
	if (!delTask) return errorResult(`Task #${params.taskId} not found`);
	if (!delTask.subtasks || delTask.subtasks.length === 0) {
		return errorResult(`Task #${params.taskId} has no subtasks`);
	}
	const uniqueIds = [...new Set(params.subIds)];
	const missing = uniqueIds.filter((id) => !delTask.subtasks!.some((s) => s.id === id));
	if (missing.length > 0) {
		return errorResult(`Subtask ${missing.map((id) => `#${params.taskId}.${id}`).join(", ")} not found`);
	}
	delTask.subtasks = delTask.subtasks.filter((s) => !uniqueIds.includes(s.id));
	if (delTask.subtasks.length === 0) delTask.subtasks = undefined;
	persistGoalState(pi, session, ctx);
	return makeGoalResult(session,
		`Deleted ${uniqueIds.length} subtasks, Task #${params.taskId} has ${delTask.subtasks?.length ?? 0} remaining`,
	);
};

// ── Helpers ───────────────────────────────────────────

/** 将 AI 传入的 task description 标准化：去换行、截断 */
function normalizeDescription(desc: string): string {
	const singleLine = desc.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
	const ELLIPSIS_LENGTH = 3;
	const MAX_TASK_DESC_LENGTH = 80;
	if (singleLine.length > MAX_TASK_DESC_LENGTH) {
		return singleLine.slice(0, MAX_TASK_DESC_LENGTH - ELLIPSIS_LENGTH) + "...";
	}
	return singleLine;
}

// ── Action Dispatch Map ──────────────────────────────

/** action 字符串到处理器的映射。executeGoalAction 使用此表进行分发。 */
export const ACTION_HANDLERS: Record<string, ActionHandler> = {
	create_tasks: handleCreateTasks,
	add_tasks: handleAddTasks,
	update_tasks: handleUpdateTasks,
	list_tasks: handleListTasks,
	complete_goal: handleCompleteGoal,
	report_blocked: handleReportBlocked,
	cancel_goal: handleCancelGoal,
	add_subtasks: handleAddSubtasks,
	update_subtasks: handleUpdateSubtasks,
	delete_subtasks: handleDeleteSubtasks,
};
