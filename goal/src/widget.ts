/**
 * Widget 渲染逻辑 — 状态栏和侧边栏任务面板
 */

import type { GoalRuntimeState } from "./state";
import { getCompletedCount, getIncompleteTasks, getElapsedTimeSeconds, getTokenUsagePercent, getTimeUsagePercent } from "./state";

export interface ThemeLike {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

export function renderStatusLine(state: GoalRuntimeState, th: ThemeLike): string {
	if (state.status === "cancelled") return "";

	const completedCount = getCompletedCount(state.tasks);
	const total = state.tasks.length;

	let text = th.fg("accent", `◆ Goal`) + th.fg("muted", ` ${state.turnCount}/${state.budget.maxTurns}`);

	if (total > 0) {
		text += th.fg("muted", ` | ${completedCount}/${total} 任务`);
	}

	// Budget indicators — 使用 state.ts 的安全函数避免 division by zero
	if (state.budget.tokenBudget && state.budget.tokenBudget > 0) {
		const pct = Math.round(getTokenUsagePercent(state));
		const color = pct >= 90 ? "error" : pct >= 70 ? "warning" : "muted";
		text += th.fg(color, ` | ${pct}% tokens`);
	}
	if (state.budget.timeBudgetMinutes && state.budget.timeBudgetMinutes > 0) {
		const pct = Math.round(getTimeUsagePercent(state));
		const color = pct >= 90 ? "error" : pct >= 70 ? "warning" : "muted";
		text += th.fg(color, ` | ${pct}% time`);
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

	const completedCount = getCompletedCount(state.tasks);
	const total = state.tasks.length;
	const incomplete = getIncompleteTasks(state.tasks);

	// Header line
	const header = renderStatusLine(state, th);
	const lines: string[] = [header];

	// Objective (truncated if too long)
	const objDisplay = state.objective.length > 80 ? state.objective.slice(0, 77) + "..." : state.objective;
	lines.push(th.fg("dim", `目标: ${objDisplay}`));

	// Task list
	if (total === 0) {
		lines.push(th.fg("dim", "  等待创建任务清单..."));
	} else {
		for (const t of state.tasks) {
			if (t.completed) {
				lines.push(`  ${th.fg("success", "✓")} ${th.fg("dim", `#${t.id}`)} ${th.fg("dim", t.description)}`);
			} else {
				lines.push(`  ${th.fg("dim", "☐")} ${th.fg("accent", `#${t.id}`)} ${th.fg("text", t.description)}`);
			}
		}
	}

	return lines;
}
