---
verdict: fail
must_fix: 2
review_metrics:
  files_reviewed: 7
  issues_found: 3
  must_fix_count: 2
  low_count: 1
  info_count: 0
  duration_estimate: "25"
---

# Dev Business Logic Review v1

## 审查记录
- 审查时间：2026-05-31 18:00
- 审查模式：Dev（L1 + L2）
- 审查对象：use-cases.md + git diff + 源代码（7 文件）
- 模拟数据路径数：6

## UC 覆盖追踪

| UC 编号 | UC 名称 | 覆盖状态 | 执行路径 | 发现的问题 |
|---------|---------|---------|----------|-----------|
| UC-1 | Goal 完成后自动清理 | ⚠️ 部分 | complete_goal → 终态 → widget 折叠 → auto-clear | #1 MUST_FIX: complete_goal 不写 goal-history entry |
| UC-2 | Task 停滞提醒 | ✅ 完整 | turn_end++ → before_agent_start 检查 → 注入提醒 → 重置 | #3 LOW: 重置未 persist |
| UC-3 | 查看历史 Goal | ✅ 完整 | /goal history → 读 entries → 格式化显示 | 受 #1 影响：complete 路径的 goal 不会出现 |
| UC-4 | 命名迁移 subTodo→subtask | ⚠️ 部分 | schema/action 名称 → AI 调用 | #2 MUST_FIX: update_subtodos 应为 update_subtasks |

## 问题清单

| # | 严重度 | UC 编号 | 描述 | 文件 | 行号/位置 | 修改建议 |
|---|--------|---------|------|------|----------|---------|
| 1 | MUST_FIX | UC-1 | `complete_goal` 不写入 `goal-history` entry。`executeGoalAction` 的 `"complete_goal"` case 设置了 `completedAtTurnIndex` 并 persist，但缺少 `writeGoalHistoryEntry(pi, session)` 调用。所有其他终态转换路径（cancel_goal、budget_limited、time_limited、maxTurnsReached 等）都正确调用了 `writeGoalHistoryEntry`，唯独 `complete_goal` 遗漏。 | goal/src/index.ts | executeGoalAction → case "complete_goal" → `state.completedAtTurnIndex = ...` 之后 | 在 `persistGoalState` 之前添加 `writeGoalHistoryEntry(pi, session);` |
| 2 | MUST_FIX | UC-4 | 工具参数 action 枚举值 `"update_subtodos"` 不符合 spec 要求的 `"update_subtasks"`。spec AC-3 明确要求 `update_sub_todos` → `update_subtasks`，但 StringEnum 中实际值为 `"update_subtodos"`（中间没有下划线分隔 update 和 sub）。同时 tool description 中写的是 `update_subtasks`，与枚举值不一致，AI 按 description 调用将得到参数校验错误。 | goal/src/index.ts | GoalManagerParams → action StringEnum 数组 | 将 `"update_subtodos"` 改为 `"update_subtasks"` |
| 3 | LOW | UC-2 | `handleBeforeAgentStart` 中停滞检测重置 `lastUpdatedTurn` 后未调用 `persistGoalState`。若进程在下次 persist 前崩溃，session 重建时重置值丢失，任务会被重新标记为停滞（多一次无效提醒）。实际影响有限：崩溃是低频事件，后果仅为一次多余提醒。 | goal/src/index.ts | handleBeforeAgentStart → `if (staleTasks.length > 0)` 分支末尾 | 在 return 之前添加 `persistGoalState(pi, session, ctx);` |

## 执行路径详情（Dev 模式）

### UC-1: Goal 完成后自动清理

**模拟数据：**
```json
{
  "uc_id": "UC-1",
  "scenario": "Goal 所有任务完成，AI 调用 complete_goal",
  "input_data": {
    "state.status": "active",
    "state.currentTurnIndex": 15,
    "state.tasks": [
      { "id": 1, "status": "completed", "evidence": "测试通过" },
      { "id": 2, "status": "completed", "evidence": "文件已创建" }
    ],
    "params.evidence": "所有功能已实现并通过测试"
  }
}
```

**执行路径：**
```
executeGoalAction("complete_goal")
  → 校验 evidence 非空 ✓
  → 校验 tasks 非空 ✓
  → getIncompleteTasks → [] ✓
  → getCompletedCount → 2 > 0 ✓
  → state.status = "complete"
  → state.completedAtTurnIndex = 15
  → ❌ 缺少 writeGoalHistoryEntry(pi, session)
  → persistGoalState ✓
  → makeGoalResult with budget report ✓

handleAgentEnd:
  → state.status === "complete" → persistGoalState + updateWidget + notify ✓
  → updateWidget → isTerminalStatus → renderTerminalStatusLine("◆ Goal ✓ 完成 | 2/2 任务") ✓

turn_end: currentTurnIndex = 16

before_agent_start (turn 16):
  → isTerminalStatus → turnsInTerminal = 16 - 15 = 1 < 2 → 折叠 status bar ✓

turn_end: currentTurnIndex = 17

before_agent_start (turn 17):
  → isTerminalStatus → turnsInTerminal = 17 - 15 = 2 >= 2 → clearGoalSession ✓
  → widget 和 status 完全消失 ✓
```

**异常路径（snapshot 写入失败）：**
```
spec: "快照写入失败 → 不阻塞清理流程"
实际: writeGoalHistoryEntry 使用 pi.appendEntry，无 try-catch 包裹
  → 如果 appendEntry 抛异常，complete_goal 整体失败
  → 建议: 为 writeGoalHistoryEntry 添加 try-catch（非 MUST_FIX，当前 appendEntry 不太可能抛异常）
```

**异常路径（cancel_goal 即时清理）：**
```
executeGoalAction("cancel_goal")
  → state.status = "cancelled"
  → state.completedAtTurnIndex = 5
  → writeGoalHistoryEntry ✓
  → persistGoalState ✓
  → clearGoalSession (立即清除) ✓
  → updateWidget: cancelled → widget/status 均为 undefined ✓

before_agent_start:
  → !session.state → return (无操作) ✓
```

---

### UC-2: 长时间执行中 task 被遗忘

**模拟数据：**
```json
{
  "uc_id": "UC-2",
  "scenario": "5 个 task，完成 #1 后其余停滞",
  "input_data": {
    "state.currentTurnIndex": 22,
    "state.tasks": [
      { "id": 1, "status": "completed", "lastUpdatedTurn": 12, "evidence": "done" },
      { "id": 2, "status": "in_progress", "lastUpdatedTurn": 12, "subtasks": [
        { "id": 1, "status": "in_progress", "lastUpdatedTurn": 12, "text": "编写测试" },
        { "id": 2, "status": "completed", "lastUpdatedTurn": 15, "text": "设计接口" }
      ]},
      { "id": 3, "status": "pending", "lastUpdatedTurn": 12 }
    ]
  },
  "expected_stale_tasks": ["#2 (10 turn)", "#3 (10 turn)"],
  "expected_stale_subtasks": ["#2.1 编写测试 (10 turn)"]
}
```

**执行路径：**
```
handleBeforeAgentStart:
  → isTerminalStatus("active") → false
  → isActiveStatus("active") → true
  → hasPendingInjection = true
  → 停滞检查循环:
    task #1: isTerminalTaskStatus("completed") → true → skip (allTerminal 不受影响)
    task #2: isTerminalTaskStatus("in_progress") → false → allTerminal = false
      staleTurns = 22 - 12 = 10 >= TASK_STALL_TURN_THRESHOLD(10) ✓
      subtask #2.1: status="in_progress", subStale = 22-12 = 10 >= 10 → 加入 staleSubtasks ✓
      subtask #2.2: status="completed" → skip ✓
      → staleTasks.push({task:#2, staleTurns:10, staleSubtasks:[{text:"编写测试", staleTurns:10}]})
    task #3: isTerminalTaskStatus("pending") → false → allTerminal = false
      staleTurns = 22 - 12 = 10 >= 10 ✓
      → staleTasks.push({task:#3, staleTurns:10, staleSubtasks:[]})

  → staleTasks.length = 2 > 0 → 进入注入分支
  → 重置 lastUpdatedTurn:
    task #2.lastUpdatedTurn = 22 ✓
    subtask #2.1.lastUpdatedTurn = 22 ✓
    task #3.lastUpdatedTurn = 22 ✓
  → ❌ 未调用 persistGoalState（LOW #3）
  → return stalenessReminderPrompt:
    "#2: <description> (10 turn 未操作)
       - 编写测试 (10 turn)
     #3: <description> (10 turn 未操作)
     请检查这些任务的状态..."

handleAgentEnd:
  → hasPendingInjection = true → false, return ✓
  → 不发送 continuation prompt（避免与 staleness reminder 冲突）✓
```

**异常路径（所有 task 已终态但 goal 仍 active）：**
```json
{
  "state.tasks": [
    { "id": 1, "status": "completed" },
    { "id": 2, "status": "cancelled" }
  ],
  "state.status": "active"
}
```
```
handleBeforeAgentStart:
  → 停滞检查循环:
    task #1: completed → skip (但 allTerminal 保持 true)
    task #2: cancelled → skip (但 allTerminal 保持 true)
  → allTerminal = true, tasks.length = 2 > 0
  → return stalenessReminderPrompt(state, [], true)
  → 提示内容: "所有任务已完成，但 goal_manager 未关闭。请调用 complete_goal 或 cancel_goal。" ✓
```

**异常路径（提醒后 AI 仍未更新，10 turn 后再提醒）：**
```
重置后: task #2.lastUpdatedTurn = 22
turn_end × 10: currentTurnIndex = 32
next before_agent_start:
  task #2: staleTurns = 32 - 22 = 10 >= 10 → 再次触发 ✓
```

---

### UC-3: 查看已完成的历史 Goal

**模拟数据：**
```json
{
  "uc_id": "UC-3",
  "scenario": "Session 内有 2 个已终结的 goal",
  "input_data": {
    "entries": [
      { "customType": "goal-history", "data": {
        "goalId": "aaa-111",
        "objective": "修复登录页面 bug",
        "status": "complete",
        "completedTasks": 3,
        "totalTasks": 3,
        "elapsedSeconds": 420,
        "timestamp": 1700000000000
      }},
      { "customType": "goal-history", "data": {
        "goalId": "bbb-222",
        "objective": "这是一个超过八十个字符的超长目标描述用于测试截断功能是否正常工作abcdef",
        "status": "cancelled",
        "completedTasks": 1,
        "totalTasks": 5,
        "elapsedSeconds": 180,
        "timestamp": 1700001000000
      }}
    ]
  }
}
```

**执行路径：**
```
handleGoalCommand("history"):
  → parseGoalArgs("history") → { action: "history" } ✓
  → ctx.sessionManager.getEntries()
  → filter goal-history entries → 2 条 ✓
  → reverse sort (按时间倒序):
    1. bbb-222 (较新)
    2. aaa-111 (较旧)
  → 格式化:
    1. ✗ 这是一个超过八十个字符的超长目标描述用于测试截断功能是否正常工作ab...
       1/5 任务 | 3分0秒 | cancelled
    2. ✓ 修复登录页面 bug
       3/3 任务 | 7分0秒 | complete
  → ctx.ui.notify(lines.join("\n")) ✓

注意: 受 MUST_FIX #1 影响，通过 complete_goal 完成的 goal 不会出现在此列表中
```

**异常路径（无历史）：**
```
→ historyEntries.length === 0
→ ctx.ui.notify("暂无历史 Goal", "info") ✓
```

---

### UC-4: 命名迁移（subTodo → subtask）

**模拟数据：**
```json
{
  "uc_id": "UC-4",
  "scenario": "AI 使用新 action 名调用工具 + 旧数据兼容",
  "input_data": {
    "new_action": "add_subtasks",
    "params": { "taskId": 2, "texts": ["编写单元测试", "添加集成测试"] },
    "currentTurnIndex": 8,
    "old_data": {
      "tasks": [
        { "id": 1, "status": "pending", "subTodos": [
          { "id": 1, "text": "旧 sub-todo", "status": "pending" }
        ]}
      ]
    }
  }
}
```

**执行路径（新 action）：**
```
executeGoalAction("add_subtasks"):
  → params.taskId = 2 → 校验存在 ✓
  → isTerminalTaskStatus → false ✓
  → subtasks = [] → startId = 1
  → newSubtasks = [
      { id: 1, text: "编写单元测试", status: "pending", lastUpdatedTurn: 8 },
      { id: 2, text: "添加集成测试", status: "pending", lastUpdatedTurn: 8 }
    ] ✓
  → persistGoalState ✓
  → return makeGoalResult ✓
```

**执行路径（update_subtodos — 当前代码中的 bug）：**
```
AI 按 description 调用 action="update_subtasks":
  → StringEnum 校验: "update_subtasks" 不在枚举 ["add_subtasks", "update_subtodos", "delete_subtasks"] 中
  → ❌ 参数校验失败，工具调用报错

AI 如果恰好知道内部 action 名调用 action="update_subtodos":
  → 进入 case "update_subtodos" ✓
  → sub.lastUpdatedTurn = state.currentTurnIndex ✓
  → 功能正确，但 action 名违反 spec
```

**执行路径（旧数据兼容）：**
```
deserializeState(old_data):
  → tasks 映射:
    rawSubtasks = (t.subtasks ?? t.subTodos) → t.subTodos 兼容 ✓
    → filter + map: { id: 1, text: "旧 sub-todo", status: "pending", lastUpdatedTurn: 0 }
  → lastUpdatedTurn: (t.lastUpdatedTurn as number) ?? 0 → 0 ✓
  → GoalTask: { id: 1, status: "pending", subtasks: [...], lastUpdatedTurn: 0 } ✓
```

---

## 各终态转换路径的 history 写入覆盖矩阵

| 终态转换路径 | 代码位置 | writeGoalHistoryEntry | completedAtTurnIndex |
|-------------|---------|----------------------|---------------------|
| complete_goal（AI 显式调用） | executeGoalAction | ❌ **缺失** | ✓ |
| cancel_goal（AI 显式调用） | executeGoalAction | ✓ | ✓ |
| /goal clear（用户命令） | handleGoalCommand | ✓ | ✓ |
| /goal set 覆盖旧 goal | handleGoalCommand | ✓ | ✓ |
| budget_limited（预算耗尽） | handleAgentEnd | ✓ | ✓ |
| time_limited（时间耗尽） | handleAgentEnd | ✓ | ✓ |
| auto-complete（allTasksDone + maxTurns） | handleAgentEnd | ✓ | ✓ |
| cancel（noTasksCreated + maxTurns） | handleAgentEnd | ✓ | ✓ |
| cancel（maxTurnsReached 有未完成任务） | handleAgentEnd | ✓ | ✓ |

**结论：9 条终态路径中，仅 `complete_goal`（最常用的正常完成路径）缺少 history 写入。**

## 结论

**需修改：2 条 MUST FIX。**

1. `complete_goal` 缺少 `writeGoalHistoryEntry` — 正常完成的 goal 不会出现在 `/goal history` 中，这是用户最常用的完成路径，影响范围最大。
2. `update_subtodos` action 名与 spec/usage 不一致 — AI 按 tool description 调用 `update_subtasks` 将得到参数校验错误，subtask 状态更新功能不可用。

修复后需重审 v2。
