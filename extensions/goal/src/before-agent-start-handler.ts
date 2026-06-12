/**
 * before_agent_start 事件处理子函数
 *
 * handleBeforeAgentStart (orchestrator, ≤20 行) 委托到 3 个子函数：
 *   handleTerminalStateBeforeAgent, checkStaleness, checkContextUsage
 *
 * P1-5/6 修复：将 122 行的大函数拆分为 ≤20 行子函数。
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
	AUTO_CLEAR_TURNS,
	CONTEXT_USAGE_RATIO_LIMIT,
	TASK_STALL_TURN_THRESHOLD,
} from "./constants";
import {
	type GoalTask,
	isActiveStatus,
	isTerminalStatus,
	isTaskDone,
	transitionStatus,
} from "./state";
import {
	contextInjectionPrompt,
	stalenessReminderPrompt,
} from "./templates";
import {
	clearGoalSession,
	type GoalSession,
	persistAndUpdate,
} from "./tool-handler";
import { renderTerminalStatusLine } from "./widget";

// ── Orchestrator ──────────────────────────────────────

export async function handleBeforeAgentStart(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
) {
	if (!session.state) return;

	// 终态处理
	if (isTerminalStatus(session.state.status)) {
		handleTerminalStateBeforeAgent(session, ctx);
		return;
	}
	if (!isActiveStatus(session.state.status)) return;

	session.hasPendingInjection = true;

	// 停滞检测
	const staleResult = checkStaleness(session);
	if (staleResult) return staleResult;

	// Context 使用率检查
	const ctxResult = checkContextUsage(pi, session, ctx);
	if (ctxResult) return ctxResult;

	// 正常 context injection
	return {
		message: {
			customType: "goal-context",
			content: contextInjectionPrompt(session.state),
			display: false,
		},
	};
}

// ── Sub-handler 1: 终态处理 ──────────────────────────

function handleTerminalStateBeforeAgent(
	session: GoalSession, ctx: ExtensionContext,
): void {
	const state = session.state!;
	const turnsInTerminal = state.currentTurnIndex - (state.completedAtTurnIndex ?? 0);

	if (turnsInTerminal >= AUTO_CLEAR_TURNS) {
		clearGoalSession(session, ctx);
		return;
	}

	// 折叠 status bar
	const statusText = renderTerminalStatusLine(state, ctx.ui.theme);
	if (statusText) ctx.ui.setStatus("goal", statusText);
	ctx.ui.setWidget("goal", undefined);
}

// ── Sub-handler 2: 停滞检测 ─────────────────────────

function checkStaleness(session: GoalSession) {
	const state = session.state!;
	const staleTasks: Array<{
		task: GoalTask;
		staleTurns: number;
		staleSubtasks: Array<{ text: string; staleTurns: number }>;
	}> = [];
	let allTerminal = true;

	for (const task of state.tasks) {
		if (!isTaskDone(task)) {
			allTerminal = false;
			const staleTurns = state.currentTurnIndex - task.lastUpdatedTurn;
			if (staleTurns >= TASK_STALL_TURN_THRESHOLD) {
				const staleSubtasks: Array<{ text: string; staleTurns: number }> = [];
				if (task.subtasks) {
					for (const s of task.subtasks) {
						if (s.status !== "completed") {
							const subStale = state.currentTurnIndex - s.lastUpdatedTurn;
							if (subStale >= TASK_STALL_TURN_THRESHOLD) {
								staleSubtasks.push({ text: s.text, staleTurns: subStale });
							}
						}
					}
				}
				staleTasks.push({ task, staleTurns, staleSubtasks });
			}
		}
	}

	// 所有 task 已终态但 goal 仍 active
	if (allTerminal && state.tasks.length > 0) {
		return {
			message: {
				customType: "goal-staleness-reminder",
				content: stalenessReminderPrompt(state, [], true),
				display: false,
			},
		};
	}

	// 有停滞项 → 注入提醒
	if (staleTasks.length > 0) {
		// 重置被提醒项的 lastUpdatedTurn
		for (const item of staleTasks) {
			item.task.lastUpdatedTurn = state.currentTurnIndex;
			if (item.task.subtasks) {
				for (const s of item.task.subtasks) {
					if (s.status !== "completed") s.lastUpdatedTurn = state.currentTurnIndex;
				}
			}
		}
		return {
			message: {
				customType: "goal-staleness-reminder",
				content: stalenessReminderPrompt(state, staleTasks, false),
				display: false,
			},
		};
	}

	return null;
}

// ── Sub-handler 3: Context 使用率 ───────────────────

function checkContextUsage(
	pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
) {
	const usage = ctx.getContextUsage();
	if (usage && usage.contextWindow > 0 && (usage.tokens ?? 0) / usage.contextWindow > CONTEXT_USAGE_RATIO_LIMIT) {
		const state = session.state!;
		state.status = transitionStatus(state.status, "paused");
		persistAndUpdate(pi, session, ctx);
		return {
			message: {
				customType: "goal-context-exceeded",
				content:
					"[GOAL — context space low, must wrap up now]\n" +
					"1. Use goal_manager's list_tasks to check remaining tasks\n" +
					"2. Only mark tasks you genuinely completed with evidence\n" +
					"3. Summarize current progress and remaining work\n" +
					"Do not start new tasks.",
				display: false,
			},
		};
	}
	return null;
}
