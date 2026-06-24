/**
 * /goal 命令适配器 — 子命令 handler（adapters 层）
 *
 * ADR-002 后子命令：set / status / resume / clear / update / history
 * （原 /goal pause 已删除；/goal abort 随 task CRUD 一并废弃）。
 *
 * 状态变更调 service（createGoal / finalizeAndPersist）；
 * ports 桥接复用 adapters/ports.buildPorts（DRY：单一 ports 构造点）；
 * FR-8.12: set/resume 后 sendUserMessage 触发 AI。
 *
 * adapters 层可 import Pi 类型（桥接 Pi 和 service）。
 */

import type { CustomEntry, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { parseGoalArgs } from "../commands";
import {
	OBJECTIVE_DISPLAY_LIMIT,
	OBJECTIVE_TRUNCATE_KEEP,
	SECONDS_PER_MINUTE,
} from "../constants";
import { checkBudgetOnResume } from "../engine/budget";
import { isActiveStatus, isTerminalStatus, transitionStatus } from "../engine/goal";
import type { BudgetConfig } from "../engine/types";
import { objectiveUpdatedPrompt } from "../projection/prompts";
import { updateWidget } from "../projection/widget";
import { createGoal, finalizeAndPersist, persistState, tickState } from "../service";
import type { GoalSession } from "../session";
import { clearGoalSession } from "../session";
import { buildPorts } from "./ports";

// ── Orchestrator ──────────────────────────────────────

/**
 * /goal 命令分发器。按 parseGoalArgs 结果路由到子命令 handler。
 *
 * 调用方（index.ts 的 command handler）把原始 args 透传到这里。
 */
export async function handleGoalCommand(
	pi: ExtensionAPI,
	session: GoalSession,
	args: string | undefined,
	ctx: ExtensionContext,
): Promise<void> {
	const parsed = parseGoalArgs(args ?? "");
	switch (parsed.action) {
		case "status":
			return handleStatus(session, ctx);
		case "resume":
			return handleResume(pi, session, ctx);
		case "history":
			return handleHistory(ctx);
		case "clear":
			return handleClear(pi, session, ctx);
		case "update":
			return handleUpdate(pi, session, parsed.objective, ctx);
		case "set":
			return handleSet(pi, session, parsed.objective ?? "", parsed.budget, ctx);
	}
}

// ── /goal status ──────────────────────────────────────

function handleStatus(session: GoalSession, ctx: ExtensionContext): void {
	if (!session.state) {
		ctx.ui.notify("Goal mode not active. Use /goal <objective> to start.", "info");
		return;
	}
	const state = session.state;
	// 回归修复：active goal 显示实时耗时（tick 累加当前运行段后再读）
	if (isActiveStatus(state.status)) {
		tickState(state);
	}
	const timeMins = Math.floor(state.timeUsedSeconds / SECONDS_PER_MINUTE);
	const timeSecs = Math.floor(state.timeUsedSeconds % SECONDS_PER_MINUTE);
	const lines: Array<string | null> = [
		`Objective: ${state.objective}`,
		`Status: ${state.status}`,
		`Turn: ${state.currentTurnIndex}`,
		`Time elapsed: ${timeMins}m${timeSecs}s`,
		state.budget.tokenBudget ? `Token: ${state.tokensUsed}/${state.budget.tokenBudget}` : null,
		`Goal ID: ${state.goalId}`,
	];
	ctx.ui.notify(lines.filter(Boolean).join("\n"), "info");
}

// ── /goal resume ──────────────────────────────────────

function handleResume(pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext): void {
	if (!session.state) {
		ctx.ui.notify("Goal mode not active.", "warning");
		return;
	}
	const state = session.state;
	if (isTerminalStatus(state.status)) {
		ctx.ui.notify(`Goal is in terminal state (${state.status}), cannot resume.`, "warning");
		return;
	}
	// ADR-002: resume 仅恢复 blocked（paused 状态已删除）
	if (state.status !== "blocked") {
		ctx.ui.notify("Goal is not blocked, no need to resume.", "info");
		return;
	}
	state.status = "active";
	state.timeStartedAt = Date.now();

	const ports = buildPorts(pi, ctx);

	// FR-8.3 G-014: resume 时 budget 重检
	const resumeCheck = checkBudgetOnResume(state);
	if (resumeCheck) {
		const dim = resumeCheck.dimension;
		state.status = transitionStatus(state.status, dim === "token" ? "budget_limited" : "time_limited");
		persistState(session, ports);
		updateWidget(session, ports.ui);
		ctx.ui.notify(
			`${dim === "token" ? "Token" : "Time"} budget exhausted, cannot resume. Use /goal clear to reset.`,
			"warning",
		);
		return;
	}
	persistState(session, ports);
	updateWidget(session, ports.ui);

	// FR-8.12 并行模式：resume 后触发 AI 继续
	const blockerNote = state.lastBlockerReason
		? `\n\nPrevious blocker: ${state.lastBlockerReason}. Try a different approach.`
		: "";
	pi.sendUserMessage(
		`Goal resumed. Continuing toward the objective.${blockerNote}\n\nObjective: ${state.objective}`,
		{ deliverAs: "followUp" },
	);
}

// ── /goal history ─────────────────────────────────────

interface GoalHistoryData {
	goalId: string;
	objective: string;
	status: string;
	completedTasks: number;
	totalTasks: number;
	elapsedSeconds: number;
	timestamp: number;
}

function handleHistory(ctx: ExtensionContext): void {
	const entries = ctx.sessionManager.getEntries();
	const historyEntries = entries.filter(
		(e): e is CustomEntry<GoalHistoryData> =>
			e.type === "custom" && (e as CustomEntry).customType === "goal-history",
	);

	if (historyEntries.length === 0) {
		ctx.ui.notify("No goal history", "info");
		return;
	}
	const sorted = [...historyEntries].reverse();
	const lines: string[] = ["Goal history:\n"];
	sorted.forEach((entry, i) => {
		const h = entry.data;
		if (!h) return;
		const icon =
			h.status === "complete"
				? "✓"
				: h.status === "cancelled"
					? "✗"
					: h.status === "budget_limited"
						? "⊗"
						: h.status === "time_limited"
							? "⏱"
							: "?";
		const obj =
			h.objective.length > OBJECTIVE_DISPLAY_LIMIT
				? `${h.objective.slice(0, OBJECTIVE_TRUNCATE_KEEP)}...`
				: h.objective;
		const mins = Math.floor(h.elapsedSeconds / SECONDS_PER_MINUTE);
		const secs = Math.floor(h.elapsedSeconds % SECONDS_PER_MINUTE);
		lines.push(`${i + 1}. ${icon} ${obj}`);
		lines.push(`   ${mins}m${secs}s | ${h.status}`);
	});
	ctx.ui.notify(lines.join("\n"), "info");
}

// ── /goal clear（强制清）──────────────────────────────

/**
 * FR-6.3：强制清。直接 cancelled + clearSession。
 */
function handleClear(pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext): void {
	if (!session.state) {
		ctx.ui.notify("Goal mode not active.", "info");
		return;
	}
	const ports = buildPorts(pi, ctx);
	// transitionStatus 查表终态不可转（engine/goal.ts）：已终态 goal 直接 clearSession
	if (!isTerminalStatus(session.state.status)) {
		// FR-3.3: 唯一终态序列入口（tick + finalizeGoal + persist）
		finalizeAndPersist(session.state, "cancelled", 0, ports);
	}
	// FR-8.7: cancelled → 立即 clearSession
	clearGoalSession(session, ports.ui);
	ctx.ui.notify("Goal cleared.", "info");
}

// ── /goal update（重塑）──────────────────────────────

/**
 * FR-8.4 G-002：重塑（reset）。重置 objective/budget flags/
 * currentTurnIndex/lastProgressTurn，保留 goalId。
 * active 状态下向 AI 注入 objective-updated steering。
 */
function handleUpdate(
	pi: ExtensionAPI,
	session: GoalSession,
	newObjective: string | undefined,
	ctx: ExtensionContext,
): void {
	if (!session.state) {
		ctx.ui.notify("Goal mode not active.", "warning");
		return;
	}
	if (!newObjective) {
		ctx.ui.notify("Usage: /goal update <new-objective>", "warning");
		return;
	}
	const state = session.state;
	const oldObjective = state.objective;
	// FR-8.4 G-002: 重塑（重置，保留 goalId）
	state.objective = newObjective;
	state.objectiveUpdatedAt = Date.now();
	state.currentTurnIndex = 0;
	state.lastProgressTurn = 0;
	state.budgetLimitSteeringSent = false;
	state.tokenWarning70Sent = false;
	state.tokenWarning90Sent = false;
	state.timeWarning70Sent = false;
	state.timeWarning90Sent = false;
	// FR-6.5: 持久化重塑后的状态（persistState 按当前 status tick 累加）+ FR-6.1 widget 刷新
	const updatePorts = buildPorts(pi, ctx);
	persistState(session, updatePorts);
	updateWidget(session, updatePorts.ui);
	ctx.ui.notify(`Objective updated:\nPrevious: ${oldObjective}\nNew: ${newObjective}`, "info");

	if (isActiveStatus(state.status)) {
		const ports = buildPorts(pi, ctx);
		ports.messaging.sendContextMessage(objectiveUpdatedPrompt(state, oldObjective), "steer");
	}
}

// ── /goal set（创建）─────────────────────────────────

/**
 * FR-3.1: 唯一创建入口之一（/goal set）。
 * #11 / D25: 非终态旧 goal（active/paused/blocked）→ 拒绝创建，提示 /goal resume 或 /goal clear
 *           （对齐 Codex create_goal，不允许有未完成 goal 时新建）。
 *           终态旧 goal → 快速路径覆盖（不写 history）。
 * FR-8.12: 创建后 sendUserMessage(objective, followUp) 触发 AI（整个 goal workflow 启动机制）。
 */
function handleSet(
	pi: ExtensionAPI,
	session: GoalSession,
	objective: string,
	budgetOverrides: Partial<BudgetConfig> | undefined,
	ctx: ExtensionContext,
): void {
	if (!objective || !objective.trim()) {
		ctx.ui.notify("Usage: /goal <objective> [--tokens N] [--timeout N]", "warning");
		return;
	}

	// #11 / D25: 非终态旧 goal（active/paused/blocked）→ 拒绝创建（不覆盖、不写 history）
	if (session.state && !isTerminalStatus(session.state.status)) {
		ctx.ui.notify(
			"Goal already active. Use /goal resume to continue or /goal clear to reset.",
			"warning",
		);
		return;
	}

	const ports = buildPorts(pi, ctx);
	// 终态旧 goal：快速路径（不写 history，createGoal 直接覆盖）

	// budget 校验 + 默认值合并
	if (budgetOverrides?.tokenBudget !== undefined && budgetOverrides.tokenBudget <= 0) {
		ctx.ui.notify("Token budget must be greater than 0.", "warning");
		return;
	}
	const budget: Partial<BudgetConfig> = {};
	if (budgetOverrides?.tokenBudget) budget.tokenBudget = budgetOverrides.tokenBudget;
	if (budgetOverrides?.timeBudgetMinutes) budget.timeBudgetMinutes = budgetOverrides.timeBudgetMinutes;

	// FR-3.1: 唯一创建入口
	createGoal(session, objective, budget, ports, false);

	const budgetNotice: string[] = [];
	if (budget.tokenBudget) budgetNotice.push(`Token budget: ${budget.tokenBudget}`);
	if (budget.timeBudgetMinutes) budgetNotice.push(`Time budget: ${budget.timeBudgetMinutes} min`);
	ctx.ui.notify(
		[`Goal started: ${objective}`, ...budgetNotice].join("\n"),
		"info",
	);

	// FR-8.12: 创建后触发 AI（整个 goal workflow 的启动机制）
	pi.sendUserMessage(objective, { deliverAs: "followUp" });
}
