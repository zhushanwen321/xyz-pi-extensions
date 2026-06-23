/**
 * goal_manager tool 的 action 处理器（adapters 层）
 *
 * 每个 action 一个薄封装 handler，委托 service.applyToolAction 完成实际工作
 * （状态变更 + persist + widget 刷新 + 副作用）。
 *
 * 状态变更 / persist / widget / history / clearSession 逻辑下沉到 service.applyToolAction；
 * handler 仅做委托。FR-8.x 行为契约在 service 对应 case 实现（见交叉引用）。
 *
 * 本文件含 task 部分 7 个 handler + 文件末尾 subtask 部分 3 个 handler。
 * ACTION_HANDLERS Record 完整组装在 tool-adapter.ts（合并两张子表）。
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { applyToolAction, type ServicePorts, type ToolActionResult } from "../service";
import type { GoalSession } from "../session";

// ── Types ────────────────────────────────────────────

/**
 * goal_manager tool 参数（schema 在 tool-adapter.ts 定义）。
 *
 * 用 `Record<string, unknown>` 而非 `Static<typeof GoalManagerParams>`，以打破
 * actions.ts ↔ tool-adapter.ts 的循环依赖（tool-adapter import actions 的 ACTION_HANDLERS，
 * actions 若再 import tool-adapter 的 schema 类型即成环）。具体字段读取（`params.tasks` /
 * `params.updates` 等）在 service.applyToolAction 内部各 case 完成，类型由内部断言收敛。
 * 符合"禁止 any"——用 `unknown` + 内部断言，而非 `any`。
 */
export type GoalToolParams = Record<string, unknown>;

/** action 处理器上下文：handler 通过此对象访问 Pi 句柄、session、params、ports。 */
export interface ActionContext {
	pi: ExtensionAPI;
	session: GoalSession;
	params: GoalToolParams;
	ctx: ExtensionContext;
	ports: ServicePorts;
}

/** action 处理器签名：所有处理器返回 ToolActionResult（成功或 errorResult）。 */
export type ActionHandler = (actx: ActionContext) => ToolActionResult;

// ── task handlers ────────────────────────────────────

/**
 * create_tasks — 创建初始任务列表。
 *
 * FR-8.8（D-19）：保持当前覆盖行为——所有 task 已完成时不报错，静默覆盖。
 * 守卫表达式 `existingIncomplete.length > 0` 才拒绝（service.create_tasks case 实现）。
 * 行为变更（all-complete 报错）拆为独立 ticket，不纳入本架构 PR。
 */
export const handleCreateTasks: ActionHandler = (actx): ToolActionResult => {
	return applyToolAction(actx.session, "create_tasks", actx.params, actx.ports);
};

/**
 * add_tasks — 追加任务到现有列表（不覆盖）。
 */
export const handleAddTasks: ActionHandler = (actx): ToolActionResult => {
	return applyToolAction(actx.session, "add_tasks", actx.params, actx.ports);
};

/**
 * update_tasks — 更新任务状态（含 verification steering 即时驱动）。
 *
 * FR-8.9（G-R4-002）：标 completed 且有 verification 配置时，service.update_tasks case
 * 立即调 ports.messaging.sendContextMessage(..., "steer") 注入验证提示，引导 AI 跑验证
 * 命令并回填 actual。这是对双维度 completion=done/verification=pending 的即时驱动，
 * 不只依赖 prompt 引导。
 */
export const handleUpdateTasks: ActionHandler = (actx): ToolActionResult => {
	return applyToolAction(actx.session, "update_tasks", actx.params, actx.ports);
};

/**
 * list_tasks — 列出当前所有任务（只读，不 persist，不触发 widget 刷新）。
 *
 * G-005：只读 action 不 persist/project。service.list_tasks case 不调 persist / updateWidget。
 */
export const handleListTasks: ActionHandler = (actx): ToolActionResult => {
	return applyToolAction(actx.session, "list_tasks", actx.params, actx.ports);
};

/**
 * complete_goal — 标记目标完成（走 finalizeGoal，写 history）。
 *
 * FR-8.10（G-R4-003）：全 cancelled 守卫——至少一个 task 必须是 completed/verified。
 * 守卫顺序（service.complete_goal case）：先 notDone 检查（有未完成任务拒绝）→
 * 再 completedOrVerified 检查（全 cancelled 拒绝）→ 通过则 transitionStatus→complete。
 * 错误信息："At least one task must be completed or verified. All-cancelled does not count."
 *
 * finalizeGoal 唯一完成入口：complete 不立即 clearSession（依赖 AUTO_CLEAR_TURNS=2
 * 在 before_agent_start 清理，用户看到终态栏 2 turn）。
 */
export const handleCompleteGoal: ActionHandler = (actx): ToolActionResult => {
	return applyToolAction(actx.session, "complete_goal", actx.params, actx.ports);
};

/**
 * report_blocked — 报告阻塞（中间态，不走 finalizeGoal，不写 history）。
 *
 * FR-3.3：blocked 是中间态，service.report_blocked case 仅设 status=blocked +
 * lastBlockerReason + persist，不调 finalizeGoal、不 writeHistoryEntry。
 */
export const handleReportBlocked: ActionHandler = (actx): ToolActionResult => {
	return applyToolAction(actx.session, "report_blocked", actx.params, actx.ports);
};

/**
 * cancel_goal — 取消目标（走 finalizeGoal，cancelled 立即 clearSession）。
 *
 * FR-8.7（G-R3-002）：cancelled → 立即 clearGoalSession（finalizeGoal 内部完成）。
 * 与 complete/budget_limited/time_limited 不同（后者不立即 clear，依赖 AUTO_CLEAR_TURNS）。
 *
 * FR-8.5（G-013）：details.tasks 返回空数组（其他 action 返回完整 tasks），
 * renderResult 据此显示。service.cancel_goal case 构造 details 时 tasks: []。
 */
export const handleCancelGoal: ActionHandler = (actx): ToolActionResult => {
	return applyToolAction(actx.session, "cancel_goal", actx.params, actx.ports);
};

// ── subtask handlers ─────────────────────────────────
// （接续上方 task handlers，类型 ActionHandler / ActionContext / GoalToolParams 已在文件顶部定义）

/**
 * add_subtasks — 给指定 task 添加 subtask。
 *
 * FR-8.11（G-R4-004）：拒绝给 completed 状态的 task 加 subtask。
 * 守卫表达式：`isTerminalTaskStatus(parentTask.status) || parentTask.status === "completed"`
 * （service.add_subtasks case 实现）。
 *
 * 设计意图：`isTerminalTaskStatus`（engine/task.ts）中 completed 不算终态
 * （verified/cancelled 才是），但 add_subtasks 额外显式拒绝 completed——
 * completed 任务已声明完成，不应再拆分（D-20 有意业务决策）。
 * 错误信息："Task #N in terminal state (completed), cannot add subtask"
 */
export const handleAddSubtasks: ActionHandler = (actx): ToolActionResult => {
	return applyToolAction(actx.session, "add_subtasks", actx.params, actx.ports);
};

/**
 * update_subtasks — 更新 subtask 状态（宽松状态机，允许 pending→completed 跳过 in_progress）。
 *
 * FR-8.3（G-018）：subtask 保持宽松，无严格状态机校验。唯一守卫：completed subtask 不可变更。
 * （service.update_subtasks case 实现）
 */
export const handleUpdateSubtasks: ActionHandler = (actx): ToolActionResult => {
	return applyToolAction(actx.session, "update_subtasks", actx.params, actx.ports);
};

/**
 * delete_subtasks — 删除指定 subtask（全部删完时 subtasks 字段置 undefined）。
 *
 * （service.delete_subtasks case 实现，行为保持：删除后若 subtasks 为空则置 undefined）
 */
export const handleDeleteSubtasks: ActionHandler = (actx): ToolActionResult => {
	return applyToolAction(actx.session, "delete_subtasks", actx.params, actx.ports);
};

// ── 局部 Action Record（供 tool-adapter.ts 组装最终 ACTION_HANDLERS）──

/**
 * task action 路由表（7 条）。
 * tool-adapter.ts 把它与 SUBTASK_ACTION_HANDLERS 合并为最终 ACTION_HANDLERS。
 */
export const TASK_ACTION_HANDLERS: Record<string, ActionHandler> = {
	create_tasks: handleCreateTasks,
	add_tasks: handleAddTasks,
	update_tasks: handleUpdateTasks,
	list_tasks: handleListTasks,
	complete_goal: handleCompleteGoal,
	report_blocked: handleReportBlocked,
	cancel_goal: handleCancelGoal,
};

/**
 * subtask action 路由表（3 条）。
 * tool-adapter.ts 把它与 TASK_ACTION_HANDLERS 合并为最终 ACTION_HANDLERS。
 */
export const SUBTASK_ACTION_HANDLERS: Record<string, ActionHandler> = {
	add_subtasks: handleAddSubtasks,
	update_subtasks: handleUpdateSubtasks,
	delete_subtasks: handleDeleteSubtasks,
};
