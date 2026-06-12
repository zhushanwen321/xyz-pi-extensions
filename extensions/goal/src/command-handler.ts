/**
 * /goal 命令处理子函数
 *
 * handleGoalCommand (orchestrator, ≤20 行) 委托到 7 个子函数：
 *   handleStatus, handlePause, handleResume, handleHistory, handleClear, handleUpdate, handleSet
 *
 * P1-5/6 修复：将 233 行的大函数拆分为 ≤20 行子函数。
 */

import type { CustomEntry,ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { checkBudgetOnResume } from "./budget.js";
import { parseGoalArgs } from "./commands";
import {
	OBJECTIVE_DISPLAY_LIMIT,
	OBJECTIVE_TRUNCATE_KEEP,
	SECONDS_PER_MINUTE,
} from "./constants";
import {
	type BudgetConfig,
	createInitialState,
	DEFAULT_BUDGET,
	getCompletedCount,
	getElapsedTimeSeconds,
	getIncompleteTasks,
	isActiveStatus,
	isTerminalStatus,
	transitionStatus,
} from "./state";
import { objectiveUpdatedPrompt } from "./templates";
import {
	clearGoalSession,
	type GoalSession,
	persistAndUpdate,
	persistGoalState,
	writeGoalHistoryEntry,
} from "./tool-handler";

// ── Orchestrator ──────────────────────────────────────

export async function handleGoalCommand(
	pi: ExtensionAPI,
	session: GoalSession,
	args: string | undefined,
	ctx: ExtensionContext,
): Promise<void> {
	const parsed = parseGoalArgs(args ?? "");
	switch (parsed.action) {
		case "status": return handleStatus(session, ctx);
		case "pause": return handlePause(pi, session, ctx);
		case "resume": return handleResume(pi, session, ctx);
		case "history": return handleHistory(ctx);
		case "clear": return handleClear(pi, session, ctx);
		case "abort": return handleAbort(pi, session, ctx);
		case "update": return handleUpdate(pi, session, parsed.objective, ctx);
		case "set": return handleSet(pi, session, parsed.objective ?? "", parsed.budget, ctx);
	}
}

// ── /goal status ──────────────────────────────────────

function handleStatus(session: GoalSession, ctx: ExtensionContext): void {
	if (!session.state) {
		ctx.ui.notify("Goal mode not active. Use /goal <objective> to start.", "info");
		return;
	}
	const state = session.state;
	const completed = getCompletedCount(state.tasks);
	const total = state.tasks.length;
	const elapsed = getElapsedTimeSeconds(state);
	const lines = [
		`Objective: ${state.objective}`,
		`Status: ${state.status}`,
		`Turn: ${state.currentTurnIndex}/${state.budget.maxTurns}`,
		`Tasks: ${completed}/${total} completed`,
		`Stall turns: ${state.stallCount}`,
		`Time elapsed: ${Math.floor(elapsed / SECONDS_PER_MINUTE)}m${Math.floor(elapsed % SECONDS_PER_MINUTE)}s`,
		state.budget.tokenBudget ? `Token: ${state.tokensUsed}/${state.budget.tokenBudget}` : null,
		`Goal ID: ${state.goalId}`,
	].filter(Boolean);
	ctx.ui.notify(lines.join("\n"), "info");
}

// ── /goal pause ───────────────────────────────────────

function handlePause(pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext): void {
	if (!session.state) { ctx.ui.notify("Goal mode not active.", "warning"); return; }
	if (isTerminalStatus(session.state.status)) {
		ctx.ui.notify(`Goal is in terminal state (${session.state.status}), cannot pause.`, "warning");
		return;
	}
	session.state.status = transitionStatus(session.state.status, "paused");
	persistAndUpdate(pi, session, ctx);
	ctx.ui.notify("Goal paused. Use /goal resume to continue.", "info");
}

// ── /goal resume ──────────────────────────────────────

function handleResume(pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext): void {
	if (!session.state) { ctx.ui.notify("Goal mode not active.", "warning"); return; }
	const state = session.state;
	if (isTerminalStatus(state.status)) {
		ctx.ui.notify(`Goal is in terminal state (${state.status}), cannot resume.`, "warning");
		return;
	}
	if (state.status !== "paused" && state.status !== "blocked") {
		ctx.ui.notify("Goal is not paused or blocked, no need to resume.", "info");
		return;
	}
	state.status = "active";
	state.stallCount = 0;
	state.timeStartedAt = Date.now();

	// Resume 时重检预算
	const resumeBudgetCheck = checkBudgetOnResume(state);
	if (resumeBudgetCheck) {
		const dim = resumeBudgetCheck.dimension;
		state.status = transitionStatus(state.status, dim === "token" ? "budget_limited" : "time_limited");
		persistAndUpdate(pi, session, ctx);
		ctx.ui.notify(`${dim === "token" ? "Token" : "Time"} budget exhausted, cannot resume. Use /goal clear to reset.`, "warning");
		return;
	}
	persistAndUpdate(pi, session, ctx);

	const incomplete = getIncompleteTasks(state.tasks);
	if (incomplete.length > 0) {
		pi.sendUserMessage(
			`Goal resumed. Continuing with ${incomplete.length} remaining tasks.` +
			(state.lastBlockerReason ? `\n\nPrevious blocker: ${state.lastBlockerReason}. Try a different approach.` : "") +
			`\n\nObjective: ${state.objective}`,
			{ deliverAs: "followUp" },
		);
	} else {
		ctx.ui.notify("All tasks completed.", "info");
	}
}

// ── /goal history ─────────────────────────────────────

function handleHistory(ctx: ExtensionContext): void {
	const entries = ctx.sessionManager.getEntries();
	const historyEntries = entries.filter(
		(e) => e.type === "custom" && (e as CustomEntry).customType === "goal-history",
	) as Array<CustomEntry<{
		goalId: string;
		objective: string;
		status: string;
		completedTasks: number;
		totalTasks: number;
		elapsedSeconds: number;
		timestamp: number;
	}>>;

	if (historyEntries.length === 0) {
		ctx.ui.notify("No goal history", "info");
		return;
	}

	const sorted = [...historyEntries].reverse();
	const lines: string[] = ["Goal history:\n"];
	for (let i = 0; i < sorted.length; i++) {
		const h = sorted[i]!.data;
		if (!h) continue;
		const statusIcon =
			h.status === "complete" ? "✓" :
			h.status === "cancelled" ? "✗" :
			h.status === "budget_limited" ? "⊗" :
			h.status === "time_limited" ? "⏱" : "?";
		const objDisplay = h.objective.length > OBJECTIVE_DISPLAY_LIMIT
			? h.objective.slice(0, OBJECTIVE_TRUNCATE_KEEP) + "..."
			: h.objective;
		const mins = Math.floor(h.elapsedSeconds / SECONDS_PER_MINUTE);
		const secs = Math.floor(h.elapsedSeconds % SECONDS_PER_MINUTE);
		lines.push(`${i + 1}. ${statusIcon} ${objDisplay}`);
		lines.push(`   ${h.completedTasks}/${h.totalTasks} tasks | ${mins}m${secs}s | ${h.status}`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

// ── /goal clear ───────────────────────────────────────

function handleClear(pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext): void {
	if (!session.state) { ctx.ui.notify("Goal mode not active.", "info"); return; }
	session.state.status = "cancelled";
	session.state.completedAtTurnIndex = session.state.currentTurnIndex;
	writeGoalHistoryEntry(pi, session);
	persistGoalState(pi, session, ctx);
	clearGoalSession(session, ctx);
	ctx.ui.notify("Goal cleared.", "info");
}

// ── /goal abort ──────────────────────────────────────

function handleAbort(pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext): void {
	if (!session.state) { ctx.ui.notify("Goal mode not active.", "info"); return; }
	if (isTerminalStatus(session.state.status)) {
		ctx.ui.notify(`Goal is already in terminal state (${session.state.status}).`, "warning");
		return;
	}
	if (session.state.tasks.length > 0) {
		ctx.ui.notify(`Cannot abort: ${session.state.tasks.length} tasks already created. Use /goal clear to force cancel.`, "warning");
		return;
	}
	session.state.status = "cancelled";
	session.state.completedAtTurnIndex = session.state.currentTurnIndex;
	writeGoalHistoryEntry(pi, session);
	persistGoalState(pi, session, ctx);
	clearGoalSession(session, ctx);
	ctx.ui.notify("Goal aborted: no work needed.", "info");
}

// ── /goal update ──────────────────────────────────────

function handleUpdate(
	pi: ExtensionAPI, session: GoalSession,
	newObjective: string | undefined, ctx: ExtensionContext,
): void {
	if (!session.state) { ctx.ui.notify("Goal mode not active.", "warning"); return; }
	if (!newObjective) {
		ctx.ui.notify("Usage: /goal update <new-objective>", "warning");
		return;
	}
	const state = session.state;
	const oldObjective = state.objective;
	state.objective = newObjective;
	state.objectiveUpdatedAt = Date.now();
	state.tasks = [];
	state.stallCount = 0;
	state.currentTurnIndex = 0;
	state.lastProgressTurn = 0;
	state.budgetLimitSteeringSent = false;
	state.budgetWarning70Sent = false;
	state.budgetWarning90Sent = false;
	session.tasksCompletedAtAgentStart = 0;
	persistAndUpdate(pi, session, ctx);
	ctx.ui.notify(`Objective updated:\nPrevious: ${oldObjective}\nNew: ${newObjective}`, "info");

	if (isActiveStatus(state.status)) {
		pi.sendUserMessage(objectiveUpdatedPrompt(state, oldObjective), { deliverAs: "steer" });
	}
}

// ── /goal set (<objective>) ───────────────────────────

function handleSet(
	pi: ExtensionAPI, session: GoalSession,
	objective: string, budgetOverrides: Partial<BudgetConfig> | undefined, ctx: ExtensionContext,
): void {
	if (!objective) {
		ctx.ui.notify("Usage: /goal <objective> [--tokens N] [--timeout N]", "warning");
		return;
	}
	if (!objective.trim()) {
		ctx.ui.notify("Objective cannot be empty.", "warning");
		return;
	}
	if (session.state && !isTerminalStatus(session.state.status)) {
		ctx.ui.notify(
			`Cancelled previous Goal: ${session.state.objective}\n(new goal started)`,
			"info",
		);
		session.state.status = "cancelled";
		session.state.completedAtTurnIndex = session.state.currentTurnIndex;
		writeGoalHistoryEntry(pi, session);
		persistGoalState(pi, session, ctx);
	}

	if (budgetOverrides?.tokenBudget !== undefined && budgetOverrides.tokenBudget <= 0) {
		ctx.ui.notify("Token budget must be greater than 0.", "warning");
		return;
	}
	const budget: Partial<BudgetConfig> = {};
	if (budgetOverrides?.tokenBudget) budget.tokenBudget = budgetOverrides.tokenBudget;
	if (budgetOverrides?.timeBudgetMinutes) budget.timeBudgetMinutes = budgetOverrides.timeBudgetMinutes;
	budget.maxTurns = budgetOverrides?.maxTurns ?? DEFAULT_BUDGET.maxTurns;
	budget.maxStallTurns = budgetOverrides?.maxStallTurns ?? DEFAULT_BUDGET.maxStallTurns;

	session.state = createInitialState(objective, budget);
	session.tasksCompletedAtAgentStart = 0;
	session.hasPendingInjection = false;

	persistAndUpdate(pi, session, ctx);

	const budgetNotice: string[] = [];
	if (budget.tokenBudget) budgetNotice.push(`Token budget: ${budget.tokenBudget}`);
	if (budget.timeBudgetMinutes) budgetNotice.push(`Time budget: ${budget.timeBudgetMinutes} min`);
	const notice = [
		`Goal started: ${objective}`,
		`Max turns: ${budget.maxTurns}`,
		...budgetNotice,
	].join("\n");
	ctx.ui.notify(notice, "info");

	pi.sendUserMessage(objective, { deliverAs: "followUp" });
}
