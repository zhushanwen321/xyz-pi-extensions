/**
 * Pi /goal Extension — Codex-style persistent goal-driven autonomous loop
 *
 * 功能：
 * - 持久化目标设定，支持 pause/resume/clear/update
 * - Evidence-based completion（完成任务必须提供具体证据）
 * - Token 预算 + 时间预算（含 70%/90% 预警）
 * - Blocked 状态检测（连续 stall 自动阻塞）
 * - Steering 模板化（continuation / budget-limit / objective-updated）
 * - 任务清单追踪
 *
 * 健壮性保障：
 * - goalId snapshot 防止旧回调操作新 goal
 * - 时间累计统一由 persistState 管理，无双写
 * - 防重入保护（hasPendingInjection）
 * - deserializeState 向后兼容旧格式
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, CustomEntry, SessionEntry } from "@mariozechner/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

import {
	type GoalRuntimeState,
	type GoalTask,
	type BudgetConfig,
	type SubTodo,
	DEFAULT_BUDGET,
	createInitialState,
	transitionStatus,
	isTerminalStatus,
	isTerminalTaskStatus,
	isActiveStatus,
	serializeState,
	deserializeState,
	getCompletedCount,
	getIncompleteTasks,
	getElapsedTimeSeconds,
	GOAL_TASK_STATUSES,
	SUB_TODO_STATUSES,
} from "./state";

import { parseGoalArgs } from "./commands";
import {
	continuationPrompt,
	budgetLimitPrompt,
	objectiveUpdatedPrompt,
	contextInjectionPrompt,
	formatTaskList,
} from "./templates";

import { renderStatusLine, renderWidgetLines } from "./widget";
import { toSingleLine } from "./widget";

import {
	SECONDS_PER_MINUTE,
	MS_PER_SECOND,
	CONTEXT_USAGE_RATIO_LIMIT,
	PERCENT_FACTOR,
} from "./constants";

import {
	checkBudgetOnTurnEnd,
	checkBudgetOnResume,
	checkProgress,
} from "./budget.js";

// ── Constants ─────────────────────────────────────────

const ENTRY_TYPE = "goal-state";

// ── Tool Parameter Schemas ────────────────────────────

const GoalManagerParams = Type.Object({
	action: StringEnum([
		"create_tasks",
		"add_tasks",
		"update_tasks",
		"list_tasks",
		"complete_goal",
		"cancel_goal",
		"report_blocked",
		"add_sub_todos",
		"update_sub_todos",
		"delete_sub_todos",
	] as const),
	tasks: Type.Optional(Type.Array(Type.String(), { description: "Task descriptions. 每条必须是一行简短摘要（不超过 60 字），不含换行或 markdown" })),
	updates: Type.Optional(Type.Array(Type.Object({
		taskId: Type.Number(),
		status: StringEnum(GOAL_TASK_STATUSES),
		evidence: Type.Optional(Type.String()),
	}))),
	taskId: Type.Optional(Type.Number({ description: "Task ID（sub-todo 操作时必需）" })),
	texts: Type.Optional(Type.Array(Type.String(), { description: "Sub-todo 文本列表（add_sub_todos 时使用）" })),
	subUpdates: Type.Optional(Type.Array(Type.Object({
		subId: Type.Number(),
		status: StringEnum(SUB_TODO_STATUSES),
	}))),
	subIds: Type.Optional(Type.Array(Type.Number(), { description: "Sub-todo ID 列表（delete_sub_todos 时使用）" })),
	evidence: Type.Optional(Type.String({ description: "Evidence for completion (required for complete_goal)" })),
	reason: Type.Optional(Type.String({ description: "Reason for being blocked (required for report_blocked)" })),
	cancelReason: Type.Optional(Type.String({ description: "Why the user wants to cancel (required for cancel_goal)" })),
});

// ── Tool Details Types ────────────────────────────────

interface GoalManagerDetails {
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

// ── Session State ─────────────────────────────────────
// goalExtension 内部的可变状态，通过对象引用传递给提取出的模块级函数。

interface GoalSession {
	state: GoalRuntimeState | null;
	tasksCompletedAtAgentStart: number;
	hasPendingInjection: boolean;
}

// ── Module-level Helpers ──────────────────────────────

function isGoalEntry(entry: SessionEntry): entry is CustomEntry<GoalRuntimeState> {
	return entry.type === "custom" && (entry as CustomEntry).customType === ENTRY_TYPE;
}

function persistGoalState(pi: ExtensionAPI, session: GoalSession, _ctx: ExtensionContext): void {
	if (!session.state) return;
	const now = Date.now();
	if (session.state.timeStartedAt > 0) {
		session.state.timeUsedSeconds += (now - session.state.timeStartedAt) / MS_PER_SECOND;
		session.state.timeStartedAt = now;
	}
	pi.appendEntry(ENTRY_TYPE, serializeState(session.state));
}

function makeGoalResult(session: GoalSession, text: string) {
	const state = session.state;
	if (!state) throw new Error("No active goal");
	const budgetInfo: string[] = [];
	if (state.budget.tokenBudget) {
		const remaining = Math.max(state.budget.tokenBudget - state.tokensUsed, 0);
		budgetInfo.push(`Token: ${state.tokensUsed}/${state.budget.tokenBudget} (剩余 ${remaining})`);
	}
	if (state.budget.timeBudgetMinutes) {
		const elapsed = getElapsedTimeSeconds(state);
		const remaining = Math.max(state.budget.timeBudgetMinutes * SECONDS_PER_MINUTE - elapsed, 0);
		budgetInfo.push(`时间: ${Math.floor(elapsed / SECONDS_PER_MINUTE)}分/${state.budget.timeBudgetMinutes}分 (剩余 ${Math.floor(remaining / SECONDS_PER_MINUTE)}分)`);
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
				summary: `${getCompletedCount(state.tasks)}/${state.tasks.length} 完成`,
				data: {
					items: state.tasks.map((t) => ({
						id: t.id,
						text: t.description,
						status: t.status,
						evidence: t.evidence,
						subItems: t.subTodos?.map((s) => ({
							id: s.id,
							text: s.text,
							status: s.status,
						})),
					})),
					meta: {
						...(state.budget.tokenBudget ? { "Token": `${state.tokensUsed}/${state.budget.tokenBudget}` } : {}),
						...(state.budget.timeBudgetMinutes ? { "时间": `${Math.floor(getElapsedTimeSeconds(state) / SECONDS_PER_MINUTE)}分/${state.budget.timeBudgetMinutes}分` } : {}),
						"轮次": `${state.turnCount}/${state.budget.maxTurns}`,
					},
				},
			},
		} satisfies GoalManagerDetails,
	};
}

function reconstructGoalState(pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext): void {
	session.state = null;
	const entries = ctx.sessionManager.getEntries();

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (isGoalEntry(entry)) {
			const data = entry.data as Record<string, unknown> | undefined;
			if (data) {
				try {
					session.state = deserializeState(data);
				} catch {
					// 旧格式 goal-state entry，视为无活跃 goal
					session.state = null;
				}
			}
			break;
		}
	}

	if (!session.state) return;

	// 非终态 → 恢复为 active（session 重启后 resume）
	if (!isTerminalStatus(session.state.status) && session.state.status !== "paused") {
		session.state.status = "active";
		session.state.timeStartedAt = Date.now();
	}

	// Entry GC — 标记旧的 goal-state entries 以便清理
	const goalEntryIndices: number[] = [];
	let latestFound = false;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (isGoalEntry(entry)) {
			if (!latestFound) {
				latestFound = true;
			} else {
				goalEntryIndices.push(i);
			}
		}
	}
	for (const idx of goalEntryIndices) {
		entries.splice(idx, 1);
	}
}

function updateWidget(session: GoalSession, ctx: ExtensionContext): void {
	if (!session.state || session.state.status === "cancelled") {
		ctx.ui.setWidget("goal", undefined);
		ctx.ui.setStatus("goal", undefined);
		return;
	}

	ctx.ui.setStatus("goal", renderStatusLine(session.state, ctx.ui.theme));
	ctx.ui.setWidget("goal", renderWidgetLines(session.state, ctx.ui.theme));
}

function clearGoalSession(session: GoalSession, ctx: ExtensionContext): void {
	session.state = null;
	session.tasksCompletedAtAgentStart = 0;
	session.hasPendingInjection = false;
	ctx.ui.setWidget("goal", undefined);
	ctx.ui.setStatus("goal", undefined);
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

async function executeGoalAction(
	pi: ExtensionAPI,
	session: GoalSession,
	params: Static<typeof GoalManagerParams>,
	ctx: ExtensionContext,
) {
	const state = session.state;
	if (!state) {
		throw new Error("Goal 模式未激活。使用 /goal <objective> 启动。");
	}

	switch (params.action) {
		case "create_tasks": {
			if (!params.tasks || params.tasks.length === 0) {
				throw new Error("create_tasks requires a non-empty tasks array");
			}
			const existingIncomplete = getIncompleteTasks(state.tasks);
			if (state.tasks.length > 0 && existingIncomplete.length > 0) {
				throw new Error(
					`已有 ${state.tasks.length} 个任务（${existingIncomplete.length} 个未完成）。` +
						`如需追加任务请用 add_tasks，如需全部重新规划请用 /goal update。`,
				);
			}
			state.tasks = params.tasks.map((desc, i) => ({
				id: i + 1,
				description: normalizeDescription(desc),
				status: "pending" as const,
			}))
			persistGoalState(pi, session, ctx);
			return makeGoalResult(session,
				`已创建 ${state.tasks.length} 个任务：\n${state.tasks.map((t) => `  #${t.id}: ${t.description}`).join("\n")}`,
			);
		}

		case "add_tasks": {
			if (!params.tasks || params.tasks.length === 0) {
				throw new Error("add_tasks requires a non-empty tasks array");
			}
			const startId = state.tasks.length > 0
				? Math.max(...state.tasks.map((t) => t.id)) + 1
				: 1;
			const newTasks: GoalTask[] = params.tasks.map((desc, i) => ({
				id: startId + i,
				description: normalizeDescription(desc),
				status: "pending" as const,
			}))
			state.tasks.push(...newTasks);
			persistGoalState(pi, session, ctx);
			return makeGoalResult(session,
				`已追加 ${newTasks.length} 个任务：\n${newTasks.map((t) => `  #${t.id}: ${t.description}`).join("\n")}`,
			);
		}

		case "update_tasks": {
			if (!params.updates || params.updates.length === 0) {
				throw new Error("update_tasks requires a non-empty updates array");
			}
			const taskIds = params.updates.map((u) => u.taskId);
			const duplicateIds = taskIds.filter((id, i) => taskIds.indexOf(id) !== i);
			if (duplicateIds.length > 0) {
				throw new Error(`重复的 taskId: ${[...new Set(duplicateIds)].join(", ")}`);
			}
			for (const u of params.updates) {
				const task = state.tasks.find((t) => t.id === u.taskId);
				if (!task) {
					throw new Error(`Task #${u.taskId} not found`);
				}
				if (isTerminalTaskStatus(task.status)) {
					throw new Error(`Task #${task.id} 已处于终态 (${task.status})，不可变更`);
				}
				if (u.status === "completed" && (!u.evidence || u.evidence.trim() === "")) {
					throw new Error(`Task #${task.id}: completed 必须提供 evidence`);
				}
			}
			const results: string[] = [];
			for (const u of params.updates) {
				const task = state.tasks.find((t) => t.id === u.taskId)!;
				const prev = task.status;
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
			return makeGoalResult(session, `已更新 ${results.length} 个任务：\n${results.join("\n")}`);
		}

		case "list_tasks": {
			return makeGoalResult(session, formatTaskList(state.tasks));
		}

		case "complete_goal": {
			if (!params.evidence || params.evidence.trim() === "") {
				throw new Error("complete_goal requires evidence — 提供具体的证据证明目标已达成");
			}
			if (state.tasks.length === 0) {
				throw new Error("请先使用 create_tasks 创建任务清单，再完成目标。");
			}
			const incomplete = getIncompleteTasks(state.tasks);
			if (incomplete.length > 0) {
				throw new Error(
					`还有 ${incomplete.length} 个任务未完成：${incomplete.map((t) => `#${t.id}`).join(", ")}。` +
						`请先完成这些任务或提供理由说明为什么它们不需要完成。`,
				);
			}
			const completedCount = getCompletedCount(state.tasks);
			if (completedCount === 0) {
				throw new Error("至少需要完成一个任务才能完成目标。全部取消不算达成。");
			}
			state.status = transitionStatus(state.status, "complete");
			persistGoalState(pi, session, ctx);
			const budgetReport: string[] = [];
			budgetReport.push(`总轮次: ${state.turnCount}`);
			budgetReport.push(`任务完成: ${getCompletedCount(state.tasks)}/${state.tasks.length}`);
			if (state.budget.tokenBudget) {
				budgetReport.push(`Token 消耗: ${state.tokensUsed}/${state.budget.tokenBudget}`);
			}
			const elapsed = getElapsedTimeSeconds(state);
			budgetReport.push(`用时: ${Math.floor(elapsed / SECONDS_PER_MINUTE)}分${Math.floor(elapsed % SECONDS_PER_MINUTE)}秒`);
			return makeGoalResult(session,
				`目标已完成!\n证据: ${params.evidence}\n\n--- Budget Report ---\n${budgetReport.join("\n")}`,
			);
		}

		case "report_blocked": {
			if (!params.reason || params.reason.trim() === "") {
				throw new Error("report_blocked requires reason — 说明阻塞原因");
			}
			state.lastBlockerReason = params.reason;
			state.status = transitionStatus(state.status, "blocked");
			persistGoalState(pi, session, ctx);
			return makeGoalResult(session, `已报告阻塞。原因: ${params.reason}`);
		}

		case "cancel_goal": {
			if (isTerminalStatus(state.status)) {
				throw new Error(`Goal 已处于终态 (${state.status})。`);
			}
			const reason = params.cancelReason ?? "用户要求取消";
			const goalId = state.goalId;
			state.status = "cancelled";
			persistGoalState(pi, session, ctx);
			clearGoalSession(session, ctx);
			return {
				content: [{ type: "text" as const, text: `Goal 已取消: ${reason}` }],
				details: {
					action: "cancel",
					tasks: [],
					goalId,
					status: "cancelled",
					_render: {
						type: "task-list" as const,
						summary: "已取消",
						data: { items: [], meta: {} },
					},
				} satisfies GoalManagerDetails,
			};
		}

		case "add_sub_todos": {
			if (params.taskId === undefined) {
				throw new Error("add_sub_todos requires taskId");
			}
			if (!params.texts || params.texts.length === 0) {
				throw new Error("add_sub_todos requires a non-empty texts array");
			}
			const parentTask = state.tasks.find((t) => t.id === params.taskId);
			if (!parentTask) {
				throw new Error(`Task #${params.taskId} not found`);
			}
			if (isTerminalTaskStatus(parentTask.status)) {
				throw new Error(`Task #${parentTask.id} 已处于终态 (${parentTask.status})，不能添加 sub-todo`);
			}
			const subTodos = parentTask.subTodos ?? [];
			const startId = subTodos.length > 0 ? Math.max(...subTodos.map((s) => s.id)) + 1 : 1;
			const trimmed = params.texts.map((t) => t.trim()).filter((t) => t.length > 0);
			if (trimmed.length === 0) {
				throw new Error("texts 中至少需要一个非空字符串");
			}
			const newSubTodos: SubTodo[] = trimmed.map((text, i) => ({
				id: startId + i,
				text,
				status: "pending" as const,
			}));
			parentTask.subTodos = [...subTodos, ...newSubTodos];
			persistGoalState(pi, session, ctx);
			return makeGoalResult(session,
				`已给 Task #${parentTask.id} 添加 ${newSubTodos.length} 项 sub-todo：\n` +
				newSubTodos.map((s) => `  - #${parentTask.id}.${s.id}: ${s.text}`).join("\n"),
			);
		}

		case "update_sub_todos": {
			if (params.taskId === undefined) {
				throw new Error("update_sub_todos requires taskId");
			}
			if (!params.subUpdates || params.subUpdates.length === 0) {
				throw new Error("update_sub_todos requires a non-empty subUpdates array");
			}
			const targetTask = state.tasks.find((t) => t.id === params.taskId);
			if (!targetTask) {
				throw new Error(`Task #${params.taskId} not found`);
			}
			if (!targetTask.subTodos || targetTask.subTodos.length === 0) {
				throw new Error(`Task #${params.taskId} 没有 sub-todo`);
			}
			const results: string[] = [];
			for (const u of params.subUpdates) {
				const sub = targetTask.subTodos.find((s) => s.id === u.subId);
				if (!sub) {
					throw new Error(`Sub-todo #${params.taskId}.${u.subId} not found`);
				}
				if (sub.status === "completed") {
					throw new Error(`Sub-todo #${params.taskId}.${sub.id} 已完成，不可变更`);
				}
				const prev = sub.status;
				sub.status = u.status;
				results.push(`#${params.taskId}.${sub.id}: ${prev} → ${u.status}`);
			}
			persistGoalState(pi, session, ctx);
			return makeGoalResult(session,
				`已更新 ${results.length} 项 sub-todo：\n${results.join("\n")}`,
			);
		}

		case "delete_sub_todos": {
			if (params.taskId === undefined) {
				throw new Error("delete_sub_todos requires taskId");
			}
			if (!params.subIds || params.subIds.length === 0) {
				throw new Error("delete_sub_todos requires a non-empty subIds array");
			}
			const delTask = state.tasks.find((t) => t.id === params.taskId);
			if (!delTask) {
				throw new Error(`Task #${params.taskId} not found`);
			}
			if (!delTask.subTodos || delTask.subTodos.length === 0) {
				throw new Error(`Task #${params.taskId} 没有 sub-todo`);
			}
			const uniqueIds = [...new Set(params.subIds)];
			const missing = uniqueIds.filter((id) => !delTask.subTodos!.some((s) => s.id === id));
			if (missing.length > 0) {
				throw new Error(`Sub-todo ${missing.map((id) => `#${params.taskId}.${id}`).join(", ")} not found`);
			}
			delTask.subTodos = delTask.subTodos.filter((s) => !uniqueIds.includes(s.id));
			if (delTask.subTodos.length === 0) {
				delTask.subTodos = undefined;
			}
			persistGoalState(pi, session, ctx);
			return makeGoalResult(session,
				`已删除 ${uniqueIds.length} 项 sub-todo，Task #${params.taskId} 剩余 ${delTask.subTodos?.length ?? 0} 项`,
			);
		}

		default:
			throw new Error(`Unknown action: ${params.action}`);
	}
}

// ── Command Handler ───────────────────────────────────

async function handleGoalCommand(pi: ExtensionAPI, session: GoalSession, args: string, ctx: ExtensionContext): Promise<void> {
	const parsed = parseGoalArgs(args);

	switch (parsed.action) {
		case "status": {
			if (!session.state) {
				ctx.ui.notify("Goal 模式未激活。使用 /goal <objective> 启动。", "info");
				return;
			}
			const completed = getCompletedCount(session.state.tasks);
			const total = session.state.tasks.length;
			const elapsed = getElapsedTimeSeconds(session.state);
			const lines = [
				`目标: ${session.state.objective}`,
				`状态: ${session.state.status}`,
				`轮次: ${session.state.turnCount}/${session.state.budget.maxTurns}`,
				`任务: ${completed}/${total} 完成`,
				`无进展轮数: ${session.state.stallCount}`,
				`已用时间: ${Math.floor(elapsed / SECONDS_PER_MINUTE)}分${Math.floor(elapsed % SECONDS_PER_MINUTE)}秒`,
				session.state.budget.tokenBudget ? `Token: ${session.state.tokensUsed}/${session.state.budget.tokenBudget}` : null,
				`Goal ID: ${session.state.goalId}`,
			].filter(Boolean);
			ctx.ui.notify(lines.join("\n"), "info");
			return;
		}

		case "pause": {
			if (!session.state) {
				ctx.ui.notify("Goal 模式未激活。", "warning");
				return;
			}
			if (isTerminalStatus(session.state.status)) {
				ctx.ui.notify(`Goal 已处于终态 (${session.state.status})，无法暂停。`, "warning");
				return;
			}
			session.state.status = transitionStatus(session.state.status, "paused");
			persistGoalState(pi, session, ctx);
			updateWidget(session, ctx);
			ctx.ui.notify("Goal 已暂停。使用 /goal resume 恢复。", "info");
			return;
		}

		case "resume": {
			if (!session.state) {
				ctx.ui.notify("Goal 模式未激活。", "warning");
				return;
			}
			if (isTerminalStatus(session.state.status)) {
				ctx.ui.notify(`Goal 已处于终态 (${session.state.status})，无法恢复。`, "warning");
				return;
			}
			if (session.state.status !== "paused" && session.state.status !== "blocked") {
				ctx.ui.notify("Goal 未暂停或阻塞，无需恢复。", "info");
				return;
			}
			session.state.status = "active";
			session.state.stallCount = 0;
			session.state.timeStartedAt = Date.now();

			// Resume 时重检预算（复用 budget.ts 的决策函数）
			const resumeBudgetCheck = checkBudgetOnResume(session.state);
			if (resumeBudgetCheck) {
				const dim = resumeBudgetCheck.dimension;
				session.state.status = transitionStatus(session.state.status, dim === "token" ? "budget_limited" : "time_limited");
				persistGoalState(pi, session, ctx);
				updateWidget(session, ctx);
				ctx.ui.notify(`${dim === "token" ? "Token" : "时间"} 预算已耗尽，无法恢复。使用 /goal clear 清除。`, "warning");
				return;
			}

			persistGoalState(pi, session, ctx);
			updateWidget(session, ctx);

			const incomplete = getIncompleteTasks(session.state.tasks);
			if (incomplete.length > 0) {
				pi.sendUserMessage(
					`Goal 已恢复。继续执行剩余 ${incomplete.length} 个任务。` +
					(session.state.lastBlockerReason ? `

上次阻塞原因: ${session.state.lastBlockerReason}。请尝试不同的方法。` : "") +
					`

目标: ${session.state.objective}`,
					{ deliverAs: "followUp" },
				);
			} else {
				ctx.ui.notify("所有任务已完成。", "info");
			}
			return;
		}

		case "clear": {
			if (!session.state) {
				ctx.ui.notify("Goal 模式未激活。", "info");
				return;
			}
			session.state.status = "cancelled";
			persistGoalState(pi, session, ctx);
			clearGoalSession(session, ctx);
			ctx.ui.notify("Goal 已清除。", "info");
			return;
		}

		case "update": {
			if (!session.state) {
				ctx.ui.notify("Goal 模式未激活。", "warning");
				return;
			}
			if (!parsed.objective) {
				ctx.ui.notify("用法: /goal update <new-objective>", "warning");
				return;
			}
			const oldObjective = session.state.objective;
			session.state.objective = parsed.objective;
			session.state.objectiveUpdatedAt = Date.now();
			session.state.tasks = [];
			session.state.stallCount = 0;
			session.state.turnCount = 0;
			session.state.lastProgressTurn = 0;
			session.state.budgetLimitSteeringSent = false;
			session.state.budgetWarning70Sent = false;
			session.state.budgetWarning90Sent = false;
			session.tasksCompletedAtAgentStart = 0;
			persistGoalState(pi, session, ctx);
			updateWidget(session, ctx);
			ctx.ui.notify(`目标已更新:\n旧: ${oldObjective}\n新: ${parsed.objective}`, "info");

			if (isActiveStatus(session.state.status)) {
				pi.sendUserMessage(objectiveUpdatedPrompt(session.state, oldObjective), { deliverAs: "steer" });
			}
			return;
		}

		case "set": {
			if (!parsed.objective) {
				ctx.ui.notify("用法: /goal <objective> [--tokens N] [--timeout N]", "warning");
				return;
			}
			if (!parsed.objective.trim()) {
				ctx.ui.notify("目标描述不能为空。", "warning");
				return;
			}
			if (session.state && !isTerminalStatus(session.state.status)) {
				ctx.ui.notify(
					`已取消旧 Goal: ${session.state.objective}\n(新目标已启动)`,
					"info",
				);
				session.state.status = "cancelled";
				persistGoalState(pi, session, ctx);
			}

			if (parsed.budget?.tokenBudget !== undefined && parsed.budget.tokenBudget <= 0) {
				ctx.ui.notify("Token 预算必须大于 0。", "warning");
				return;
			}
			const budget: Partial<BudgetConfig> = {};
			if (parsed.budget?.tokenBudget) budget.tokenBudget = parsed.budget.tokenBudget;
			if (parsed.budget?.timeBudgetMinutes) budget.timeBudgetMinutes = parsed.budget.timeBudgetMinutes;
			budget.maxTurns = parsed.budget?.maxTurns ?? DEFAULT_BUDGET.maxTurns;
			budget.maxStallTurns = parsed.budget?.maxStallTurns ?? DEFAULT_BUDGET.maxStallTurns;

			session.state = createInitialState(parsed.objective, budget);
			session.tasksCompletedAtAgentStart = 0;
			session.hasPendingInjection = false;

			persistGoalState(pi, session, ctx);
			updateWidget(session, ctx);

			const budgetNotice: string[] = [];
			if (budget.tokenBudget) budgetNotice.push(`Token 预算: ${budget.tokenBudget}`);
			if (budget.timeBudgetMinutes) budgetNotice.push(`时间预算: ${budget.timeBudgetMinutes} 分钟`);
			const notice = [
				`Goal 已启动: ${parsed.objective}`,
				`最大轮次: ${budget.maxTurns}`,
				...budgetNotice,
			].join("\n");
			ctx.ui.notify(notice, "info");

			pi.sendUserMessage(parsed.objective, { deliverAs: "followUp" });
			return;
		}
	}
}

// ── Event: before_agent_start Handler ─────────────────

async function handleBeforeAgentStart(pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext) {
	if (!session.state || !isActiveStatus(session.state.status)) return;

	session.hasPendingInjection = true;

	const usage = ctx.getContextUsage();
	if (usage && usage.contextWindow > 0 && (usage.tokens ?? 0) / usage.contextWindow > CONTEXT_USAGE_RATIO_LIMIT) {
		session.state.status = transitionStatus(session.state.status, "paused");
		persistGoalState(pi, session, ctx);
		updateWidget(session, ctx);

		return {
			message: {
				customType: "goal-context-exceeded",
				content:
					"[GOAL — 上下文空间不足，必须立即收尾]\n" +
					"1. 用 goal_manager 的 list_tasks 查看剩余任务\n" +
					"2. 只标记你真正完成且有证据的任务\n" +
					"3. 总结当前进度和剩余工作\n" +
					"不要再开始新任务。",
				display: false,
			},
		};
	}

	return {
		message: {
			customType: "goal-context",
			content: contextInjectionPrompt(session.state),
			display: false,
		},
	};
}

// ── Event: agent_end Handler ──────────────────────────

async function handleAgentEnd(pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext): Promise<void> {
	if (!session.state) return;

	const snapshotGoalId = session.state.goalId;
	const checkStale = () => !session.state || session.state.goalId !== snapshotGoalId;

	// 终态处理：complete / blocked 只需 persist + notify
	if (session.state.status === "complete") {
		persistGoalState(pi, session, ctx);
		if (checkStale()) return;
		updateWidget(session, ctx);
		ctx.ui.notify(
			`目标已完成 ✓ (${getCompletedCount(session.state.tasks)}/${session.state.tasks.length} 任务, ${session.state.turnCount} 轮)`,
			"info",
		);
		return;
	}

	if (session.state.status === "blocked") {
		persistGoalState(pi, session, ctx);
		if (checkStale()) return;
		updateWidget(session, ctx);
		ctx.ui.notify("Goal 被阻塞。使用 /goal resume 恢复或 /goal clear 清除。", "warning");
		return;
	}

	if (!isActiveStatus(session.state.status)) return;

	// 防重入
	if (session.hasPendingInjection) {
		session.hasPendingInjection = false;
		return;
	}

	if (checkStale()) return;

	// ── 预算策略（集中检查）──

	const budgetResult = checkBudgetOnTurnEnd(session.state);

	// 发送预警
	for (const w of budgetResult.warnings) {
		if (w.type === "warning90") {
			session.state.budgetWarning90Sent = true;
			ctx.ui.notify(`${w.dimension === "token" ? "Token" : "时间"} 预算已用 90%，请开始收尾。`, "warning");
		} else if (w.type === "warning70") {
			session.state.budgetWarning70Sent = true;
			ctx.ui.notify(`${w.dimension === "token" ? "Token" : "时间"} 预算已用 70%，注意控制范围。`, "info");
		}
	}

	// 预算耗尽 → 终止
	if (budgetResult.terminal) {
		const dim = budgetResult.terminal.dimension;
		session.state.status = transitionStatus(session.state.status, dim === "token" ? "budget_limited" : "time_limited");
		persistGoalState(pi, session, ctx);
		if (checkStale()) return;
		updateWidget(session, ctx);
		ctx.ui.notify(
			dim === "token"
				? "Token 预算已耗尽，Goal 已终止。"
				: `时间预算耗尽 (${session.state.budget.timeBudgetMinutes} 分钟)，Goal 已终止。`,
			"warning",
		);
		return;
	}

	// 90% steering → 发送收尾指令
	if (budgetResult.shouldSendSteering) {
		session.state.budgetLimitSteeringSent = true;
		persistGoalState(pi, session, ctx);
		if (checkStale()) return;
		updateWidget(session, ctx);
		pi.sendUserMessage(budgetLimitPrompt(session.state, "token"), { deliverAs: "steer" });
		return;
	}

	if (checkStale()) return;

	// ── Turn 递增 + 进展评估 ──

	session.state.turnCount++;

	const progress = checkProgress(session.state, session.tasksCompletedAtAgentStart);

	// 所有任务完成 → 提示 complete_goal
	if (progress.allTasksDone) {
		if (progress.maxTurnsReached) {
			session.state.status = transitionStatus(session.state.status, "complete");
			persistGoalState(pi, session, ctx);
			if (checkStale()) return;
			updateWidget(session, ctx);
			ctx.ui.notify(
				`所有任务已完成，Goal 自动结束。(${progress.completedCount}/${progress.totalCount} 任务, ${session.state.turnCount} 轮)`,
				"info",
			);
			return;
		}

		if (progress.budgetTight) {
			pi.sendUserMessage(
				`所有任务已完成，且 token 预算已用 ${Math.round(session.state.tokensUsed / session.state.budget.tokenBudget! * PERCENT_FACTOR)}%。` +
				`请立即调用 goal_manager 的 complete_goal 完成目标，提供整体 evidence。` +
				`\n\n目标: ${session.state.objective}`,
				{ deliverAs: "steer" },
			);
		} else {
			pi.sendUserMessage(
				`所有 ${progress.totalCount} 个任务已完成。请调用 goal_manager 的 complete_goal 完成目标，提供整体 evidence。` +
					`\n\n目标: ${session.state.objective}`,
				{ deliverAs: "followUp" },
			);
		}
		persistGoalState(pi, session, ctx);
		updateWidget(session, ctx);
		return;
	}

	// 没有任务创建 → 提醒 create_tasks
	if (progress.noTasksCreated) {
		if (progress.maxTurnsReached) {
			session.state.status = transitionStatus(session.state.status, "cancelled");
			persistGoalState(pi, session, ctx);
			if (checkStale()) return;
			updateWidget(session, ctx);
			ctx.ui.notify(
				`已达最大轮次 (${session.state.budget.maxTurns})，LLM 未创建任务清单。`,
				"warning",
			);
			return;
		}
		pi.sendUserMessage(
			`你尚未创建任务清单。请立即调用 goal_manager 的 create_tasks 将工作拆分为具体可验证的任务步骤。` +
				`\n\n目标: ${session.state.objective}`,
			{ deliverAs: "followUp" },
		);
		persistGoalState(pi, session, ctx);
		updateWidget(session, ctx);
		return;
	}

	// 最大轮次 → 取消
	if (progress.maxTurnsReached) {
		const incomplete = getIncompleteTasks(session.state.tasks);
		session.state.status = transitionStatus(session.state.status, "cancelled");
		persistGoalState(pi, session, ctx);
		if (checkStale()) return;
		updateWidget(session, ctx);
		ctx.ui.notify(
			`已达最大轮次 (${session.state.budget.maxTurns})，还有 ${incomplete.length} 个任务未完成。`,
			"warning",
		);
		return;
	}

	// Stall 检测
	if (progress.isStalled) {
		session.state.stallCount++;
	} else {
		session.state.stallCount = 0;
		session.state.lastProgressTurn = session.state.turnCount;
	}

	if (session.state.stallCount >= session.state.budget.maxStallTurns) {
		session.state.status = transitionStatus(session.state.status, "blocked");
		persistGoalState(pi, session, ctx);
		if (checkStale()) return;
		updateWidget(session, ctx);
		ctx.ui.notify(
			`已连续 ${session.state.stallCount} 轮无进展，Goal 自动阻塞。使用 /goal resume 恢复或 /goal clear 清除。`,
			"warning",
		);
		return;
	}

	if (checkStale()) return;

	// 去抖：本 turn 无 token 消耗则不发 continuation
	const tokenDelta = session.state.tokensUsed - session.state.lastTurnTokensUsed;
	session.state.lastTurnTokensUsed = session.state.tokensUsed;

	if (tokenDelta === 0) {
		persistGoalState(pi, session, ctx);
		updateWidget(session, ctx);
		return;
	}

	// Normal continuation
	persistGoalState(pi, session, ctx);
	updateWidget(session, ctx);

	pi.sendUserMessage(continuationPrompt(session.state), { deliverAs: "followUp" });
}

// ── Extension Factory ─────────────────────────────────

export default function goalExtension(pi: ExtensionAPI) {
	const session: GoalSession = {
		state: null,
		tasksCompletedAtAgentStart: 0,
		hasPendingInjection: false,
	};

	// ── Tool: goal_manager ─────────────────────────────

	pi.registerTool({
		name: "goal_manager",
		label: "Goal Manager",
		description:
			"Goal 模式任务管理器。此工具仅在用户通过 /goal 命令启动目标后才可用，AI 不能主动触发此功能。如果 Goal 模式未激活，调用此工具会报错。" +
			"\n\n可用 action:" +
			"\n- create_tasks: 首次拆分目标为任务清单（每个 goal 开始时调用一次）。每条 task description 必须是一行简短摘要（不超过 60 字），不要包含换行、markdown、详细参数" +
			"\n- add_tasks: 向已有任务清单追加新任务（执行中发现遗漏时使用）。每条 task description 必须是一行简短摘要（不超过 60 字），不要包含换行、markdown、详细参数" +
			"\n- update_tasks: 批量更新任务状态（completed 必须带 evidence，cancelled 不阻碍 goal 完成）" +
			"\n- list_tasks: 查看进度和剩余预算" +
			"\n- complete_goal: 标记目标达成（必须所有任务完成 + evidence）" +
			"\n- cancel_goal: 取消当前目标（用户要求退出/停止时使用）" +
			"\n- report_blocked: 报告阻塞（遇到无法解决的问题时使用）" +
			"\n- add_sub_todos: 给指定 task 添加 sub-todo（参数: taskId, texts[]）。Goal 模式下用此替代 todo 工具" +
			"\n- update_sub_todos: 批量更新 sub-todo 状态（参数: taskId, subUpdates[]）" +
			"\n- delete_sub_todos: 删除指定 task 的 sub-todo（参数: taskId, subIds[]）",
		promptSnippet: "管理 /goal 模式的任务清单、完成状态和退出",
		promptGuidelines: [
			"[工作流] 收到目标后，第一步必须调用 create_tasks 拆分任务。已有任务清单时不要重复调用",
			"[格式] 每个 task description 必须是一行简短摘要，不超过 60 个字符。不要包含换行符、markdown 格式、详细参数列表——这些放在执行阶段处理。示例: '修复 hook-registry 去重逻辑' 而不是 '修复 hook-registry 去重逻辑 + transport-execute enhancementConfig 防护 + failover-loop ...'",
			"[追加] 执行中发现遗漏的子任务时，使用 add_tasks 追加，不要尝试重新 create_tasks",
			"[完成] 每完成一个任务调用 update_tasks 将状态设为 completed，必须提供 evidence（具体证据，如'测试 X 通过'、'文件 F 已创建'）",
			"[目标完成] 只有所有任务完成且有整体证据时，才能调用 complete_goal",
			"[退出] 当用户说'停止'、'退出'、'取消'、'stop'、'exit'、'cancel'、'不用了'、'结束'等表示不想继续时，立即调用 cancel_goal 取消目标，不要引导用户走 complete_goal 流程",
			"[阻塞] 遇到无法解决的技术问题时调用 report_blocked 说明原因",
			"[进度] 随时可用 list_tasks 查看剩余任务和预算，",
			"[取消] 取消任务时使用 update_tasks 将状态设为 cancelled，取消的任务不阻碍 goal 完成",
			"[禁止] 不要在没有 evidence 的情况下将任务标记为 completed，也不要在没有 evidence 时调用 complete_goal",
			"[禁止] 不要在用户明确想退出时强制要求完成任务——直接 cancel_goal",
			"[禁止] 不要重复调用 create_tasks 覆盖已有未完成任务，如需追加请用 add_tasks",
			"[sub-todo] Goal 模式下需要细粒度步骤追踪时，使用 add_sub_todos 给 task 添加 sub-todo，不要使用 todo 工具",
		],
		parameters: GoalManagerParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				return await executeGoalAction(pi, session, params, ctx);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const inputSummary = JSON.stringify(params, null, 2);
				throw new Error(`${msg}\n\nInput: ${inputSummary}`);
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("goal_manager ")) + theme.fg("muted", args.action);
			if (args.tasks) text += ` ${theme.fg("dim", `(${args.tasks.length} tasks)`)}`;
			if (args.updates) text += ` ${theme.fg("dim", `(${args.updates.length} updates)`)}`;
			if (args.taskId !== undefined) text += ` ${theme.fg("accent", `#${args.taskId}`)}`;
			if (args.texts) text += ` ${theme.fg("dim", `(${args.texts.length} sub-todos)`)}`;
			if (args.subUpdates) text += ` ${theme.fg("dim", `(${args.subUpdates.length} sub-updates)`)}`;
			if (args.subIds) text += ` ${theme.fg("dim", `del #${args.subIds.join(",")}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as GoalManagerDetails | undefined;
			if (!details || !Array.isArray(details.tasks)) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const tasks = details.tasks;
			const completed = tasks.filter((t) => t.status === "completed").length;
			const summary = theme.fg("success", `✓ ${completed}/${tasks.length} 完成`);
			if (!expanded || tasks.length === 0) {
				return new Text(summary, 0, 0);
			}
			const lines = [summary];
			for (const t of tasks) {
				const icon = t.status === "completed"
					? theme.fg("success", "✓")
					: t.status === "in_progress"
						? theme.fg("warning", "●")
						: t.status === "cancelled"
							? theme.fg("dim", "✗")
							: theme.fg("dim", "☐");
				const descText = toSingleLine(t.description);
				const desc = (t.status === "completed" || t.status === "cancelled")
					? theme.fg("dim", descText)
					: theme.fg("text", descText);
				lines.push(`  ${icon} ${theme.fg("accent", `#${t.id}`)} ${desc}`);
			// Sub-todo items in expanded view
			if (t.subTodos && t.subTodos.length > 0) {
				for (const s of t.subTodos) {
					const subIcon = s.status === "completed"
						? theme.fg("success", "\u2713")
						: s.status === "in_progress"
							? theme.fg("warning", "\u25cf")
							: theme.fg("dim", "\u25cb");
					const subText = s.status === "completed" ? theme.fg("dim", s.text) : theme.fg("muted", s.text);
					lines.push(`    ${subIcon} ${theme.fg("dim", `${t.id}.${s.id}`)} ${subText}`);
				}
			}
		}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// ── Command: /goal ─────────────────────────────────

	pi.registerCommand("goal", {
		description:
			"目标驱动模式: /goal <objective> [--tokens N] [--timeout N] [--max-turns N] | /goal pause | /goal resume | /goal clear | /goal update <new-objective> | /goal status",
		handler: async (args, ctx) => {
			await handleGoalCommand(pi, session, args, ctx);
		},
	});

	// ── Event: before_agent_start ──────────────────────

	pi.on("before_agent_start", async (_event, ctx) => {
		return handleBeforeAgentStart(pi, session, ctx);
	});

	// ── Event: agent_start ─────────────────────────────

	pi.on("agent_start", async () => {
		if (!session.state || !isActiveStatus(session.state.status)) return;
		session.tasksCompletedAtAgentStart = getCompletedCount(session.state.tasks);
	});

	// ── Event: turn_end ────────────────────────────────

	pi.on("turn_end", async (_event, ctx) => {
		if (!session.state) return;
		updateWidget(session, ctx);
	});

	// ── Event: message_end (token accounting) ──────────

	pi.on("message_end", async (event, _ctx) => {
		if (!session.state || !isActiveStatus(session.state.status)) return;
		if (event.message.role !== "assistant") return;

		const usage = event.message.usage;
		if (usage) {
			const input = usage.input ?? 0;
			const output = usage.output ?? 0;
			const cacheRead = usage.cacheRead ?? 0;
			if (input > 0 || output > 0) {
				session.state.tokensUsed += Math.max(input - cacheRead, 0) + output;
			} else if (usage.totalTokens) {
				session.state.tokensUsed += usage.totalTokens;
			}
		}
	});

	// ── Event: agent_end ───────────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		await handleAgentEnd(pi, session, ctx);
	});

	// ── Event: session_start (state reconstruction) ───

	pi.on("session_start", async (_event, ctx) => {
		reconstructGoalState(pi, session, ctx);
		if (session.state) {
			session.tasksCompletedAtAgentStart = getCompletedCount(session.state.tasks);
			updateWidget(session, ctx);
		}
	});

	// ── Message Renderers ──────────────────────────────

	const goalMessageTypes = [
		"goal-context",
		"goal-context-exceeded",
	];

	for (const customType of goalMessageTypes) {
		pi.registerMessageRenderer(customType, (message, _options, theme) => {
			const prefix =
				message.customType === "goal-context-exceeded"
					? theme.fg("error", "[GOAL 预算] ")
					: theme.fg("accent", "[GOAL] ");
			const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
			return new Text(prefix + theme.fg("dim", content), 0, 0);
		});
	}
}
