/**
 * Widget 渲染逻辑 — 状态栏和侧边栏任务面板
 */

import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import type { GoalRuntimeState } from "./state";
import { getCompletedCount, getElapsedTimeSeconds } from "./state";
import { getTokenUsagePercent, getTimeUsagePercent, getBudgetColor } from "./budget.js";
import {
	SECONDS_PER_MINUTE,
	PERCENT_FACTOR,
	PROGRESS_BAR_DEFAULT_WIDTH,
	OBJECTIVE_DISPLAY_LIMIT,
	OBJECTIVE_TRUNCATE_KEEP,
} from "./constants";

/**
 * 将多行文本压缩为单行，用于 widget 渲染。
 * 多行 content 泄漏到 widget 会导致 markdown 表格/标题等破坏布局。
 */
export function toSingleLine(text: string): string {
	return text.replace(/\r?\n/g, " ").trim();
}

export interface ThemeLike {
	fg: (color: ThemeColor, text: string) => string;
	bold: (text: string) => string;
}

function renderProgressBar(pct: number, width: number = PROGRESS_BAR_DEFAULT_WIDTH): string {
	const clamped = Math.min(Math.max(pct, 0), 1);
	const filled = Math.round(clamped * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

export function renderStatusLine(state: GoalRuntimeState, th: ThemeLike): string {
	if (state.status === "cancelled") return "";

	const completedCount = getCompletedCount(state.tasks);
	const total = state.tasks.length;

	let text = th.fg("accent", `◆ Goal`) + th.fg("muted", ` ${state.turnCount}/${state.budget.maxTurns}`);

	if (total > 0) {
		text += th.fg("muted", ` | ${completedCount}/${total} 任务`);
		const cancelledCount = state.tasks.filter(t => t.status === "cancelled").length;
		if (cancelledCount > 0) {
			text += th.fg("dim", `, ${cancelledCount} 取消`);
		}
	}

	// Budget indicators
	if (state.budget.tokenBudget && state.budget.tokenBudget > 0) {
		const pct = Math.round(getTokenUsagePercent(state));
		text += th.fg(getBudgetColor(pct), ` | ${pct}% tokens`);
	}
	if (state.budget.timeBudgetMinutes && state.budget.timeBudgetMinutes > 0) {
		const pct = Math.round(getTimeUsagePercent(state));
		text += th.fg(getBudgetColor(pct), ` | ${pct}% time`);
	}

	if (state.stallCount > 0) {
		text += th.fg("warning", ` | ⚠ ${state.stallCount}轮无进展`);
	}

	// Status suffix
	switch (state.status) {
		case "paused":
			text += th.fg("warning", " | ⏸ 暂停");
			break;
		case "blocked":
			text += th.fg("error", " | ⊘ 阻塞");
			break;
		case "complete":
			text += th.fg("success", " | ✓ 完成");
			break;
		case "budget_limited":
			text += th.fg("error", " | ⊗ Token 预算耗尽");
			break;
		case "time_limited":
			text += th.fg("error", " | ⏱ 时间预算耗尽");
			break;
	}

	return text;
}

export function renderWidgetLines(state: GoalRuntimeState, th: ThemeLike): string[] {
	if (state.status === "cancelled") return [];

	const total = state.tasks.length;

	// Header line
	const header = renderStatusLine(state, th);
	const lines: string[] = [header];

	// Objective (single-line + truncated if too long)
	const objSingleLine = toSingleLine(state.objective);
	const objDisplay = objSingleLine.length > OBJECTIVE_DISPLAY_LIMIT
		? objSingleLine.slice(0, OBJECTIVE_TRUNCATE_KEEP) + "..."
		: objSingleLine;
	lines.push(th.fg("dim", `目标: ${objDisplay}`));

	// Task list
	if (total === 0) {
		lines.push(th.fg("dim", "  等待创建任务清单..."));
	} else {
		for (const t of state.tasks) {
			const desc = toSingleLine(t.description);
			if (t.status === "completed") {
				lines.push(`  ${th.fg("success", "✓")} ${th.fg("dim", `#${t.id}`)} ${th.fg("dim", desc)}`);
			} else if (t.status === "cancelled") {
				lines.push(`  ${th.fg("dim", "✗")} ${th.fg("dim", `#${t.id}`)} ${th.fg("dim", desc)}`);
			} else if (t.status === "in_progress") {
				lines.push(`  ${th.fg("warning", "●")} ${th.fg("accent", `#${t.id}`)} ${th.fg("text", desc)}`);
			} else {
				lines.push(`  ${th.fg("dim", "☐")} ${th.fg("accent", `#${t.id}`)} ${th.fg("text", desc)}`);
			}
			// Sub-todo items
			if (t.subTodos && t.subTodos.length > 0 && t.status !== "cancelled") {
				for (const s of t.subTodos) {
					const subIcon = s.status === "completed"
						? th.fg("success", "✓")
						: s.status === "in_progress"
							? th.fg("warning", "●")
							: th.fg("dim", "○");
					const subText = s.status === "completed" ? th.fg("dim", s.text) : th.fg("muted", s.text);
					lines.push(`    ${subIcon} ${th.fg("dim", `${t.id}.${s.id}`)} ${subText}`);
				}
			}
		}
	}

	// P2-8: Budget progress bars
	if (state.budget.tokenBudget && state.budget.tokenBudget > 0) {
		const pct = getTokenUsagePercent(state) / PERCENT_FACTOR;
		lines.push(`  Token: ${renderProgressBar(pct)} ${Math.round(pct * PERCENT_FACTOR)}%`);
	}
	if (state.budget.timeBudgetMinutes && state.budget.timeBudgetMinutes > 0) {
		const pct = getTimeUsagePercent(state) / PERCENT_FACTOR;
		const elapsed = getElapsedTimeSeconds(state);
		const mins = Math.floor(elapsed / SECONDS_PER_MINUTE);
		lines.push(`  时间: ${renderProgressBar(pct)} ${mins}/${state.budget.timeBudgetMinutes}分钟`);
	}

	return lines;
}
