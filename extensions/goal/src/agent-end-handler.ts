/**
 * agent_end 事件处理子函数
 *
 * handleAgentEnd (orchestrator) 按顺序委托到 5 个 ≤20 行子函数：
 *   1. handleTerminalStateAgentEnd — 终态处理（complete / blocked）
 *   2. handleBudgetChecks — 预算预警 + 耗尽 + steering
 *   3. handleAllTasksDone — 全部任务完成 → 提示 complete_goal
 *   4. handleNoTasksOrMaxTurns — 无任务创建 / 最大轮次
 *   5. handleStallAndContinuation — Stall 检测 + Normal continuation
 *
 * P0-2 修复：将 197 行的大函数拆分为 ≤20 行子函数。
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { BudgetCheckResult } from "./budget.js";
import {
	checkBudgetOnTurnEnd,
	checkProgress,
} from "./budget.js";
import { PERCENT_FACTOR } from "./constants";
import {
	getCompletedCount,
	getIncompleteTasks,
	isActiveStatus,
	transitionStatus,
} from "./state";
import {
	budgetLimitPrompt,
	continuationPrompt,
} from "./templates";
import {
	type GoalSession,
	persistAndUpdate,
	writeGoalHistoryEntry,
} from "./tool-handler";

// ── Orchestrator ──────────────────────────────────────

/**
 * agent_end 事件处理主函数
 *
 * 关键约定：
 * - 防重入：session.isProcessing 标志在入口加锁，finally 释放
 * - 快照检查：snapshotGoalId 防止旧回调操作新 goal
 * - 所有副作用（persist / widget / notify / sendUserMessage）都通过 checkStale 守卫
 */
export async function handleAgentEnd(pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext): Promise<void> {
	if (!session.state || session.isProcessing) return;
	session.isProcessing = true;
	try {
		const checkStale = makeStaleChecker(session);
		if (checkStale()) return;
		if (session.state.status === "complete" || session.state.status === "blocked") {
			await handleTerminalStateAgentEnd(pi, session, ctx, checkStale); return;
		}
		if (!isActiveStatus(session.state.status)) return;

		// ESC / user abort during text generation also pauses the goal
		if (ctx.signal?.aborted) {
			session.pendingPause = true;
			const progress = checkProgress(session.state, session.tasksCompletedAtAgentStart);
			await handleStallAndContinuation(pi, session, ctx, progress, checkStale);
			return;
		}

		const budgetAction = await handleBudgetChecks(pi, session, ctx, checkBudgetOnTurnEnd(session.state), checkStale);
		if (budgetAction !== "continue") return;
		const progress = checkProgress(session.state, session.tasksCompletedAtAgentStart);
		const progressAction = handleProgressAndTasks(pi, session, ctx, progress, checkStale);
		if (progressAction !== "continue") return;
		await handleStallAndContinuation(pi, session, ctx, progress, checkStale);
	} finally {
		session.isProcessing = false;
	}
}

/** 构造 stale-check 闭包：在入口快照 goalId，后续可判断是否被新 goal 覆盖。 */
function makeStaleChecker(session: GoalSession): () => boolean {
	const snapshotGoalId = session.state?.goalId;
	return () => !session.state || session.state.goalId !== snapshotGoalId;
}

// ── Sub-handler 1: 终态 ─────────────────────────────

async function handleTerminalStateAgentEnd(
	pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
	checkStale: () => boolean,
): Promise<void> {
	const state = session.state!;
	if (persistAndUpdate(pi, session, ctx, checkStale)) return;
	if (state.status === "complete") {
		ctx.ui.notify(
			`Objective completed ✓ (${getCompletedCount(state.tasks)}/${state.tasks.length} tasks, ${state.currentTurnIndex} turns)`,
			"info",
		);
	} else {
		ctx.ui.notify("Goal blocked. Use /goal resume to continue or /goal clear to reset.", "warning");
	}
}

// ── Sub-handler 2: 预算检查 ─────────────────────────

type BudgetAction = "continue" | "stop";

async function handleBudgetChecks(
	pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
	budgetResult: BudgetCheckResult, checkStale: () => boolean,
): Promise<BudgetAction> {
	// 发送预警
	for (const w of budgetResult.warnings) {
		if (w.type === "warning90") {
			session.state!.budgetWarning90Sent = true;
			ctx.ui.notify(`${w.dimension === "token" ? "Token" : "Time"} budget 90% used — start wrapping up.`, "warning");
		} else if (w.type === "warning70") {
			session.state!.budgetWarning70Sent = true;
			ctx.ui.notify(`${w.dimension === "token" ? "Token" : "Time"} budget 70% used — keep scope in check.`, "info");
		}
	}
	// 预算耗尽 → 终止
	if (budgetResult.terminal) {
		const dim = budgetResult.terminal.dimension;
		session.state!.status = transitionStatus(session.state!.status, dim === "token" ? "budget_limited" : "time_limited");
		session.state!.completedAtTurnIndex = session.state!.currentTurnIndex;
		writeGoalHistoryEntry(pi, session);
		if (persistAndUpdate(pi, session, ctx, checkStale)) return "stop";
		ctx.ui.notify(
			dim === "token"
				? "Token budget exhausted, Goal terminated."
				: `Time budget exhausted (${session.state!.budget.timeBudgetMinutes} min), Goal terminated.`,
			"warning",
		);
		return "stop";
	}
	// 90% steering → 收尾
	if (budgetResult.shouldSendSteering) {
		session.state!.budgetLimitSteeringSent = true;
		if (persistAndUpdate(pi, session, ctx, checkStale)) return "stop";
		sendGoalContextMessage(pi, budgetLimitPrompt(session.state!, "token"), "steer");
		return "stop";
	}
	if (checkStale()) return "stop";
	return "continue";
}

// ── Sub-handler 3: 进展 + 任务列表 ───────────────────

type ProgressAction = "continue" | "stop";

function handleProgressAndTasks(
	pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
	progress: ReturnType<typeof checkProgress>, checkStale: () => boolean,
): ProgressAction {
	// 全部任务完成
	if (progress.allTasksDone) {
		return handleAllTasksDone(pi, session, ctx, progress, checkStale);
	}
	// 无任务创建
	if (progress.noTasksCreated) {
		return handleNoTasksOrMaxTurns(pi, session, ctx, progress, checkStale);
	}
	// 最大轮次
	if (progress.maxTurnsReached) {
		return handleMaxTurnsReached(pi, session, ctx, checkStale);
	}
	return "continue";
}

function handleAllTasksDone(
	pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
	progress: ReturnType<typeof checkProgress>, checkStale: () => boolean,
): ProgressAction {
	const state = session.state!;
	if (progress.maxTurnsReached) {
		state.status = transitionStatus(state.status, "complete");
		state.completedAtTurnIndex = state.currentTurnIndex;
		writeGoalHistoryEntry(pi, session);
		if (persistAndUpdate(pi, session, ctx, checkStale)) return "stop";
		ctx.ui.notify(
			`All tasks completed, Goal auto-closed. (${progress.completedCount}/${progress.totalCount} tasks, ${state.currentTurnIndex} turns)`,
			"info",
		);
		return "stop";
	}
	if (progress.budgetTight) {
		sendGoalContextMessage(
			pi,
			`All tasks completed, token budget ${Math.round(state.tokensUsed / state.budget.tokenBudget! * PERCENT_FACTOR)}% used.` +
			`Call goal_manager's complete_goal now with overall evidence.` +
			`\n\nObjective: ${state.objective}`,
			"steer",
		);
	} else {
		sendGoalContextMessage(
			pi,
			`All ${progress.totalCount} tasks completed. Call goal_manager's complete_goal with overall evidence.` +
				`\n\nObjective: ${state.objective}`,
			"followUp",
		);
	}
	persistAndUpdate(pi, session, ctx);
	return "stop";
}

function handleNoTasksOrMaxTurns(
	pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
	progress: ReturnType<typeof checkProgress>, checkStale: () => boolean,
): ProgressAction {
	const state = session.state!;
	if (progress.maxTurnsReached) {
		state.status = transitionStatus(state.status, "cancelled");
		state.completedAtTurnIndex = state.currentTurnIndex;
		writeGoalHistoryEntry(pi, session);
		if (persistAndUpdate(pi, session, ctx, checkStale)) return "stop";
		ctx.ui.notify(
			`Max turns reached (${state.budget.maxTurns}), LLM did not create task list.`,
			"warning",
		);
		return "stop";
	}
	sendGoalContextMessage(
		pi,
		`No task list created yet. First check if the objective is already satisfied — if yes, call goal_manager's cancel_goal with cancelReason. Otherwise call create_tasks immediately to decompose the work into verifiable task steps.` +
			`\n\nObjective: ${state.objective}`,
		"followUp",
	);
	persistAndUpdate(pi, session, ctx);
	return "stop";
}

function handleMaxTurnsReached(
	pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
	checkStale: () => boolean,
): ProgressAction {
	const state = session.state!;
	const incomplete = getIncompleteTasks(state.tasks);
	state.status = transitionStatus(state.status, "cancelled");
	state.completedAtTurnIndex = state.currentTurnIndex;
	writeGoalHistoryEntry(pi, session);
	if (persistAndUpdate(pi, session, ctx, checkStale)) return "stop";
	ctx.ui.notify(
		`Max turns reached (${state.budget.maxTurns}), ${incomplete.length} tasks still incomplete.`,
		"warning",
	);
	return "stop";
}

// ── Sub-handler 4: Stall + Continuation ─────────────

async function handleStallAndContinuation(
	pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
	progress: ReturnType<typeof checkProgress>, checkStale: () => boolean,
): Promise<void> {
	const state = session.state!;
	if (checkStale()) return;

	// ESC pause: if tool call was aborted, pause instead of continuing
	if (session.pendingPause) {
		session.pendingPause = false;
		state.status = transitionStatus(state.status, "paused");
		if (persistAndUpdate(pi, session, ctx, checkStale)) return;
		ctx.ui.notify("Goal paused (user interrupt). Use /goal resume to continue.", "info");
		return;
	}

	// Stall 检测
	updateStallCounter(state, progress.isStalled);
	if (state.stallCount >= state.budget.maxStallTurns) {
		markGoalBlocked(pi, session, ctx, checkStale);
		return;
	}
	if (checkStale()) return;

	// 去抖 + Continuation
	if (!consumeTokensForDebounce(state)) {
		persistAndUpdate(pi, session, ctx);
		return;
	}
	persistAndUpdate(pi, session, ctx);
	sendGoalContextMessage(pi, continuationPrompt(state), "followUp");
}

/** Send a hidden custom message that feeds the LLM but is not rendered in TUI. */
function sendGoalContextMessage(
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

/** 更新 stall 计数。stall 时递增，否则重置。 */
function updateStallCounter(state: { stallCount: number; lastProgressTurn: number; currentTurnIndex: number }, isStalled: boolean): void {
	if (isStalled) state.stallCount++;
	else { state.stallCount = 0; state.lastProgressTurn = state.currentTurnIndex; }
}

/** Stall 超限 → 标记 blocked。 */
function markGoalBlocked(pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext, checkStale: () => boolean): void {
	const state = session.state!;
	state.status = transitionStatus(state.status, "blocked");
	if (persistAndUpdate(pi, session, ctx, checkStale)) return;
	ctx.ui.notify(
		`${state.stallCount} consecutive turns without progress, Goal auto-blocked. Use /goal resume to continue or /goal clear to reset.`,
		"warning",
	);
}

/** 去抖检查：返回 true 表示本 turn 有 token 消耗，可以发送 continuation。 */
function consumeTokensForDebounce(state: { tokensUsed: number; lastTurnTokensUsed: number }): boolean {
	const tokenDelta = state.tokensUsed - state.lastTurnTokensUsed;
	state.lastTurnTokensUsed = state.tokensUsed;
	return tokenDelta > 0;
}
