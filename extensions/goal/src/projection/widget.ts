/**
 * Widget 渲染逻辑（projection 层）— 状态栏和侧边栏面板
 *
 * 设计要点：
 * - 不 import Pi 类型（ThemeColor → ThemeLike，fg 接收 string）
 * - 类型 import 自 engine/types.ts
 * - 工具函数 import 自 engine/budget.ts
 * - 时间计算基于 state.timeUsedSeconds（不含 Date.now() 副作用段）
 * - updateWidget(session, uiPort) 含 FR-6.6 hasUI 守卫
 */

import {
	OBJECTIVE_DISPLAY_LIMIT,
	OBJECTIVE_TRUNCATE_KEEP,
	PERCENT_FACTOR,
	PROGRESS_BAR_DEFAULT_WIDTH,
	SECONDS_PER_MINUTE,
} from "../constants";
import { getBudgetColor, getTimeUsagePercent, getTokenUsagePercent } from "../engine/budget";
import { isTerminalStatus } from "../engine/goal";
import type { GoalRuntimeState } from "../engine/types";
import type { UiPort } from "../ports";
import type { GoalSession } from "../session";

/**
 * projection 层的 Theme 抽象。不 import Pi 的 ThemeColor。
 * adapter 层负责把 Pi 的 theme（fg 接收 ThemeColor）适配到此签名（fg 接收 string）。
 */
export interface ThemeLike {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

/**
 * 将多行文本压缩为单行，用于 widget 渲染。
 * 多行 content 泄漏到 widget 会导致 markdown 表格/标题等破坏布局。
 */
export function toSingleLine(text: string): string {
	return text.replace(/\r?\n/g, " ").trim();
}

function renderProgressBar(pct: number, width: number = PROGRESS_BAR_DEFAULT_WIDTH): string {
	const clamped = Math.min(Math.max(pct, 0), 1);
	const filled = Math.round(clamped * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

/**
 * 返回累计耗时秒数（仅基于 state 内字段，不含 Date.now() 副作用）。
 * 终态 / blocked 状态下停止累计，直接返回已记录值。
 * adapter/service 在调用 projection 前已通过 budget.tick() 把当前活跃段计入
 * state.timeUsedSeconds，因此此处直接读取即可。
 */
function getElapsedSeconds(state: GoalRuntimeState): number {
	return state.timeUsedSeconds;
}

export function renderStatusLine(state: GoalRuntimeState, th: ThemeLike): string {
	if (state.status === "cancelled") return "";

	let text = th.fg("accent", `◆ Goal`) + th.fg("muted", ` ${state.currentTurnIndex}/${state.budget.maxTurns}`);

	// Budget indicators
	if (state.budget.tokenBudget && state.budget.tokenBudget > 0) {
		const pct = Math.round(getTokenUsagePercent(state));
		text += th.fg(getBudgetColor(pct), ` | ${pct}% tokens`);
	}
	if (state.budget.timeBudgetMinutes && state.budget.timeBudgetMinutes > 0) {
		const pct = Math.round(getTimeUsagePercent(state, getElapsedSeconds(state)));
		text += th.fg(getBudgetColor(pct), ` | ${pct}% time`);
	}

	if (state.stallCount > 0) {
		text += th.fg("warning", ` | ⚠ ${state.stallCount} turns stalled`);
	}

	// Status suffix（ADR-002：paused 视图已删除）
	switch (state.status) {
		case "blocked":
			text += th.fg("error", " | ⊘ Blocked");
			break;
		case "complete":
			text += th.fg("success", " | ✓ Completed");
			break;
		case "budget_limited":
			text += th.fg("error", " | ⊗ Token budget exhausted");
			break;
		case "time_limited":
			text += th.fg("error", " | ⏱ Time budget exhausted");
			break;
	}

	return text;
}

export function renderTerminalStatusLine(state: GoalRuntimeState, th: ThemeLike): string {
	if (state.status === "cancelled") return "";

	let text = th.fg("accent", "◆ Goal");

	// 状态后缀
	switch (state.status) {
		case "complete":
			text += th.fg("success", " ✓ Completed");
			break;
		case "budget_limited":
			text += th.fg("error", " ⊗ Token budget exhausted");
			break;
		case "time_limited":
			text += th.fg("error", " ⏱ Time budget exhausted");
			break;
		default:
			break;
	}

	// 预算摘要
	if (state.budget.tokenBudget && state.budget.tokenBudget > 0) {
		const pct = Math.round(getTokenUsagePercent(state));
		text += th.fg(getBudgetColor(pct), ` | ${pct}% tokens`);
	}
	if (state.budget.timeBudgetMinutes && state.budget.timeBudgetMinutes > 0) {
		const pct = Math.round(getTimeUsagePercent(state, getElapsedSeconds(state)));
		text += th.fg(getBudgetColor(pct), ` | ${pct}% time`);
	}

	return text;
}

export function renderWidgetLines(state: GoalRuntimeState, th: ThemeLike): string[] {
	if (state.status === "cancelled") return [];

	const header = renderStatusLine(state, th);
	const lines: string[] = [header];

	const objSingleLine = toSingleLine(state.objective);
	const objDisplay =
		objSingleLine.length > OBJECTIVE_DISPLAY_LIMIT
			? objSingleLine.slice(0, OBJECTIVE_TRUNCATE_KEEP) + "..."
			: objSingleLine;
	lines.push(th.fg("dim", `Objective: ${objDisplay}`));

	if (state.budget.tokenBudget && state.budget.tokenBudget > 0) {
		const pct = getTokenUsagePercent(state) / PERCENT_FACTOR;
		lines.push(`  Token: ${renderProgressBar(pct)} ${Math.round(pct * PERCENT_FACTOR)}%`);
	}
	if (state.budget.timeBudgetMinutes && state.budget.timeBudgetMinutes > 0) {
		const elapsed = getElapsedSeconds(state);
		const pct = getTimeUsagePercent(state, elapsed) / PERCENT_FACTOR;
		const mins = Math.floor(elapsed / SECONDS_PER_MINUTE);
		lines.push(`  Time: ${renderProgressBar(pct)} ${mins}/${state.budget.timeBudgetMinutes}min`);
	}

	return lines;
}

// ── updateWidget（FR-6.6 hasUI 守卫）──

/**
 * 从 UiPort 取出 ThemeLike。
 *
 * ports.ts 的 UiPort 故意不暴露 theme（保持抽象最小）。adapter 层在
 * 构造 UiPort 实现时，把 Pi 的 ctx.ui.theme 的 fg/bold 方法挂到对象上，
 * 使该实现同时满足 UiPort 与 ThemeLike 形状。projection 层通过此单步断言取出。
 */
function asTheme(uiPort: UiPort): ThemeLike {
	return uiPort as unknown as ThemeLike;
}

/**
 * 导出 asTheme：单一 theme 提取断言点（TS-1）。
 *
 * adapter 层（event-adapter handleTerminalStateBeforeAgent）复用本函数，
 * 避免重复 `ctx.ui.theme as unknown as ThemeLike` 断言。
 */
export { asTheme };

/**
 * 刷新 widget + status bar。
 *
 * FR-6.6：`uiPort.hasUI === false`（headless / RPC mode）时直接 return，
 * 不调 setWidget / setStatus，避免无 UI 环境崩溃或无意义写入。
 *
 * 终态折叠为单行 status bar；cancelled / 无 state 时清除 widget + status。
 */
export function updateWidget(session: GoalSession, uiPort: UiPort): void {
	if (!uiPort.hasUI) return;

	if (!session.state || session.state.status === "cancelled") {
		uiPort.setWidget("goal", undefined);
		uiPort.setStatus("goal", undefined);
		return;
	}

	// 终态折叠为单行 status bar
	if (isTerminalStatus(session.state.status)) {
		const statusText = renderTerminalStatusLine(session.state, asTheme(uiPort));
		if (statusText) {
			uiPort.setStatus("goal", statusText);
		}
		uiPort.setWidget("goal", undefined);
		return;
	}

	uiPort.setStatus("goal", renderStatusLine(session.state, asTheme(uiPort)));
	uiPort.setWidget("goal", renderWidgetLines(session.state, asTheme(uiPort)));
}
