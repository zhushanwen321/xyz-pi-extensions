---
verdict: pass
---

# Todo & GoalManager 工具接口批量化和状态升级

## Background

当前 `todo` 和 `goal_manager` 两个 Tool 的添加/删除操作只支持单条处理。LLM 每次创建 3-8 项 todo 需要调用 3-8 次工具，每次调用消耗一轮 LLM 思考 + 返回完整状态快照。Goal 的 `complete_task` 同理——8 个任务需要 8 次调用。

同时，Goal 的 `GoalTask` 使用 `completed: boolean` 二元标记，无法表达"执行中"或"已取消"等中间状态。需要改为四态模型。

## Functional Requirements

### FR-1: Todo 批量添加

`todo` Tool 的 `add` action 参数从 `text: string` 改为 `texts: string[]`。单条添加通过长度为 1 的数组实现。返回格式为简洁汇总：`已添加 N 项 todo (#X-#Y)`。

**参数变更：**
- 删除：`text: Type.Optional(Type.String())`
- 新增：`texts: Type.Optional(Type.Array(Type.String()))`

**约束：**
- `texts` 不能为空数组
- `texts` 中每项不能为空字符串（`trim()` 后为空也视为无效）
- ID 按数组顺序连续分配

### FR-2: Todo 批量删除

`todo` Tool 的 `delete` action 参数从 `id: number` 改为 `ids: number[]`。单条删除通过长度为 1 的数组实现。

**参数变更：**
- 删除：`id: Type.Optional(Type.Number())`
- 新增：`ids: Type.Optional(Type.Array(Type.Number()))`

**约束：**
- `ids` 不能为空数组
- `ids` 中重复 ID 自动去重后执行（无副作用）
- 不存在的 ID 整体报错（不部分删除）

### FR-3: Todo update 保持单条

`update` action 的 `id` 和 `status` 参数不变。

### FR-4: GoalTask 四态模型

`GoalTask` 接口从 `completed: boolean` 改为 `status: "pending" | "in_progress" | "completed" | "cancelled"`。

**类型变更：**
```typescript
// 旧
interface GoalTask {
  id: number;
  description: string;
  completed: boolean;
  evidence?: string;
}

// 新
interface GoalTask {
  id: number;
  description: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  evidence?: string;
}
```

**状态语义：**
- `pending` — 未开始（初始状态）
- `in_progress` — 执行中
- `completed` — 已完成，必须有 evidence
- `cancelled` — 已取消，不阻碍 goal 完成

**约束：**
- `evidence` 仅在 `status === "completed"` 时有意义
- `cancelled` 不强制要求 reason
- 不做向后兼容：`deserializeState` 不处理旧 `completed: boolean` 格式

### FR-5: Goal update_tasks action（替代 complete_task）

删除 `complete_task` action，新增 `update_tasks` action。接受 `updates` 数组，每条包含 `taskId`、`status`、可选 `evidence`。

**参数变更：**
- 删除：`taskId: Type.Optional(Type.Number())`
- 新增：`updates: Type.Optional(Type.Array(Type.Object({ taskId: Type.Number(), status: StringEnum(["pending", "in_progress", "completed", "cancelled"]), evidence: Type.Optional(Type.String()) })))`

**约束：**
- `updates` 不能为空数组
- `updates` 中不能有重复 taskId（整体报错）
- 当 `status === "completed"` 时，`evidence` 必填且非空
- 当 `status !== "completed"` 时，如果提供了 `evidence`，静默忽略
- 对已经 `cancelled` 的任务不允许再变更状态（返回错误）
- 对已经 `completed` 的任务不允许再变更状态（返回错误）
- 不存在的 taskId 整体报错

### FR-6: Goal complete_goal 逻辑调整

`complete_goal` 的完成条件从"所有 tasks completed === true"改为"排除 cancelled 后，剩余全部 completed"。

**逻辑变更：**
```typescript
// 旧
const incomplete = tasks.filter(t => !t.completed);

// 新
const incomplete = tasks.filter(t => t.status === "pending" || t.status === "in_progress");
```

### FR-7: Goal 辅助函数适配

以下函数需适配四态模型：

| 函数 | 旧逻辑 | 新逻辑 |
|------|--------|--------|
| `getCompletedCount` | `tasks.filter(t => t.completed).length` | `tasks.filter(t => t.status === "completed").length` |
| `getIncompleteTasks` | `tasks.filter(t => !t.completed)` | `tasks.filter(t => t.status === "pending" \|\| t.status === "in_progress")` |
| `checkProgress` | 依赖上述两个函数 | 间接适配；新增 `allSettled` 判断：`tasks.every(t => t.status === "completed" \|\| t.status === "cancelled")` |

### FR-8: Goal 模板和渲染适配

**`formatTaskList`（templates.ts）：** 从两组（completed / incomplete）改为三组：
1. `completed` — ✓ 图标
2. `in_progress` + `pending` — ☐/● 图标
3. `cancelled` — ✗ 图标，灰色文本

统计行：`N/M 完成, K 已取消`

**`renderStatusLine` / `renderWidgetLines`（widget.ts）：** 任务计数适配四态。

**`renderCall` / `renderResult`（index.ts）：**
- `renderCall`：`update_tasks` action 显示 `(N updates)` 而非单条 taskId
- `renderResult`：任务列表渲染适配四态图标

### FR-9: Goal promptGuidelines 更新

`goal_manager` Tool 的 `promptGuidelines` 需更新：
- 删除所有 `complete_task` 引用
- 新增 `update_tasks` 使用说明（批量状态变更，completed 必须带 evidence）
- 新增 `cancelled` 状态说明（不阻碍 goal 完成，无需 reason）
- 删除 `taskId` 参数说明

### FR-10: Goal agent_end 自动完成逻辑适配

`handleAgentEnd` 中"所有任务完成"的检测逻辑：
- 旧：`incomplete.length === 0`（基于 `!completed`）
- 新：`tasks.every(t => t.status === "completed" || t.status === "cancelled")`
- 且至少有一个 `completed`（全部 cancelled 不算成功）

### FR-11: Goal state 序列化/反序列化

`serializeState` / `deserializeState` 适配新 `GoalTask` 结构。不做向后兼容——旧 session 的 goal-state entry 中 `completed: boolean` 格式将不被识别，视为无活跃 goal。

### FR-12: Todo renderCall / renderResult 适配

**`renderCall`：**
- `add` action：显示 `(N items)` 而非单条文本
- `delete` action：显示 `#1, #3, #5` 而非单个 `#1`

**`renderResult`：**
- `add`：显示 `✓ 已添加 3 项 (#1-#3)` 而非单条
- `delete`：显示 `✓ 已删除 3 项 (#1, #3, #5)，剩余 N 项`

## Acceptance Criteria

### AC-1: Todo 批量添加
- 调用 `todo add` 传入 `texts: ["A", "B", "C"]`，返回汇总文本，todos 数组包含 3 项，ID 连续
- 调用 `todo add` 传入 `texts: ["单条"]`，等价于旧的单条添加
- 调用 `todo add` 不传 `texts` 或传空数组，返回错误

### AC-2: Todo 批量删除
- 调用 `todo delete` 传入 `ids: [1, 3]`，两项被删除，返回汇总文本
- 调用 `todo delete` 传入不存在的 ID，返回错误，不部分删除
- 调用 `todo delete` 传入 `ids: [2]`，等价于旧的单条删除

### AC-3: GoalTask 四态
- `create_tasks` 创建的任务初始 status 为 `"pending"`
- 任务可从 `pending` → `in_progress` → `completed`（正常流程）
- 任务可从任意非终态 → `cancelled`
- 已 `completed` 的任务不能再变更状态
- 已 `cancelled` 的任务不能再变更状态
- `completed` 状态的任务必须有 evidence

### AC-4: Goal update_tasks
- 调用 `update_tasks` 传入 3 条 update，其中 2 条 completed + evidence，1 条 cancelled，全部生效
- 调用 `update_tasks` 中某条 completed 不带 evidence，整体报错
- 调用 `update_tasks` 中某条 taskId 不存在，整体报错
- 调用 `update_tasks` 传入空数组，报错
- 调用 `update_tasks` 中包含重复 taskId，整体报错
- 调用 `update_tasks` 传入 `{taskId: 1, status: "in_progress", evidence: "ignored"}`，evidence 被静默忽略，任务状态正常变更

### AC-5: Goal complete_goal 适配
- 8 个任务中 6 completed + 2 cancelled → `complete_goal` 允许完成
- 8 个任务中 6 completed + 2 pending → `complete_goal` 拒绝，提示未完成任务
- 全部 cancelled → `complete_goal` 拒绝（至少需要一个 completed）

### AC-6: 渲染验证
- `formatTaskList` 输出包含三组：completed（✓）、in_progress+pending（●/☐）、cancelled（✗ 灰色）
- `renderCall` 对 `add` 显示 `(N items)`
- `renderCall` 对 `update_tasks` 显示 `(N updates)`
- widget 状态栏显示正确的完成/取消计数

### AC-7: 类型检查通过
- `npx tsc --noEmit` 零错误

### AC-8: ESLint 通过
- `npm run lint` 零 error

## Constraints

- **不做向后兼容**：GoalTask 的 `completed: boolean` 格式不保留兼容代码
- **不改 goal 命令解析**：`/goal` 命令的子命令（set/status/pause/resume/clear/update）不受影响
- **不改 `/todos` 命令**：TUI 组件的 TodoListComponent 渲染逻辑不变（todo 本身的 status 没变）
- **不改 session 重建模式**：goal 用 custom entry、todo 用 toolResult detail，维持各自的持久化方式
- **不改错误处理模式**：goal 继续 throw Error，todo 继续返回 error-success pattern
- **遵循现有架构**：单文件 <1000 行、typebox schema、pi-tui 渲染

## Complexity Assessment

**中等**。涉及两个扩展共 9 个文件，但改动模式清晰且重复（类型替换 + 批量参数 + 渲染适配），无架构级变更。主要风险在 goal 扩展的四态传播——`state.ts`、`templates.ts`、`widget.ts`、`budget.ts` 都要同步修改，遗漏任一处会导致行为不一致。

预估改动量：
- `todo/src/index.ts`：~50 行改动（schema + execute add/delete + renderCall/Result）
- `goal/src/state.ts`：~30 行改动（GoalTask 类型 + 辅助函数）
- `goal/src/index.ts`：~80 行改动（schema + execute handler + render + promptGuidelines）
- `goal/src/templates.ts`：~30 行改动（formatTaskList + steering 模板中的任务描述）
- `goal/src/widget.ts`：~20 行改动（四态渲染）
- `goal/src/budget.ts`：~15 行改动（checkProgress 适配）

总计约 225 行改动，分散在 6 个文件。
