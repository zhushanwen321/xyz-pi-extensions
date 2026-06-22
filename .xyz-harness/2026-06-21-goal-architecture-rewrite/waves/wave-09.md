# Wave 9: adapters/actions.ts（subtask 部分 3 个 handler）+ service 5 个 action 补齐

- **目标文件**：`extensions/goal/src/adapters/actions.ts`（接续 Wave 8，在文件末尾追加）、`extensions/goal/src/service.ts`（补齐 5 个 action case）
- **前置 wave**：Wave 5（service.ts）、Wave 8（actions.ts task 部分）
- **目标**：① 在 `service.applyToolAction` 补齐 5 个缺失 action case（add_tasks / list_tasks / add_subtasks / update_subtasks / delete_subtasks）——修复 Wave 5 的设计缺口（原 default 分支声明「service 不重复实现」，但 Wave 8 handler 已委托 service，导致运行时返回错误）；② 在 `adapters/actions.ts` 末尾追加 3 个 subtask handler + export 2 个子 Record（TASK_ACTION_HANDLERS 7 条 + SUBTASK_ACTION_HANDLERS 3 条）。

## 实现修正 0（架构冲突，已采纳「全部下沉到 service」方案）

**冲突**：Wave 5 提交的 `service.applyToolAction` 只实现 5 个核心 action，default 分支明确写「其余 5 个由 adapters 实现，service 不重复实现」。但 Wave 8/9 的 handler 全部 1 行委托 `service.applyToolAction(...)`，且 JSDoc 标注「(service.add_subtasks case 实现)」——两边自相矛盾。Wave 8 的 `handleAddTasks` / `handleListTasks`（已提交但 Wave 10 前未接线）运行时会命中 default 分支返回错误。

**用户决策**：「全部下沉到 service」——在 `service.applyToolAction` 补齐这 5 个 case，覆盖 Wave 5 default 注释。Wave 8/9 handler 保持 1 行委托。优点：FR-6.5 persist 走单一路径、行为一致、handler 极薄。

**list_tasks 渲染**：service 层 import `formatTaskList` 自 `projection/prompts`（不构成循环——`projection/prompts.ts` 只 import `constants`/`engine/*`，不 import service；循环仅存在于 `projection/result.ts → service`，不影响本路径）。复用而非内联，保持渲染逻辑单一定义点。

## 关键改动点

1. **接续 Wave 8**：在已有 7 个 task handler 之后追加 3 个 subtask handler，不重复类型定义（`ActionHandler` / `ActionContext` / `GoalToolParams` 已在 Wave 8 定义）。
2. **薄封装**：与 task handler 一致，每个 handler 委托 `service.applyToolAction`。
3. **FR-8.11（add_subtasks 拒绝 completed task）**：service.add_subtasks case 守卫表达式 `isTerminalTaskStatus(parentTask.status) || parentTask.status === "completed"` 拒绝。注意 `isTerminalTaskStatus`（engine/task.ts）不含 completed（completed 有 verification 时需转 verified），此处额外显式拒绝 completed 是有意的业务决策（D-20 / G-R4-004）。
4. **子 Record export**：export `TASK_ACTION_HANDLERS`（7 条）和 `SUBTASK_ACTION_HANDLERS`（3 条），Wave 10 的 tool-adapter.ts 用 `{ ...TASK_ACTION_HANDLERS, ...SUBTASK_ACTION_HANDLERS }` 组装最终 `ACTION_HANDLERS`。这避免 actions.ts ↔ tool-adapter.ts 循环依赖，同时让 Wave 10 能 grep 验证 10 条完整性。

## 步骤 1：在 `extensions/goal/src/adapters/actions.ts` 末尾追加 subtask handler

在 Wave 8 已创建的文件末尾（`handleCancelGoal` 之后）追加：

```typescript
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

// ── 局部 Action Record（供 Wave 10 组装最终 ACTION_HANDLERS）──

/**
 * task action 路由表（7 条）。
 * Wave 10 的 tool-adapter.ts 把它与 SUBTASK_ACTION_HANDLERS 合并为最终 ACTION_HANDLERS。
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
 * Wave 10 的 tool-adapter.ts 把它与 TASK_ACTION_HANDLERS 合并为最终 ACTION_HANDLERS。
 */
export const SUBTASK_ACTION_HANDLERS: Record<string, ActionHandler> = {
	add_subtasks: handleAddSubtasks,
	update_subtasks: handleUpdateSubtasks,
	delete_subtasks: handleDeleteSubtasks,
};
```

## 步骤 2：typecheck 验证

```bash
pnpm --filter @zhushanwen/pi-goal typecheck
```

> 验证点：
> - 3 个 subtask handler 导出，签名匹配 `ActionHandler`
> - `TASK_ACTION_HANDLERS`（7 条）+ `SUBTASK_ACTION_HANDLERS`（3 条）导出
> - handler 不重复定义类型（继承 Wave 8 的 `ActionHandler` / `ActionContext`）
> - 不 import 旧文件，禁止 `any`

> **本 wave 结束时 actions.ts 完整内容**：类型定义（3 个）+ 7 个 task handler + 3 个 subtask handler + 2 个子 Record。共 10 个 handler、10 条路由表项（分散在 2 个子 Record），Wave 10 合并组装。

## 步骤 3：提交

```bash
git add extensions/goal/src/adapters/actions.ts
git commit -m "refactor(goal): add subtask handlers + sub-records to actions.ts (Wave 9)"
```

## 验收标准

### 1. 测试

- [x] **新增 22 个 service 层单元测试**——实现修正 0 把 5 个 action 下沉到 service（不再是薄封装），故需独立测试覆盖每个 action 的校验/变更/persist 路径（add_tasks 3 + add_subtasks 7 + update_subtasks 5 + delete_subtasks 4 + list_tasks 3 = 22）。service.test.ts 由 47 增至 69 个测试。
- [x] `pnpm --filter @zhushanwen/pi-goal typecheck` 零错误
- [x] 全量 `test` 仍全绿（253 tests passed）

### 2. 架构边界

- [x] `grep -rn "\.\./state\|\.\./tool-handler\|\.\./action-handlers" extensions/goal/src/adapters/actions.ts` 无输出
- [x] 类型 `ActionHandler` / `ActionContext` 不重复定义（继承 Wave 8）
- [x] 禁止 `any`（service.ts 5 个 action 用 `Record<string, unknown>` + 内部断言；actions.ts 无 any）

### 3. 接口契约

- [x] 新增 3 个 subtask handler：`handleAddSubtasks` / `handleUpdateSubtasks` / `handleDeleteSubtasks`
- [x] 导出 `TASK_ACTION_HANDLERS`（7 条）+ `SUBTASK_ACTION_HANDLERS`（3 条）两个子 Record
- [x] **实现修正 0**：service.applyToolAction 新增 5 个 case（add_tasks / list_tasks / add_subtasks / update_subtasks / delete_subtasks），default 分支改为「Action X not supported」

### 4. 行为契约

- [x] FR-8.11（G-R4-004）：add_subtasks 拒绝给 completed 状态的 task 加 subtask（`isTerminalTaskStatus(parentTask.status) || parentTask.status === "completed"`）
- [x] FR-8.3 G-018：subtask 宽松状态机（JSDoc 标注 + 测试覆盖 completed 守卫）
- [x] G-005：list_tasks 只读——不 persist、不写 history（测试覆盖）
- [x] 10 个 handler + 2 个子 Record，与 plan 接口契约的 10 个 action 枚举值一一对应
- [x] service 层 5 个 action 行为与旧 action-handlers.ts 等价（错误信息逐字迁移，含 "terminal state" / "already completed" / "no subtasks" / "non-empty" / "not found"）

### 5. 提交

- [x] commit message 以 `wave-9:` 开头，含「subtask handler」+「service 5 action」

---

## 实现修正记录

0. **架构冲突修复——5 个 action 下沉到 service**：详见文件顶部「实现修正 0」段。用户决策「全部下沉到 service」，覆盖 Wave 5 default 分支注释。
1. **service.ts 新增 import**：`import { formatTaskList } from "./projection/prompts"`（list_tasks 复用渲染器，不内联不重复）。新增 engine/task 导入：`getNextTaskId, isTerminalTaskStatus`（add_tasks 用前者分配 id，add_subtasks 用后者终态检查）+ 类型 `Subtask, TaskVerification`。
2. **新增测试文件改动**：service.test.ts 由 47 → 69 测试。原有「未实现的 action → 报错」测试（断言 add_subtasks 返回 "not implemented"）改为「未知 action → default 分支报错」（断言 `totally_unknown_action` 返回 "not supported"），反映 5 个 action 现已实现。
3. **list_tasks 渲染不内联**：service 层 `list_tasks` 复用 `projection/prompts.formatTaskList`（纯渲染函数）。确认无循环依赖——`projection/prompts.ts` 仅 import `constants`/`engine/*`，不 import service。
4. **actions.ts 不需改 Wave 8 handler**：Wave 8 的 `handleAddTasks` / `handleListTasks` 已正确 1 行委托 service，service 补齐 case 后自动可用，无需回改。
5. **import 顺序自动修正**：eslint `simple-import-sort/imports` 自动重排 service.ts 导入（`formatTaskList` 排到末尾），通过 `eslint --fix` 处理，无行为影响。
