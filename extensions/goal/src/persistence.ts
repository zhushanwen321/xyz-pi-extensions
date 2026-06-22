/**
 * 持久化层 — serialize/deserialize + history entry 构造
 *
 * FR-5: 移除旧格式兼容，字段缺失直接 throw。
 * 零 Pi 依赖。
 */

import type {
	GoalTask,
	Subtask,
	SubtaskStatus,
	TaskStatus,
	TaskVerification,
} from "./engine/task";
import type { GoalRuntimeState } from "./engine/types";
import type { GoalHistoryEntry } from "./ports";

// ── 常量 ──────────────────────────────────────────────

export const ENTRY_TYPE = "goal-state";
export const HISTORY_ENTRY_TYPE = "goal-history";

// ── serialize（深拷贝，纯函数）────────────────────────

export function serializeState(state: GoalRuntimeState): GoalRuntimeState {
	return {
		...state,
		tasks: state.tasks.map((t) => ({
			...t,
			subtasks: t.subtasks?.map((s) => ({ ...s })),
		})),
		budget: { ...state.budget },
	};
}

// ── deserialize（FR-5 严格解析，缺字段 throw）──────────

export function deserializeState(data: Record<string, unknown>): GoalRuntimeState {
	const req = <T>(key: string): T => {
		if (!(key in data) || data[key] === undefined) {
			throw new Error(`Missing required field: ${key}`);
		}
		return data[key] as T;
	};

	const tasksRaw = req<unknown[]>("tasks");
	const tasks: GoalTask[] = tasksRaw.map((tRaw): GoalTask => {
		const t = tRaw as Record<string, unknown>;
		if (!("status" in t)) {
			throw new Error("Legacy goal-state format detected, session reset required");
		}
		const subtasksRaw = t.subtasks as Record<string, unknown>[] | undefined;
		const subtasks: Subtask[] | undefined = Array.isArray(subtasksRaw)
			? subtasksRaw.map((s) => ({
					id: s.id as number,
					text: s.text as string,
					status: s.status as SubtaskStatus,
					lastUpdatedTurn: (s.lastUpdatedTurn as number) ?? 0,
				}))
			: undefined;
		return {
			id: t.id as number,
			description: t.description as string,
			status: t.status as TaskStatus,
			evidence: t.evidence as string | undefined,
			verification: t.verification as TaskVerification | undefined,
			subtasks,
			lastUpdatedTurn: (t.lastUpdatedTurn as number) ?? 0,
		};
	});

	return {
		goalId: req("goalId"),
		objective: req("objective"),
		status: req("status"),
		tasks,
		stallCount: req("stallCount"),
		tokensUsed: req("tokensUsed"),
		timeStartedAt: req("timeStartedAt"),
		timeUsedSeconds: req("timeUsedSeconds"),
		budget: req("budget"),
		lastProgressTurn: req("lastProgressTurn"),
		budgetLimitSteeringSent: req("budgetLimitSteeringSent"),
		objectiveUpdatedAt: req("objectiveUpdatedAt"),
		lastBlockerReason: req("lastBlockerReason"),
		tokenWarning70Sent: req("tokenWarning70Sent"),
		tokenWarning90Sent: req("tokenWarning90Sent"),
		timeWarning70Sent: req("timeWarning70Sent"),
		timeWarning90Sent: req("timeWarning90Sent"),
		lastTurnTokensUsed: req("lastTurnTokensUsed"),
		currentTurnIndex: req("currentTurnIndex"),
		completedAtTurnIndex: data.completedAtTurnIndex as number | undefined,
	};
}

// ── makeHistoryEntry ─────────────────────────────────

/** 从 state 构造 GoalHistoryEntry（纯函数） */
export function makeHistoryEntry(state: GoalRuntimeState, completedTasks: number): GoalHistoryEntry {
	return {
		goalId: state.goalId,
		objective: state.objective,
		status: state.status,
		completedTasks,
		totalTasks: state.tasks.length,
		elapsedSeconds: Math.floor(state.timeUsedSeconds),
		timestamp: Date.now(),
	};
}
