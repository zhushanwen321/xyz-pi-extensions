/**
 * Widget 渲染逻辑 — 状态栏和侧边栏任务面板
 */

import type { ThemeColor } from "@mariozechner/pi-coding-agent";

import { getBudgetColor,getTimeUsagePercent, getTokenUsagePercent } from "./budget.js";
import {
	ELLIPSIS_LENGTH,
	OBJECTIVE_DISPLAY_LIMIT,
	OBJECTIVE_TRUNCATE_KEEP,
	PERCENT_FACTOR,
	PROGRESS_BAR_DEFAULT_WIDTH,
	SECONDS_PER_MINUTE,
	VERIFY_METHOD_WIDGET_LEN,
} from "./constants";
import type { GoalRuntimeState, GoalTask } from "./state";
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

function truncateText(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen - ELLIPSIS_LENGTH) + "...";
}

export function renderStatusLine(state: GoalRuntimeState, th: ThemeLike): string {
	if (state.status === "cancelled") return "";

	const verifiedCount = state.tasks.filter(t => t.status === "verified").length;
	const completedCount = state.tasks.filter(t => t.status === "completed").length;
	const total = state.tasks.length;
	const doneCount = verifiedCount + completedCount;

	let text = th.fg("accent", `◆ Goal`) + th.fg("muted", ` ${state.currentTurnIndex}/${state.budget.maxTurns}`);

	if (total > 0) {
		text += th.fg("muted", ` | ${doneCount}/${total} tasks`);
		if (completedCount > 0) {
			const pendingVerify = state.tasks.filter(t => t.status === "completed" && t.verification).length;
			if (pendingVerify > 0) {
				text += th.fg("warning", `, ${pendingVerify} pending verify`);
			} else if (verifiedCount > 0) {
				text += th.fg("success", `, ${verifiedCount} verified`);
			}
		}
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
	const header = renderStatusLine(state, th);
	const lines: string[] = [header];

	const objSingleLine = toSingleLine(state.objective);
	const objDisplay = objSingleLine.length > OBJECTIVE_DISPLAY_LIMIT
		? objSingleLine.slice(0, OBJECTIVE_TRUNCATE_KEEP) + "..."
		: objSingleLine;
	lines.push(th.fg("dim", `Objective: ${objDisplay}`));

	if (total === 0) {
		lines.push(th.fg("dim", "  Waiting for task list creation..."));
	} else {
		for (const t of state.tasks) {
			lines.push(...renderTaskRow(t, th));
		}
	}

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

// ── Task Row Rendering (extracted from renderWidgetLines) ──

/** 渲染单个 task 行（含 verified 状态图标、验证标签、subtask 展开）。 */
function renderTaskRow(t: GoalTask, th: ThemeLike): string[] {
	const lines: string[] = [];
	const desc = toSingleLine(t.description);
	const verifyTag = t.verification
		? th.fg("dim", ` [验证: ${truncateText(t.verification.method, VERIFY_METHOD_WIDGET_LEN)}]`)
		: "";

	if (t.status === "verified") {
		const actualInfo = t.verification?.actual ? th.fg("dim", ` actual: ${truncateText(t.verification.actual, VERIFY_METHOD_WIDGET_LEN)}`) : "";
		lines.push(`  ${th.fg("success", "◉")} ${th.fg("dim", `#${t.id}`)} ${th.fg("dim", desc)}${actualInfo}`);
	} else if (t.status === "completed") {
		const note = t.verification ? th.fg("warning", " [待验证]") : "";
		lines.push(`  ${th.fg("success", "✓")} ${th.fg("dim", `#${t.id}`)} ${th.fg("dim", desc)}${note}`);
	} else if (t.status === "cancelled") {
		lines.push(`  ${th.fg("dim", "✗")} ${th.fg("dim", `#${t.id}`)} ${th.fg("dim", desc)}`);
	} else if (t.status === "in_progress") {
		lines.push(`  ${th.fg("warning", "●")} ${th.fg("accent", `#${t.id}`)} ${th.fg("text", desc)}${verifyTag}`);
	} else {
		lines.push(`  ${th.fg("dim", "☐")} ${th.fg("accent", `#${t.id}`)} ${th.fg("text", desc)}${verifyTag}`);
	}

	if (t.subtasks && t.subtasks.length > 0 && t.status !== "cancelled") {
		lines.push(...renderSubtaskLines(t, th));
	}
	return lines;
}

/** 渲染 subtask 行，全部 completed 时折叠不显示。 */
function renderSubtaskLines(t: GoalTask, th: ThemeLike): string[] {
	if (!t.subtasks || t.subtasks.length === 0) return [];
	const allSubCompleted = t.subtasks.every((s) => s.status === "completed");
	if (allSubCompleted) return [];
	const lines: string[] = [];
	for (const s of t.subtasks) {
		const subIcon = s.status === "completed"
			? th.fg("success", "✓")
			: s.status === "in_progress"
				? th.fg("warning", "●")
				: th.fg("dim", "○");
		const subText = s.status === "completed" ? th.fg("dim", s.text) : th.fg("muted", s.text);
		lines.push(`    ${subIcon} ${th.fg("dim", `${t.id}.${s.id}`)} ${subText}`);
	}
	return lines;
}
