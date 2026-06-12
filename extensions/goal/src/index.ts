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
 * - before_agent_start 注入 context，agent_end 负责 continuation（预算检查/进度评估/续跑）
 * - deserializeState 向后兼容旧格式
 * - isProcessing 防重入（agent_end 重入时直接返回）
 */

import type { CustomEntry, ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static } from "typebox";

import { handleAgentEnd } from "./agent-end-handler";
import { handleBeforeAgentStart } from "./before-agent-start-handler";
import { handleGoalCommand } from "./command-handler";
import {
	ELLIPSIS_LENGTH,
	EXT_INIT_TASK_DESC_MAX,
	MAX_HISTORY_ENTRIES,
} from "./constants";
import {
	createInitialState,
	deserializeState,
	getCompletedCount,
	type GoalExternalInit,
	isActiveStatus,
	isTerminalStatus,
} from "./state";
import {
	executeGoalAction,
	type GoalManagerDetails,
	GoalManagerParams,
	type GoalSession,
	HISTORY_ENTRY_TYPE,
	isGoalEntry,
	isStaleContextError,
	persistGoalState,
	updateWidget,
} from "./tool-handler";
import { toSingleLine } from "./widget";

// ── Local Interfaces (avoid `any` on Pi callback/event signatures) ────

/** Fields accessed from BeforeAgentStartEvent */
interface BeforeAgentStartLikeEvent {
	type: "before_agent_start";
	prompt: string;
	systemPrompt: string;
}

/** Fields accessed from TurnEndEvent */
interface TurnEndLikeEvent {
	type: "turn_end";
	turnIndex: number;
}

/** Subset of AgentMessage.usage accessed in message_end handler */
interface LikeUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	totalTokens?: number;
}

/** Fields accessed from MessageEndEvent */
interface MessageEndLikeEvent {
	type: "message_end";
	message: {
		role: string;
		usage?: LikeUsage;
	};
}

/** Fields accessed from AgentEndEvent */
interface AgentEndLikeEvent {
	type: "agent_end";
	messages: unknown[];
}

/** Fields accessed from SessionStartEvent */
interface SessionStartLikeEvent {
	type: "session_start";
	reason: string;
}

/** Shape of CustomMessage passed to registerMessageRenderer */
interface LikeCustomMessage {
	customType: string;
	content: string | unknown;
}

/** Options bag for registerMessageRenderer callback */
interface LikeMessageRenderOptions {
	expanded: boolean;
}

/** Result shape accessed in renderResult */
interface LikeToolResult {
	content: Array<{ type: string; text?: string }>;
	details?: GoalManagerDetails;
}

/** Options bag for renderResult callback */
interface LikeToolRenderResultOptions {
	expanded: boolean;
}

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
					session.state = null;
				}
			}
			break;
		}
	}

	if (!session.state) return;

	// 非终态 → 恢复为 active
	if (!isTerminalStatus(session.state.status) && session.state.status !== "paused") {
		session.state.status = "active";
		session.state.timeStartedAt = Date.now();
	}

	// Entry GC — 标记旧的 goal-state entries
	const goalEntryIndices: number[] = [];
	let latestFound = false;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (isGoalEntry(entry)) {
			if (!latestFound) latestFound = true;
			else goalEntryIndices.push(i);
		}
	}
	for (const idx of goalEntryIndices) {
		entries.splice(idx, 1);
	}

	// Goal-history entry GC
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

// ── Extension Factory ─────────────────────────────────

export default function goalExtension(pi: ExtensionAPI) {
	const session: GoalSession = {
		state: null,
		tasksCompletedAtAgentStart: 0,
		hasPendingInjection: false,
		isProcessing: false, // P1-3: 防重入
		pendingPause: false, // ESC 中断标记
	};

	// Capture latest ctx for external API (initializeGoalFromExternal needs it for persistGoalState)
	let lastCtx: ExtensionContext | undefined;

	pi.registerTool({
		name: "goal_manager",
		label: "Goal Manager",
			description:
				"Goal mode task manager. This tool is only available after starting a goal via the /goal command. AI cannot trigger it proactively. If Goal mode is not active, calling this tool will error." +
				"\n\nAvailable actions:" +
				"\n- create_tasks: Decompose the objective into a task list (call once at goal start). Each task description must be a one-line summary (max 60 chars), no newlines or markdown. Accept verifications array for task verification." +
				"\n- add_tasks: Append new tasks to the existing list (when omissions are discovered). Each task description must be a one-line summary (max 60 chars), no newlines or markdown. Accept verifications array." +
				"\n- update_tasks: Batch update task statuses. Must follow state machine: pending→in_progress→completed→verified. Cannot skip states. Completed requires evidence. Cancelled does not block goal completion. Completing a task with verification triggers a verification prompt — then call update_tasks with status=verified and actual=<result>." +
				"\n- list_tasks: View progress and remaining budget" +
				"\n- complete_goal: Mark the objective as achieved (all tasks must be completed or verified + evidence)" +
				"\n- cancel_goal: Cancel the current goal (use when user wants to exit/stop)" +
				"\n- report_blocked: Report being blocked (use when encountering unsolvable issues)" +
				"\n- add_subtasks: Add subtasks to a specified task (params: taskId, texts[]). Use this instead of todo tool in Goal mode" +
				"\n- update_subtasks: Batch update subtask statuses (params: taskId, subUpdates[])" +
				"\n- delete_subtasks: Delete subtasks from a specified task (params: taskId, subIds[])",
		promptSnippet: "Manage task list, completion status, and exit for /goal mode",
		promptGuidelines: [
			"[Workflow] After receiving the objective, the first step must be create_tasks to decompose. Do not re-call if task list already exists",
			"[Status flow] Tasks must follow this order: pending → in_progress → completed → verified. You CANNOT skip in_progress. Before marking completed, always set status=in_progress first. Transitions: pending→in_progress | pending→cancelled, in_progress→completed | in_progress→cancelled, completed→verified (only if task has verification)",
			"[Format] Each task description must be a one-line summary, max 60 chars. No newlines, markdown, or detailed parameter lists — those go in execution phase. Example: 'Fix hook-registry dedup logic' not 'Fix hook-registry dedup + transport-execute enhancementConfig guard + failover-loop ...'",
			"[Append] When discovering omissions during execution, use add_tasks to append — do not re-call create_tasks",
			"[Completion] After completing a task, call update_tasks with status=completed and provide evidence (e.g. 'test X passed', 'file F created')",
			"[Goal completion] Only call complete_goal when all tasks are completed or verified with overall evidence",
			"[Exit] When user says 'stop', 'exit', 'cancel', '不用了', '结束', etc. indicating they don't want to continue, immediately call cancel_goal — do not guide them through complete_goal",
			"[Blocked] When encountering unsolvable technical issues, call report_blocked with the reason",
			"[Progress] Use list_tasks anytime to check remaining tasks and budget",
			"[Cancel] To cancel a task, use update_tasks with status=cancelled. Cancelled tasks do not block goal completion",
			"[Forbidden] Do not mark tasks as completed without evidence, and do not call complete_goal without evidence",
			"[Forbidden] Do not force task completion when the user explicitly wants to exit — call cancel_goal directly",
			"[Quick exit] When no tasks have been created and you determine the objective is already met, call cancel_goal with cancelReason instead of creating tasks",
			"[Forbidden] Do not re-call create_tasks to overwrite existing incomplete tasks — use add_tasks to append",
			"[Subtask] For fine-grained step tracking in Goal mode, use add_subtasks — do not use the todo tool",
			"[Verification] Each task should have a concrete verification method. Use verifications param in create_tasks/add_tasks. Templates:",
			"[Verification] - Command: method='pnpm --filter <pkg> typecheck', expected='zero type errors'",
			"[Verification] - Test: method='pnpm --filter <pkg> test', expected='all tests pass'",
			"[Verification] - File: method='check <path> exists and contains <content>', expected='file exists with matching content'",
			"[Verification] - Manual: method='manual check <specific items>', expected='<expected result'",
			"[Verification] Multiple related tasks can share one verification — set verification on the LAST related task only",
			"[Verification] Do NOT create a separate 'run tests' task for verification — use verification field instead",
			"[Verification] When a task with verification is completed, run the verification command with bash. Then call update_tasks with status=verified and actual=<result>",
		],
		parameters: GoalManagerParams,

		async execute(_toolCallId: string, params: Static<typeof GoalManagerParams>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			lastCtx = ctx;
			try {
				// P1-4: 透传 signal
				return await executeGoalAction(pi, session, params, ctx, signal);
			} catch (err) {
				// P1-2: Stale context 检测 — 静默吞掉
				if (isStaleContextError(err)) {
					return {
						content: [{ type: "text" as const, text: "Goal context stale after compact or session replacement." }],
						isError: true as const,
					};
				}
				const msg = err instanceof Error ? err.message : String(err);
				const inputSummary = JSON.stringify(params, null, 2); // eslint-disable-line no-magic-numbers -- JSON.stringify indent
				return {
					content: [{ type: "text", text: `${msg}\n\nInput: ${inputSummary}` }],
					isError: true,
				};
			}
		},

		renderCall(args: Static<typeof GoalManagerParams>, theme: Theme) {
			let text = theme.fg("toolTitle", theme.bold("goal_manager ")) + theme.fg("muted", args.action);
			if (args.tasks) text += ` ${theme.fg("dim", `(${args.tasks.length} tasks)`)}`;
			if (args.updates) text += ` ${theme.fg("dim", `(${args.updates.length} updates)`)}`;
			if (args.taskId !== undefined) text += ` ${theme.fg("accent", `#${args.taskId}`)}`;
			if (args.texts) text += ` ${theme.fg("dim", `(${args.texts.length} subtasks)`)}`;
			if (args.subUpdates) text += ` ${theme.fg("dim", `(${args.subUpdates.length} subtask updates)`)}`;
			if (args.subIds) text += ` ${theme.fg("dim", `del #${args.subIds.join(",")}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result: LikeToolResult, { expanded }: LikeToolRenderResultOptions, theme: Theme) {
			const details = result.details as GoalManagerDetails | undefined;
			if (!details || !Array.isArray(details.tasks)) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
			}
			const tasks = details.tasks;
			const completed = getCompletedCount(tasks);
			const summary = theme.fg("success", `✓ ${completed}/${tasks.length} completed`);
			if (!expanded || tasks.length === 0) {
				return new Text(summary, 0, 0);
			}
			const lines = [summary];
			for (const t of tasks) {
				const icon = t.status === "verified"
					? theme.fg("success", "◉")
					: t.status === "completed"
						? theme.fg("success", "✓")
						: t.status === "in_progress"
							? theme.fg("warning", "●")
							: t.status === "cancelled"
								? theme.fg("dim", "✗")
								: theme.fg("dim", "☐");
				const descText = toSingleLine(t.description);
				const desc = (t.status === "verified" || t.status === "completed" || t.status === "cancelled")
					? theme.fg("dim", descText)
					: theme.fg("text", descText);
				lines.push(`  ${icon} ${theme.fg("accent", `#${t.id}`)} ${desc}`);
			// Subtask items in expanded view — collapse when all completed
			if (t.subtasks && t.subtasks.length > 0) {
				const allSubCompleted = t.subtasks.every((s: { status: string }) => s.status === "completed");
				if (!allSubCompleted) {
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
		}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// ── Command: /goal ─────────────────────────────────

	pi.registerCommand("goal", {
		description:
			"Goal-driven mode: /goal <objective> [--tokens N] [--timeout N] [--max-turns N] | /goal pause | /goal resume | /goal abort | /goal clear | /goal update <new-objective> | /goal status | /goal history",
		handler: async (args: string | undefined, ctx: ExtensionCommandContext) => {
			await handleGoalCommand(pi, session, args, ctx);
		},
	});

	// ── Event: before_agent_start ──────────────────────
	pi.on("before_agent_start", async (_event: BeforeAgentStartLikeEvent, ctx: ExtensionContext) => {
		lastCtx = ctx;
		return handleBeforeAgentStart(pi, session, ctx);
	});

	// ── Event: agent_start ─────────────────────────────

	pi.on("agent_start", async () => {
		if (!session.state || !isActiveStatus(session.state.status)) return;
		session.tasksCompletedAtAgentStart = getCompletedCount(session.state.tasks);
	});

	// ── Event: turn_end ────────────────────────────────
	pi.on("turn_end", async (_event: TurnEndLikeEvent, ctx: ExtensionContext) => {
		if (!session.state) return;
		session.state.currentTurnIndex++;
		updateWidget(session, ctx);
	});

	// ── Event: message_end (token accounting) ──────────
	pi.on("message_end", async (event: MessageEndLikeEvent, _ctx: ExtensionContext) => {
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
	pi.on("agent_end", async (_event: AgentEndLikeEvent, ctx: ExtensionContext) => {
		await handleAgentEnd(pi, session, ctx);
	});

	// ── Event: session_start (state reconstruction) ───
	pi.on("session_start", async (_event: SessionStartLikeEvent, ctx: ExtensionContext) => {
		lastCtx = ctx;
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
		pi.registerMessageRenderer(customType, (message: LikeCustomMessage, _options: LikeMessageRenderOptions, theme: Theme) => {
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

	// ── External API: initializeGoalFromExternal ──────────

	/**
	 * Allow other extensions (e.g. coding-workflow) to programmatically initialize a goal.
	 * Skips the /goal command flow — directly creates state + tasks.
	 * Returns true if initialized, false if goal already active.
	 */
	function initializeGoalFromExternal(
		objective: string,
		tasks: string[],
		budget?: { tokenBudget?: number; timeBudgetMinutes?: number; maxTurns?: number },
	): boolean {
		if (session.state && isActiveStatus(session.state.status)) {
			return false;
		}

		session.state = createInitialState(objective, budget);
		session.tasksCompletedAtAgentStart = 0;

		// Create tasks (same logic as handleCreateTasks)
		session.state.tasks = tasks.map((desc, i) => ({
			id: i + 1,
			description: desc.length > EXT_INIT_TASK_DESC_MAX ? desc.slice(0, EXT_INIT_TASK_DESC_MAX - ELLIPSIS_LENGTH) + "..." : desc,
			status: "pending" as const,
			lastUpdatedTurn: session.state!.currentTurnIndex,
		}));

		// Persist state so it survives session reconstruction
		// Note: ctx is captured from the last event handler invocation — acceptable
		// because initializeGoalFromExternal is called synchronously during tool execution.
		if (lastCtx) {
			persistGoalState(pi, session, lastCtx);
		}

		return true;
	}

	// Expose on pi for cross-extension access
	const api = pi as unknown as Record<string, unknown>;
	api.__goalInit = initializeGoalFromExternal satisfies GoalExternalInit;
}
