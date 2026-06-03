/**
 * Steering prompt 模板
 *
 * 参考 Codex /goal 的三套模板：
 * 1. continuation.md — 每个 continuation turn 开始时注入
 * 2. budget_limit.md — 首次达到 token budget 时注入
 * 3. objective_updated.md — 外部修改了 goal objective 时注入
 *
 * 所有模板中的 objective 文本都经过 XML 转义，防止 prompt 注入。
 */

import type { GoalRuntimeState, GoalTask } from "./state";
import { getIncompleteTasks, getCompletedCount, getElapsedTimeSeconds } from "./state";
import { SECONDS_PER_MINUTE, PERCENT_FACTOR, TASK_STALL_TURN_THRESHOLD } from "./constants";

// ── XML 转义（防止 objective 中的 XML 标签破坏 prompt 结构）──

function escapeXmlText(input: string): string {
	return input
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

// ── Continuation Prompt ───────────────────────────────
// 精简版，对标 Codex ~500 chars。详细信息在 before_agent_start 注入。

export function continuationPrompt(state: GoalRuntimeState): string {
	const objective = escapeXmlText(state.objective);
	const incomplete = getIncompleteTasks(state.tasks);
	const completedCount = getCompletedCount(state.tasks);
	const total = state.tasks.length;

	// Budget info (single line, Codex style)
	const budgetLine = formatBudgetLine(state);
	const stallLine = state.stallCount > 0 ? `\nStall: ${state.stallCount}/${state.budget.maxStallTurns} turns stalled` : "";

	// Task summary (only IDs, not full descriptions — descriptions in before_agent_start)
	const taskLine = total > 0
		? `Tasks: ${completedCount}/${total}${incomplete.length > 0 ? ` (remaining: ${incomplete.map(t => `#${t.id}`).join(",")})` : " ✓"}`
		: "Tasks: Not created. Call create_tasks immediately.";

	return (
		`<goal_context>\n` +
		`[GOAL] Turn ${state.turnCount}/${state.budget.maxTurns}${budgetLine}${stallLine}\n` +
		`<objective>${objective}</objective>\n` +
		`${taskLine}\n` +
		`Rules: create_tasks→update_tasks(evidence)→complete_goal(evidence). blocked→report_blocked(reason). subtask: add_subtasks/update_subtasks (replaces todo tool).\n` +
		`Audit: Verify each requirement has authoritative evidence. Do not mark completed due to budget exhaustion, do not mark blocked due to difficulty.\n` +
		`</goal_context>`
	);
}

// ── Budget Limit Prompt ───────────────────────────────

export function budgetLimitPrompt(state: GoalRuntimeState, limitType: "token" | "time"): string {
	const objective = escapeXmlText(state.objective);
	const completedCount = getCompletedCount(state.tasks);
	const total = state.tasks.length;
	const elapsed = getElapsedTimeSeconds(state);

	const incomplete = getIncompleteTasks(state.tasks);
	const incompleteSummary =
		incomplete.length > 0
			? `Incomplete: ${incomplete.map((t) => `#${t.id}`).join(", ")}`
			: "All tasks completed.";

	return (
		`<goal_context>\n` +
		`[GOAL — ${limitType === "token" ? "TOKEN budget" : "time budget"} almost exhausted]\n\n` +
		`<objective>\n${objective}\n</objective>\n\n` +
		`Current progress: ${completedCount}/${total} tasks completed\n` +
		`${incompleteSummary}\n` +
		(limitType === "token"
			? `Tokens used: ${state.tokensUsed} / ${state.budget.tokenBudget ?? "unknown"}\n`
			: `Time elapsed: ${Math.floor(elapsed / SECONDS_PER_MINUTE)}m${Math.floor(elapsed % SECONDS_PER_MINUTE)}s / ${state.budget.timeBudgetMinutes ?? "unknown"} min\n`) +
		`\nYou must wrap up immediately:\n` +
		`1. Use goal_manager's list_tasks to check remaining tasks\n` +
		`2. Only mark tasks you have genuinely completed with evidence\n` +
		`3. If the objective is met, call goal_manager's complete_goal\n` +
		`4. Summarize current progress and remaining work\n` +
		`Do not start new tasks. Do not mark completed due to budget exhaustion.\n` +
		`</goal_context>`
	);
}

// ── Objective Updated Prompt ──────────────────────────

export function objectiveUpdatedPrompt(state: GoalRuntimeState, oldObjective: string): string {
	const newObjective = escapeXmlText(state.objective);
	const escapedOld = escapeXmlText(oldObjective);

	return (
		`<goal_context>\n` +
		`[GOAL — Objective updated]\n\n` +
		`Previous objective: ${escapedOld}\n` +
		`<untrusted_objective>\n${newObjective}\n</untrusted_objective>\n\n` +
		`This new objective supersedes all prior objective context. You must:\n` +
		`1. Immediately stop working toward the old objective\n` +
		`2. Re-evaluate the task list — call goal_manager's create_tasks to re-decompose if needed\n` +
		`3. Only continue old work if it also serves the new objective\n` +
		`4. Proceed with the new objective\n` +
		`</goal_context>`
	);
}

// ── Context Injection Prompt (before_agent_start) ─────

export function contextInjectionPrompt(state: GoalRuntimeState): string {
	const objective = escapeXmlText(state.objective);
	const completedCount = getCompletedCount(state.tasks);
	const total = state.tasks.length;
	const budgetInfo = formatBudgetInfo(state);

	return (
		`<goal_context>\n` +
		`[GOAL mode activated]\n\n` +
		`<objective>\n${objective}\n</objective>\n` +
		`Status: ${state.status}\n` +
		`Turn: ${state.turnCount}/${state.budget.maxTurns}${budgetInfo}\n` +
		`Task progress: ${completedCount}/${total}\n\n` +
		`Strict rules:\n` +
		`1. First step: call goal_manager's create_tasks to decompose tasks (if not yet created)\n` +
		`2. After completing a task, call update_tasks with status=completed and provide evidence\n` +
		`3. Only call complete_goal with concrete evidence\n` +
		`4. If blocked, call report_blocked\n` +
		`5. In Goal mode, do not use the todo tool — use add_subtasks / update_subtasks for fine-grained tracking\n` +
		`</goal_context>`
	);
}

// ── Staleness Reminder Prompt ────────────────────────

export function stalenessReminderPrompt(
	state: GoalRuntimeState,
	staleTasks: Array<{
		task: GoalTask;
		staleTurns: number;
		staleSubtasks: Array<{ text: string; staleTurns: number }>;
	}>,
	allTerminal: boolean,
): string {
	const objective = escapeXmlText(state.objective);
	const lines: string[] = [];

	lines.push("<goal_context>");
	lines.push("[GOAL reminder — tasks stalled]\n");

	if (allTerminal) {
		lines.push("All tasks completed but goal_manager is still open. Call complete_goal or cancel_goal.");
	} else {
		lines.push(`The following tasks have exceeded ${TASK_STALL_TURN_THRESHOLD} turns without update:\n`);
		for (const item of staleTasks) {
			lines.push(`  #${item.task.id}: ${item.task.description} (${item.staleTurns} turns idle)`);
			for (const s of item.staleSubtasks) {
				lines.push(`    - ${s.text} (${s.staleTurns} turns)`);
			}
		}
		lines.push("\nCheck these tasks — call update_tasks to report progress or cancel tasks that are no longer needed.");
	}

	lines.push(`\nObjective: ${objective}`);
	lines.push(`Turn: ${state.turnCount}/${state.budget.maxTurns}`);
	lines.push("</goal_context>");

	return lines.join("\n");
}

// ── Helpers ───────────────────────────────────────────

function formatBudgetInfo(state: GoalRuntimeState): string {
	const parts: string[] = [];
	if (state.budget.tokenBudget) {
		const pct = Math.round((state.tokensUsed / state.budget.tokenBudget) * PERCENT_FACTOR);
		parts.push(`Token: ${pct}%`);
	}
	if (state.budget.timeBudgetMinutes) {
		const elapsed = getElapsedTimeSeconds(state);
		const pct = Math.round((elapsed / (state.budget.timeBudgetMinutes * SECONDS_PER_MINUTE)) * PERCENT_FACTOR);
		parts.push(`Time: ${pct}%`);
	}
	return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function formatBudgetLine(state: GoalRuntimeState): string {
	const parts: string[] = [];
	if (state.budget.tokenBudget) {
		const remaining = Math.max(state.budget.tokenBudget - state.tokensUsed, 0);
		parts.push(`Tokens: ${remaining}/${state.budget.tokenBudget}`);
	}
	if (state.budget.timeBudgetMinutes) {
		const elapsed = getElapsedTimeSeconds(state);
		const remaining = Math.max(state.budget.timeBudgetMinutes * SECONDS_PER_MINUTE - elapsed, 0);
		parts.push(`Time: ${Math.floor(remaining / SECONDS_PER_MINUTE)}m/${state.budget.timeBudgetMinutes}m`);
	}
	return parts.length > 0 ? ` | ${parts.join(" ")}` : "";
}

export function formatTaskList(tasks: GoalTask[]): string {
	if (tasks.length === 0) return "No tasks yet.";
	const completed = tasks.filter(t => t.status === "completed");
	const active = tasks.filter(t => t.status === "in_progress" || t.status === "pending");
	const cancelled = tasks.filter(t => t.status === "cancelled");
	const lines: string[] = [];
	if (active.length > 0) {
		lines.push(`In progress / Pending (${active.length}):`);
		for (const t of active) {
			const icon = t.status === "in_progress" ? "●" : "☐";
			lines.push(`  ${icon} #${t.id}: ${t.description}`);
			if (t.subtasks && t.subtasks.length > 0) {
				for (const s of t.subtasks) {
					const sIcon = s.status === "completed" ? "✓" : s.status === "in_progress" ? "●" : "○";
					lines.push(`    ${sIcon} #${t.id}.${s.id}: ${s.text}`);
				}
			}
		}
	}
	if (completed.length > 0) {
		lines.push(`Completed (${completed.length}):`);
		for (const t of completed) {
			const evidence = t.evidence ? ` — ${t.evidence}` : "";
			lines.push(`  ✓ #${t.id}: ${t.description}${evidence}`);
		}
	}
	if (cancelled.length > 0) {
		lines.push(`Cancelled (${cancelled.length}):`);
		for (const t of cancelled) lines.push(`  ✗ #${t.id}: ${t.description}`);
	}
	const summary = `${completed.length}/${tasks.length} completed` + (cancelled.length > 0 ? `, ${cancelled.length} cancelled` : "");
	lines.push(summary);
	return lines.join("\n");
}
