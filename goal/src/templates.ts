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
import { SECONDS_PER_MINUTE, PERCENT_FACTOR } from "./constants";

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
	const stallLine = state.stallCount > 0 ? `\nStall: ${state.stallCount}/${state.budget.maxStallTurns}轮无进展` : "";

	// Task summary (only IDs, not full descriptions — descriptions in before_agent_start)
	const taskLine = total > 0
		? `Tasks: ${completedCount}/${total}${incomplete.length > 0 ? ` (剩余: ${incomplete.map(t => `#${t.id}`).join(",")})` : " ✓"}`
		: "Tasks: 未创建。请立即 create_tasks。";

	return (
		`<goal_context>\n` +
		`[GOAL] Turn ${state.turnCount}/${state.budget.maxTurns}${budgetLine}${stallLine}\n` +
		`<objective>${objective}</objective>\n` +
		`${taskLine}\n` +
		`Rules: create_tasks→update_tasks(evidence)→complete_goal(evidence). blocked→report_blocked(reason). sub-todo: add_sub_todos/update_sub_todos (替代 todo 工具).\n` +
		`Audit: 逐项验证每个需求有权威证据。不因预算耗尽标记完成，不因困难标记阻塞。\n` +
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
			? `未完成: ${incomplete.map((t) => `#${t.id}`).join(", ")}`
			: "所有任务已完成。";

	return (
		`<goal_context>\n` +
		`[GOAL — ${limitType === "token" ? "TOKEN 预算" : "时间预算"}即将耗尽]\n\n` +
		`<objective>\n${objective}\n</objective>\n\n` +
		`当前进度: ${completedCount}/${total} 任务完成\n` +
		`${incompleteSummary}\n` +
		(limitType === "token"
			? `Token 已使用: ${state.tokensUsed} / ${state.budget.tokenBudget ?? "未知"}\n`
			: `已用时间: ${Math.floor(elapsed / SECONDS_PER_MINUTE)}分${Math.floor(elapsed % SECONDS_PER_MINUTE)}秒 / ${state.budget.timeBudgetMinutes ?? "未知"}分钟\n`) +
		`\n你必须立即收尾:\n` +
		`1. 用 goal_manager 的 list_tasks 查看剩余任务\n` +
		`2. 只标记你真正完成且有证据的任务\n` +
		`3. 如果目标已达成，调用 goal_manager 的 complete_goal 完成目标\n` +
		`4. 总结当前进度和剩余工作\n` +
		`不要再开始新任务。不要因为预算耗尽就标记完成。\n` +
		`</goal_context>`
	);
}

// ── Objective Updated Prompt ──────────────────────────

export function objectiveUpdatedPrompt(state: GoalRuntimeState, oldObjective: string): string {
	const newObjective = escapeXmlText(state.objective);
	const escapedOld = escapeXmlText(oldObjective);

	return (
		`<goal_context>\n` +
		`[GOAL — 目标已更新]\n\n` +
		`旧目标: ${escapedOld}\n` +
		`<untrusted_objective>\n${newObjective}\n</untrusted_objective>\n\n` +
		`这个新目标取代了之前的所有目标上下文。你需要:\n` +
		`1. 立即停止朝旧目标方向的工作\n` +
		`2. 重新评估任务清单，必要时调用 goal_manager 的 create_tasks 重新拆分\n` +
		`3. 只在旧目标的工作也对新目标有帮助时才继续\n` +
		`4. 按照新目标继续工作\n` +
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
		`[GOAL 模式已激活]\n\n` +
		`<objective>\n${objective}\n</objective>\n` +
		`状态: ${state.status}\n` +
		`轮次: ${state.turnCount}/${state.budget.maxTurns}${budgetInfo}\n` +
		`任务进度: ${completedCount}/${total}\n\n` +
		`严格规则:\n` +
		`1. 第一步必须调用 goal_manager 的 create_tasks 拆分任务（如果尚未创建）\n` +
		`2. 每完成一个任务调用 update_tasks 将状态设为 completed，并提供 evidence\n` +
		`3. 只有提供具体证据时才能调用 complete_goal\n` +
		`4. 遇到阻塞调用 report_blocked\n` +
		`5. Goal 模式下不要使用 todo 工具，使用 add_sub_todos / update_sub_todos 追踪细粒度步骤\n` +
		`</goal_context>`
	);
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
		parts.push(`时间: ${pct}%`);
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
	if (tasks.length === 0) return "暂无任务。";
	const completed = tasks.filter(t => t.status === "completed");
	const active = tasks.filter(t => t.status === "in_progress" || t.status === "pending");
	const cancelled = tasks.filter(t => t.status === "cancelled");
	const lines: string[] = [];
	if (active.length > 0) {
		lines.push(`进行中/待执行 (${active.length}):`);
		for (const t of active) {
			const icon = t.status === "in_progress" ? "●" : "☐";
			lines.push(`  ${icon} #${t.id}: ${t.description}`);
			if (t.subTodos && t.subTodos.length > 0) {
				for (const s of t.subTodos) {
					const sIcon = s.status === "completed" ? "✓" : s.status === "in_progress" ? "●" : "○";
					lines.push(`    ${sIcon} #${t.id}.${s.id}: ${s.text}`);
				}
			}
		}
	}
	if (completed.length > 0) {
		lines.push(`已完成 (${completed.length}):`);
		for (const t of completed) {
			const evidence = t.evidence ? ` — ${t.evidence}` : "";
			lines.push(`  ✓ #${t.id}: ${t.description}${evidence}`);
		}
	}
	if (cancelled.length > 0) {
		lines.push(`已取消 (${cancelled.length}):`);
		for (const t of cancelled) lines.push(`  ✗ #${t.id}: ${t.description}`);
	}
	const summary = `${completed.length}/${tasks.length} 完成` + (cancelled.length > 0 ? `, ${cancelled.length} 已取消` : "");
	lines.push(summary);
	return lines.join("\n");
}
