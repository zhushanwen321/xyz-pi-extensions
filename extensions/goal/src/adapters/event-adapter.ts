/**
 * Event adapter — Pi 事件 handler + 并发保护（adapters 层）
 *
 * 6 个事件 handler：
 * - agent_start / turn_end / message_end / session_start：委托 service.applyEvent
 *   （路径 B）做状态变更，adapter 负责 ESC 守卫 + 执行 EventEffect[] + persist
 * - before_agent_start：AUTO_CLEAR + staleness reminder + context wrap-up + injection
 * - agent_end：FR-8.7 完整分支优先级 + ESC 守卫 + 并发保护
 *
 * 设计（D-21 双路径）：
 * - persist 时机：before_agent_start / agent_end 触发（turn_end / message_end 不 persist，
 *   与重构前 index.ts 行为对齐）
 *
 * 并发保护（在此层，D-21）：
 * - isProcessing 防重入（FR-8.2 G-021，agent_end 用）
 * - makeStaleChecker goalId snapshot（FR-8.2 G-020，agent_end 用）
 *
 * FR-6.7 ESC 守卫：message_end / turn_end / agent_end 三 handler 入口检查 ctx.signal.aborted。
 *
 * ports 桥接复用 adapters/ports.buildPorts（DRY：单一 ports 构造点）。
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
	AUTO_CLEAR_TURNS,
	CONTEXT_USAGE_RATIO_LIMIT,
} from "../constants";
import { checkBudgetOnTurnEnd, checkProgress } from "../engine/budget";
import { isActiveStatus, isTerminalStatus, transitionStatus } from "../engine/goal";
import { serializeState } from "../persistence";
import {
	budgetLimitPrompt,
	contextInjectionPrompt,
	continuationPrompt,
} from "../projection/prompts";
import { asTheme, renderTerminalStatusLine, updateWidget } from "../projection/widget";
import { applyEvent, finalizeAndPersist, tickState } from "../service";
import type { GoalSession } from "../session";
import { clearGoalSession, reconstructGoalState } from "../session";
import { buildPorts } from "./ports";

// ── 基础设施：stale-checker（FR-8.2 G-020）────────────

/**
 * 构造 stale-check 闭包：入口快照 goalId，后续判断是否被新 goal 覆盖。
 *
 * 用法（agent_end）：
 * ```ts
 * const checkStale = makeStaleChecker(session);
 * // ... 长流程 ...
 * if (checkStale()) return; // goal 被覆盖，本次 agent_end 作废
 * ```
 *
 * 语义：snapshot 时 session.state 可能为 null（首次启动），此时 snapshotGoalId
 * 为 undefined；后续若有新 goal（goalId !== undefined）即视为 stale。
 */
export function makeStaleChecker(session: GoalSession): () => boolean {
	const snapshotGoalId = session.state?.goalId;
	return () => !session.state || session.state.goalId !== snapshotGoalId;
}

/**
 * FR-8.2 G-021：isProcessing 防重入。
 *
 * agent_end 可能并发触发（多 message），重入时直接返回（不重复预算检查/续跑）。
 * 通过 session.isProcessing flag 实现（定义在 session.ts）。
 * 本函数为 agent_end 提供「锁住 + 解锁」语义。
 */
export function acquireProcessing(session: GoalSession): boolean {
	if (session.isProcessing) return false; // 已被占用
	session.isProcessing = true;
	return true;
}

export function releaseProcessing(session: GoalSession): void {
	session.isProcessing = false;
}

// ── 事件 1: agent_start ───────────────────────────────

/**
 * 委托 service.applyEvent("agent_start")。task 已移除，当前无副作用
 * （#7 注入 todo 进度后可能重填基线逻辑）。
 *
 * 无 ESC 守卫（agent_start 是 agent 开始时的信号，此时无 aborted 可能）。
 * 无 persist / updateWidget。
 */
export async function handleAgentStart(session: GoalSession): Promise<void> {
	if (!session.state) return;
	applyEvent(session, "agent_start", undefined);
}

// ── 事件 2: turn_end（FR-6.7 ESC 守卫 + 递增）──────────

/**
 * FR-6.7 ESC 守卫：ctx.signal.aborted 时跳过递增（ESC 不算 goal turn）。
 * 正常路径：currentTurnIndex++ + updateWidget。
 *
 * 委托 service.applyEvent("turn_end")——它递增 currentTurnIndex 并返回
 * EventEffect[{kind:"updateWidget"}]。adapter 执行该 effect。
 *
 * 不 persist（与旧 index.ts 行为对齐——turn_end 只内存变更 + widget）。
 */
export async function handleTurnEnd(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
): Promise<void> {
	if (!session.state) return;
	// FR-6.7 ESC 守卫
	if (ctx.signal?.aborted) return;

	const effects = applyEvent(session, "turn_end", undefined, buildPorts(pi, ctx));
	// 执行 effects（updateWidget 等）
	for (const effect of effects) {
		if (effect.kind === "updateWidget") {
			updateWidget(session, buildPorts(pi, ctx).ui);
		}
	}
}

// ── 事件 3: message_end（FR-6.7 ESC 守卫 + token 累加）──

export interface MessageEndLikeEvent {
	message: {
		role: string;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			totalTokens?: number;
		};
	};
}

/**
 * FR-6.7 ESC 守卫：ctx.signal.aborted 时跳过 token 累加。
 * FR-8.6: token 累加算法（委托 service.applyEvent("message_end")）。
 *
 * 不 persist / updateWidget。
 */
export async function handleMessageEnd(
	session: GoalSession,
	ctx: ExtensionContext,
	event: MessageEndLikeEvent,
): Promise<void> {
	if (!session.state) return;
	// FR-6.7 ESC 守卫
	if (ctx.signal?.aborted) return;

	applyEvent(session, "message_end", event);
}

// ── 事件 4: session_start（状态重建）───────────────────

/**
 * session_start：调 reconstructGoalState 重建持久化状态 + updateWidget。
 */
export async function handleSessionStart(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
): Promise<void> {
	const ports = buildPorts(pi, ctx);
	reconstructGoalState(session, ports.session);
	if (session.state) {
		updateWidget(session, ports.ui);
	}
}

// ── 持久化辅助（before_agent_start / agent_end 用）────

/**
 * persist + updateWidget 的统一入口。
 *
 * BL-3 DRY：tick 逻辑复用 service.tickState（单一 tick 定义点）。
 * 与 service.persistState 的差异：adapter 层 event handler 需要在 persist 后再 updateWidget，
 * 并支持可选 stale check。
 *
 * 语义：返回 true 表示 state 已被新 goal 覆盖（checkStale 触发），调用方应中止后续副作用。
 */
function persistAndUpdate(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
	checkStale?: (() => boolean) | undefined,
): boolean {
	if (!session.state) return false;
	// FR-6.5: tick 累加运行时间（复用 service.tickState——单一 tick 定义点）
	tickState(session.state);
	pi.appendEntry("goal-state", serializeState(session.state));
	if (checkStale?.()) return true;
	updateWidget(session, buildPorts(pi, ctx).ui);
	return false;
}

// ── 事件 5: before_agent_start（staleness + context wrap-up + injection）───

/**
 * before_agent_start 事件 handler（FR-8.1 G-007 + FR-8.6）。
 *
 * 返回 message（注入到 LLM context）或 undefined（无注入）。
 *
 * 分支顺序：
 * 1. 终态：currentTurnIndex - completedAtTurnIndex >= AUTO_CLEAR_TURNS(2) → clearGoalSession
 * 2. ADR-002：Context 使用率 > 85% → 保持 active + 注入 wrap-up 指令
 * 3. 正常：注入 contextInjectionPrompt
 *
 * 无 ESC 守卫（before_agent_start 是 agent 开始前的信号，此时无 aborted 可能）。
 *
 * 注：staleness reminder 暂时禁用（原基于 task/subtask，task 已移除）。
 * #6 会基于 lastUpdatedTurn 重做 goal 级 staleness 检测。
 */
interface BeforeAgentStartResult {
	message: {
		customType: string;
		content: string;
		display: boolean;
	};
}

export async function handleBeforeAgentStart(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
): Promise<BeforeAgentStartResult | undefined> {
	if (!session.state) return;

	// 终态处理
	if (isTerminalStatus(session.state.status)) {
		handleTerminalStateBeforeAgent(pi, session, ctx);
		return;
	}
	if (!isActiveStatus(session.state.status)) return;

	// Context 使用率检查（ADR-002：保持 active，仅注入提示）
	const ctxResult = checkContextUsage(session, ctx);
	if (ctxResult) return ctxResult;

	// 正常 context injection
	return {
		message: {
			customType: "goal-context",
			content: contextInjectionPrompt(session.state, session.state.timeUsedSeconds),
			display: false,
		},
	};
}

/**
 * FR-8.1 G-007：终态 goal 在 AUTO_CLEAR_TURNS(2) 轮后自动清理。
 * 未到清理阈值时：折叠 status bar（显示终态单行），清 widget。
 */
function handleTerminalStateBeforeAgent(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
): void {
	const state = session.state!;
	const turnsInTerminal = state.currentTurnIndex - (state.completedAtTurnIndex ?? 0);
	if (turnsInTerminal >= AUTO_CLEAR_TURNS) {
		clearGoalSession(session, buildPorts(pi, ctx).ui);
		return;
	}
	// 折叠 status bar（终态显示）
	const statusText = renderTerminalStatusLine(state, asTheme(buildPorts(pi, ctx).ui));
	if (statusText && ctx.hasUI) ctx.ui.setStatus("goal", statusText);
	if (ctx.hasUI) ctx.ui.setWidget("goal", undefined);
}

/**
 * ADR-002 context usage 提示：getContextUsage 超过 CONTEXT_USAGE_RATIO_LIMIT(0.85)
 * → goal **保持 active**（不转 paused），仅注入 wrap-up 指令让 AI 自行 complete/cancel。
 * 不做状态变更、不 persist、不 tick（资源保护通过"提示"而非"状态机"实现）。
 */
function checkContextUsage(
	_session: GoalSession,
	_ctx: ExtensionContext,
): BeforeAgentStartResult | undefined {
	const usage = _ctx.getContextUsage();
	if (
		usage &&
		usage.contextWindow > 0 &&
		(usage.tokens ?? 0) / usage.contextWindow > CONTEXT_USAGE_RATIO_LIMIT
	) {
		return {
			message: {
				customType: "goal-context-exceeded",
				content:
					"[GOAL — context space low, must wrap up now]\n" +
					"1. Check remaining work and verify what is genuinely completed\n" +
					"2. Only report completion for work backed by concrete evidence\n" +
					"3. Summarize current progress and remaining work\n" +
					"Do not start new work.",
				display: false,
			},
		};
	}
	return undefined;
}

// ── 事件 6: agent_end（FR-8.7 完整分支 + ESC 守卫 + 并发保护）──

/**
 * agent_end 事件 handler——整个重构最复杂的函数（FR-8.7 完整分支）。
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
	if (persistAndUpdate(pi, session, ctx, checkStale)) return;
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
		if (persistAndUpdate(pi, session, ctx, checkStale)) return "stop";
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
		persistAndUpdate(pi, session, ctx);
		return;
	}
	persistAndUpdate(pi, session, ctx);
	// 发 continuation（FR-8.7: 去 debounce 后才发）
	buildPorts(pi, ctx).messaging.sendContextMessage(
		continuationPrompt(state, state.timeUsedSeconds),
		"followUp",
	);
}
