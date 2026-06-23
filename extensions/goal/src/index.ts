/**
 * Pi /goal Extension — 工厂入口（重构后架构）
 *
 * 注册 tool / command / events，全部委托 adapters 层。
 * __goalInit 内部调 service.createGoal（FR-4.1 双轨消除）。
 *
 * 架构（D-21 双路径 + Ports/Adapters）：
 * - engine/：零 Pi 依赖的纯状态机（task/goal/budget/types）
 * - ports.ts：机器可检查的能力边界
 * - service.ts：双入口协调器（applyToolAction / applyEvent）
 * - adapters/：Pi 桥接（tool-adapter / command-adapter / event-adapter / actions）
 * - projection/：渲染（widget / prompts / result）
 *
 * 行为契约（与重构前等价，AC-4）：
 * - goal_manager tool schema 不变
 * - /goal 命令子命令不变（8 个）
 * - 6 个事件 handler 覆盖 Pi 的 6 个事件
 *
 * FR-4.2/D-16：ctx 必填，移除 lastCtx 模块级可变状态。
 * FR-6.4：移除 hasPendingInjection。
 * FR-6.7：移除 pendingPause（ESC 改用 ctx.signal.aborted 守卫，在 event-adapter）。
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static } from "typebox";

import { handleGoalCommand } from "./adapters/command-adapter";
import {
	handleAgentEnd,
	handleAgentStart,
	handleBeforeAgentStart,
	handleMessageEnd,
	handleSessionStart,
	handleTurnEnd,
} from "./adapters/event-adapter";
import { buildPorts, executeGoalAction, GoalManagerParams } from "./adapters/tool-adapter";
import { getCompletedCount } from "./engine/task";
import { type GoalManagerDetails } from "./projection/result";
import { toSingleLine } from "./projection/widget";
import { createGoal } from "./service";
import { createGoalSession, type GoalSession, isStaleContextError } from "./session";

// ── Local Interfaces (Like*Event — 避免 any on Pi callback/event signatures) ────

interface BeforeAgentStartLikeEvent {
	type: "before_agent_start";
	prompt: string;
	systemPrompt: string;
}

interface TurnEndLikeEvent {
	type: "turn_end";
	turnIndex: number;
}

interface MessageEndLikeEvent {
	type: "message_end";
	message: {
		role: string;
		usage?: { input?: number; output?: number; cacheRead?: number; totalTokens?: number };
	};
}

interface AgentEndLikeEvent {
	type: "agent_end";
	messages: unknown[];
}

interface SessionStartLikeEvent {
	type: "session_start";
	reason: string;
}

interface LikeCustomMessage {
	customType: string;
	content: string | unknown;
}

interface LikeMessageRenderOptions {
	expanded: boolean;
}

interface LikeToolResult {
	content: Array<{ type: string; text?: string }>;
	details?: GoalManagerDetails;
}

interface LikeToolRenderResultOptions {
	expanded: boolean;
}

/** JSON.stringify 缩进空格数（错误诊断输出用） */
const JSON_INDENT = 2;

// ── Extension Factory ─────────────────────────────────

export default function goalExtension(pi: ExtensionAPI) {
	const session: GoalSession = createGoalSession();

	// ── Tool: goal_manager ────────────────────────────

	pi.registerTool({
		name: "goal_manager",
		label: "Goal Manager",
		description:
			"Goal mode task manager. This tool is only available after starting a goal via the /goal command. AI cannot trigger it proactively. If Goal mode is not active, calling this tool will error." +
			"\n\nAvailable actions:" +
			"\n- create_tasks: Decompose the objective into a task list (call once at goal start). Each task description must be a one-line summary (max 60 chars), no newlines or markdown. Accept verifications array for task verification." +
			"\n- add_tasks: Append new tasks to the existing list (when omissions are discovered). Fails if no tasks exist yet — use create_tasks first. Each task description must be a one-line summary (max 60 chars), no newlines or markdown. Accept verifications array." +
			"\n- update_tasks: Batch update task statuses. Must follow state machine: pending→in_progress→completed→verified. Cannot skip states (pending→completed is forbidden). Exactly one task should be in_progress at a time. Completed requires evidence. Cancelled does not block goal completion. Completing a task with verification triggers a verification prompt — then call update_tasks with status=verified and actual=<result>." +
			"\n- list_tasks: View progress and remaining budget" +
			"\n- complete_goal: Mark the objective as achieved. Only call when ALL tasks are completed or verified with concrete evidence. Do not mark complete merely because the budget is nearly exhausted or because you are stopping work. Before calling, use list_tasks to verify all tasks are done." +
			"\n- cancel_goal: Cancel the current goal (use when user wants to exit/stop)" +
			"\n- report_blocked: Report being blocked. Only use after trying at least 3 alternative approaches to the same blocking condition. Do not use merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification. Requires a specific reason describing what is blocking and what you have already tried." +
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
			"[Blocked] Do not call report_blocked the first time a blocker appears. Try at least 3 alternative approaches first. Only report blocked when genuinely at an impasse without user input — not because work is hard, slow, uncertain, or incomplete. Once you call report_blocked, include what you have already tried in the reason.",
			"[Progress] Use list_tasks anytime to check remaining tasks and budget",
			"[Cancel] To cancel a task, use update_tasks with status=cancelled. Cancelled tasks do not block goal completion",
			"[Audit] Before marking a task completed, verify against actual current state (files, command output, test results). Intent, partial progress, or 'it should work' are NOT evidence. Do not redefine success around work already done — preserve original scope. Uncertain or indirect evidence means not completed, keep working.",
			"[Fidelity] Optimize for movement toward the requested end state, not the easiest passing change. Do not substitute a narrower or safer solution because it is easier to verify. An edit is aligned only if it makes the requested final state more true.",
			"[Forbidden] Do not mark tasks as completed without evidence, and do not call complete_goal without evidence. Do not mark completed due to budget exhaustion or because you are stopping work.",
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

		async execute(
			_toolCallId: string,
			params: Static<typeof GoalManagerParams>,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			try {
				// FR-4.2/D-16: ctx 必填（不再 fallback 到模块级 lastCtx）
				return await executeGoalAction(pi, session, params, ctx, signal);
			} catch (err) {
				// Stale context 检测 — 静默吞掉（compact/session 替换后）
				if (isStaleContextError(err)) {
					return {
						content: [{ type: "text" as const, text: "Goal context stale after compact or session replacement." }],
						isError: true as const,
					};
				}
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `${msg}\n\nInput: ${JSON.stringify(params, null, JSON_INDENT)}` }],
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
			const details = result.details;
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
				const icon =
					t.status === "verified"
						? theme.fg("success", "◉")
						: t.status === "completed"
							? theme.fg("success", "✓")
							: t.status === "in_progress"
								? theme.fg("warning", "●")
								: t.status === "cancelled"
									? theme.fg("dim", "✗")
									: theme.fg("dim", "☐");
				const descText = toSingleLine(t.description);
				const desc =
					t.status === "verified" || t.status === "completed" || t.status === "cancelled"
						? theme.fg("dim", descText)
						: theme.fg("text", descText);
				lines.push(`  ${icon} ${theme.fg("accent", `#${t.id}`)} ${desc}`);
				// Subtask items in expanded view — collapse when all completed
				if (t.subtasks && t.subtasks.length > 0) {
					const allSubCompleted = t.subtasks.every((s: { status: string }) => s.status === "completed");
					if (!allSubCompleted) {
						for (const s of t.subtasks) {
							const subIcon =
								s.status === "completed"
									? theme.fg("success", "✓")
									: s.status === "in_progress"
										? theme.fg("warning", "●")
										: theme.fg("dim", "○");
							const subText = s.status === "completed" ? theme.fg("dim", s.text) : theme.fg("muted", s.text);
							lines.push(`    ${subIcon} ${theme.fg("dim", `${t.id}.${s.id}`)} ${subText}`);
						}
					}
				}
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// ── Command: /goal ────────────────────────────────

	pi.registerCommand("goal", {
		description:
			"Goal-driven mode: /goal <objective> [--tokens N] [--timeout N] [--max-turns N] | /goal pause | /goal resume | /goal abort | /goal clear | /goal update <new-objective> | /goal status | /goal history",
		handler: async (args: string | undefined, ctx: ExtensionCommandContext) => {
			await handleGoalCommand(pi, session, args, ctx);
		},
	});

	// ── Events（全部委托 adapters/event-adapter）────────

	pi.on("before_agent_start", async (_event: BeforeAgentStartLikeEvent, ctx: ExtensionContext) => {
		return handleBeforeAgentStart(pi, session, ctx);
	});

	pi.on("agent_start", async () => {
		await handleAgentStart(session);
	});

	pi.on("turn_end", async (_event: TurnEndLikeEvent, ctx: ExtensionContext) => {
		await handleTurnEnd(pi, session, ctx);
	});

	pi.on("message_end", async (event: MessageEndLikeEvent, ctx: ExtensionContext) => {
		await handleMessageEnd(session, ctx, event);
	});

	pi.on("agent_end", async (_event: AgentEndLikeEvent, ctx: ExtensionContext) => {
		await handleAgentEnd(pi, session, ctx);
	});

	pi.on("session_start", async (_event: SessionStartLikeEvent, ctx: ExtensionContext) => {
		await handleSessionStart(pi, session, ctx);
	});

	// ── Message Renderers ──────────────────────────────

	const goalMessageTypes = ["goal-context", "goal-context-exceeded", "goal-staleness-reminder"];
	for (const customType of goalMessageTypes) {
		pi.registerMessageRenderer(
			customType,
			(message: LikeCustomMessage, _options: LikeMessageRenderOptions, theme: Theme) => {
				const prefix =
					message.customType === "goal-context-exceeded"
						? theme.fg("error", "[GOAL Budget] ")
						: message.customType === "goal-staleness-reminder"
							? theme.fg("warning", "[GOAL Reminder] ")
							: theme.fg("accent", "[GOAL] ");
				const content =
					typeof message.content === "string" ? message.content : JSON.stringify(message.content);
				return new Text(prefix + theme.fg("dim", content), 0, 0);
			},
		);
	}

	// ── External API: __goalInit（FR-4 双轨消除）──────────

	/**
	 * 允许其他扩展（coding-workflow / plan）通过 pi.__goalInit 编程式初始化 goal。
	 * 内部调 service.createGoal（FR-4.1 双轨消除——与 /goal set 走同一创建逻辑）。
	 *
	 * FR-4.2/D-16: ctx 必填（消除 lastCtx 模块级可变状态）。
	 * D-12: tasks 参数保留（核心价值是 task 构造逻辑唯一，不是砍参数）。
	 * ports 构造复用 tool-adapter.buildPorts（DRY：单一 ports 构造点）。
	 *
	 * @param objective 目标描述
	 * @param tasks 初始任务描述数组（空数组表示等待 AI 调 create_tasks）
	 * @param budget 预算配置，传 undefined 用默认值
	 * @param ctx **必填**——调用方的 ExtensionContext。省略会返回 false（创建失败）。
	 * @returns true 创建成功；false 已有 active goal 或 ctx 缺失
	 */
	const api = pi as unknown as Record<string, unknown>;
	api.__goalInit = (
		objective: string,
		tasks: string[],
		budget: GoalInitBudget | undefined,
		ctx: ExtensionContext,
	): boolean => {
		if (!ctx) return false;
		return createGoal(session, objective, tasks, budget ?? {}, buildPorts(pi, ctx), true);
	};
}

// ── Cross-extension API 类型（单一 source of truth，API-1）──────────

/**
 * `pi.__goalInit` 的预算配置形状。
 *
 * 跨扩展（coding-workflow / plan）通过 `pi.__goalInit` 编程式初始化 goal 时使用。
 * 与 `BudgetConfig` 的差异：本类型只暴露外部可设的 3 个可选字段（maxStallTurns
 * 不对外暴露，用默认值），且全部 optional。
 */
export interface GoalInitBudget {
	tokenBudget?: number;
	timeBudgetMinutes?: number;
	maxTurns?: number;
}

/**
 * `pi.__goalInit` 的规范函数签名（API-1：单一 source of truth）。
 *
 * 跨扩展消费者应 import 本类型而非重复声明 inline alias，避免签名 drift：
 * ```ts
 * import type { GoalInitFn } from "@zhushanwen/pi-goal";
 * const goalInit = (pi as unknown as { __goalInit?: GoalInitFn }).__goalInit;
 * ```
 *
 * @param objective 目标描述
 * @param tasks 初始任务描述数组（空数组表示等待 AI 调 create_tasks）
 * @param budget 预算配置，传 undefined 用默认值
 * @param ctx **必填**——调用方的 ExtensionContext。省略会返回 false（创建失败）。
 * @returns true 创建成功；false 已有 active goal 或 ctx 缺失
 */
export type GoalInitFn = (
	objective: string,
	tasks: string[],
	budget: GoalInitBudget | undefined,
	ctx: ExtensionContext,
) => boolean;
