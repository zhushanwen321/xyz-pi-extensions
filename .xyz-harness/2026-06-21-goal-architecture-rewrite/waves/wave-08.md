# Wave 8: adapters/actions.ts（task 部分 7 个 handler）

- **目标文件**：`extensions/goal/src/adapters/actions.ts`
- **前置 wave**：Wave 4（session.ts）、Wave 5（service.ts）、Wave 7（projection/result.ts）
- **目标**：创建 `adapters/actions.ts`，实现 task 相关的 7 个 action handler（薄封装，调 `service.applyToolAction`），并定义 `ActionHandler` / `ActionContext` 类型。本 wave 仅写 task 部分；subtask 3 个 handler 在 Wave 9 接续，`ACTION_HANDLERS` Record 完整组装在 Wave 10。

## 关键改动点

1. **薄封装设计**：每个 handler 是 1-3 行代码，核心委托 `service.applyToolAction(session, actionName, params, ports)`。service 内部完成状态变更 + persist + 副作用（widget 刷新 / verification steering / history 写入 / clearSession）。
2. **FR-6.1 widget 刷新**：service.applyToolAction 内部已通过 `ports.ui` 调 `updateWidget`（state 变更 action 刷新，list_tasks 只读不刷新）。handler 不重复触发。
3. **FR-8.x 行为契约归位**：以下行为在 service.applyToolAction 的对应 action case 内实现（Wave 5 已建），wave 文件此处仅做交叉引用标注，确保迁移不丢：
   - **FR-8.8**（create_tasks all-complete 保持覆盖）：`create_tasks` case 守卫表达式 `existingIncomplete.length > 0` 才拒绝，all-complete 时不报错、静默覆盖（D-19 拆独立 ticket）
   - **FR-8.9**（update_tasks verification steering）：`update_tasks` case 在标 completed 且有 verification 时，通过 `ports.messaging.sendContextMessage(..., "steer")` 立即注入 steering
   - **FR-8.10**（complete_goal 全 cancelled 守卫）：`complete_goal` case 检查 `completedOrVerified.length === 0` 拒绝
   - report_blocked 不走 finalizeGoal、不写 history（中间态）
   - cancel_goal 走 finalizeGoal、cancelled 立即 clearSession
4. **adapters 层可 import Pi 类型**：`ActionContext` 持 `ExtensionAPI` / `ExtensionContext`（Pi 类型），handler 通过 ports 桥接 Pi 与 service。

## ActionContext 与 ActionHandler 类型

```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Static } from "typebox";
import type { GoalSession } from "../session.js";
import type { ServicePorts, ToolActionResult } from "../service.js";

/**
 * goal_manager tool 的参数 schema（typebox）。
 * 在 Wave 10 的 tool-adapter.ts 定义并 export，actions.ts 通过 type-only import 引用。
 * Wave 10 前先用本地别名占位——实际 import 自 ../adapters/tool-adapter.js（Wave 10 建）。
 *
 * 注：为避免循环依赖（tool-adapter import actions 的 ACTION_HANDLERS），
 *     GoalManagerParams 的 type 在 tool-adapter 定义；actions.ts 用 `Record<string, unknown>`
 *     接收 params，具体字段读取由 service.applyToolAction 内部各 case 完成。
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
```

> **params 类型说明**：actions.ts 用 `Record<string, unknown>` 而非 `Static<typeof GoalManagerParams>`，以打破 actions.ts ↔ tool-adapter.ts 的循环依赖（tool-adapter import actions 的 ACTION_HANDLERS，actions 若再 import tool-adapter 的 schema 类型即成环）。具体字段读取（`params.tasks` / `params.updates` 等）在 service.applyToolAction 内部完成，类型由 service 内部断言收敛。这符合"禁止 any"——用 `unknown` + 内部断言，而非 `any`。

## 步骤 1：创建 `extensions/goal/src/adapters/actions.ts`（task 部分 7 个 handler）

```typescript
/**
 * goal_manager tool 的 action 处理器（adapters 层）
 *
 * 每个 action 一个薄封装 handler，委托 service.applyToolAction 完成实际工作
 * （状态变更 + persist + widget 刷新 + 副作用）。
 *
 * 迁移自 src/action-handlers.ts。改动：
 * - 状态变更 / persist / widget / history / clearSession 逻辑下沉到 service.applyToolAction
 * - handler 仅做：params 类型断言 + 委托 service
 * - FR-8.x 行为契约在 service 对应 case 实现（见交叉引用）
 *
 * 本文件含 task 部分 7 个 handler；subtask 部分 3 个 handler 在文件末尾接续（Wave 9）。
 * ACTION_HANDLERS Record 完整组装在 Wave 10 的 tool-adapter.ts（避免本 wave 引用尚未存在的
 * subtask handler 导致编译错误）。
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { GoalSession } from "../session.js";
import { applyToolAction, type ServicePorts, type ToolActionResult } from "../service.js";

// ── Types ────────────────────────────────────────────

/** goal_manager tool 参数（类型在 tool-adapter.ts 定义，此处用宽松 Record 打破循环依赖）。 */
export type GoalToolParams = Record<string, unknown>;

/** action 处理器上下文。 */
export interface ActionContext {
	pi: ExtensionAPI;
	session: GoalSession;
	params: GoalToolParams;
	ctx: ExtensionContext;
	ports: ServicePorts;
}

/** action 处理器签名：返回 ToolActionResult（成功或 errorResult）。 */
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
```

> **为什么 handler 都是 1 行委托**：
> - 旧 `action-handlers.ts` 每个 handler ~30-50 行，含状态变更 + persist + result 构建。新架构把这些下沉到 `service.applyToolAction` 的对应 case（Wave 5 已实现），handler 退化成路由薄封装。
> - handler 的存在价值：`ACTION_HANDLERS: Record<string, ActionHandler>` 提供 **编译期 action 完整性**（AC-3）——tool-adapter 的分发表用此 Record，漏一个 action 即编译错误。
> - 行为契约（FR-8.x）在 service 层实现，wave 文件用 JSDoc 交叉引用标注，确保迁移不丢。

## 步骤 2：typecheck 验证

```bash
pnpm --filter @zhushanwen/pi-goal typecheck
```

> 验证点：
> - `ActionHandler` / `ActionContext` / `GoalToolParams` 类型定义正确
> - 7 个 task handler 导出，签名匹配 `ActionHandler`
> - `applyToolAction` import 自 `../service.js` 成功（Wave 5 已建）
> - 不 import 旧文件（`../action-handlers`、`../tool-handler`、`../state`）
> - 禁止 `any`（params 用 `Record<string, unknown>`）

> **注意**：本 wave 不组装 `ACTION_HANDLERS` Record（subtask handler 在 Wave 9、Record 在 Wave 10），避免引用尚未存在的 handler 导致编译错误。本 wave 结束时 actions.ts 含 7 个 exported handler 函数 + 类型定义，可独立 typecheck。

## 步骤 3：提交

```bash
git add extensions/goal/src/adapters/actions.ts
git commit -m "refactor(goal): add adapters/actions.ts task handlers (Wave 8)"
```

## 验证清单

- [ ] `adapters/actions.ts` 导出 7 个 task handler：`handleCreateTasks` / `handleAddTasks` / `handleUpdateTasks` / `handleListTasks` / `handleCompleteGoal` / `handleReportBlocked` / `handleCancelGoal`
- [ ] 导出类型：`ActionHandler` / `ActionContext` / `GoalToolParams`
- [ ] 每个 handler 是薄封装，调 `applyToolAction(session, action, params, ports)`
- [ ] JSDoc 标注 FR-8.8（create_tasks 覆盖）/ FR-8.9（verification steering）/ FR-8.10（全 cancelled 守卫）/ FR-3.3（blocked 不走 finalizeGoal）/ FR-8.7（cancel 立即 clear）/ FR-8.5（cancel tasks:[]）/ G-005（list_tasks 只读）
- [ ] adapters 层可 import Pi 类型（`ExtensionAPI` / `ExtensionContext`）
- [ ] 不 import 旧文件，禁止 `any`（用 `Record<string, unknown>`）
- [ ] `pnpm --filter @zhushanwen/pi-goal typecheck` 通过
