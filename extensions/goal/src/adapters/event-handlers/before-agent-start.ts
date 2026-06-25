/**
 * 事件 5: before_agent_start（staleness + context wrap-up + injection）。
 *
 * FR-8.1 G-007 + FR-8.6。返回 message（注入到 LLM context）或 undefined（无注入）。
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
 * FR-7: contextInjectionPrompt 注入时运行时检测 pi.__planStart，plan 不可用时不建议 plan mode。
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { AUTO_CLEAR_TURNS, CONTEXT_USAGE_RATIO_LIMIT, STALENESS_THRESHOLD_TURNS } from "../../constants";
import { isActiveStatus, isTerminalStatus } from "../../engine/goal";
import { contextInjectionPrompt, stalenessReminderPrompt } from "../../projection/prompts";
import { asTheme, renderTerminalStatusLine } from "../../projection/widget";
import type { GoalSession } from "../../session";
import { clearGoalSession } from "../../session";
import { buildProgressInput } from "../goal-control-adapter";
import { buildPorts } from "../ports";

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

	// FR-4/AC-4 staleness 提醒：todo 进度停滞超过阈值轮数 → 注入推进提醒（纯 prompt，不转终态）。
	// todo 未加载（undefined）时不触发（无进度数据）。
	const stalenessResult = checkStaleness(pi, session);
	if (stalenessResult) return stalenessResult;

	// 正常 context injection
	// FR-7: 运行时检测 plan extension 可用性（typeof pi.__planStart === "function"），
	// 决定 contextInjectionPrompt 是否注入 plan mode 建议段落。
	const planAvailable =
		typeof (pi as unknown as { __planStart?: unknown }).__planStart === "function";
	return {
		message: {
			customType: "goal-context",
			content: contextInjectionPrompt(session.state, session.state.timeUsedSeconds, planAvailable),
			display: false,
		},
	};
}

/**
 * FR-4/AC-4 staleness 检测：未完成 todo 存在且 `currentTurnIndex - lastUpdatedTurn >= 阈值` 时，
 * 注入 stalenessReminderPrompt（推进提醒）。纯 prompt 驱动，不做状态变更。
 *
 * todo 未加载（undefined）或有未完成项时才检测；全完成或无 todo 数据 → 返回 undefined（走正常 injection）。
 */
function checkStaleness(
	pi: ExtensionAPI,
	session: GoalSession,
): BeforeAgentStartResult | undefined {
	const state = session.state!;
	const progress = buildProgressInput(pi);
	if (!progress) return undefined; // todo 未加载
	if (progress.incompleteIds.length === 0) return undefined; // 无未完成项

	const stalledTurns = state.currentTurnIndex - state.lastUpdatedTurn;
	if (stalledTurns >= STALENESS_THRESHOLD_TURNS) {
		return {
			message: {
				customType: "goal-staleness-reminder",
				content: stalenessReminderPrompt(stalledTurns, progress.incompleteIds.length),
				display: false,
			},
		};
	}
	return undefined;
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
