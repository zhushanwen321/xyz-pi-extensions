/**
 * Goal 扩展 — Tool 执行处理器和共享 helpers
 *
 * 从 index.ts 提取的 executeGoalAction 及其依赖的辅助函数、类型和 schema。
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, CustomEntry, SessionEntry } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";

import {
	type GoalRuntimeState,
	type GoalTask,
	type Subtask,
	serializeState,
	transitionStatus,
	isTerminalStatus,
	isTerminalTaskStatus,
	getCompletedCount,
	getIncompleteTasks,
	getElapsedTimeSeconds,
	GOAL_TASK_STATUSES,
	SUBTASK_STATUSES,
} from "./state";

import { formatTaskList } from "./templates";

import { renderStatusLine, renderWidgetLines, renderTerminalStatusLine } from "./widget";

import {
	SECONDS_PER_MINUTE,
	MS_PER_SECOND,
} from "./constants";

// ── 常量 ─────────────────────────────────────────────

const ENTRY_TYPE = "goal-state";

export const HISTORY_ENTRY_TYPE = "goal-history";

// ── Session State Interface ──────────────────────────

export interface GoalSession {
	state: GoalRuntimeState | null;
	tasksCompletedAtAgentStart: number;
	hasPendingInjection: boolean;
}

// ── Tool Parameter Schema ────────────────────────────

export const GoalManagerParams = Type.Object({
	action: StringEnum([
		"create_tasks",
		"add_tasks",
		"update_tasks",
		"list_tasks",
		"complete_goal",
		"cancel_goal",
		"report_blocked",
		"add_subtasks",
		"update_subtasks",
		"delete_subtasks",
	] as const),
	tasks: Type.Optional(Type.Array(Type.String(), { description: "Task descriptions. Each must be a one-line summary (max 60 chars), no newlines or markdown" })),
	updates: Type.Optional(Type.Array(Type.Object({
		taskId: Type.Number(),
		status: StringEnum(GOAL_TASK_STATUSES),
		evidence: Type.Optional(Type.String()),
	}))),
	taskId: Type.Optional(Type.Number({ description: "Task ID (required for subtask operations)" })),
	texts: Type.Optional(Type.Array(Type.String(), { description: "Subtask text list (for add_subtasks)" })),
	subUpdates: Type.Optional(Type.Array(Type.Object({
		subId: Type.Number(),
		status: StringEnum(SUBTASK_STATUSES),
	}))),
	subIds: Type.Optional(Type.Array(Type.Number(), { description: "Subtask ID list (for delete_subtasks)" })),
	evidence: Type.Optional(Type.String({ description: "Evidence for completion (required for complete_goal)" })),
	reason: Type.Optional(Type.String({ description: "Reason for being blocked (required for report_blocked)" })),
	cancelReason: Type.Optional(Type.String({ description: "Why the user wants to cancel (required for cancel_goal)" })),
});

// ── Tool Details Types ───────────────────────────────

export interface GoalManagerDetails {
	action: string;
	tasks: GoalTask[];
	goalId: string;
	status: string;
	_render?: {
		type: "task-list" | "summary-table" | "progress" | "code-block";
		summary?: string;
		data: unknown;
	};
}

// ── Module-level Helpers ─────────────────────────────

export function isGoalEntry(entry: SessionEntry): entry is CustomEntry<GoalRuntimeState> {
	return entry.type === "custom" && (entry as CustomEntry).customType === ENTRY_TYPE;
}

export function persistGoalState(pi: ExtensionAPI, session: GoalSession, _ctx: ExtensionContext): void {
	if (!session.state) return;
	const now = Date.now();
	if (session.state.timeStartedAt > 0) {
		session.state.timeUsedSeconds += (now - session.state.timeStartedAt) / MS_PER_SECOND;
		session.state.timeStartedAt = now;
	}
	pi.appendEntry(ENTRY_TYPE, serializeState(session.state));
}

export function writeGoalHistoryEntry(pi: ExtensionAPI, session: GoalSession): void {
	const state = session.state;
	if (!state) return;
	pi.appendEntry(HISTORY_ENTRY_TYPE, {
		goalId: state.goalId,
		objective: state.objective,
		status: state.status,
		completedTasks: getCompletedCount(state.tasks),
		totalTasks: state.tasks.length,
		elapsedSeconds: Math.floor(getElapsedTimeSeconds(state)),
		timestamp: Date.now(),
	});
}

export function updateWidget(session: GoalSession, ctx: ExtensionContext): void {
	if (!session.state || session.state.status === "cancelled") {
		ctx.ui.setWidget("goal", undefined);
		ctx.ui.setStatus("goal", undefined);
		return;
	}

	// 终态折叠为单行 status bar
	if (isTerminalStatus(session.state.status)) {
		const statusText = renderTerminalStatusLine(session.state, ctx.ui.theme);
		if (statusText) {
			ctx.ui.setStatus("goal", statusText);
		}
		ctx.ui.setWidget("goal", undefined);
		return;
	}

	ctx.ui.setStatus("goal", renderStatusLine(session.state, ctx.ui.theme));
	ctx.ui.setWidget("goal", renderWidgetLines(session.state, ctx.ui.theme));
}

export function clearGoalSession(session: GoalSession, ctx: ExtensionContext): void {
	session.state = null;
	session.tasksCompletedAtAgentStart = 0;
	session.hasPendingInjection = false;
	ctx.ui.setWidget("goal", undefined);
	ctx.ui.setStatus("goal", undefined);
}

// ── Result Builder ───────────────────────────────────

export function makeGoalResult(session: GoalSession, text: string) {
	const state = session.state;
	if (!state) throw new Error("No active goal");
	const budgetInfo: string[] = [];
	if (state.budget.tokenBudget) {
		const remaining = Math.max(state.budget.tokenBudget - state.tokensUsed, 0);
		budgetInfo.push(`Token: ${state.tokensUsed}/${state.budget.tokenBudget} (${remaining} remaining)`);
	}
	if (state.budget.timeBudgetMinutes) {
		const elapsed = getElapsedTimeSeconds(state);
		const remaining = Math.max(state.budget.timeBudgetMinutes * SECONDS_PER_MINUTE - elapsed, 0);
		budgetInfo.push(`Time: ${Math.floor(elapsed / SECONDS_PER_MINUTE)}m/${state.budget.timeBudgetMinutes}m (${Math.floor(remaining / SECONDS_PER_MINUTE)}m remaining)`);
	}
	const suffix = budgetInfo.length > 0 ? `\n\n[Budget] ${budgetInfo.join(" | ")}` : "";
	return {
		content: [{ type: "text" as const, text: text + suffix }],
		details: {
			action: "update",
			tasks: state.tasks.map((t) => ({ ...t })),
			goalId: state.goalId,
			status: state.status,
			_render: {
				type: "task-list" as const,
				summary: `${getCompletedCount(state.tasks)}/${state.tasks.length} completed`,
				data: {
					items: state.tasks.map((t) => ({
						id: t.id,
						text: t.description,
						status: t.status,
						evidence: t.evidence,
						subtasks: t.subtasks?.map((s) => ({
							id: s.id,
							text: s.text,
							status: s.status,
						})),
					})),
					meta: {
						...(state.budget.tokenBudget ? { "Token": `${state.tokensUsed}/${state.budget.tokenBudget}` } : {}),
						...(state.budget.timeBudgetMinutes ? { "Time": `${Math.floor(getElapsedTimeSeconds(state) / SECONDS_PER_MINUTE)}m/${state.budget.timeBudgetMinutes}m` } : {}),
						"Turn": `${state.turnCount}/${state.budget.maxTurns}`,
					},
				},
			},
		} satisfies GoalManagerDetails,
	};
}

// ── Tool Execute Handler ──────────────────────────────

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

export async function executeGoalAction(
	pi: ExtensionAPI,
	session: GoalSession,
	params: Static<typeof GoalManagerParams>,
	ctx: ExtensionContext,
) {
	const state = session.state;
	if (!state) {
		throw new Error("Goal mode not active. Use /goal <objective> to start.");
	}

	switch (params.action) {
		case "create_tasks": {
			if (!params.tasks || params.tasks.length === 0) {
				throw new Error("create_tasks requires a non-empty tasks array");
			}
			const existingIncomplete = getIncompleteTasks(state.tasks);
			if (state.tasks.length > 0 && existingIncomplete.length > 0) {
				throw new Error(
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
		}

		case "add_tasks": {
			if (!params.tasks || params.tasks.length === 0) {
				throw new Error("add_tasks requires a non-empty tasks array");
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
		}

		case "update_tasks": {
			if (!params.updates || params.updates.length === 0) {
				throw new Error("update_tasks requires a non-empty updates array");
			}
			const taskIds = params.updates.map((u: { taskId: number; status: string; evidence?: string }) => u.taskId);
			const duplicateIds = taskIds.filter((id: number, i: number) => taskIds.indexOf(id) !== i);
			if (duplicateIds.length > 0) {
				throw new Error(`Duplicate taskIds: ${[...new Set(duplicateIds)].join(", ")}`);
			}
			for (const u of params.updates) {
				const task = state.tasks.find((t) => t.id === u.taskId);
				if (!task) {
					throw new Error(`Task #${u.taskId} not found`);
				}
				if (isTerminalTaskStatus(task.status)) {
					throw new Error(`Task #${task.id} already in terminal state (${task.status}), cannot be changed`);
				}
				if (u.status === "completed" && (!u.evidence || u.evidence.trim() === "")) {
					throw new Error(`Task #${task.id}: completed requires evidence`);
				}
			}
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
		}

		case "list_tasks": {
			return makeGoalResult(session, formatTaskList(state.tasks));
		}

		case "complete_goal": {
			if (!params.evidence || params.evidence.trim() === "") {
				throw new Error("complete_goal requires evidence — provide concrete proof that the objective has been achieved");
			}
			if (state.tasks.length === 0) {
				throw new Error("Create a task list with create_tasks before completing the goal.");
			}
			const incomplete = getIncompleteTasks(state.tasks);
			if (incomplete.length > 0) {
				throw new Error(
					`${incomplete.length} tasks still incomplete: ${incomplete.map((t) => `#${t.id}`).join(", ")}. Complete them first or explain why they don't need completion.`,
				);
			}
			const completedCount = getCompletedCount(state.tasks);
			if (completedCount === 0) {
				throw new Error("At least one task must be completed. All-cancelled does not count.");
			}
			state.status = transitionStatus(state.status, "complete");
			state.completedAtTurnIndex = state.currentTurnIndex;
			writeGoalHistoryEntry(pi, session);
			persistGoalState(pi, session, ctx);
			const budgetReport: string[] = [];
			budgetReport.push(`Total turns: ${state.turnCount}`);
			budgetReport.push(`Tasks completed: ${getCompletedCount(state.tasks)}/${state.tasks.length}`);
			if (state.budget.tokenBudget) {
				budgetReport.push(`Token usage: ${state.tokensUsed}/${state.budget.tokenBudget}`);
			}
			const elapsed = getElapsedTimeSeconds(state);
			budgetReport.push(`Duration: ${Math.floor(elapsed / SECONDS_PER_MINUTE)}m${Math.floor(elapsed % SECONDS_PER_MINUTE)}s`);
			return makeGoalResult(session,
				`Objective completed!\nEvidence: ${params.evidence}\n\n--- Budget Report ---\n${budgetReport.join("\n")}`,
			);
		}

		case "report_blocked": {
			if (!params.reason || params.reason.trim() === "") {
				throw new Error("report_blocked requires reason — describe what is blocking you");
			}
			state.lastBlockerReason = params.reason;
			state.status = transitionStatus(state.status, "blocked");
			persistGoalState(pi, session, ctx);
			return makeGoalResult(session, `Blocked reported. Reason: ${params.reason}`);
		}

		case "cancel_goal": {
			if (isTerminalStatus(state.status)) {
				throw new Error(`Goal is already in terminal state (${state.status}).`);
			}
			const reason = params.cancelReason ?? "User requested cancellation";
			const goalId = state.goalId;
			state.status = "cancelled";
			state.completedAtTurnIndex = state.currentTurnIndex;
			writeGoalHistoryEntry(pi, session);
			persistGoalState(pi, session, ctx);
			clearGoalSession(session, ctx);
			return {
				content: [{ type: "text" as const, text: `Goal cancelled: ${reason}` }],
				details: {
					action: "cancel",
					tasks: [],
					goalId,
					status: "cancelled",
					_render: {
						type: "task-list" as const,
						summary: "Cancelled",
						data: { items: [], meta: {} },
					},
				} satisfies GoalManagerDetails,
			};
		}

		case "add_subtasks": {
			if (params.taskId === undefined) {
				throw new Error("add_subtasks requires taskId");
			}
			if (!params.texts || params.texts.length === 0) {
				throw new Error("add_subtasks requires a non-empty texts array");
			}
			const parentTask = state.tasks.find((t) => t.id === params.taskId);
			if (!parentTask) {
				throw new Error(`Task #${params.taskId} not found`);
			}
			if (isTerminalTaskStatus(parentTask.status)) {
				throw new Error(`Task #${parentTask.id} already in terminal state (${parentTask.status}), cannot add subtask`);
			}
			const subtasks = parentTask.subtasks ?? [];
			const startId = subtasks.length > 0 ? Math.max(...subtasks.map((s) => s.id)) + 1 : 1;
			const trimmed = params.texts.map((t: string) => t.trim()).filter((t: string) => t.length > 0);
			if (trimmed.length === 0) {
				throw new Error("texts requires at least one non-empty string");
			}
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
		}

		case "update_subtasks": {
			if (params.taskId === undefined) {
				throw new Error("update_subtasks requires taskId");
			}
			if (!params.subUpdates || params.subUpdates.length === 0) {
				throw new Error("update_subtasks requires a non-empty subUpdates array");
			}
			const targetTask = state.tasks.find((t) => t.id === params.taskId);
			if (!targetTask) {
				throw new Error(`Task #${params.taskId} not found`);
			}
			if (!targetTask.subtasks || targetTask.subtasks.length === 0) {
				throw new Error(`Task #${params.taskId} has no subtasks`);
			}
			const results: string[] = [];
			for (const u of params.subUpdates) {
				const sub = targetTask.subtasks.find((s) => s.id === u.subId);
				if (!sub) {
					throw new Error(`Subtask #${params.taskId}.${u.subId} not found`);
				}
				if (sub.status === "completed") {
					throw new Error(`Subtask #${params.taskId}.${sub.id} already completed, cannot be changed`);
				}
				const prev = sub.status;
				sub.status = u.status;
				sub.lastUpdatedTurn = state.currentTurnIndex;
				results.push(`#${params.taskId}.${sub.id}: ${prev} → ${u.status}`);
			}
			persistGoalState(pi, session, ctx);
			return makeGoalResult(session,
				`Updated ${results.length} subtasks:\n${results.join("\n")}`,
			);
		}

		case "delete_subtasks": {
			if (params.taskId === undefined) {
				throw new Error("delete_subtasks requires taskId");
			}
			if (!params.subIds || params.subIds.length === 0) {
				throw new Error("delete_subtasks requires a non-empty subIds array");
			}
			const delTask = state.tasks.find((t) => t.id === params.taskId);
			if (!delTask) {
				throw new Error(`Task #${params.taskId} not found`);
			}
			if (!delTask.subtasks || delTask.subtasks.length === 0) {
				throw new Error(`Task #${params.taskId} has no subtasks`);
			}
			const uniqueIds = [...new Set(params.subIds)];
			const missing = uniqueIds.filter((id) => !delTask.subtasks!.some((s) => s.id === id));
			if (missing.length > 0) {
				throw new Error(`Subtask ${missing.map((id) => `#${params.taskId}.${id}`).join(", ")} not found`);
			}
			delTask.subtasks = delTask.subtasks.filter((s) => !uniqueIds.includes(s.id));
			if (delTask.subtasks.length === 0) {
				delTask.subtasks = undefined;
			}
			persistGoalState(pi, session, ctx);
			return makeGoalResult(session,
				`Deleted ${uniqueIds.length} subtasks, Task #${params.taskId} has ${delTask.subtasks?.length ?? 0} remaining`,
			);
		}

		default:
			throw new Error(`Unknown action: ${params.action}`);
	}
}
