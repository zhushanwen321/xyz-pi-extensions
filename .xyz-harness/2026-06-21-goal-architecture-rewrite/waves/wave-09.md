# Wave 9: adapters/actions.ts（subtask 部分 3 个 handler）

- **目标文件**：`extensions/goal/src/adapters/actions.ts`（接续 Wave 8，在文件末尾追加）
- **前置 wave**：Wave 8（actions.ts task 部分）
- **目标**：在 `adapters/actions.ts` 末尾追加 3 个 subtask handler，并 export 局部 `TASK_ACTION_HANDLERS` / `SUBTASK_ACTION_HANDLERS` 两个子 Record 供 Wave 10 组装完整 `ACTION_HANDLERS`。本 wave 不组装最终 Record（Wave 10 在 tool-adapter.ts 完成完整组装，避免本 wave 引用循环）。

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

- [ ] **无独立单元测试**——与 Wave 8 一致，薄封装逻辑在 service
- [ ] `pnpm --filter @zhushanwen/pi-goal typecheck` 零错误
- [ ] 全量 `test` 仍全绿

### 2. 架构边界

- [ ] `grep -rn "\.\./state\|\.\./tool-handler\|\.\./action-handlers" extensions/goal/src/adapters/actions.ts` 无输出
- [ ] 类型 `ActionHandler` / `ActionContext` 不重复定义（继承 Wave 8）
- [ ] 禁止 `any`

### 3. 接口契约

- [ ] 新增 3 个 subtask handler：`handleAddSubtasks` / `handleUpdateSubtasks` / `handleDeleteSubtasks`
- [ ] 导出 `TASK_ACTION_HANDLERS`（7 条）+ `SUBTASK_ACTION_HANDLERS`（3 条）两个子 Record

### 4. 行为契约

- [ ] FR-8.11（G-R4-004）：add_subtasks 拒绝给 completed 状态的 task 加 subtask（`isTerminalTaskStatus(parentTask.status) || parentTask.status === "completed"`）
- [ ] FR-8.3 G-018：subtask 宽松状态机（JSDoc 标注）
- [ ] 10 个 handler + 2 个子 Record，与 plan 接口契约的 10 个 action 枚举值一一对应

### 5. 提交

- [ ] commit message 以 `wave-9:` 开头，含「3 subtask handler」+「FR-8.11」
