---
verdict: pass
---

# Use Cases — Todo Extension v3 升级

## UC-1: 自动清空已完成的 Todo

**Actor:** Agent（AI 助手）
**Preconditions:** 
- Todo 列表非空
- 所有 todo 状态为 `completed`

**Main Flow:**
1. Agent 完成所有任务，将所有 todo 状态更新为 `completed`
2. 用户发送下一条消息，触发 `agent_start` 事件，`userMessageCount++`
3. 用户发送第二条消息，触发 `agent_start` 事件，`userMessageCount++`
4. 用户发送第三条消息，触发 `before_agent_start` 事件
5. 系统检测到 `allCompletedAtCount !== null && userMessageCount - allCompletedAtCount >= 2`
6. 系统清空 todo 列表，重置 `allCompletedAtCount = null`
7. 系统注入 `todo-auto-clear` 消息（`display: false`）
8. Agent 收到消息，知道列表已清空

**Alternative Paths:**
- **UC-1a: 用户在清空前添加新 todo**
  1. 在步骤 2-4 之间，用户调用 `todo add` 添加新任务
  2. 系统重置 `allCompletedAtCount = null`
  3. 自动清空不再触发

**Postconditions:**
- Todo 列表为空
- 状态栏无显示
- Widget 无显示

**Module Boundaries:** todo extension（状态管理 + before_agent_start 事件）

---

## UC-2: Todo Reminder 提醒

**Actor:** Agent（AI 助手）
**Preconditions:**
- Todo 列表非空
- 距离上次调用 todo 工具已过 10 轮用户消息
- 距离上次提醒已过 10 轮用户消息
- 自动清空未触发（`allCompletedAtCount === null`）

**Main Flow:**
1. Agent 处理用户任务，但未调用 todo 工具
2. 用户连续发送 10 条消息，每次触发 `agent_start` 事件
3. 用户发送第 11 条消息，触发 `before_agent_start` 事件
4. 系统检测到 `userMessageCount - lastTodoCallCount >= 10 && userMessageCount - lastReminderCount >= 10`
5. 系统更新 `lastReminderCount = userMessageCount`
6. 系统注入 `todo-reminder` 消息（`display: false`）
7. Agent 收到消息，决定是否调用 todo 工具更新进度

**Alternative Paths:**
- **UC-2a: Agent 调用 todo 工具**
  1. 在步骤 1-3 之间，Agent 调用 `todo list/add/update`
  2. 系统更新 `lastTodoCallCount = userMessageCount`
  3. 提醒不再触发

**Postconditions:**
- Todo 列表未变
- `lastReminderCount` 已更新

**Module Boundaries:** todo extension（状态管理 + before_agent_start 事件）

---

## UC-3: Verification Nudge 验证提醒

**Actor:** Agent（AI 助手）
**Preconditions:**
- 所有 todo 状态为 `completed`
- Todo 数量 >= 3
- 没有包含 "verif" 或 "验证" 关键词的任务

**Main Flow:**
1. Agent 完成所有任务，将所有 todo 状态更新为 `completed`
2. 用户发送下一条消息，触发 `before_agent_start` 事件
3. 系统检测到 `allCompletedAtCount !== null && todos.length >= 3 && !todos.some(t => /verif|验证/i.test(t.text))`
4. 系统更新 `lastReminderCount = userMessageCount`
5. 系统注入 `todo-verification-nudge` 消息（`display: false`）
6. Agent 收到消息，添加验证任务或直接总结

**Alternative Paths:**
- **UC-3a: 有验证任务**
  1. Agent 在创建 todo 时包含"验证"关键词的任务
  2. 步骤 3 检查不通过，不注入消息

- **UC-3b: 少于 3 个任务**
  1. Agent 只创建了 2 个 todo
  2. 步骤 3 检查不通过，不注入消息

**Postconditions:**
- Todo 列表未变
- Agent 可能添加验证任务

**Module Boundaries:** todo extension（before_agent_start 事件）

---

## Spec AC 覆盖映射

| Use Case | Spec AC | 覆盖说明 |
|----------|---------|----------|
| UC-1 | AC-1 自动清空 | 完整覆盖触发条件、边界情况 |
| UC-2 | AC-2 Todo Reminder | 完整覆盖触发条件、重置逻辑 |
| UC-3 | AC-3 Verification Nudge | 完整覆盖触发条件、优先级 |
| — | AC-4 Prompt 更新 | 无业务流程，静态配置 |
