/**
 * 持久化层 — serialize/deserialize + history entry 构造
 *
 * FR-5: 移除旧格式兼容，字段缺失直接 throw（tasks 字段例外——向后兼容忽略）。
 * 零 Pi 依赖。
 */

import type { GoalRuntimeState } from "./engine/types";
import type { GoalHistoryEntry } from "./ports";

// ── 常量 ──────────────────────────────────────────────

export const ENTRY_TYPE = "goal-state";
export const HISTORY_ENTRY_TYPE = "goal-history";

// ── serialize（深拷贝，纯函数）────────────────────────

export function serializeState(state: GoalRuntimeState): GoalRuntimeState {
	return {
		...state,
		budget: { ...state.budget },
	};
}

// ── deserialize（FR-5 严格解析，缺字段 throw）──────────

/**
 * 反序列化持久化 state。
 *
 * 向后兼容：旧 entry 可能含 `tasks` 字段（task CRUD 删除前的格式），此处忽略不 throw。
 * 其余必填字段缺失仍 throw（FR-5）。
 */
export function deserializeState(data: Record<string, unknown>): GoalRuntimeState {
	const req = <T>(key: string): T => {
		if (!(key in data) || data[key] === undefined) {
			throw new Error(`Missing required field: ${key}`);
		}
		return data[key] as T;
	};

	return {
		goalId: req("goalId"),
		objective: req("objective"),
		status: req("status"),
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

/**
 * 从 state 构造 GoalHistoryEntry（纯函数）。
 *
 * totalTasks 暂置 0（task CRUD 已删除，#7 注入 todo 进度后可重填）。
 */
export function makeHistoryEntry(state: GoalRuntimeState, completedTasks: number): GoalHistoryEntry {
	return {
		goalId: state.goalId,
		objective: state.objective,
		status: state.status,
		completedTasks,
		totalTasks: 0,
		elapsedSeconds: Math.floor(state.timeUsedSeconds),
		timestamp: Date.now(),
	};
}
