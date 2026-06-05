/**
 * Widget 渲染逻辑 — 状态栏和侧边栏任务面板
 */

import type { ThemeColor } from "@mariozechner/pi-coding-agent";

import { getBudgetColor,getTimeUsagePercent, getTokenUsagePercent } from "./budget.js";
import {
	OBJECTIVE_DISPLAY_LIMIT,
	OBJECTIVE_TRUNCATE_KEEP,
	PERCENT_FACTOR,
	PROGRESS_BAR_DEFAULT_WIDTH,
	SECONDS_PER_MINUTE,
} from "./constants";
import type { GoalRuntimeState } from "./state";
import { getCompletedCount, getElapsedTimeSeconds } from "./state";

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

	let text = th.fg("accent", `◆ Goal`) + th.fg("muted", ` ${state.currentTurnIndex}/${state.budget.maxTurns}`);

	if (total > 0) {
		text += th.fg("muted", ` | ${completedCount}/${total} tasks`);
		const cancelledCount = state.tasks.filter(t => t.status === "cancelled").length;
		if (cancelledCount > 0) {
			text += th.fg("dim", `, ${cancelledCount} cancelled`);
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
		text += th.fg("warning", ` | ⚠ ${state.stallCount} turns stalled`);
	}

	// Status suffix
	switch (state.status) {
		case "paused":
			text += th.fg("warning", " | ⏸ Paused");
			break;
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

	const completedCount = getCompletedCount(state.tasks);
	const total = state.tasks.length;

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

	text += th.fg("muted", ` | ${completedCount}/${total} tasks`);

	// 预算摘要
	if (state.budget.tokenBudget && state.budget.tokenBudget > 0) {
		const pct = Math.round(getTokenUsagePercent(state));
		text += th.fg(getBudgetColor(pct), ` | ${pct}% tokens`);
	}
	if (state.budget.timeBudgetMinutes && state.budget.timeBudgetMinutes > 0) {
		const pct = Math.round(getTimeUsagePercent(state));
		text += th.fg(getBudgetColor(pct), ` | ${pct}% time`);
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
	lines.push(th.fg("dim", `Objective: ${objDisplay}`));

	// Task list
	if (total === 0) {
		lines.push(th.fg("dim", "  Waiting for task list creation..."));
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
			if (t.subtasks && t.subtasks.length > 0 && t.status !== "cancelled") {
				for (const s of t.subtasks) {
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
		lines.push(`  Time: ${renderProgressBar(pct)} ${mins}/${state.budget.timeBudgetMinutes}min`);
	}

	return lines;
}
