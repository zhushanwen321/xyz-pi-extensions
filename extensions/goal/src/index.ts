/**
 * Pi /goal Extension — Codex-style persistent goal-driven autonomous loop
 *
 * 功能：
 * - 持久化目标设定，支持 pause/resume/clear/update
 * - Evidence-based completion（完成任务必须提供具体证据）
 * - Token 预算 + 时间预算（含 70%/90% 预警）
 * - Blocked 状态检测（连续 stall 自动阻塞）
 * - Steering 模板化（continuation / budget-limit / objective-updated）
 * - 任务清单追踪
 *
 * 健壮性保障：
 * - goalId snapshot 防止旧回调操作新 goal
 * - 时间累计统一由 persistState 管理，无双写
 * - 防重入保护（hasPendingInjection）
 * - deserializeState 向后兼容旧格式
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, CustomEntry, Theme } from "@mariozechner/pi-coding-agent";

import { Text } from "@mariozechner/pi-tui";
import { type Static } from "typebox";


import {
	type GoalTask,
	type BudgetConfig,
	DEFAULT_BUDGET,
	createInitialState,
	transitionStatus,
	isTerminalStatus,
	isTerminalTaskStatus,
	isActiveStatus,
	deserializeState,
	getCompletedCount,
	getIncompleteTasks,
	getElapsedTimeSeconds,
} from "./state";

import { parseGoalArgs } from "./commands";
import {
	continuationPrompt,
	budgetLimitPrompt,
	objectiveUpdatedPrompt,
	contextInjectionPrompt,
	stalenessReminderPrompt,
} from "./templates";

import { renderTerminalStatusLine } from "./widget";
import { toSingleLine } from "./widget";

import {
	SECONDS_PER_MINUTE,
	CONTEXT_USAGE_RATIO_LIMIT,
	PERCENT_FACTOR,
	TASK_STALL_TURN_THRESHOLD,
	AUTO_CLEAR_TURNS,
	MAX_HISTORY_ENTRIES,
	OBJECTIVE_DISPLAY_LIMIT,
	OBJECTIVE_TRUNCATE_KEEP,
} from "./constants";

import {
	checkBudgetOnTurnEnd,
	checkBudgetOnResume,
	checkProgress,
} from "./budget.js";

import {
	type GoalSession,
	type GoalManagerDetails,
	GoalManagerParams,
	executeGoalAction,
	persistGoalState,
	clearGoalSession,
	updateWidget,
	writeGoalHistoryEntry,
	isGoalEntry,
	HISTORY_ENTRY_TYPE,
} from "./tool-handler";

// ── State Reconstruction ─────────────────────────────

function reconstructGoalState(pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext): void {
	session.state = null;
	const entries = ctx.sessionManager.getEntries();

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (isGoalEntry(entry)) {
			const data = entry.data as Record<string, unknown> | undefined;
			if (data) {
				try {
					session.state = deserializeState(data);
				} catch {
					// 旧格式 goal-state entry，视为无活跃 goal
					session.state = null;
				}
			}
			break;
		}
	}

	if (!session.state) return;

	// 非终态 → 恢复为 active（session 重启后 resume）
	if (!isTerminalStatus(session.state.status) && session.state.status !== "paused") {
		session.state.status = "active";
		session.state.timeStartedAt = Date.now();
	}

	// Entry GC — 标记旧的 goal-state entries 以便清理
	const goalEntryIndices: number[] = [];
	let latestFound = false;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (isGoalEntry(entry)) {
			if (!latestFound) {
				latestFound = true;
			} else {
				goalEntryIndices.push(i);
			}
		}
	}
	for (const idx of goalEntryIndices) {
		entries.splice(idx, 1);
	}

	// Goal-history entry GC — 保留最近 MAX_HISTORY_ENTRIES 条
	const historyIndices: number[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		if (entry.type === "custom" && (entry as CustomEntry).customType === HISTORY_ENTRY_TYPE) {
			historyIndices.push(i);
		}
	}
	if (historyIndices.length > MAX_HISTORY_ENTRIES) {
		const toDelete = historyIndices.slice(0, historyIndices.length - MAX_HISTORY_ENTRIES);
		for (let i = toDelete.length - 1; i >= 0; i--) {
			entries.splice(toDelete[i]!, 1);
		}
	}
}

// ── Command Handler ───────────────────────────────────

async function handleGoalCommand(pi: ExtensionAPI, session: GoalSession, args: string | undefined, ctx: ExtensionContext): Promise<void> {
	const parsed = parseGoalArgs(args ?? "");

	switch (parsed.action) {
		case "status": {
			if (!session.state) {
				ctx.ui.notify("Goal mode not active. Use /goal <objective> to start.", "info");
				return;
			}
			const completed = getCompletedCount(session.state.tasks);
			const total = session.state.tasks.length;
			const elapsed = getElapsedTimeSeconds(session.state);
			const lines = [
				`Objective: ${session.state.objective}`,
				`Status: ${session.state.status}`,
				`Turn: ${session.state.turnCount}/${session.state.budget.maxTurns}`,
				`Tasks: ${completed}/${total} completed`,
				`Stall turns: ${session.state.stallCount}`,
				`Time elapsed: ${Math.floor(elapsed / SECONDS_PER_MINUTE)}m${Math.floor(elapsed % SECONDS_PER_MINUTE)}s`,
				session.state.budget.tokenBudget ? `Token: ${session.state.tokensUsed}/${session.state.budget.tokenBudget}` : null,
				`Goal ID: ${session.state.goalId}`,
			].filter(Boolean);
			ctx.ui.notify(lines.join("\n"), "info");
			return;
		}

		case "pause": {
			if (!session.state) {
				ctx.ui.notify("Goal mode not active.", "warning");
				return;
			}
			if (isTerminalStatus(session.state.status)) {
				ctx.ui.notify(`Goal is in terminal state (${session.state.status}), cannot pause.`, "warning");
				return;
			}
			session.state.status = transitionStatus(session.state.status, "paused");
			persistGoalState(pi, session, ctx);
			updateWidget(session, ctx);
			ctx.ui.notify("Goal paused. Use /goal resume to continue.", "info");
			return;
		}

		case "resume": {
			if (!session.state) {
				ctx.ui.notify("Goal mode not active.", "warning");
				return;
			}
			if (isTerminalStatus(session.state.status)) {
				ctx.ui.notify(`Goal is in terminal state (${session.state.status}), cannot resume.`, "warning");
				return;
			}
			if (session.state.status !== "paused" && session.state.status !== "blocked") {
				ctx.ui.notify("Goal is not paused or blocked, no need to resume.", "info");
				return;
			}
			session.state.status = "active";
			session.state.stallCount = 0;
			session.state.timeStartedAt = Date.now();

			// Resume 时重检预算（复用 budget.ts 的决策函数）
			const resumeBudgetCheck = checkBudgetOnResume(session.state);
			if (resumeBudgetCheck) {
				const dim = resumeBudgetCheck.dimension;
				session.state.status = transitionStatus(session.state.status, dim === "token" ? "budget_limited" : "time_limited");
				persistGoalState(pi, session, ctx);
				updateWidget(session, ctx);
				ctx.ui.notify(`${dim === "token" ? "Token" : "Time"} budget exhausted, cannot resume. Use /goal clear to reset.`, "warning");
				return;
			}

			persistGoalState(pi, session, ctx);
			updateWidget(session, ctx);

			const incomplete = getIncompleteTasks(session.state.tasks);
			if (incomplete.length > 0) {
				pi.sendUserMessage(
					`Goal resumed. Continuing with ${incomplete.length} remaining tasks.` +
					(session.state.lastBlockerReason ? `

Previous blocker: ${session.state.lastBlockerReason}. Try a different approach.` : "") +
					`

Objective: ${session.state.objective}`,
					{ deliverAs: "followUp" },
				);
			} else {
				ctx.ui.notify("All tasks completed.", "info");
			}
			return;
		}

		case "history": {
			const entries = ctx.sessionManager.getEntries();
			const historyEntries = entries.filter(
				(e) => e.type === "custom" && (e as CustomEntry).customType === HISTORY_ENTRY_TYPE,
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

			// 按时间倒序
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
			return;
		}

		case "clear": {
			if (!session.state) {
				ctx.ui.notify("Goal mode not active.", "info");
				return;
			}
			session.state.status = "cancelled";
			session.state.completedAtTurnIndex = session.state.currentTurnIndex;
			writeGoalHistoryEntry(pi, session);
			persistGoalState(pi, session, ctx);
			clearGoalSession(session, ctx);
			ctx.ui.notify("Goal cleared.", "info");
			return;
		}

		case "update": {
			if (!session.state) {
				ctx.ui.notify("Goal mode not active.", "warning");
				return;
			}
			if (!parsed.objective) {
				ctx.ui.notify("Usage: /goal update <new-objective>", "warning");
				return;
			}
			const oldObjective = session.state.objective;
			session.state.objective = parsed.objective;
			session.state.objectiveUpdatedAt = Date.now();
			session.state.tasks = [];
			session.state.stallCount = 0;
			session.state.turnCount = 0;
			session.state.lastProgressTurn = 0;
			session.state.budgetLimitSteeringSent = false;
			session.state.budgetWarning70Sent = false;
			session.state.budgetWarning90Sent = false;
			session.tasksCompletedAtAgentStart = 0;
			persistGoalState(pi, session, ctx);
			updateWidget(session, ctx);
			ctx.ui.notify(`Objective updated:\nPrevious: ${oldObjective}\nNew: ${parsed.objective}`, "info");

			if (isActiveStatus(session.state.status)) {
				pi.sendUserMessage(objectiveUpdatedPrompt(session.state, oldObjective), { deliverAs: "steer" });
			}
			return;
		}

		case "set": {
			if (!parsed.objective) {
				ctx.ui.notify("Usage: /goal <objective> [--tokens N] [--timeout N]", "warning");
				return;
			}
			if (!parsed.objective.trim()) {
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

			if (parsed.budget?.tokenBudget !== undefined && parsed.budget.tokenBudget <= 0) {
				ctx.ui.notify("Token budget must be greater than 0.", "warning");
				return;
			}
			const budget: Partial<BudgetConfig> = {};
			if (parsed.budget?.tokenBudget) budget.tokenBudget = parsed.budget.tokenBudget;
			if (parsed.budget?.timeBudgetMinutes) budget.timeBudgetMinutes = parsed.budget.timeBudgetMinutes;
			budget.maxTurns = parsed.budget?.maxTurns ?? DEFAULT_BUDGET.maxTurns;
			budget.maxStallTurns = parsed.budget?.maxStallTurns ?? DEFAULT_BUDGET.maxStallTurns;

			session.state = createInitialState(parsed.objective, budget);
			session.tasksCompletedAtAgentStart = 0;
			session.hasPendingInjection = false;

			persistGoalState(pi, session, ctx);
			updateWidget(session, ctx);

			const budgetNotice: string[] = [];
			if (budget.tokenBudget) budgetNotice.push(`Token budget: ${budget.tokenBudget}`);
			if (budget.timeBudgetMinutes) budgetNotice.push(`Time budget: ${budget.timeBudgetMinutes} min`);
			const notice = [
				`Goal started: ${parsed.objective}`,
				`Max turns: ${budget.maxTurns}`,
				...budgetNotice,
			].join("\n");
			ctx.ui.notify(notice, "info");

			pi.sendUserMessage(parsed.objective, { deliverAs: "followUp" });
			return;
		}
	}
}

// ── Event: before_agent_start Handler ─────────────────

async function handleBeforeAgentStart(pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext) {
	if (!session.state) return;

	// 终态处理：自动清理或折叠 status bar
	if (isTerminalStatus(session.state.status)) {
		const state = session.state;
		const turnsInTerminal = state.currentTurnIndex - (state.completedAtTurnIndex ?? 0);

		if (turnsInTerminal >= AUTO_CLEAR_TURNS) {
			clearGoalSession(session, ctx);
			return;
		}

		// 折叠 status bar（不渲染 task 列表）
		const statusText = renderTerminalStatusLine(state, ctx.ui.theme);
		if (statusText) {
			ctx.ui.setStatus("goal", statusText);
		}
		ctx.ui.setWidget("goal", undefined);
		return;
	}

	if (!isActiveStatus(session.state.status)) return;

	session.hasPendingInjection = true;

	// 停滞检查
	const state = session.state;
	const staleTasks: Array<{
		task: GoalTask;
		staleTurns: number;
		staleSubtasks: Array<{ text: string; staleTurns: number }>;
	}> = [];
	let allTerminal = true;

	for (const task of state.tasks) {
		if (!isTerminalTaskStatus(task.status)) {
			allTerminal = false;
			const staleTurns = state.currentTurnIndex - task.lastUpdatedTurn;
			if (staleTurns >= TASK_STALL_TURN_THRESHOLD) {
				const staleSubtasks: Array<{ text: string; staleTurns: number }> = [];
				if (task.subtasks) {
					for (const s of task.subtasks) {
						if (s.status !== "completed") {
							const subStale = state.currentTurnIndex - s.lastUpdatedTurn;
							if (subStale >= TASK_STALL_TURN_THRESHOLD) {
								staleSubtasks.push({ text: s.text, staleTurns: subStale });
							}
						}
					}
				}
				staleTasks.push({ task, staleTurns, staleSubtasks });
			}
		}
	}

	// 边界：所有 task 已终态但 goal 仍 active
	if (allTerminal && state.tasks.length > 0) {
		return {
			message: {
				customType: "goal-staleness-reminder",
				content: stalenessReminderPrompt(state, [], true),
				display: false,
			},
		};
	}

	// 有停滞项 → 注入提醒
	if (staleTasks.length > 0) {
		// 重置被提醒项的 lastUpdatedTurn
		for (const item of staleTasks) {
			item.task.lastUpdatedTurn = state.currentTurnIndex;
			if (item.task.subtasks) {
				for (const s of item.task.subtasks) {
					if (s.status !== "completed") {
						s.lastUpdatedTurn = state.currentTurnIndex;
					}
				}
			}
		}

		return {
			message: {
				customType: "goal-staleness-reminder",
				content: stalenessReminderPrompt(state, staleTasks, false),
				display: false,
			},
		};
	}

	// 无停滞 → 继续原有 context injection
	const usage = ctx.getContextUsage();
	if (usage && usage.contextWindow > 0 && (usage.tokens ?? 0) / usage.contextWindow > CONTEXT_USAGE_RATIO_LIMIT) {
		session.state.status = transitionStatus(session.state.status, "paused");
		persistGoalState(pi, session, ctx);
		updateWidget(session, ctx);

		return {
			message: {
				customType: "goal-context-exceeded",
				content:
					"[GOAL — context space low, must wrap up now]\n" +
					"1. Use goal_manager's list_tasks to check remaining tasks\n" +
					"2. Only mark tasks you genuinely completed with evidence\n" +
					"3. Summarize current progress and remaining work\n" +
					"Do not start new tasks.",
				display: false,
			},
		};
	}

	return {
		message: {
			customType: "goal-context",
			content: contextInjectionPrompt(session.state),
			display: false,
		},
	};
}

// ── Event: agent_end Handler ──────────────────────────

async function handleAgentEnd(pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext): Promise<void> {
	if (!session.state) return;

	const snapshotGoalId = session.state.goalId;
	const checkStale = () => !session.state || session.state.goalId !== snapshotGoalId;

	// 终态处理：complete / blocked 只需 persist + notify
	if (session.state.status === "complete") {
		persistGoalState(pi, session, ctx);
		if (checkStale()) return;
		updateWidget(session, ctx);
		ctx.ui.notify(
			`Objective completed ✓ (${getCompletedCount(session.state.tasks)}/${session.state.tasks.length} tasks, ${session.state.turnCount} turns)`,
			"info",
		);
		return;
	}

	if (session.state.status === "blocked") {
		persistGoalState(pi, session, ctx);
		if (checkStale()) return;
		updateWidget(session, ctx);
		ctx.ui.notify("Goal blocked. Use /goal resume to continue or /goal clear to reset.", "warning");
		return;
	}

	if (!isActiveStatus(session.state.status)) return;

	// 防重入
	if (session.hasPendingInjection) {
		session.hasPendingInjection = false;
		return;
	}

	if (checkStale()) return;

	// ── 预算策略（集中检查）──

	const budgetResult = checkBudgetOnTurnEnd(session.state);

	// 发送预警
	for (const w of budgetResult.warnings) {
		if (w.type === "warning90") {
			session.state.budgetWarning90Sent = true;
			ctx.ui.notify(`${w.dimension === "token" ? "Token" : "Time"} budget 90% used — start wrapping up.`, "warning");
		} else if (w.type === "warning70") {
			session.state.budgetWarning70Sent = true;
			ctx.ui.notify(`${w.dimension === "token" ? "Token" : "Time"} budget 70% used — keep scope in check.`, "info");
		}
	}

	// 预算耗尽 → 终止
	if (budgetResult.terminal) {
		const dim = budgetResult.terminal.dimension;
		session.state.status = transitionStatus(session.state.status, dim === "token" ? "budget_limited" : "time_limited");
		session.state.completedAtTurnIndex = session.state.currentTurnIndex;
		writeGoalHistoryEntry(pi, session);
		persistGoalState(pi, session, ctx);
		if (checkStale()) return;
		updateWidget(session, ctx);
		ctx.ui.notify(
			dim === "token"
				? "Token budget exhausted, Goal terminated."
				: `Time budget exhausted (${session.state.budget.timeBudgetMinutes} min), Goal terminated.`,
			"warning",
		);
		return;
	}

	// 90% steering → 发送收尾指令
	if (budgetResult.shouldSendSteering) {
		session.state.budgetLimitSteeringSent = true;
		persistGoalState(pi, session, ctx);
		if (checkStale()) return;
		updateWidget(session, ctx);
		pi.sendUserMessage(budgetLimitPrompt(session.state, "token"), { deliverAs: "steer" });
		return;
	}

	if (checkStale()) return;

	// ── Turn 递增 + 进展评估 ──

	session.state.turnCount++;

	const progress = checkProgress(session.state, session.tasksCompletedAtAgentStart);

	// 所有任务完成 → 提示 complete_goal
	if (progress.allTasksDone) {
		if (progress.maxTurnsReached) {
			session.state.status = transitionStatus(session.state.status, "complete");
			session.state.completedAtTurnIndex = session.state.currentTurnIndex;
			writeGoalHistoryEntry(pi, session);
			persistGoalState(pi, session, ctx);
			if (checkStale()) return;
			updateWidget(session, ctx);
			ctx.ui.notify(
				`All tasks completed, Goal auto-closed. (${progress.completedCount}/${progress.totalCount} tasks, ${session.state.turnCount} turns)`,
				"info",
			);
			return;
		}

		if (progress.budgetTight) {
			pi.sendUserMessage(
				`All tasks completed, token budget ${Math.round(session.state.tokensUsed / session.state.budget.tokenBudget! * PERCENT_FACTOR)}% used.` +
				`Call goal_manager's complete_goal now with overall evidence.` +
				`\n\nObjective: ${session.state.objective}`,
				{ deliverAs: "steer" },
			);
		} else {
			pi.sendUserMessage(
				`All ${progress.totalCount} tasks completed. Call goal_manager's complete_goal with overall evidence.` +
					`\n\nObjective: ${session.state.objective}`,
				{ deliverAs: "followUp" },
			);
		}
		persistGoalState(pi, session, ctx);
		updateWidget(session, ctx);
		return;
	}

	// 没有任务创建 → 提醒 create_tasks
	if (progress.noTasksCreated) {
		if (progress.maxTurnsReached) {
			session.state.status = transitionStatus(session.state.status, "cancelled");
			session.state.completedAtTurnIndex = session.state.currentTurnIndex;
			writeGoalHistoryEntry(pi, session);
			persistGoalState(pi, session, ctx);
			if (checkStale()) return;
			updateWidget(session, ctx);
			ctx.ui.notify(
				`Max turns reached (${session.state.budget.maxTurns}), LLM did not create task list.`,
				"warning",
			);
			return;
		}
		pi.sendUserMessage(
			`No task list created yet. Call goal_manager's create_tasks immediately to decompose the work into verifiable task steps.` +
				`\n\nObjective: ${session.state.objective}`,
			{ deliverAs: "followUp" },
		);
		persistGoalState(pi, session, ctx);
		updateWidget(session, ctx);
		return;
	}

	// 最大轮次 → 取消
	if (progress.maxTurnsReached) {
		const incomplete = getIncompleteTasks(session.state.tasks);
		session.state.status = transitionStatus(session.state.status, "cancelled");
		session.state.completedAtTurnIndex = session.state.currentTurnIndex;
		writeGoalHistoryEntry(pi, session);
		persistGoalState(pi, session, ctx);
		if (checkStale()) return;
		updateWidget(session, ctx);
		ctx.ui.notify(
			`Max turns reached (${session.state.budget.maxTurns}), ${incomplete.length} tasks still incomplete.`,
			"warning",
		);
		return;
	}

	// Stall 检测
	if (progress.isStalled) {
		session.state.stallCount++;
	} else {
		session.state.stallCount = 0;
		session.state.lastProgressTurn = session.state.turnCount;
	}

	if (session.state.stallCount >= session.state.budget.maxStallTurns) {
		session.state.status = transitionStatus(session.state.status, "blocked");
		persistGoalState(pi, session, ctx);
		if (checkStale()) return;
		updateWidget(session, ctx);
		ctx.ui.notify(
			`${session.state.stallCount} consecutive turns without progress, Goal auto-blocked. Use /goal resume to continue or /goal clear to reset.`,
			"warning",
		);
		return;
	}

	if (checkStale()) return;

	// 去抖：本 turn 无 token 消耗则不发 continuation
	const tokenDelta = session.state.tokensUsed - session.state.lastTurnTokensUsed;
	session.state.lastTurnTokensUsed = session.state.tokensUsed;

	if (tokenDelta === 0) {
		persistGoalState(pi, session, ctx);
		updateWidget(session, ctx);
		return;
	}

	// Normal continuation
	persistGoalState(pi, session, ctx);
	updateWidget(session, ctx);

	pi.sendUserMessage(continuationPrompt(session.state), { deliverAs: "followUp" });
}

// ── Extension Factory ─────────────────────────────────

export default function goalExtension(pi: ExtensionAPI) {
	const session: GoalSession = {
		state: null,
		tasksCompletedAtAgentStart: 0,
		hasPendingInjection: false,
	};

	// ── Tool: goal_manager ─────────────────────────────

	pi.registerTool({
		name: "goal_manager",
		label: "Goal Manager",
		description:
			"Goal mode task manager. This tool is only available after starting a goal via the /goal command. AI cannot trigger it proactively. If Goal mode is not active, calling this tool will error." +
			"\n\nAvailable actions:" +
			"\n- create_tasks: Decompose the objective into a task list (call once at goal start). Each task description must be a one-line summary (max 60 chars), no newlines or markdown" +
			"\n- add_tasks: Append new tasks to the existing list (when omissions are discovered). Each task description must be a one-line summary (max 60 chars), no newlines or markdown" +
			"\n- update_tasks: Batch update task statuses (completed requires evidence, cancelled does not block goal completion)" +
			"\n- list_tasks: View progress and remaining budget" +
			"\n- complete_goal: Mark the objective as achieved (all tasks must be completed + evidence)" +
			"\n- cancel_goal: Cancel the current goal (use when user wants to exit/stop)" +
			"\n- report_blocked: Report being blocked (use when encountering unsolvable issues)" +
			"\n- add_subtasks: Add subtasks to a specified task (params: taskId, texts[]). Use this instead of todo tool in Goal mode" +
			"\n- update_subtasks: Batch update subtask statuses (params: taskId, subUpdates[])" +
			"\n- delete_subtasks: Delete subtasks from a specified task (params: taskId, subIds[])",
		promptSnippet: "Manage task list, completion status, and exit for /goal mode",
		promptGuidelines: [
			"[Workflow] After receiving the objective, the first step must be create_tasks to decompose. Do not re-call if task list already exists",
			"[Format] Each task description must be a one-line summary, max 60 chars. No newlines, markdown, or detailed parameter lists — those go in execution phase. Example: 'Fix hook-registry dedup logic' not 'Fix hook-registry dedup + transport-execute enhancementConfig guard + failover-loop ...'",
			"[Append] When discovering omissions during execution, use add_tasks to append — do not re-call create_tasks",
			"[Completion] After completing a task, call update_tasks with status=completed and provide evidence (e.g. 'test X passed', 'file F created')",
			"[Goal completion] Only call complete_goal when all tasks are completed with overall evidence",
			"[Exit] When user says 'stop', 'exit', 'cancel', '不用了', '结束', etc. indicating they don't want to continue, immediately call cancel_goal — do not guide them through complete_goal",
			"[Blocked] When encountering unsolvable technical issues, call report_blocked with the reason",
			"[Progress] Use list_tasks anytime to check remaining tasks and budget",
			"[Cancel] To cancel a task, use update_tasks with status=cancelled. Cancelled tasks do not block goal completion",
			"[Forbidden] Do not mark tasks as completed without evidence, and do not call complete_goal without evidence",
			"[Forbidden] Do not force task completion when the user explicitly wants to exit — call cancel_goal directly",
			"[Forbidden] Do not re-call create_tasks to overwrite existing incomplete tasks — use add_tasks to append",
			"[Subtask] For fine-grained step tracking in Goal mode, use add_subtasks — do not use the todo tool",
		],
		parameters: GoalManagerParams,

		async execute(_toolCallId: string, params: Static<typeof GoalManagerParams>, _signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext) {
			try {
				return await executeGoalAction(pi, session, params, ctx);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const inputSummary = JSON.stringify(params, null, 2);
				return {
					content: [{ type: "text", text: `${msg}\n\nInput: ${inputSummary}` }],
					isError: true,
				};
			}
		},

		renderCall(args: any, theme: Theme) {
			let text = theme.fg("toolTitle", theme.bold("goal_manager ")) + theme.fg("muted", args.action);
			if (args.tasks) text += ` ${theme.fg("dim", `(${args.tasks.length} tasks)`)}`;
			if (args.updates) text += ` ${theme.fg("dim", `(${args.updates.length} updates)`)}`;
			if (args.taskId !== undefined) text += ` ${theme.fg("accent", `#${args.taskId}`)}`;
			if (args.texts) text += ` ${theme.fg("dim", `(${args.texts.length} subtasks)`)}`;
			if (args.subUpdates) text += ` ${theme.fg("dim", `(${args.subUpdates.length} subtask updates)`)}`;
			if (args.subIds) text += ` ${theme.fg("dim", `del #${args.subIds.join(",")}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result: any, { expanded }: any, theme: Theme) {
			const details = result.details as GoalManagerDetails | undefined;
			if (!details || !Array.isArray(details.tasks)) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const tasks = details.tasks;
			const completed = tasks.filter((t) => t.status === "completed").length;
			const summary = theme.fg("success", `✓ ${completed}/${tasks.length} completed`);
			if (!expanded || tasks.length === 0) {
				return new Text(summary, 0, 0);
			}
			const lines = [summary];
			for (const t of tasks) {
				const icon = t.status === "completed"
					? theme.fg("success", "✓")
					: t.status === "in_progress"
						? theme.fg("warning", "●")
						: t.status === "cancelled"
							? theme.fg("dim", "✗")
							: theme.fg("dim", "☐");
				const descText = toSingleLine(t.description);
				const desc = (t.status === "completed" || t.status === "cancelled")
					? theme.fg("dim", descText)
					: theme.fg("text", descText);
				lines.push(`  ${icon} ${theme.fg("accent", `#${t.id}`)} ${desc}`);
			// Subtask items in expanded view
			if (t.subtasks && t.subtasks.length > 0) {
				for (const s of t.subtasks) {
					const subIcon = s.status === "completed"
						? theme.fg("success", "\u2713")
						: s.status === "in_progress"
							? theme.fg("warning", "\u25cf")
							: theme.fg("dim", "\u25cb");
					const subText = s.status === "completed" ? theme.fg("dim", s.text) : theme.fg("muted", s.text);
					lines.push(`    ${subIcon} ${theme.fg("dim", `${t.id}.${s.id}`)} ${subText}`);
				}
			}
		}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// ── Command: /goal ─────────────────────────────────

	pi.registerCommand("goal", {
		description:
			"Goal-driven mode: /goal <objective> [--tokens N] [--timeout N] [--max-turns N] | /goal pause | /goal resume | /goal clear | /goal update <new-objective> | /goal status | /goal history",
		handler: async (args: string | undefined, ctx: ExtensionCommandContext) => {
			await handleGoalCommand(pi, session, args, ctx);
		},
	});

	// ── Event: before_agent_start ──────────────────────

	pi.on("before_agent_start", async (_event: any, ctx: ExtensionContext) => {
		return handleBeforeAgentStart(pi, session, ctx);
	});

	// ── Event: agent_start ─────────────────────────────

	pi.on("agent_start", async () => {
		if (!session.state || !isActiveStatus(session.state.status)) return;
		session.tasksCompletedAtAgentStart = getCompletedCount(session.state.tasks);
	});

	// ── Event: turn_end ────────────────────────────────

	pi.on("turn_end", async (_event: any, ctx: ExtensionContext) => {
		if (!session.state) return;
		session.state.currentTurnIndex++;
		updateWidget(session, ctx);
	});

	// ── Event: message_end (token accounting) ──────────

	pi.on("message_end", async (event: any, _ctx: ExtensionContext) => {
		if (!session.state || !isActiveStatus(session.state.status)) return;
		if (event.message.role !== "assistant") return;

		const usage = event.message.usage;
		if (usage) {
			const input = usage.input ?? 0;
			const output = usage.output ?? 0;
			const cacheRead = usage.cacheRead ?? 0;
			if (input > 0 || output > 0) {
				session.state.tokensUsed += Math.max(input - cacheRead, 0) + output;
			} else if (usage.totalTokens) {
				session.state.tokensUsed += usage.totalTokens;
			}
		}
	});

	// ── Event: agent_end ───────────────────────────────

	pi.on("agent_end", async (_event: any, ctx: ExtensionContext) => {
		await handleAgentEnd(pi, session, ctx);
	});

	// ── Event: session_start (state reconstruction) ───

	pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
		reconstructGoalState(pi, session, ctx);
		if (session.state) {
			session.tasksCompletedAtAgentStart = getCompletedCount(session.state.tasks);
			updateWidget(session, ctx);
		}
	});

	// ── Message Renderers ──────────────────────────────

	const goalMessageTypes = [
		"goal-context",
		"goal-context-exceeded",
		"goal-staleness-reminder",
	];

	for (const customType of goalMessageTypes) {
		pi.registerMessageRenderer(customType, (message: any, _options: any, theme: Theme) => {
			const prefix =
				message.customType === "goal-context-exceeded"
					? theme.fg("error", "[GOAL Budget] ")
					: message.customType === "goal-staleness-reminder"
						? theme.fg("warning", "[GOAL Reminder] ")
						: theme.fg("accent", "[GOAL] ");
			const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
			return new Text(prefix + theme.fg("dim", content), 0, 0);
		});
	}
}
