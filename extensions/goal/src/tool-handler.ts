/**
 * Goal 扩展 — Tool 执行处理器和共享 helpers
 *
 * 从 index.ts 提取的 executeGoalAction 及其依赖的辅助函数、类型和 schema。
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { type Static,Type } from "typebox";

import { ACTION_HANDLERS } from "./action-handlers.js";
import {
	MS_PER_SECOND,
	SECONDS_PER_MINUTE,
} from "./constants";
import {
	getCompletedCount,
	getElapsedTimeSeconds,
	GOAL_TASK_STATUSES,
	type GoalRuntimeState,
	type GoalTask,
	isTerminalStatus,
	serializeState,
	SUBTASK_STATUSES,
} from "./state";
import { renderStatusLine, renderTerminalStatusLine,renderWidgetLines } from "./widget";

// ── 常量 ─────────────────────────────────────────────

const ENTRY_TYPE = "goal-state";

export const HISTORY_ENTRY_TYPE = "goal-history";

// ── Session State Interface ──────────────────────────

export interface GoalSession {
	state: GoalRuntimeState | null;
	tasksCompletedAtAgentStart: number;
	hasPendingInjection: boolean;
	/** 防重入标志：handleAgentEnd / handleBeforeAgentStart 等事件处理器入口检查 */
	isProcessing: boolean;
	/** ESC 中断标记：tool call 被 abort 时设为 true，agent_end 检查后进入 paused */
	pendingPause: boolean;
}

// ── Stale Context Detection ──────────────────────────

const STALE_CONTEXT_PATTERNS = ["aborted", "context canceled", "stale context", "stalecontext", "extension context no longer active"];

/** 检查错误是否表示 stale / canceled context（如 session 重建 / compact 后） */
export function isStaleContextError(error: Error | unknown): boolean {
	const msg = error instanceof Error ? error.message : String(error);
	const lower = msg.toLowerCase();
	return STALE_CONTEXT_PATTERNS.some((p) => lower.includes(p));
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
		actual: Type.Optional(Type.String({ description: "Actual verification result (required when status=verified)" })),
	}))),
	taskId: Type.Optional(Type.Number({ description: "Task ID (required for subtask operations)" })),
	texts: Type.Optional(Type.Array(Type.String(), { description: "Subtask text list (for add_subtasks)" })),
	subUpdates: Type.Optional(Type.Array(Type.Object({
		subId: Type.Number(),
		status: StringEnum(SUBTASK_STATUSES),
	}))),
	subIds: Type.Optional(Type.Array(Type.Number(), { description: "Subtask ID list (for delete_subtasks)" })),
	verifications: Type.Optional(Type.Array(Type.Object({
		method: Type.String({ description: "Verification method, e.g. 'pnpm --filter <pkg> typecheck'" }),
		expected: Type.String({ description: "Expected result, e.g. 'zero type errors'" }),
	}), { description: "Verification configs for each task (1-to-1 with tasks array, for create_tasks/add_tasks)" })),
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

/** persist + widget 的统一入口。可选 stale check：返回 true 表示 state 已被替换（新 goal），调用方应中止。 */
export function persistAndUpdate(
	pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
	checkStale?: () => boolean,
): boolean {
	persistGoalState(pi, session, ctx);
	if (checkStale?.()) return true;
	updateWidget(session, ctx);
	return false;
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
	session.pendingPause = false;
	ctx.ui.setWidget("goal", undefined);
	ctx.ui.setStatus("goal", undefined);
}

// ── Result Builder ───────────────────────────────────

export function makeGoalResult(session: GoalSession, text: string) {
	const state = session.state;
	if (!state) {
		// P1-1: 不再抛异常，返回标准 isError 结果
		return errorResult("No active goal");
	}
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
						verification: t.verification
							? { method: t.verification.method, expected: t.verification.expected, actual: t.verification.actual }
							: undefined,
						subtasks: t.subtasks?.map((s) => ({
							id: s.id,
							text: s.text,
							status: s.status,
						})),
					})),
					meta: {
						...(state.budget.tokenBudget ? { "Token": `${state.tokensUsed}/${state.budget.tokenBudget}` } : {}),
						...(state.budget.timeBudgetMinutes ? { "Time": `${Math.floor(getElapsedTimeSeconds(state) / SECONDS_PER_MINUTE)}m/${state.budget.timeBudgetMinutes}m` } : {}),
						"Turn": `${state.currentTurnIndex}/${state.budget.maxTurns}`,
					},
				},
			},
		} satisfies GoalManagerDetails,
	};
}

// ── Tool Execute Handler ──────────────────────────────

/**
 * 执行 goal_manager tool action 的分发入口。
 *
 * 行为不变 —— 所有 case 逻辑已委托到 action-handlers.ts 中的独立函数。
 * 这里仅做：状态检查 + signal 守卫 + action 查表分发。
 */
export async function executeGoalAction(
	pi: ExtensionAPI,
	session: GoalSession,
	params: Static<typeof GoalManagerParams>,
	ctx: ExtensionContext,
	signal?: AbortSignal,
) {
	const state = session.state;
	if (!state) {
		return errorResult("Goal mode not active. Use /goal <objective> to start.");
	}

	// P1-4: signal 透传 — 若已 abort 标记 pendingPause
	if (signal?.aborted) {
		session.pendingPause = true;
		return errorResult("Tool call aborted by signal.");
	}

	// 委托到 action-handlers.ts 中的具体处理器
	const handler = ACTION_HANDLERS[params.action];
	if (!handler) {
		return errorResult(`Unknown action: ${params.action}`);
	}
	return handler({ pi, session, state, params, ctx });
}

/** 构造标准的错误结果（避免重复的 content 模板） */
export function errorResult(message: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		isError: true as const,
	};
}

/** Send a hidden custom message that feeds the LLM but is not rendered in TUI. */
export function sendGoalContextMessage(
	pi: ExtensionAPI,
	content: string,
	deliverAs: "steer" | "followUp",
): void {
	pi.sendMessage(
		{
			customType: "goal-context",
			content,
			display: false,
		},
		{ deliverAs },
	);
}
