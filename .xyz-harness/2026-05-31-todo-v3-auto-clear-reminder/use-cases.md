---
verdict: pass
---

# Use Cases — todo-v3-auto-clear-reminder

## UC-1: 自动清空已完成任务列表

| 字段 | 值 |
|------|---|
| Actor | Todo Extension（自动化） |
| Preconditions | 用户有 N 个 todo，全部标记为 completed |
| Main Flow | 1. Agent 完成最后一个 todo（update → completed）<br>2. Extension 记录 allCompletedAtCount = current userMessageCount<br>3. 用户发送第 1 条消息（agent_start 递增 userMessageCount）<br>4. before_agent_start 检查：差值 = 1 < 2，不触发<br>5. 用户发送第 2 条消息<br>6. before_agent_start 检查：差值 = 2 ≥ 2，触发自动清空<br>7. Extension 清空 todos、重置 nextId、注入 todo-auto-clear 消息 |
| Alternative Paths | 3a. 用户在 2 轮内添加新 todo → allCompletedAtCount 重置为 null，自动清空取消 |
| Postconditions | todo 列表为空，agent 收到自动清空通知 |
| Module Boundaries | executeTodoAction（设置 allCompletedAtCount） → before_agent_start handler（检查并清空） |
| Spec AC Ref | FR-1 |

## UC-2: 长时间未更新 Todo 提醒

| 字段 | 值 |
|------|---|
| Actor | Todo Extension（自动化） |
| Preconditions | 用户有未完成的 todo 列表 |
| Main Flow | 1. 用户在对话中操作 10 轮，未调用 todo 工具<br>2. before_agent_start 检查：userMessageCount - lastTodoCallCount ≥ 10<br>3. Extension 注入 todo-reminder 消息（display: false）<br>4. Agent 收到提醒，可能主动更新 todo |
| Alternative Paths | 2a. 距上次提醒不足 10 轮 → 不触发（防止频繁提醒）<br>2b. todo 列表为空 → 不触发<br>2c. 已全部完成（allCompletedAtCount !== null）→ 不触发（等待自动清空） |
| Postconditions | Agent 收到 todo-reminder 消息，lastReminderCount 更新 |
| Module Boundaries | executeTodoAction（更新 lastTodoCallCount） → before_agent_start handler（检查并注入） |
| Spec AC Ref | FR-2 |

## UC-3: 验证步骤提醒

| 字段 | 值 |
|------|---|
| Actor | Todo Extension（自动化） |
| Preconditions | 用户完成 3+ 个 todo，且无验证步骤 |
| Main Flow | 1. Agent 完成第 3 个 todo（或更多），全部标记 completed<br>2. before_agent_start 检查：todos.length ≥ 3 且无 /verif\|验证/ 匹配<br>3. Extension 注入 todo-verification-nudge 消息（display: false）<br>4. Agent 收到提醒，可能添加验证任务 |
| Alternative Paths | 2a. todo 文本包含"验证"或"verif" → 不触发<br>2b. todo 数量 < 3 → 不触发 |
| Postconditions | Agent 收到 verification nudge 消息 |
| Module Boundaries | executeTodoAction（设置 allCompletedAtCount） → before_agent_start handler（检查并注入） |
| Spec AC Ref | FR-3 |

## Coverage Mapping

| UC | Spec AC | Covered |
|----|---------|---------|
| UC-1 | FR-1 自动清空 | ✅ |
| UC-2 | FR-2 Todo Reminder | ✅ |
| UC-3 | FR-3 Verification Nudge | ✅ |
