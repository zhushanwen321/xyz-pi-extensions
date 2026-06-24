/**
 * 事件 6: agent_end（FR-8.7 完整分支 + ESC 守卫 + 并发保护）。
 *
 * 整个重构最复杂的函数（FR-8.7 完整分支）。
 *
 * 关键约定：
 * - FR-8.2 G-021 防重入：session.isProcessing 入口加锁，finally 释放
 * - FR-8.2 G-020 stale 快照：入口 makeStaleChecker snapshot goalId，每个副作用前 checkStale
 * - FR-6.7 ESC 守卫（最关键）：ctx.signal?.aborted → 不发 continuation、不递增 stall、
 *   不做 budget 检查、不做任何状态变更，goal 保持 active，等用户下次输入恢复
 *
 * FR-8.7 分支优先级（严格按序）：
 * 1. allTasksDone → maxTurnsReached? complete : budgetTight? steer : followUp
 * 2. noTasksCreated → maxTurnsReached? cancelled : followUp
 * 3. maxTurnsReached（有未完成）→ cancelled
 * 4. 否则 → stall 检测 + continuation（去抖：tokenDelta=0 不发）
 *
 * 注：#1 去 task 依赖后，checkProgress 的 allTasksDone/noTasksCreated 暂置 false，
 * 分支 1/2 不会进入；分支 3（maxTurns）和 stall 检测仍生效（属 #6 范围，保留）。
 *
 * ESC 路径：aborted 时直接 return（goal 保持 active）。注意 ESC 守卫在终态/非 active
 * 检查之后——终态 goal 仍走终态 notify（不被 ESC 影响），非 active 状态直接返回。
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { checkBudgetOnTurnEnd, checkProgress } from "../../engine/budget";
import { isActiveStatus, transitionStatus } from "../../engine/goal";
import { serializeState } from "../../persistence";
import {
	budgetLimitPrompt,
	continuationPrompt,
} from "../../projection/prompts";
import { updateWidget } from "../../projection/widget";
import { finalizeAndPersist, persistAndUpdate, tickState } from "../../service";
import type { GoalSession } from "../../session";
import { buildPorts } from "../ports";
import { makeStaleChecker } from "./shared";

export async function handleAgentEnd(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
): Promise<void> {
	if (!session.state || session.isProcessing) return;
	session.isProcessing = true;
	try {
		const checkStale = makeStaleChecker(session);
		if (checkStale()) return;

		// 终态处理（complete / blocked）
		if (session.state.status === "complete" || session.state.status === "blocked") {
			await handleTerminalStateAgentEnd(pi, session, ctx, checkStale);
			return;
		}
		if (!isActiveStatus(session.state.status)) return;

		// FR-6.7 ESC 守卫（最关键）：aborted 时 goal 保持 active，不做任何副作用
		if (ctx.signal?.aborted) {
			return;
		}

		// 预算检查（FR-6.2 维度独立）——先 tick 把当前运行段计入 timeUsedSeconds，
		// 否则时间预算检测会比实际晚一轮（回归修复）
		tickState(session.state);
		const budgetResult = checkBudgetOnTurnEnd(session.state, session.state.timeUsedSeconds);
		const budgetAction = await handleBudgetChecks(pi, session, ctx, budgetResult, checkStale);
		if (budgetAction !== "continue") return;

		// 进度 + 任务检查（FR-8.7 分支优先级）
		const progress = checkProgress(session.state);
		const progressAction = handleProgressAndTasks(pi, session, ctx, progress, checkStale);
		if (progressAction !== "continue") return;

		// stall 检测 + continuation（去抖）
		await handleStallAndContinuation(pi, session, ctx, progress, checkStale);
	} finally {
		session.isProcessing = false;
	}
}

/** 终态 agent_end：persist + notify（complete/blocked 各一条消息）。 */
async function handleTerminalStateAgentEnd(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
	checkStale: () => boolean,
): Promise<void> {
	const state = session.state!;
	if (persistAndUpdate(session, buildPorts(pi, ctx), checkStale)) return;
	if (state.status === "complete") {
		ctx.ui.notify(`Objective completed ✓ (${state.currentTurnIndex} turns)`, "info");
	} else {
		ctx.ui.notify(
			"Goal blocked. Use /goal resume to continue or /goal clear to reset.",
			"warning",
		);
	}
}

type BudgetAction = "continue" | "stop";

/**
 * FR-6.2 维度独立预算检查：
 * - 预警（warning70/warning90）：set flag + notify（不阻塞 continuation）
 * - 耗尽（terminal）：转 budget_limited/time_limited + 写 history + notify
 * - 90% steering（shouldSendSteering）：set flag + 发 budgetLimitPrompt（收尾）
 */
async function handleBudgetChecks(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
	budgetResult: ReturnType<typeof checkBudgetOnTurnEnd>,
	checkStale: () => boolean,
): Promise<BudgetAction> {
	const state = session.state!;

	// 发送预警（FR-6.2 维度独立：token/time 各有 70/90 flag）
	for (const w of budgetResult.warnings) {
		if (w.type === "warning90") {
			if (w.dimension === "token") state.tokenWarning90Sent = true;
			else state.timeWarning90Sent = true;
			ctx.ui.notify(
				`${w.dimension === "token" ? "Token" : "Time"} budget 90% used — start wrapping up.`,
				"warning",
			);
		} else if (w.type === "warning70") {
			if (w.dimension === "token") state.tokenWarning70Sent = true;
			else state.timeWarning70Sent = true;
			ctx.ui.notify(
				`${w.dimension === "token" ? "Token" : "Time"} budget 70% used — keep scope in check.`,
				"info",
			);
		}
	}

	// 预算耗尽 → 终止
	if (budgetResult.terminal) {
		const dim = budgetResult.terminal.dimension;
		// FR-3.3: 唯一终态序列入口（tick + finalizeGoal + persist）
		finalizeAndPersist(
			state,
			dim === "token" ? "budget_limited" : "time_limited",
			0,
			buildPorts(pi, ctx),
		);
		if (checkStale()) return "stop";
		updateWidget(session, buildPorts(pi, ctx).ui);
		ctx.ui.notify(
			dim === "token"
				? "Token budget exhausted, Goal terminated."
				: "Time budget exhausted, Goal terminated.",
			"warning",
		);
		return "stop";
	}

	// 90% steering → 收尾
	if (budgetResult.shouldSendSteering) {
		state.budgetLimitSteeringSent = true;
		if (persistAndUpdate(session, buildPorts(pi, ctx), checkStale)) return "stop";
		buildPorts(pi, ctx).messaging.sendContextMessage(
			budgetLimitPrompt(state, "token", state.timeUsedSeconds),
			"steer",
		);
		return "stop";
	}

	if (checkStale()) return "stop";
	return "continue";
}

type ProgressAction = "continue" | "stop";

/**
 * FR-8.7 分支优先级 dispatcher：按 allTasksDone → noTasksCreated → maxTurnsReached 顺序。
 *
 * 注：#1 去 task 依赖后 allTasksDone/noTasksCreated 暂为 false，仅 maxTurnsReached 分支可能进入。
 * allTasksDone/noTasksCreated 分支整体移除属 #8（agent_end 重构）范围。
 */
function handleProgressAndTasks(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
	progress: ReturnType<typeof checkProgress>,
	checkStale: () => boolean,
): ProgressAction {
	// FR-8.7 分支 3: 最大轮次（有未完成）
	if (progress.maxTurnsReached) {
		return handleMaxTurnsReached(pi, session, ctx, checkStale);
	}
	return "continue";
}

/**
 * FR-8.7 分支 3: maxTurnsReached → cancelled。
 *
 * 注：此函数整体删除属 #6 范围。#1 阶段仅去掉 task 计数依赖。
 */
function handleMaxTurnsReached(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
	checkStale: () => boolean,
): ProgressAction {
	const state = session.state!;
	// FR-3.3: 唯一终态序列入口（tick + finalizeGoal + persist）
	finalizeAndPersist(state, "cancelled", 0, buildPorts(pi, ctx));
	if (checkStale()) return "stop";
	updateWidget(session, buildPorts(pi, ctx).ui);
	ctx.ui.notify(`Max turns reached (${state.budget.maxTurns}).`, "warning");
	return "stop";
}

/**
 * stall 检测 + continuation（去抖）。
 *
 * - isStalled → stallCount++，否则重置 stallCount + 更新 lastProgressTurn
 * - stallCount >= maxStallTurns → blocked（中间态，不写 history，不走 finalizeGoal）
 * - continuation 去抖：tokenDelta=0（空 turn）不发，只 persist
 * - 否则 persist + 发 continuationPrompt
 *
 * 注：stall/maxStallTurns 字段删除属 #6 范围；#1 阶段保留此控制流。
 * #1 去 task 依赖后 progress.isStalled 暂为 false（stallCount 恒重置为 0），
 * 等价于 stall 检测暂时静默——#6 重做后基于 lastUpdatedTurn 判断。
 */
async function handleStallAndContinuation(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
	progress: ReturnType<typeof checkProgress>,
	checkStale: () => boolean,
): Promise<void> {
	const state = session.state!;
	if (checkStale()) return;

	// Stall 检测
	if (progress.isStalled) {
		state.stallCount++;
	} else {
		state.stallCount = 0;
		state.lastProgressTurn = state.currentTurnIndex;
	}
	if (state.stallCount >= state.budget.maxStallTurns) {
		// stall 超限 → blocked（中间态，不走 finalizeGoal，不写 history）
		// FR-6.5: 转 blocked 前先 tick（此时 status 仍为 active，累加当前运行段）
		tickState(state);
		state.status = transitionStatus(state.status, "blocked");
		pi.appendEntry("goal-state", serializeState(state));
		if (checkStale()) return;
		updateWidget(session, buildPorts(pi, ctx).ui);
		ctx.ui.notify(
			`${state.stallCount} consecutive turns without progress, Goal auto-blocked. Use /goal resume to continue or /goal clear to reset.`,
			"warning",
		);
		return;
	}
	if (checkStale()) return;

	// FR-8.6: continuation 去抖（空 turn 不发）
	const tokenDelta = state.tokensUsed - state.lastTurnTokensUsed;
	state.lastTurnTokensUsed = state.tokensUsed;
	if (tokenDelta <= 0) {
		// 空 turn：只 persist，不发 continuation
		persistAndUpdate(session, buildPorts(pi, ctx));
		return;
	}
	persistAndUpdate(session, buildPorts(pi, ctx));
	// 发 continuation（FR-8.7: 去 debounce 后才发）
	buildPorts(pi, ctx).messaging.sendContextMessage(
		continuationPrompt(state, state.timeUsedSeconds),
		"followUp",
	);
}
