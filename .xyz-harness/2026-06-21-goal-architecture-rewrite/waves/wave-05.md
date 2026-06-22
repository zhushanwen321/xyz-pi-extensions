# Wave 5: service.ts + service.test.ts

- **目标文件**：
  - 创建：`extensions/goal/src/service.ts`
  - 创建：`extensions/goal/src/__tests__/service.test.ts`
- **前置 wave**：Wave 2（engine/budget）、Wave 4（session.ts）
- **目标**：核心协调层。双入口（applyToolAction / applyEvent）+ 唯一创建（createGoal）+ 唯一完成（finalizeGoal）。调 engine 纯函数，通过 ports 接口做副作用。

## 关键约束

- service 不持有 ctx（D-16），通过 ports 参数接收能力
- `completed && !verification` 全锁逻辑在此层（validateTaskTransition 只看 status）
- FR-6.5：persist 前调 tick 累计时间
- FR-8.7：finalizeGoal 按 history 写入矩阵决定是否 writeHistory + clearSession
- 禁止 `any`

---

- [ ] **步骤 1：编写 service.ts**

创建 `extensions/goal/src/service.ts`：

```typescript
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

import { checkBudgetOnResume, tick } from "./engine/budget";
import { createGoalState, isActiveStatus, isTerminalStatus, transitionStatus } from "./engine/goal";
import type { GoalSession } from "./session";
import { clearGoalSession } from "./session";
import {
	type GoalTask,
	isTaskDone,
	validateTaskTransition,
} from "./engine/task";
import type { BudgetConfig, GoalRuntimeState, GoalStatus } from "./engine/types";
import { makeHistoryEntry, serializeState } from "./persistence";
import type { GoalHistoryEntry, PersistencePort, MessagingPort, SessionPort, UiPort } from "./ports";

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

/** persist + updateWidget 的统一入口 */
function persistAndUpdate(session: GoalSession, ports: ServicePorts): void {
	persistState(session, ports);
	effects_updateWidget();
}

function effects_updateWidget(): void {
	// widget 刷新由 event-adapter 调 projection/widget.updateWidget 实现
	// service 只返回 effect，不直接操作 UI
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
	const taskDescs = Array.isArray(tasks)
		? tasks
		: tasks.map((t) => t.description);
	const EXT_INIT_TASK_DESC_MAX = 60;
	const ELLIPSIS_LENGTH = 3;
	session.state.tasks = taskDescs.map((desc, i) => ({
		id: i + 1,
		description: normalizeDescription(desc, isExternalInit ? EXT_INIT_TASK_DESC_MAX : 80, ELLIPSIS_LENGTH),
		status: "pending" as const,
		lastUpdatedTurn: session.state!.currentTurnIndex,
	}));

	persistState(session, ports);
	return true;
}

function normalizeDescription(desc: string, maxLength: number, ellipsis: number): string {
	const singleLine = desc.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
	if (singleLine.length > maxLength) {
		return singleLine.slice(0, maxLength - ellipsis) + "...";
	}
	return singleLine;
}

// ── FR-3.3 唯一完成入口 ──────────────────────────────

/**
 * 唯一完成入口。按 FR-8.7 矩阵决定 writeHistory + clearSession。
 *
 * @param terminalStatus 终态（complete/budget_limited/time_limited/cancelled）
 * @param options.clearImmediately cancelled → true（立即 clearSession）；其他终态 → false（依赖 AUTO_CLEAR_TURNS）
 * @param options.completedTasks 用于 history entry
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
	const entry = makeHistoryEntry(state, options.completedTasks);
	ports.persistence.appendHistory(entry);

	if (options.clearImmediately) {
		// cancelled → 立即清 session
		// clearGoalSession 需要 session 引用，但 finalizeGoal 只接收 state
		// 实际 clearSession 由调用方（command-adapter/event-adapter）在调 finalizeGoal 后执行
		// 这里只设状态，不直接 clear
	}
}

// ── 路径 A：applyToolAction ───────────────────────────

/**
 * 路径 A 入口。同步，返回 ToolActionResult。
 * 10 个 action handler 的薄委托。实际 action 逻辑在 adapters/actions.ts，
 * 但核心状态变更经此函数（service 统一 persist 时机）。
 *
 * 注意：本函数是 service 层的"统一入口签名"，具体 action 分发在 tool-adapter。
 * service.applyToolAction 负责：校验 → engine 纯函数变更 state → persist。
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
	const state = session.state;

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
		default:
			// add_tasks / list_tasks / add_subtasks / update_subtasks / delete_subtasks
			// 这些 handler 由 adapters/actions.ts 实现（薄封装），service 只统一 persist
			// 此处不重复实现，返回占位让 adapter 处理
			return errorResult(`Action ${action} not implemented in service core`);
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
	const completedCount = state.tasks.filter((t) => t.status === "completed" || t.status === "verified").length;
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

// ── 路径 B：applyEvent ────────────────────────────────

/**
 * 路径 B 入口。异步事件，返回 EventEffect[]。
 * 并发保护（isProcessing / stale-check）在 event-adapter，不在此层。
 *
 * 注意：event-adapter 是实际的 6 个事件 handler 实现位置。
 * service.applyEvent 提供统一的"事件→状态变更→effects"转换，
 * 但复杂的事件分支（agent_end 的 4 层优先级）在 event-adapter 直接实现，
 * 调 engine 纯函数 + service 辅助函数。
 *
 * 本函数作为简单事件的统一入口（agent_start / turn_end / message_end）。
 */
export function applyEvent(
	session: GoalSession,
	eventType: string,
	eventData: unknown,
	ports: ServicePorts,
): EventEffect[] {
	const effects: EventEffect[] = [];
	if (!session.state) return effects;

	switch (eventType) {
		case "message_end": {
			// token 累加（FR-8.6）
			const data = eventData as { message?: { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; totalTokens?: number } } };
			if (data?.message?.role !== "assistant") break;
			const usage = data.message.usage;
			if (!usage) break;
			const input = usage.input ?? 0;
			const output = usage.output ?? 0;
			const cacheRead = usage.cacheRead ?? 0;
			if (input > 0 || output > 0) {
				session.state.tokensUsed += Math.max(input - cacheRead, 0) + output;
			} else if (usage.totalTokens) {
				session.state.tokensUsed += usage.totalTokens;
			}
			break;
		}
		case "turn_end":
			session.state.currentTurnIndex++;
			effects.push({ kind: "updateWidget" });
			break;
		case "agent_start":
			if (isActiveStatus(session.state.status)) {
				session.state.tasksCompletedAtAgentStart = session.state.tasks.filter(
					(t) => t.status === "completed" || t.status === "verified",
				).length;
			}
			break;
	}
	return effects;
}

// ── resume 预算重检（供 command-adapter 调用）─────────

export function checkResumeBudget(state: GoalRuntimeState): { type: "exceeded"; dimension: "token" | "time" } | null {
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
```

> **重要说明**：
> 1. `persistAndUpdate` / `effects_updateWidget` 是简化占位——实际 widget 刷新由 event-adapter 调 `projection/widget.updateWidget` 实现。service 只负责状态变更 + persist，不直接操作 UI。
> 2. `applyToolAction` 只实现了核心 5 个 action（create_tasks / update_tasks / complete_goal / cancel_goal / report_blocked）。其余 5 个（add_tasks / list_tasks / add_subtasks / update_subtasks / delete_subtasks）由 adapters/actions.ts 直接实现（它们较简单，不需要 service 的统一 persist）。
> 3. `applyEvent` 只处理简单事件（message_end / turn_end / agent_start）。复杂事件（before_agent_start / agent_end / session_start）由 event-adapter 直接实现，调 engine 纯函数 + service 辅助函数。
> 4. service 的核心价值是：createGoal 唯一入口 + finalizeGoal 唯一完成 + update_tasks/complete_goal/cancel_goal 的校验逻辑集中。

- [ ] **步骤 2：编写 service.test.ts**

创建 `extensions/goal/src/__tests__/service.test.ts`（用 fake ports 内存实现）：

```typescript
/**
 * service.ts 测试 — 用 fake ports（内存实现 ports.ts 接口）
 *
 * FR-7.2: service 层测试，不 import Pi SDK
 */
import { describe, expect, it } from "vitest";

import { applyToolAction, createGoal, finalizeGoal, type ServicePorts } from "../service";
import { createGoalSession, type GoalSession } from "../session";
import type { GoalRuntimeState } from "../engine/types";
import { createGoalState } from "../engine/goal";

// ── Fake Ports ───────────────────────────────────────

function makeFakePorts(): ServicePorts & { states: GoalRuntimeState[]; history: unknown[]; messages: unknown[] } {
	const states: GoalRuntimeState[] = [];
	const history: unknown[] = [];
	const messages: unknown[] = [];
	return {
		states,
		history,
		messages,
		persistence: {
			appendState: (s) => states.push(s),
			appendHistory: (e) => history.push(e),
		},
		ui: {
			setWidget: () => {},
			setStatus: () => {},
			notify: (text, level) => messages.push({ kind: "notify", text, level }),
			hasUI: true,
		},
		messaging: {
			sendContextMessage: (content, deliverAs, customType) => messages.push({ kind: "sendContext", content, deliverAs, customType }),
			sendUserMessage: (content, deliverAs) => messages.push({ kind: "sendUser", content, deliverAs }),
		},
		session: {
			getEntries: () => [],
			spliceEntry: () => {},
			getContextUsage: () => null,
			signal: undefined,
		},
	};
}

const makeState = (): GoalRuntimeState => createGoalState("test");

// ── createGoal 测试 ──────────────────────────────────

describe("createGoal — 唯一创建入口", () => {
	it("成功创建：state + tasks 构造", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();
		const ok = createGoal(session, "my objective", ["task 1", "task 2"], {}, ports, false);
		expect(ok).toBe(true);
		expect(session.state).not.toBeNull();
		expect(session.state!.objective).toBe("my objective");
		expect(session.state!.tasks).toHaveLength(2);
		expect(session.state!.tasks[0]!.id).toBe(1);
		expect(session.state!.tasks[1]!.id).toBe(2);
		expect(session.state!.tasks[0]!.status).toBe("pending");
	});

	it("已有 active goal → 拒绝创建（返回 false）", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();
		createGoal(session, "first", ["t1"], {}, ports, false);
		const ok = createGoal(session, "second", ["t2"], {}, ports, false);
		expect(ok).toBe(false);
		expect(session.state!.objective).toBe("first"); // 保持原 goal
	});

	it("isExternalInit 不影响 task 构造", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();
		createGoal(session, "obj", ["short", "a".repeat(100)], {}, ports, true);
		// external init 截断到 60 字符
		expect(session.state!.tasks[1]!.description.length).toBeLessThanOrEqual(60);
	});

	it("persist 被调用", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();
		createGoal(session, "obj", ["t1"], {}, ports, false);
		expect(ports.states.length).toBeGreaterThanOrEqual(1);
	});
});

// ── applyToolAction — create_tasks ───────────────────

describe("applyToolAction — create_tasks", () => {
	it("成功创建 tasks", () => {
		const session = createGoalSession();
		session.state = makeState();
		const ports = makeFakePorts();
		const result = applyToolAction(session, "create_tasks", { tasks: ["a", "b"] }, ports);
		expect(result.isError).toBeUndefined();
		expect(session.state!.tasks).toHaveLength(2);
	});

	it("已有未完成 tasks → 拒绝", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "existing", status: "in_progress", lastUpdatedTurn: 0 }];
		const ports = makeFakePorts();
		const result = applyToolAction(session, "create_tasks", { tasks: ["new"] }, ports);
		expect(result.isError).toBe(true);
	});

	it("all-complete → 覆盖（FR-8.8 保持当前行为，D-19 拆出）", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "done", status: "completed", lastUpdatedTurn: 0 }];
		const ports = makeFakePorts();
		const result = applyToolAction(session, "create_tasks", { tasks: ["new"] }, ports);
		expect(result.isError).toBeUndefined();
		expect(session.state!.tasks).toHaveLength(1);
		expect(session.state!.tasks[0]!.description).toBe("new");
	});
});

// ── applyToolAction — update_tasks ───────────────────

describe("applyToolAction — update_tasks", () => {
	it("pending → in_progress 合法", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "t", status: "pending", lastUpdatedTurn: 0 }];
		const result = applyToolAction(session, "update_tasks", { updates: [{ taskId: 1, status: "in_progress" }] }, makeFakePorts());
		expect(result.isError).toBeUndefined();
		expect(session.state!.tasks[0]!.status).toBe("in_progress");
	});

	it("pending → completed 非法（跳过 in_progress）", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "t", status: "pending", lastUpdatedTurn: 0 }];
		const result = applyToolAction(session, "update_tasks", { updates: [{ taskId: 1, status: "completed", evidence: "x" }] }, makeFakePorts());
		expect(result.isError).toBe(true);
	});

	it("completed 无 verification → 全锁（FR-8.3 G-017）", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "t", status: "completed", lastUpdatedTurn: 0 }];
		const result = applyToolAction(session, "update_tasks", { updates: [{ taskId: 1, status: "cancelled" }] }, makeFakePorts());
		expect(result.isError).toBe(true);
	});

	it("completed 有 verification → 只能 verified", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "t", status: "completed", lastUpdatedTurn: 0, verification: { method: "test", expected: "pass" } }];
		const result = applyToolAction(session, "update_tasks", { updates: [{ taskId: 1, status: "cancelled" }] }, makeFakePorts());
		expect(result.isError).toBe(true);
	});

	it("completed 有 verification → verified 合法", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "t", status: "completed", lastUpdatedTurn: 0, verification: { method: "test", expected: "pass" } }];
		const result = applyToolAction(session, "update_tasks", { updates: [{ taskId: 1, status: "verified", actual: "ok" }] }, makeFakePorts());
		expect(result.isError).toBeUndefined();
		expect(session.state!.tasks[0]!.status).toBe("verified");
	});

	it("completed 有 verification → 触发 FR-8.9 steering", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "t", status: "in_progress", lastUpdatedTurn: 0, verification: { method: "test", expected: "pass" } }];
		const ports = makeFakePorts();
		applyToolAction(session, "update_tasks", { updates: [{ taskId: 1, status: "completed", evidence: "done" }] }, ports);
		// 应有 steering 消息
		const steer = ports.messages.find((m) => (m as { deliverAs?: string }).deliverAs === "steer");
		expect(steer).toBeTruthy();
	});
});

// ── applyToolAction — complete_goal ──────────────────

describe("applyToolAction — complete_goal", () => {
	it("全完成 → complete", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "t", status: "completed", lastUpdatedTurn: 0 }];
		const result = applyToolAction(session, "complete_goal", { evidence: "all done" }, makeFakePorts());
		expect(result.isError).toBeUndefined();
		expect(session.state!.status).toBe("complete");
	});

	it("有未完成 → 拒绝", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "t", status: "in_progress", lastUpdatedTurn: 0 }];
		const result = applyToolAction(session, "complete_goal", { evidence: "x" }, makeFakePorts());
		expect(result.isError).toBe(true);
	});

	it("全 cancelled → 拒绝（FR-8.10）", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "t", status: "cancelled", lastUpdatedTurn: 0 }];
		const result = applyToolAction(session, "complete_goal", { evidence: "x" }, makeFakePorts());
		expect(result.isError).toBe(true);
	});
});

// ── applyToolAction — cancel_goal ────────────────────

describe("applyToolAction — cancel_goal", () => {
	it("cancel → cancelled + clearSession", () => {
		const session = createGoalSession();
		session.state = makeState();
		const result = applyToolAction(session, "cancel_goal", { cancelReason: "user wants" }, makeFakePorts());
		expect(result.isError).toBeUndefined();
		expect(session.state).toBeNull(); // clearSession
	});
});

// ── finalizeGoal — history 写入矩阵 ──────────────────

describe("finalizeGoal — history 写入矩阵", () => {
	it("complete → 写 history", () => {
		const ports = makeFakePorts();
		const state = makeState();
		finalizeGoal(state, "complete", ports, { clearImmediately: false, completedTasks: 1 });
		expect(ports.history.length).toBe(1);
		expect((ports.history[0] as { status: string }).status).toBe("complete");
	});

	it("cancelled → 写 history", () => {
		const ports = makeFakePorts();
		const state = makeState();
		finalizeGoal(state, "cancelled", ports, { clearImmediately: true, completedTasks: 0 });
		expect(ports.history.length).toBe(1);
	});

	it("budget_limited → 写 history", () => {
		const ports = makeFakePorts();
		const state = makeState();
		finalizeGoal(state, "budget_limited", ports, { clearImmediately: false, completedTasks: 2 });
		expect(ports.history.length).toBe(1);
	});
});
```

- [ ] **步骤 3：运行测试确认通过**

运行：`pnpm --filter @zhushanwen/pi-goal test src/__tests__/service.test.ts`
预期：PASS

> **注意**：此测试可能因 service.ts 的实现细节（如 makeResult 的 details 格式）有微调需求。执行者根据实际 typecheck 错误修正测试断言。

- [ ] **步骤 4：typecheck**

运行：`pnpm --filter @zhushanwen/pi-goal typecheck`
预期：零错误。

- [ ] **步骤 5：提交**

```bash
git add extensions/goal/src/service.ts extensions/goal/src/__tests__/service.test.ts
git commit -m "wave-5: add service.ts — dual entry (applyToolAction/applyEvent) + createGoal + finalizeGoal with fake-ports tests"
```

---

## 验收标准

### 1. 测试

- [ ] `pnpm --filter @zhushanwen/pi-goal test src/__tests__/service.test.ts` PASS
- [ ] service.test.ts 用 fake ports（不依赖 Pi runtime）
- [ ] 全量 `test` 仍全绿
- [ ] 测试覆盖：createGoal 初始化 / finalizeGoal 三终态（complete/cancelled/budget_limited）/ applyToolAction 至少一个 action case / applyEvent 至少一个 event case

### 2. 架构边界

- [ ] service.ts 不持有 ctx（D-16：通过 ports 参数接收能力）
- [ ] import 自 `./engine/*` + `./ports` + `./session` + `./persistence`（不 import Pi / adapters / 旧文件）
- [ ] 禁止 `any`

### 3. 接口契约

- [ ] `service.ts` 导出：`ServicePorts` 类型 / `ToolActionResult` 类型 / `EventEffect` 类型 / `createGoal(session, objective, tasks, budgetOverrides, ports, writeHistory)` / `finalizeGoal(state, status, ports, opts)` / `applyToolAction(session, action, params, ports): ToolActionResult` / `applyEvent(session, event, payload, ports): Promise<EventEffect>`

### 4. 行为契约

- [ ] D-21：双入口（applyToolAction 同步返回 result / applyEvent 异步返回 effects），不合并为单一 applyCommand
- [ ] `completed && !verification` 全锁逻辑在此层（validateTaskTransition 只看 status，service 补 verification 维度）
- [ ] FR-6.5：persist 前调 tick 累计时间
- [ ] FR-8.7：finalizeGoal 按 history 写入矩阵（complete/cancelled 写 history；budget_limited/time_limited 看配置）决定 writeHistory + clearSession
- [ ] FR-3.1：createGoal 是唯一创建入口

### 5. 提交

- [ ] commit message 以 `wave-5:` 开头，含「dual entry」+「createGoal」+「finalizeGoal」+「fake-ports tests」
