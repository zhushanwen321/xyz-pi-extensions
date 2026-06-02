---
verdict: pass
---

# Goal Staleness Reminder & Auto-Clear

## Background

Goal 扩展有 7 态状态机，进入终态（complete/cancelled/budget_limited/time_limited）后，session 状态和 widget/status 一直残留，需要用户手动 `/goal clear`。Todo 扩展已有"全部完成后 2 轮自动清理"机制，Goal 缺少类似功能。

同时，Goal 内的 task/subtask 在执行中可能被遗忘——AI 忙于编码但忘记 update_tasks 更新状态。当前只有粗粒度的 stall 检测（全局无任何 task 状态变化），没有细化到个别 task/subtask 的停滞检测。

此外，命名不一致：task 下级的 `subTodo` / `sub-todo` 与 `task` 不在同一语义维度，应统一为 `subtask`。

## Functional Requirements

### FR-1: 终态自动清理

Goal 进入任何终态（complete/cancelled/budget_limited/time_limited）后，经过 N 轮 `before_agent_start` 自动清除 session（等同 `/goal clear`）。

- **终态中间态**：进入终态后，widget **折叠为单行 status bar**（显示终态状态 + 预算摘要，如 `◆ Goal ✓ 完成 | 3/5 任务 | Token: 45%`），task 列表不再渲染
- N 轮后（默认 2 轮，与 todo 一致），自动执行 `clearGoalSession`
- 自动清理后，widget 和 status **完全消失**
- 所有终态均保留 budget report 通知（通过 status bar 显示），用户有 2 轮窗口查看
- **快照写入**：goal 进入终态时，在 `clearGoalSession` 之前自动写入一个 `goal-history` entry（见 FR-4）

### FR-2: Task/Subtask 停滞提醒

在 `before_agent_start` 中检查所有非终态 task 和 subtask 的停滞时间。如果有任何非终态 task/subtask 停滞超过阈值（默认 10 turn），注入 steering 提醒。

- 停滞计数基准：`turn_end` 粒度（与 skill-state 一致）
- 每个 task/subtask 记录 `lastUpdatedTurn`：最近一次状态变更时的 `currentTurnIndex`
- 停滞计算：`currentTurnIndex - lastUpdatedTurn`
- **提醒范围**：一次性列出所有非终态 task 及其 subtask 的停滞 turn 数
- **提醒内容**：格式化列表（task ID + 描述 + 停滞 turn 数 + subtask 状态），提示 agent 更新状态或继续推进
- 提醒触发后重置**所有被列出项**的 `lastUpdatedTurn` 为当前值
- **边界情况**：当所有 task 已终态但 goal 仍为 active 时，注入提醒 "所有任务已完成，请调用 complete_goal 或 cancel_goal"

### FR-3: 命名统一 subTodo → subtask

将代码中所有 `subTodo` / `sub-todo` / `sub_todos` 统一为 `subtask` / `subtasks`：

- 类型名：`SubTodo` → `Subtask`
- 字段名：`subTodos` → `subtasks`
- 工具参数名：`add_sub_todos` → `add_subtasks`, `update_sub_todos` → `update_subtasks`, `delete_sub_todos` → `delete_subtasks`
- 参数字段名：`subUpdates` → `subUpdates`（保持不变，已经足够清晰）
- 工具 description 和 promptGuidelines 中的所有引用
- TUI 渲染中的所有引用
- 向后兼容：`deserializeState` 需兼容旧 `subTodos` 字段名

### FR-4: /goal history 查看历史

新增 `/goal history` 子命令，展示当前 session 内已终结的 goal 列表。

- **快照机制**：
  - 新增 entry type `goal-history`（与现有 `goal-state` 分离）
  - 在 goal 进入终态时（`transitionStatus` 调用后、`clearGoalSession` 之前）写入快照
  - 快照字段：`{ goalId, objective, status, completedTasks, totalTasks, elapsedSeconds, timestamp }`
  - 快照不随 `clearGoalSession` 删除，由 session 级 GC 管理（每个 session 最多保留最近 20 条）
- 显示每个已终结 goal 的：objective（截断到 80 字符）、终态状态、完成/总任务数、用时
- 不做跨 session 持久化（未来可扩展为文件存储）

## Acceptance Criteria

### AC-1: 终态自动清理
- [ ] Goal 进入终态后，`GoalSession` 记录 `completedAtTurnIndex`
- [ ] 进入终态时，widget 折叠为单行 status bar（终态状态 + 预算摘要），task 列表不再渲染
- [ ] 每次 `before_agent_start`，如果 goal 处于终态且 `currentTurnIndex - completedAtTurnIndex >= 2`，自动清除 session
- [ ] 清除后 widget 和 status 完全消失
- [ ] 进入终态时自动写入 `goal-history` 快照 entry

### AC-2: 停滞提醒
- [ ] `GoalRuntimeState` 新增 `currentTurnIndex` 字段（初始值 0，goal 创建时设置），在 `turn_end` 事件中递增
- [ ] `GoalTask` 新增 `lastUpdatedTurn` 字段（默认 0，即 goal 创建时的 turn），在 task 状态变更时更新为当前 `currentTurnIndex`
- [ ] `Subtask` 新增 `lastUpdatedTurn` 字段（默认为 subtask 创建时的 `currentTurnIndex`），在 subtask 状态变更时更新
- [ ] `before_agent_start` 中检查：如果有任何非终态 task/subtask 停滞 >= 10 turn，注入提醒
- [ ] 提醒内容列出所有非终态 task 及其停滞 turn 数（含 subtask 状态摘要）
- [ ] 提醒触发后重置所有被列出项的 `lastUpdatedTurn` 为当前 `currentTurnIndex`
- [ ] 边界情况：所有 task 终态但 goal 仍 active 时，注入 complete_goal/cancel_goal 提醒

### AC-3: 命名统一
- [ ] 所有 `subTodo`/`sub-todo` 引用改为 `subtask`
- [ ] 工具参数 action 名变更（add_subtasks 等）
- [ ] `deserializeState` 兼容旧 `subTodos` 字段名

### AC-4: /goal history
- [ ] `/goal history` 从 `goal-history` entries 读取并显示当前 session 内已终结的 goal 列表
- [ ] 每条历史显示：objective（截断 80 字符）、终态状态、完成/总任务数、用时
- [ ] 无历史时显示 "暂无历史 Goal"
- [ ] `goal-history` entry 在 goal 进入终态时自动写入（与 AC-1 联动）
- [ ] `goal-history` entries 不被 `clearGoalSession` 或 goal-state GC 清理

## Constraints

- **向后兼容**：`deserializeState` 必须兼容旧格式（无 `currentTurnIndex`、`lastUpdatedTurn`、`subTodos` 旧字段名）
- **事件选择**：停滞计数用 `turn_end`，清理和提醒检查用 `before_agent_start`，与 todo/skill-state 模式一致
- **命名迁移**：subTodo → subtask 是破坏性变更（工具参数名变了），但由于 goal 是 AI 调用的工具，AI 的 prompt 会被 promptGuidelines 更新覆盖，不需要用户侧迁移
- **_render 协议**：`_render.data.items[].subItems` 字段名同步变更为 `subtasks`，xyz-agent GUI 侧需配套更新
- **持久化限制**：history 仅限当前 session，不做文件 I/O
- **停滞阈值**：默认 10 turn，暂不可配置（与 `BudgetConfig.maxStallTurns` 不同维度的概念，后续按需加入配置）

## 业务用例

### UC-1: Goal 完成后自动清理
- **Actor**: AI agent（自动）
- **场景**: Goal 所有任务完成，AI 调用 `complete_goal`，goal 进入 `complete` 终态
- **预期结果**: status bar 显示 `◆ Goal ✓ 完成`，2 轮对话后 widget 和 status 自动消失

### UC-2: 长时间执行的 Goal 中 task 被遗忘
- **Actor**: AI agent（自动）
- **场景**: Goal 有 5 个 task，AI 完成 #1 后专注于编码，忘记 update_tasks 更新状态
- **预期结果**: 10 turn 后，`before_agent_start` 注入 steering 提醒列出停滞项，AI 更新 task 状态

### UC-3: 查看已完成的历史 Goal
- **Actor**: 用户
- **场景**: 用户想回顾本次 session 做了哪些 goal
- **预期结果**: 输入 `/goal history`，看到已完成/取消的 goal 列表

## Complexity Assessment

**中等复杂度**。核心改动集中在：
1. `state.ts`：新增 3 个字段 + 类型重命名 + 向后兼容
2. `index.ts`：新增 `turn_end` / `before_agent_start` 逻辑 + 自动清理 + 停滞提醒 + history 命令
3. `templates.ts`：新增停滞提醒 prompt 模板
4. `commands.ts`：新增 `history` 子命令
5. `widget.ts`：无实质改动

无外部依赖变更，无架构重构。最大的风险点是 `deserializeState` 的向后兼容——字段缺失需要给合理默认值。
