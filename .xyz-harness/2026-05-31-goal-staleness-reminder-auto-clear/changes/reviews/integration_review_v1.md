---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 7
  boundaries_checked: 14
  issues_found: 2
  must_fix_count: 0
  low_count: 2
  info_count: 0
  duration_estimate: "20"
---

# Integration Review v1

## 审查记录
- 审查时间：2026-05-31 18:30
- 上游 BLR: business_logic_review_v1.md
- 模块边界点数：14
- 模拟数据验证路径数：6

## BLR 修复验证

| BLR # | 严重度 | 描述 | 修复状态 | 验证方式 |
|--------|--------|------|----------|---------|
| MUST_FIX #1 | MUST_FIX | complete_goal 缺少 writeGoalHistoryEntry | ✅ 已修复 | index.ts `case "complete_goal"` 在 `persistGoalState` 前调用 `writeGoalHistoryEntry(pi, session)` |
| MUST_FIX #2 | MUST_FIX | update_subtodos 应为 update_subtasks | ✅ 已修复 | GoalManagerParams StringEnum 包含 `"update_subtasks"`，case 标签与 tool description 三者一致 |
| LOW #3 | LOW | 停滞重置后未 persistGoalState | ⚠ 未修复 | handleBeforeAgentStart 停滞重置后直接 return message，未调用 persistGoalState。确认仍为 LOW |

## 模块结构

```
index.ts  ←→ state.ts      状态机、序列化、进度计算
index.ts  ←→ budget.ts     预算策略、进展评估
index.ts  ←→ templates.ts  Steering prompt 模板
index.ts  ←→ widget.ts     TUI 渲染
index.ts  ←→ constants.ts  语义常量
index.ts  ←→ commands.ts   命令参数解析
widget.ts ←→ state.ts      进度/时间计算
widget.ts ←→ budget.ts     百分比计算、颜色阈值
templates.ts ←→ state.ts   进度计算
templates.ts ←→ constants.ts 阈值常量
```

## 边界检查矩阵

| UC 编号 | 边界点 | D1 格式转换 | D2 错误传播 | D3 契约一致 | D4 前后端 | 问题 |
|---------|--------|------------|------------|------------|----------|------|
| UC-1 | index→state(transitionStatus) | ✅ | ✅ | ✅ | — | |
| UC-1 | index→state(serializeState) | ✅ | ✅ | ✅ | — | |
| UC-1 | index→state(writeGoalHistoryEntry→getElapsedTimeSeconds) | ✅ | ✅ | ✅ | — | |
| UC-1 | index→widget(renderTerminalStatusLine) | ✅ | ✅ | ✅ | — | |
| UC-1 | index→constants(AUTO_CLEAR_TURNS) | ✅ | — | ✅ | — | |
| UC-2 | index→state(isTerminalTaskStatus) | ✅ | ✅ | ✅ | — | |
| UC-2 | index→constants(TASK_STALL_TURN_THRESHOLD) | ✅ | — | ✅ | — | |
| UC-2 | index→templates(stalenessReminderPrompt) | ✅ | ✅ | ✅ | — | |
| UC-2 | index→state(lastUpdatedTurn 重置) | ✅ | — | ⚠️ | — | LOW #1: 未 persist |
| UC-3 | commands→index(parseGoalArgs) | ✅ | ✅ | ✅ | — | |
| UC-3 | index→constants(截断常量) | ✅ | — | ✅ | — | |
| UC-4 | schema→switch case(action 名称) | ✅ | ✅ | ✅ | — | |
| UC-4 | state→index(deserializeState subTodos 兼容) | ✅ | ✅ | ✅ | — | |
| ALL | index→budget(checkBudgetOnTurnEnd) | ✅ | ✅ | ✅ | — | |

## 问题清单

| # | 严重度 | UC | 边界点 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|-----|--------|------|------|------|------|---------|
| 1 | LOW | UC-2 | index→state | D3 | 停滞重置 lastUpdatedTurn 后未 persist。BLR LOW #3 遗留，非本次新增 | goal/src/index.ts | handleBeforeAgentStart → staleTasks.length > 0 分支末尾 | 在 return 前添加 `persistGoalState(pi, session, ctx);` |
| 2 | LOW | ALL | index→GUI | D4 | `_render.data` 的字段名（`text`, `id`, `evidence`, `subtasks`, `meta`）与 CLAUDE.md 文档的 TaskListData/TaskItem 协议（`title`, `label`, `detail`, `children`）不一致。xyz-agent GUI 未实现，暂无影响 | goal/src/index.ts | makeGoalResult `_render` 字段 | 待 xyz-agent 实现 GUI 时统一对齐 |

## 模拟数据验证详情

### UC-1: Goal 完成后自动清理

#### 边界 index→state(transitionStatus)

**模拟数据：** `current = "active", next = "complete"`
**调用方传递：** `transitionStatus("active", "complete")`
**被调用方逻辑：** `TERMINAL_STATUSES.has("active")` → false → return `"complete"`
**结论：** ✅ 匹配 — active→complete 转换正常

#### 边界 index→state(serializeState → persist)

**模拟数据：** `state.status = "complete", state.completedAtTurnIndex = 15, tasks = [{id:1,status:"completed"},{id:2,status:"completed"}]`
**调用方传递：** `serializeState(session.state)` → 深拷贝含 tasks.map + subtasks.map
**被调用方返回：** 新 GoalRuntimeState 对象，与原状态结构一致
**结论：** ✅ 匹配 — 序列化保留所有字段

#### 边界 index→state(writeGoalHistoryEntry)

**模拟数据：** `state.goalId = "uuid-xxx", state.objective = "修复bug", state.status = "complete", state.tasks = [completed×2]`
**调用方传递：** `pi.appendEntry("goal-history", {goalId, objective, status, completedTasks:2, totalTasks:2, elapsedSeconds, timestamp})`
**被调用方逻辑：** getCompletedCount → 2, getElapsedTimeSeconds → 计算值, Date.now()
**结论：** ✅ 匹配 — BLR MUST_FIX #1 已修复，history entry 正确写入

#### 边界 index→widget(renderTerminalStatusLine)

**模拟数据：** `state.status = "complete", tasks = [completed×2]`
**调用方传递：** `renderTerminalStatusLine(state, ctx.ui.theme)`
**被调用方逻辑：** `state.status === "cancelled"` → false → switch `"complete"` → ✓ 完成
**结论：** ✅ 匹配 — 终态折叠为单行 status bar

#### 边界 index→constants(AUTO_CLEAR_TURNS)

**模拟数据：** `turnsInTerminal = currentTurnIndex(17) - completedAtTurnIndex(15) = 2`
**调用方比较：** `2 >= AUTO_CLEAR_TURNS(2)` → true → clearGoalSession
**结论：** ✅ 匹配 — 终态后 2 turn 自动清理

### UC-2: 长时间执行中 task 被遗忘

#### 边界 index→state(isTerminalTaskStatus) + constants(TASK_STALL_TURN_THRESHOLD)

**模拟数据：** `currentTurnIndex = 22, task.status = "in_progress", task.lastUpdatedTurn = 12`
**调用方计算：** `staleTurns = 22 - 12 = 10`
**被调用方：** `isTerminalTaskStatus("in_progress")` → false → 继续检查; `10 >= TASK_STALL_TURN_THRESHOLD(10)` → 停滞
**结论：** ✅ 匹配 — 停滞检测阈值正确

#### 边界 index→templates(stalenessReminderPrompt)

**模拟数据：** `staleTasks = [{task:{id:2, description:"开发功能"}, staleTurns:10, staleSubtasks:[{text:"编写测试", staleTurns:10}]}, {task:{id:3}, staleTurns:10}]`
**调用方传递：** `stalenessReminderPrompt(state, staleTasks, false)`
**被调用方访问：** `item.task.id`, `item.task.description`, `item.staleTurns`, `item.staleSubtasks[].text`, `item.staleSubtasks[].staleTurns`
**结论：** ✅ 匹配 — 调用方构造的对象结构与被调用方期望的字段完全一致

#### 边界 index→state(lastUpdatedTurn 重置)

**模拟数据：** `item.task.lastUpdatedTurn = 12 → 重置为 22`
**调用方操作：** `item.task.lastUpdatedTurn = state.currentTurnIndex`（直接变异 session.state.tasks 内的对象引用）
**结论：** ⚠️ 变异正确但未 persist — BLR LOW #3 遗留

### UC-3: 查看已完成的历史 Goal

#### 边界 commands→index(parseGoalArgs)

**模拟数据：** `raw = "history"`
**调用方传递：** `parseGoalArgs("history")`
**被调用方返回：** `{ action: "history" }` — GoalCommandArgs 类型
**结论：** ✅ 匹配 — action 枚举值正确

#### 边界 index→constants(截断常量)

**模拟数据：** `h.objective = "这是一个超过八十个字符的超长目标描述..."` (length > 80)
**调用方逻辑：** `h.objective.length > OBJECTIVE_DISPLAY_LIMIT(80)` → true → `h.objective.slice(0, OBJECTIVE_TRUNCATE_KEEP(77)) + "..."`
**结论：** ✅ 匹配 — 77 + "..." = 80 字符显示

### UC-4: 命名迁移 subTodo→subtask

#### 边界 schema→switch case(action 名称)

**模拟数据：** `action = "update_subtasks"`
**StringEnum 枚举：** `["create_tasks", "add_tasks", "update_tasks", "list_tasks", "complete_goal", "cancel_goal", "report_blocked", "add_subtasks", "update_subtasks", "delete_subtasks"]`
**switch case：** `case "update_subtasks":`
**tool description：** `"- update_subtasks: 批量更新 subtask 状态（参数: taskId, subUpdates[]）"`
**结论：** ✅ 匹配 — BLR MUST_FIX #2 已修复，三处名称一致

#### 边界 state→index(deserializeState 旧数据兼容)

**模拟数据：** `old_data = {tasks: [{subTodos: [{id:1, text:"旧", status:"pending"}]}]}`
**被调用方逻辑：** `rawSubtasks = (t.subtasks ?? t.subTodos)` → 取到 `t.subTodos` → filter + map → `[{id:1, text:"旧", status:"pending", lastUpdatedTurn:0}]`
**结论：** ✅ 匹配 — 旧数据 subTodos 字段名向后兼容

### 跨 UC 边界：index→budget(checkBudgetOnTurnEnd)

**模拟数据：** `state.tokensUsed = 85000, state.budget.tokenBudget = 100000`
**调用方传递：** `checkBudgetOnTurnEnd(state)`
**被调用方返回：** `{terminal: null, warnings: [{type:"warning90",dimension:"token"}], shouldSendSteering: false}`
**调用方处理：** `if (w.type === "warning90")` → 设置 budgetWarning90Sent + ctx.ui.notify
**结论：** ✅ 匹配 — BudgetCheckResult 各字段被正确消费

### 跨 UC 边界：index→budget(checkProgress)

**模拟数据：** `state.turnCount = 49, state.budget.maxTurns = 50, tasks = [completed×3]`
**调用方传递：** `checkProgress(state, tasksCompletedAtAgentStart)`
**被调用方返回：** `{allTasksDone: true, noTasksCreated: false, maxTurnsReached: false, isStalled: ..., budgetTight: ..., completedCount: 3, totalCount: 3}`
**调用方处理：** `if (progress.allTasksDone)` → 发送 complete_goal 提示
**结论：** ✅ 匹配 — ProgressCheck 各字段被正确消费

## 完整性验证：终态路径 history 写入覆盖矩阵

| 终态转换路径 | writeGoalHistoryEntry | 代码位置 | 当前状态 |
|-------------|----------------------|---------|---------|
| complete_goal（AI 显式调用） | ✅ 调用 | executeGoalAction → case "complete_goal" | BLR #1 已修复 |
| cancel_goal（AI 显式调用） | ✅ 调用 | executeGoalAction → case "cancel_goal" | 正常 |
| /goal clear（用户命令） | ✅ 调用 | handleGoalCommand → case "clear" | 正常 |
| /goal set 覆盖旧 goal | ✅ 调用 | handleGoalCommand → case "set" | 正常 |
| budget_limited（token 耗尽） | ✅ 调用 | handleAgentEnd → budgetResult.terminal | 正常 |
| time_limited（时间耗尽） | ✅ 调用 | handleAgentEnd → budgetResult.terminal | 正常 |
| auto-complete（allTasksDone + maxTurns） | ✅ 调用 | handleAgentEnd → progress.allTasksDone + maxTurnsReached | 正常 |
| cancel（noTasksCreated + maxTurns） | ✅ 调用 | handleAgentEnd → progress.noTasksCreated + maxTurnsReached | 正常 |
| cancel（maxTurnsReached 有未完成任务） | ✅ 调用 | handleAgentEnd → progress.maxTurnsReached | 正常 |

**结论：9 条终态路径全部覆盖 writeGoalHistoryEntry。**

## 完整性验证：action 名称三处一致性矩阵

| action | StringEnum 枚举 | switch case | tool description | 一致 |
|--------|----------------|-------------|-----------------|------|
| create_tasks | ✅ | ✅ | ✅ | ✅ |
| add_tasks | ✅ | ✅ | ✅ | ✅ |
| update_tasks | ✅ | ✅ | ✅ | ✅ |
| list_tasks | ✅ | ✅ | ✅ | ✅ |
| complete_goal | ✅ | ✅ | ✅ | ✅ |
| cancel_goal | ✅ | ✅ | ✅ | ✅ |
| report_blocked | ✅ | ✅ | ✅ | ✅ |
| add_subtasks | ✅ | ✅ | ✅ | ✅ |
| update_subtasks | ✅ | ✅ | ✅ | ✅ |
| delete_subtasks | ✅ | ✅ | ✅ | ✅ |

**结论：10 个 action 的枚举值、case 标签、description 文本三方完全一致。**

## 结论

**通过。** BLR 的 2 条 MUST FIX 均已在代码中正确修复，验证通过。模块间边界数据传递正确，错误传播安全，接口契约一致。

遗留 2 条 LOW：
1. BLR LOW #3（停滞重置未 persist）仍在，影响有限（崩溃恢复时多一次无效提醒）
2. `_render` 数据结构与 CLAUDE.md 协议定义存在字段名差异，xyz-agent GUI 未实现，暂无影响
