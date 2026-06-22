/**
 * Service 协调层 — 双入口（applyToolAction / applyEvent）
 *
 * D-21: 不合并为单一 applyCommand。命令/事件路径在触发方/返回值/并发模型上全不同。
 * engine 层纯函数是真正共享层。
 *
 * D-16: service 不持有 ctx，通过 ports 参数接收能力。
 *
 * FR-3.1: createGoal 唯一创建入口（三个调用源都走它）
 * FR-3.3: finalizeGoal 唯一完成入口（按矩阵决定 writeHistory + clearSession）
 * FR-6.5: persist 前调 tick 累计时间
 */

import { accumulateTokens, checkBudgetOnResume, tick } from "./engine/budget";
import { createGoalState, isActiveStatus, isTerminalStatus, transitionStatus } from "./engine/goal";
import type { GoalTask, Subtask, TaskVerification } from "./engine/task";
import { getNextTaskId, isTaskDone, isTerminalTaskStatus, validateTaskTransition } from "./engine/task";
import type { BudgetConfig, GoalRuntimeState, GoalStatus } from "./engine/types";
import { makeHistoryEntry, serializeState } from "./persistence";
import type {
	GoalHistoryEntry,
	MessagingPort,
	PersistencePort,
	SessionPort,
	UiPort,
} from "./ports";
import { formatTaskList } from "./projection/prompts";
import type { GoalSession } from "./session";
import { clearGoalSession } from "./session";

// ── Ports 组合 ────────────────────────────────────────

export interface ServicePorts {
	persistence: PersistencePort;
	ui: UiPort;
	messaging: MessagingPort;
	session: SessionPort;
}

// ── Tool action 结果（路径 A）─────────────────────────

export interface ToolActionResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	details?: { action: string; tasks: GoalTask[]; goalId: string; status: string };
}

// ── Event 效果（路径 B）───────────────────────────────

export type EventEffect =
	| { kind: "sendContextMessage"; content: string; deliverAs: "steer" | "followUp"; customType?: string }
	| { kind: "sendUserMessage"; content: string; deliverAs: "steer" | "followUp" }
	| { kind: "notify"; text: string; level: "info" | "warning" | "error" }
	| { kind: "clearSession" }
	| { kind: "updateWidget" };

// ── 持久化辅助 ────────────────────────────────────────

/** FR-6.5: persist 前调 tick 累计时间，然后 serialize + appendState */
function persistState(session: GoalSession, ports: ServicePorts): void {
	if (!session.state) return;
	const state = session.state;
	const isRunning = isActiveStatus(state.status);
	const ticked = tick(state.timeStartedAt, state.timeUsedSeconds, Date.now(), isRunning);
	state.timeUsedSeconds = ticked.timeUsedSeconds;
	state.timeStartedAt = ticked.timeStartedAt;
	ports.persistence.appendState(serializeState(state));
}

// ── 描述归一化 ────────────────────────────────────────

/** 描述归一化：单行 + 去多余空白 + 截断（external init 更严格）。纯函数。 */
function normalizeDescription(desc: string, maxLength: number, ellipsis: number): string {
	const singleLine = desc.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
	if (singleLine.length > maxLength) {
		return singleLine.slice(0, maxLength - ellipsis) + "...";
	}
	return singleLine;
}

// ── FR-3.1 唯一创建入口 ──────────────────────────────

/**
 * 唯一创建入口。三个调用源都走它：
 * - /goal set（command-adapter）
 * - create_tasks（tool-adapter → actions）
 * - __goalInit（index.ts，isExternalInit=true）
 *
 * task 构造逻辑唯一（normalizeDescription + id 分配）。
 * isExternalInit=true 时不触发 sendUserMessage（__goalInit 不触发 AI）。
 *
 * @returns true 如果创建成功，false 如果已有 active goal（拒绝创建）
 */
export function createGoal(
	session: GoalSession,
	objective: string,
	tasks: GoalTask[] | string[],
	budget: Partial<BudgetConfig>,
	ports: ServicePorts,
	isExternalInit: boolean,
): boolean {
	// 已有 active goal → 拒绝
	if (session.state && isActiveStatus(session.state.status)) {
		return false;
	}

	session.state = createGoalState(objective, budget);
	session.tasksCompletedAtAgentStart = 0;

	// 统一 task 构造（消除双轨）
	const taskDescs = toDescriptions(tasks);
	const EXT_INIT_TASK_DESC_MAX = 60;
	const TASK_DESC_MAX = 80;
	const ELLIPSIS_LENGTH = 3;
	const maxLength = isExternalInit ? EXT_INIT_TASK_DESC_MAX : TASK_DESC_MAX;
	session.state.tasks = taskDescs.map((desc, i) => ({
		id: i + 1,
		description: normalizeDescription(desc, maxLength, ELLIPSIS_LENGTH),
		status: "pending" as const,
		lastUpdatedTurn: session.state!.currentTurnIndex,
	}));

	persistState(session, ports);
	return true;
}

/** 区分 string[] vs GoalTask[]，统一输出描述数组。 */
function toDescriptions(tasks: GoalTask[] | string[]): string[] {
	if (tasks.length === 0) return [];
	const first = tasks[0];
	if (typeof first === "string") {
		return tasks as string[];
	}
	return (tasks as GoalTask[]).map((t) => t.description);
}

// ── FR-3.3 唯一完成入口 ──────────────────────────────

/**
 * 唯一完成入口。按 FR-8.7 矩阵：所有终态都写 history（paused/blocked 不走此入口）。
 *
 * 注意：finalizeGoal 只负责状态变更 + 写 history。
 * clearSession 由调用方（command-adapter/event-adapter）根据 options.clearImmediately
 * 决定是否在 finalizeGoal 之后执行（cancelled → 立即 clearSession）。
 */
export function finalizeGoal(
	state: GoalRuntimeState,
	terminalStatus: GoalStatus,
	ports: ServicePorts,
	options: { clearImmediately: boolean; completedTasks: number },
): void {
	state.status = transitionStatus(state.status, terminalStatus);
	state.completedAtTurnIndex = state.currentTurnIndex;

	// FR-8.7: 所有终态都写 history（paused/blocked 不走此入口）
	const entry: GoalHistoryEntry = makeHistoryEntry(state, options.completedTasks);
	ports.persistence.appendHistory(entry);
}

// ── 路径 A：applyToolAction ───────────────────────────

/**
 * 路径 A 入口。同步，返回 ToolActionResult。
 *
 * 实现 10 个 goal_manager action（全部 mutation + 只读的 list_tasks 集中此处）：
 * - 核心状态变更（5）：create_tasks / update_tasks / complete_goal / cancel_goal / report_blocked
 * - 任务追加（4）：add_tasks / add_subtasks / update_subtasks / delete_subtasks
 * - 只读（1）：list_tasks（G-005：不 persist、不 updateWidget，仅格式化 tasks 到 result 文本）
 *
 * service.applyToolAction 负责：校验 → engine 纯函数变更 state → persist（FR-6.5）。
 */
export function applyToolAction(
	session: GoalSession,
	action: string,
	params: Record<string, unknown>,
	ports: ServicePorts,
): ToolActionResult {
	if (!session.state) {
		return errorResult("Goal mode not active. Use /goal <objective> to start.");
	}

	switch (action) {
		case "create_tasks":
			return actionCreateTasks(session, params, ports);
		case "update_tasks":
			return actionUpdateTasks(session, params, ports);
		case "complete_goal":
			return actionCompleteGoal(session, params, ports);
		case "cancel_goal":
			return actionCancelGoal(session, params, ports);
		case "report_blocked":
			return actionReportBlocked(session, params, ports);
		case "add_tasks":
			return actionAddTasks(session, params, ports);
		case "add_subtasks":
			return actionAddSubtasks(session, params, ports);
		case "update_subtasks":
			return actionUpdateSubtasks(session, params, ports);
		case "delete_subtasks":
			return actionDeleteSubtasks(session, params, ports);
		case "list_tasks":
			return actionListTasks(session);
		default:
			return errorResult(`Action ${action} not supported by goal_manager tool`);
	}
}

// ── action 实现（核心状态变更 + persist）──────────────

function actionCreateTasks(
	session: GoalSession,
	params: Record<string, unknown>,
	_ports: ServicePorts,
): ToolActionResult {
	const state = session.state!;
	const tasks = params.tasks as string[] | undefined;
	if (!tasks || tasks.length === 0) {
		return errorResult("create_tasks requires a non-empty tasks array");
	}
	// FR-8.8: 保持当前行为（D-19 拆出独立 ticket）——有未完成才拒绝，all-complete 覆盖
	const existingIncomplete = state.tasks.filter((t) => !isTaskDone(t));
	if (state.tasks.length > 0 && existingIncomplete.length > 0) {
		return errorResult(
			`Already has ${state.tasks.length} tasks (${existingIncomplete.length} incomplete). Use add_tasks to append, or /goal update to re-plan.`,
		);
	}
	const verifications = params.verifications as GoalTask["verification"][] | undefined;
	state.tasks = tasks.map((desc, i) => ({
		id: i + 1,
		description: normalizeDescription(desc, 80, 3),
		status: "pending" as const,
		verification: verifications?.[i],
		lastUpdatedTurn: state.currentTurnIndex,
	}));
	return makeResult(session, `Created ${state.tasks.length} tasks`);
}

function actionUpdateTasks(
	session: GoalSession,
	params: Record<string, unknown>,
	ports: ServicePorts,
): ToolActionResult {
	const state = session.state!;
	const updates = params.updates as Array<{
		taskId: number;
		status: GoalTask["status"];
		evidence?: string;
		actual?: string;
	}> | undefined;
	if (!updates || updates.length === 0) {
		return errorResult("update_tasks requires a non-empty updates array");
	}

	// 校验：重复 taskId
	const taskIds = updates.map((u) => u.taskId);
	const dupes = taskIds.filter((id, i) => taskIds.indexOf(id) !== i);
	if (dupes.length > 0) {
		return errorResult(`Duplicate taskIds: ${[...new Set(dupes)].join(", ")}`);
	}

	const tasksNeedingVerification: GoalTask[] = [];

	for (const u of updates) {
		const task = state.tasks.find((t) => t.id === u.taskId);
		if (!task) return errorResult(`Task #${u.taskId} not found`);

		// 终态检查（verified/cancelled 不可变）
		if (task.status === "verified" || task.status === "cancelled") {
			return errorResult(`Task #${task.id} in terminal state (${task.status}), cannot be changed`);
		}
		// FR-8.3 G-017: completed 无 verification 全锁（连 cancel 都拒绝）
		if (task.status === "completed" && !task.verification) {
			return errorResult(`Task #${task.id} already completed, cannot be changed`);
		}
		// completed 有 verification：只允许 verified
		if (task.status === "completed" && task.verification && u.status !== "verified") {
			return errorResult(`Task #${task.id} completed but requires verification. Call update_tasks with status=verified.`);
		}

		// status 级转换校验
		const transitionErr = validateTaskTransition(task.status, u.status);
		if (transitionErr) {
			return errorResult(`Task #${task.id}: ${transitionErr}`);
		}

		// completed 必须有 evidence
		if (u.status === "completed" && (!u.evidence || u.evidence.trim() === "")) {
			return errorResult(`Task #${task.id}: completed requires evidence`);
		}
		// verified 必须有 actual + verification 配置
		if (u.status === "verified") {
			if (!u.actual || u.actual.trim() === "") {
				return errorResult(`Task #${task.id}: verified requires actual verification result`);
			}
			if (!task.verification) {
				return errorResult(`Task #${task.id}: cannot verify a task without verification config`);
			}
		}

		// 执行变更
		task.lastUpdatedTurn = state.currentTurnIndex;
		if (u.status === "completed") {
			task.status = "completed";
			task.evidence = u.evidence;
			if (task.verification) tasksNeedingVerification.push(task);
		} else if (u.status === "verified") {
			task.status = "verified";
			task.verification!.actual = u.actual;
		} else {
			task.status = u.status;
		}
	}

	// FR-8.9: verification steering
	if (tasksNeedingVerification.length > 0) {
		const lines = tasksNeedingVerification.map((t) =>
			`Task #${t.id} requires verification. Run: ${t.verification!.method} (expected: ${t.verification!.expected})\n` +
			`Then call update_tasks with taskId=${t.id}, status="verified", actual=<result>.`,
		).join("\n\n");
		ports.messaging.sendContextMessage(
			`[GOAL Verification] Task(s) completed with verification pending:\n${lines}`,
			"steer",
		);
	}

	return makeResult(session, `Updated ${updates.length} task actions`);
}

function actionCompleteGoal(
	session: GoalSession,
	params: Record<string, unknown>,
	ports: ServicePorts,
): ToolActionResult {
	const state = session.state!;
	const evidence = params.evidence as string | undefined;
	if (!evidence || evidence.trim() === "") {
		return errorResult("complete_goal requires evidence");
	}
	if (state.tasks.length === 0) {
		return errorResult("Create a task list with create_tasks before completing the goal.");
	}
	// 检查所有 task 都 done
	const notDone = state.tasks.filter((t) => !isTaskDone(t));
	if (notDone.length > 0) {
		return errorResult(`${notDone.length} tasks not done: ${notDone.map((t) => `#${t.id}`).join(", ")}. Complete them first.`);
	}
	// FR-8.10: 全 cancelled 守卫
	const completedOrVerified = state.tasks.filter((t) => t.status === "completed" || t.status === "verified");
	if (completedOrVerified.length === 0) {
		return errorResult("At least one task must be completed or verified. All-cancelled does not count.");
	}

	// finalizeGoal
	const completedCount = completedOrVerified.length;
	finalizeGoal(state, "complete", ports, { clearImmediately: false, completedTasks: completedCount });
	persistState(session, ports);
	return makeResult(session, `Objective completed! Evidence: ${evidence}`);
}

function actionCancelGoal(
	session: GoalSession,
	params: Record<string, unknown>,
	ports: ServicePorts,
): ToolActionResult {
	const state = session.state!;
	if (isTerminalStatus(state.status)) {
		return errorResult(`Goal is already in terminal state (${state.status}).`);
	}
	const reason = (params.cancelReason as string) ?? "User requested cancellation";
	const completedCount = state.tasks.filter((t) => t.status === "completed" || t.status === "verified").length;
	finalizeGoal(state, "cancelled", ports, { clearImmediately: true, completedTasks: completedCount });
	persistState(session, ports);
	// FR-8.7: cancelled → 立即 clearSession
	clearGoalSession(session, ports.ui);
	return {
		content: [{ type: "text", text: `Goal cancelled: ${reason}` }],
		details: { action: "cancel", tasks: [], goalId: state.goalId, status: "cancelled" },
	};
}

function actionReportBlocked(
	session: GoalSession,
	params: Record<string, unknown>,
	ports: ServicePorts,
): ToolActionResult {
	const state = session.state!;
	const reason = params.reason as string | undefined;
	if (!reason || reason.trim() === "") {
		return errorResult("report_blocked requires reason");
	}
	// FR-8.7: blocked 是中间态，不走 finalizeGoal，不写 history
	state.lastBlockerReason = reason;
	state.status = transitionStatus(state.status, "blocked");
	persistState(session, ports);
	return makeResult(session, `Blocked reported. Reason: ${reason}`);
}

// ── 追加 / 只读 action（FR-3 范围内）──────────────────

function actionAddTasks(
	session: GoalSession,
	params: Record<string, unknown>,
	ports: ServicePorts,
): ToolActionResult {
	const state = session.state!;
	const tasks = params.tasks as string[] | undefined;
	if (!tasks || tasks.length === 0) {
		return errorResult("add_tasks requires a non-empty tasks array");
	}
	const startId = getNextTaskId(state.tasks);
	const verifications = params.verifications as TaskVerification[] | undefined;
	const newTasks: GoalTask[] = tasks.map((desc, i) => ({
		id: startId + i,
		description: normalizeDescription(desc, 80, 3),
		status: "pending" as const,
		verification: verifications?.[i],
		lastUpdatedTurn: state.currentTurnIndex,
	}));
	state.tasks.push(...newTasks);
	persistState(session, ports);
	return makeResult(
		session,
		`Appended ${newTasks.length} tasks:\n${newTasks
			.map((t) => `  #${t.id}: ${t.description}${t.verification ? ` [验证: ${t.verification.method}]` : ""}`)
			.join("\n")}`,
	);
}

function actionAddSubtasks(
	session: GoalSession,
	params: Record<string, unknown>,
	ports: ServicePorts,
): ToolActionResult {
	const state = session.state!;
	const taskId = params.taskId as number | undefined;
	if (taskId === undefined) return errorResult("add_subtasks requires taskId");
	const texts = params.texts as string[] | undefined;
	if (!texts || texts.length === 0) {
		return errorResult("add_subtasks requires a non-empty texts array");
	}
	const parentTask = state.tasks.find((t) => t.id === taskId);
	if (!parentTask) return errorResult(`Task #${taskId} not found`);
	// FR-8.11（G-R4-004）：isTerminalTaskStatus 不含 completed（completed 有 verification 时需转 verified），
	// 这里的 || completed 是有意的业务决策：completed 任务不允许加 subtask（D-20）
	if (isTerminalTaskStatus(parentTask.status) || parentTask.status === "completed") {
		return errorResult(`Task #${parentTask.id} in terminal state (${parentTask.status}), cannot add subtask`);
	}
	const subtasks = parentTask.subtasks ?? [];
	const startId = subtasks.length > 0 ? Math.max(...subtasks.map((s) => s.id)) + 1 : 1;
	const trimmed = texts.map((t) => t.trim()).filter((t) => t.length > 0);
	if (trimmed.length === 0) return errorResult("texts requires at least one non-empty string");
	const newSubtasks: Subtask[] = trimmed.map((text, i) => ({
		id: startId + i,
		text,
		status: "pending" as const,
		lastUpdatedTurn: state.currentTurnIndex,
	}));
	parentTask.subtasks = [...subtasks, ...newSubtasks];
	persistState(session, ports);
	return makeResult(
		session,
		`Added ${newSubtasks.length} subtasks to Task #${parentTask.id}:\n` +
			newSubtasks.map((s) => `  - #${parentTask.id}.${s.id}: ${s.text}`).join("\n"),
	);
}

function actionUpdateSubtasks(
	session: GoalSession,
	params: Record<string, unknown>,
	ports: ServicePorts,
): ToolActionResult {
	const state = session.state!;
	const taskId = params.taskId as number | undefined;
	if (taskId === undefined) return errorResult("update_subtasks requires taskId");
	const subUpdates = params.subUpdates as Array<{ subId: number; status: Subtask["status"] }> | undefined;
	if (!subUpdates || subUpdates.length === 0) {
		return errorResult("update_subtasks requires a non-empty subUpdates array");
	}
	const targetTask = state.tasks.find((t) => t.id === taskId);
	if (!targetTask) return errorResult(`Task #${taskId} not found`);
	if (!targetTask.subtasks || targetTask.subtasks.length === 0) {
		return errorResult(`Task #${taskId} has no subtasks`);
	}
	const results: string[] = [];
	for (const u of subUpdates) {
		const sub = targetTask.subtasks.find((s) => s.id === u.subId);
		if (!sub) return errorResult(`Subtask #${taskId}.${u.subId} not found`);
		// FR-8.3 G-018：subtask 宽松状态机——唯一守卫：completed 不可变更
		if (sub.status === "completed") {
			return errorResult(`Subtask #${taskId}.${sub.id} already completed, cannot be changed`);
		}
		const prev = sub.status;
		sub.status = u.status;
		sub.lastUpdatedTurn = state.currentTurnIndex;
		results.push(`#${taskId}.${sub.id}: ${prev} → ${u.status}`);
	}
	persistState(session, ports);
	return makeResult(session, `Updated ${results.length} subtasks:\n${results.join("\n")}`);
}

function actionDeleteSubtasks(
	session: GoalSession,
	params: Record<string, unknown>,
	ports: ServicePorts,
): ToolActionResult {
	const state = session.state!;
	const taskId = params.taskId as number | undefined;
	if (taskId === undefined) return errorResult("delete_subtasks requires taskId");
	const subIds = params.subIds as number[] | undefined;
	if (!subIds || subIds.length === 0) {
		return errorResult("delete_subtasks requires a non-empty subIds array");
	}
	const delTask = state.tasks.find((t) => t.id === taskId);
	if (!delTask) return errorResult(`Task #${taskId} not found`);
	if (!delTask.subtasks || delTask.subtasks.length === 0) {
		return errorResult(`Task #${taskId} has no subtasks`);
	}
	const uniqueIds = [...new Set(subIds)];
	const missing = uniqueIds.filter((id) => !delTask.subtasks!.some((s) => s.id === id));
	if (missing.length > 0) {
		return errorResult(`Subtask ${missing.map((id) => `#${taskId}.${id}`).join(", ")} not found`);
	}
	delTask.subtasks = delTask.subtasks.filter((s) => !uniqueIds.includes(s.id));
	// 行为保持：删空后 subtasks 置 undefined
	if (delTask.subtasks.length === 0) delTask.subtasks = undefined;
	persistState(session, ports);
	return makeResult(
		session,
		`Deleted ${uniqueIds.length} subtasks, Task #${taskId} has ${delTask.subtasks?.length ?? 0} remaining`,
	);
}

/**
 * list_tasks — 只读：格式化当前任务列表到 result 文本。
 *
 * G-005：只读 action 不 persist、不 updateWidget。仅调用 projection/formatTaskList
 * 渲染（纯渲染函数，无副作用）。复用而非内联，保持渲染逻辑单一定义点。
 */
function actionListTasks(session: GoalSession): ToolActionResult {
	const state = session.state!;
	return makeResult(session, formatTaskList(state.tasks));
}

// ── 路径 B：applyEvent ────────────────────────────────

/**
 * 路径 B 入口。异步事件，返回 EventEffect[]。
 * 并发保护（isProcessing / stale-check）在 event-adapter，不在此层。
 *
 * 本函数作为简单事件的统一入口（message_end / turn_end / agent_start）。
 * 复杂事件（before_agent_start / agent_end / session_start）由 event-adapter
 * 直接实现，调 engine 纯函数 + service 辅助函数。
 */
export function applyEvent(
	session: GoalSession,
	eventType: string,
	eventData: unknown,
	_ports: ServicePorts,
): EventEffect[] {
	const effects: EventEffect[] = [];
	if (!session.state) return effects;

	switch (eventType) {
		case "message_end": {
			// token 累加（FR-8.6）—— 复用 engine 纯函数
			const data = eventData as {
				message?: {
					role?: string;
					usage?: { input?: number; output?: number; cacheRead?: number; totalTokens?: number };
				};
			};
			if (data?.message?.role !== "assistant") break;
			const usage = data.message.usage;
			if (!usage) break;
			session.state.tokensUsed = accumulateTokens(session.state.tokensUsed, usage);
			break;
		}
		case "turn_end":
			session.state.currentTurnIndex++;
			effects.push({ kind: "updateWidget" });
			break;
		case "agent_start":
			if (isActiveStatus(session.state.status)) {
				// 字段在 session 上，不在 session.state 上
				session.tasksCompletedAtAgentStart = session.state.tasks.filter(
					(t) => t.status === "completed" || t.status === "verified",
				).length;
			}
			break;
	}

	return effects;
}

// ── resume 预算重检（供 command-adapter 调用）─────────

export function checkResumeBudget(
	state: GoalRuntimeState,
): { type: "exceeded"; dimension: "token" | "time" } | null {
	return checkBudgetOnResume(state);
}

// ── 结果构造辅助 ──────────────────────────────────────

function makeResult(session: GoalSession, text: string): ToolActionResult {
	const state = session.state!;
	return {
		content: [{ type: "text", text }],
		details: {
			action: "update",
			tasks: state.tasks.map((t) => ({ ...t })),
			goalId: state.goalId,
			status: state.status,
		},
	};
}

function errorResult(message: string): ToolActionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
	};
}
