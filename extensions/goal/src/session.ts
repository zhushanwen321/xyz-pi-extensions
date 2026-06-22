/**
 * Session 层 — 运行时句柄 + 状态重建 + entry GC
 *
 * GoalSession 是进程内瞬态句柄（不持久化）。
 * reconstructGoalState 从 entry 恢复状态（session_start 时调）。
 *
 * FR-6.4: 删除 hasPendingInjection（僵尸字段）
 * FR-6.7: 删除 pendingPause（ESC 改用 aborted 守卫）
 * FR-8.1 G-006: entry GC（goal-state 最新 1 条，goal-history 20 条）
 * FR-8.3 G-015: 非对称强制激活（非终态非 paused → active）
 */

import { isTerminalStatus } from "./engine/goal";
import type { GoalRuntimeState } from "./engine/types";
import { deserializeState, ENTRY_TYPE, HISTORY_ENTRY_TYPE } from "./persistence";
import type { SessionEntryLike, SessionPort, UiPort } from "./ports";

// ── 运行时句柄 ────────────────────────────────────────

export interface GoalSession {
	state: GoalRuntimeState | null;
	tasksCompletedAtAgentStart: number;
	/** 防重入标志：agent_end / before_agent_start 等事件处理器入口检查 */
	isProcessing: boolean;
}

export function createGoalSession(): GoalSession {
	return {
		state: null,
		tasksCompletedAtAgentStart: 0,
		isProcessing: false,
	};
}

// ── Stale Context 检测（FR-8.2 G-010）─────────────────

export const STALE_CONTEXT_PATTERNS = [
	"aborted",
	"context canceled",
	"stale context",
	"stalecontext",
	"extension context no longer active",
] as const;

export function isStaleContextError(error: Error | unknown): boolean {
	const msg = error instanceof Error ? error.message : String(error);
	const lower = msg.toLowerCase();
	return STALE_CONTEXT_PATTERNS.some((p) => lower.includes(p));
}

// ── reconstructGoalState（session_start 时调）──────────

/**
 * 从 session entries 恢复 goal state。
 *
 * FR-8.1 G-006: goal-state 只保留最新 1 条（splice 其余）
 * FR-8.3 G-015: 非终态且非 paused → 强制 active（crashed blocked 重启变 active）
 * FR-8.1 G-024: deserialize throw → state=null（部分损坏全丢）
 * FR-8.1 G-006: goal-history entry 保留最近 MAX_HISTORY_ENTRIES=20 条
 */
export function reconstructGoalState(session: GoalSession, sessionPort: SessionPort): void {
	session.state = null;
	const entries = sessionPort.getEntries();

	// 找到最新的 goal-state entry（从后往前）
	let latestStateIdx = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (isGoalStateEntry(entries[i]!)) {
			latestStateIdx = i;
			break;
		}
	}

	if (latestStateIdx >= 0) {
		const data = entries[latestStateIdx]!.data as Record<string, unknown> | undefined;
		if (data) {
			try {
				session.state = deserializeState(data);
			} catch {
				// FR-8.1 G-024: 部分损坏全丢
				session.state = null;
			}
		}
	}

	// Entry GC — 收集除最新外的所有 goal-state entries（从后往前，降序）
	const goalStateIndicesToDelete: number[] = [];
	let latestFound = false;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (isGoalStateEntry(entries[i]!)) {
			if (!latestFound) {
				latestFound = true;
			} else {
				goalStateIndicesToDelete.push(i);
			}
		}
	}
	// 降序 splice（先删大索引，不影响小索引）
	for (const idx of goalStateIndicesToDelete) {
		sessionPort.spliceEntry(idx, 1);
	}

	// Goal-history entry GC（保留最近 MAX_HISTORY_ENTRIES 条）
	const MAX_HISTORY_ENTRIES = 20;
	const historyIndices: number[] = [];
	for (let i = 0; i < entries.length; i++) {
		if (entries[i]!.type === "custom" && (entries[i] as { customType?: string }).customType === HISTORY_ENTRY_TYPE) {
			historyIndices.push(i);
		}
	}
	if (historyIndices.length > MAX_HISTORY_ENTRIES) {
		const toDelete = historyIndices.slice(0, historyIndices.length - MAX_HISTORY_ENTRIES);
		// 降序 splice
		for (let i = toDelete.length - 1; i >= 0; i--) {
			sessionPort.spliceEntry(toDelete[i]!, 1);
		}
	}

	if (!session.state) return;

	// FR-8.3 G-015: 非对称强制激活
	if (!isTerminalStatus(session.state.status) && session.state.status !== "paused") {
		session.state.status = "active";
		session.state.timeStartedAt = Date.now();
	}
}

function isGoalStateEntry(entry: SessionEntryLike): boolean {
	return entry.type === "custom" && entry.customType === ENTRY_TYPE;
}

// ── clearGoalSession ──────────────────────────────────

export function clearGoalSession(session: GoalSession, uiPort: UiPort): void {
	session.state = null;
	session.tasksCompletedAtAgentStart = 0;
	session.isProcessing = false;
	// FR-6.6: hasUI 守卫
	if (uiPort.hasUI) {
		uiPort.setWidget("goal", undefined);
		uiPort.setStatus("goal", undefined);
	}
}
