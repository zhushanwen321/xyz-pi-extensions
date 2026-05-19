/**
 * Steering prompt 模板
 *
 * 参考 Codex /goal 的三套模板：
 * 1. continuation.md — 每个 continuation turn 开始时注入
 * 2. budget_limit.md — 首次达到 token budget 时注入
 * 3. objective_updated.md — 外部修改了 goal objective 时注入
 *
 * 所有模板接收 GoalRuntimeState 来生成上下文感知的 prompt。
 */

import type { GoalRuntimeState, GoalTask } from "./state";
import { getIncompleteTasks, getCompletedCount, getElapsedTimeSeconds, getTokenUsagePercent, getTimeUsagePercent } from "./state";

// ── Continuation Prompt ───────────────────────────────

export function continuationPrompt(state: GoalRuntimeState): string {
	const incomplete = getIncompleteTasks(state.tasks);
	const completedCount = getCompletedCount(state.tasks);
	const total = state.tasks.length;

	const taskSection =
		total > 0
			? [
					`任务进度: ${completedCount}/${total} 完成`,
					incomplete.length > 0
						? `未完成任务:\n${incomplete.map((t) => `  - #${t.id}: ${t.description}`).join("\n")}`
						: "所有任务已完成。",
				].join("\n")
			: "尚未创建任务清单。请先调用 goal_manager 的 create_tasks 拆分任务。";

	const stallWarning =
		state.stallCount > 0
			? `\n\n⚠ 警告：已连续 ${state.stallCount} 轮没有进展。你必须专注于推进任务，而不是重复之前的操作。如果遇到阻塞，使用 goal_manager 的 report_blocked 报告。`
			: "";

	const budgetInfo = formatBudgetInfo(state);
	const tokenPct = Math.round(getTokenUsagePercent(state));
	const timePct = Math.round(getTimeUsagePercent(state));

	return (
		`<goal_context>\n` +
		`[GOAL — 持续工作模式]\n\n` +
		`目标: ${state.objective}\n\n` +
		`${taskSection}\n\n` +
		`轮次: ${state.turnCount}/${state.budget.maxTurns}${budgetInfo}\n` +
		(tokenPct > 0 ? `Token 使用: ${tokenPct}%\n` : "") +
		(timePct > 0 ? `时间 使用: ${timePct}%\n` : "") +
		`${stallWarning}\n\n` +
		`你必须严格遵守以下规则:\n` +
		`1. 如果尚未创建任务清单，立即调用 goal_manager 的 create_tasks 将目标拆分为具体可验证的步骤\n` +
		`2. 每完成一个任务，必须调用 goal_manager 的 complete_task 标记，并提供 evidence（具体证据，如'运行测试 X 通过'）\n` +
		`3. 只有当你能提供具体证据证明目标已达成时，才能调用 goal_manager 的 complete_goal\n` +
		`4. 遇到无法解决的阻塞时，调用 goal_manager 的 report_blocked 报告原因\n` +
		`5. 不要重复之前的操作。如果某个方法不work，换一种方式\n` +
		`</goal_context>`
	);
}

// ── Budget Limit Prompt ───────────────────────────────

export function budgetLimitPrompt(state: GoalRuntimeState, limitType: "token" | "time"): string {
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
		`目标: ${state.objective}\n\n` +
		`当前进度: ${completedCount}/${total} 任务完成\n` +
		`${incompleteSummary}\n` +
		(limitType === "token"
			? `Token 已使用: ${state.tokensUsed} / ${state.budget.tokenBudget ?? "未知"}\n`
			: `已用时间: ${Math.floor(elapsed / 60)}分${Math.floor(elapsed % 60)}秒 / ${state.budget.timeBudgetMinutes ?? "未知"}分钟\n`) +
		`\n你必须立即收尾:\n` +
		`1. 用 goal_manager 的 list_tasks 查看剩余任务\n` +
		`2. 只标记你真正完成且有证据的任务\n` +
		`3. 如果目标已达成，调用 goal_manager 的 complete_goal 完成目标\n` +
		`4. 总结当前进度和剩余工作\n` +
		`不要再开始新任务。\n` +
		`</goal_context>`
	);
}

// ── Objective Updated Prompt ──────────────────────────

export function objectiveUpdatedPrompt(state: GoalRuntimeState, oldObjective: string): string {
	return (
		`<goal_context>\n` +
		`[GOAL — 目标已更新]\n\n` +
		`旧目标: ${oldObjective}\n` +
		`新目标: ${state.objective}\n\n` +
		`你需要:\n` +
		`1. 停止朝旧目标方向工作\n` +
		`2. 重新评估任务清单，必要时调用 goal_manager 的 create_tasks 重新拆分\n` +
		`3. 按照新目标继续工作\n` +
		`</goal_context>`
	);
}

// ── Context Injection Prompt (before_agent_start) ─────

export function contextInjectionPrompt(state: GoalRuntimeState): string {
	const completedCount = getCompletedCount(state.tasks);
	const total = state.tasks.length;
	const budgetInfo = formatBudgetInfo(state);

	return (
		`<goal_context>\n` +
		`[GOAL 模式已激活]\n\n` +
		`目标: ${state.objective}\n` +
		`状态: ${state.status}\n` +
		`轮次: ${state.turnCount}/${state.budget.maxTurns}${budgetInfo}\n` +
		`任务进度: ${completedCount}/${total}\n\n` +
		`严格规则:\n` +
		`1. 第一步必须调用 goal_manager 的 create_tasks 拆分任务（如果尚未创建）\n` +
		`2. 每完成一个任务调用 complete_task 并提供 evidence\n` +
		`3. 只有提供具体证据时才能调用 complete_goal\n` +
		`4. 遇到阻塞调用 report_blocked\n` +
		`</goal_context>`
	);
}

// ── Helpers ───────────────────────────────────────────

function formatBudgetInfo(state: GoalRuntimeState): string {
	const parts: string[] = [];
	if (state.budget.tokenBudget) {
		const pct = Math.round((state.tokensUsed / state.budget.tokenBudget) * 100);
		parts.push(`Token: ${pct}%`);
	}
	if (state.budget.timeBudgetMinutes) {
		const elapsed = getElapsedTimeSeconds(state);
		const pct = Math.round((elapsed / (state.budget.timeBudgetMinutes * 60)) * 100);
		parts.push(`时间: ${pct}%`);
	}
	return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

export function formatTaskList(tasks: GoalTask[]): string {
	if (tasks.length === 0) return "暂无任务。";
	const completed = tasks.filter((t) => t.completed);
	const incomplete = tasks.filter((t) => !t.completed);
	const lines: string[] = [];
	if (incomplete.length > 0) {
		lines.push(`未完成 (${incomplete.length}):`);
		for (const t of incomplete) lines.push(`  ☐ #${t.id}: ${t.description}`);
	}
	if (completed.length > 0) {
		lines.push(`已完成 (${completed.length}):`);
		for (const t of completed) {
			const evidence = t.evidence ? ` — ${t.evidence}` : "";
			lines.push(`  ✓ #${t.id}: ${t.description}${evidence}`);
		}
	}
	return lines.join("\n");
}
