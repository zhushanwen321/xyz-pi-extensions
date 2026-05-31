---
verdict: pass
---

# Business Use Cases — goal-staleness-reminder-auto-clear

## UC-1: Goal 完成后自动清理

- **Actor:** AI agent（自动）
- **Preconditions:** Goal 已创建且所有 task 已完成
- **Main Flow:**
  1. AI 调用 `goal_manager complete_goal` 附带 evidence
  2. Goal 状态转为 `complete`
  3. 系统记录 `completedAtTurnIndex = currentTurnIndex`
  4. 系统写入 `goal-history` 快照 entry
  5. Widget 折叠为单行 status bar（`◆ Goal ✓ 完成 | N/N 任务`）
  6. 用户继续对话 2 轮
  7. `before_agent_start` 检测到 `currentTurnIndex - completedAtTurnIndex >= 2`
  8. 系统自动执行 `clearGoalSession`，widget 和 status 完全消失
- **Alternative Paths:**
  - 4a. 快照写入失败 → 不阻塞清理流程，history 功能降级
- **Postconditions:** Goal session 已清除，history entry 保留
- **Module Boundaries:** index.ts (handleBeforeAgentStart, clearGoalSession) → widget.ts (renderTerminalStatusLine) → state.ts (completedAtTurnIndex)
- **Spec AC Coverage:** AC-1 全部

## UC-2: 长时间执行中 task 被遗忘

- **Actor:** AI agent（自动）
- **Preconditions:** Goal 已创建，task 已创建，AI 正在执行编码工作
- **Main Flow:**
  1. AI 完成 task #1，调用 `update_tasks` 标记 completed（lastUpdatedTurn 更新）
  2. AI 专注于编码，不操作 task #2 和 #3
  3. 每个 `turn_end` 事件，`currentTurnIndex` 递增
  4. task #2 和 #3 的 `lastUpdatedTurn` 不变（保持创建时的值）
  5. 当 `currentTurnIndex - task.lastUpdatedTurn >= 10` 时
  6. `before_agent_start` 检测到停滞，注入 staleness 提醒
  7. 提醒内容列出 #2 和 #3 的停滞 turn 数及 subtask 状态
  8. 重置被提醒项的 `lastUpdatedTurn` 为当前值
  9. AI 响应提醒，更新 task 状态或继续推进
- **Alternative Paths:**
  - 5a. 所有 task 已终态但 goal 仍 active → 注入 "请调用 complete_goal" 提醒
  - 6a. 提醒注入后 AI 仍未更新 → 10 turn 后再次提醒
- **Postconditions:** AI 被提醒更新 task 状态，goal 继续正常执行
- **Module Boundaries:** index.ts (handleTurnEnd → checkStaleness → stalenessReminderPrompt) → templates.ts (stalenessReminderPrompt) → state.ts (currentTurnIndex, lastUpdatedTurn)
- **Spec AC Coverage:** AC-2 全部

## UC-3: 查看已完成的历史 Goal

- **Actor:** 用户
- **Preconditions:** 当前 session 内至少有一个已终结的 goal
- **Main Flow:**
  1. 用户输入 `/goal history`
  2. 系统从 `goal-history` entries 读取历史快照
  3. 按时间倒序排列
  4. 格式化显示每条记录：objective（截断 80 字符）、状态图标、完成/总任务数、用时
  5. 用户查看后继续其他操作
- **Alternative Paths:**
  - 2a. 无 `goal-history` entries → 显示 "暂无历史 Goal"
- **Postconditions:** 用户了解本次 session 的 goal 执行历史
- **Module Boundaries:** commands.ts (parseGoalArgs "history") → index.ts (handleGoalCommand "history" case) → state.ts (getElapsedTimeSeconds)
- **Spec AC Coverage:** AC-4 全部

## UC-4: 命名迁移（subTodo → subtask）

- **Actor:** AI agent（调用工具时）
- **Preconditions:** goal 扩展已更新为使用新命名
- **Main Flow:**
  1. AI 调用 `goal_manager add_subtasks`（新 action 名）
  2. 系统在 GoalTask 上创建 subtask（新类型名）
  3. AI 调用 `update_subtasks` / `delete_subtasks`（新 action 名）
  4. 所有操作正常执行
- **Alternative Paths:**
  - 1a. 旧 session 包含 `subTodos` 字段 → `deserializeState` 自动映射为 `subtasks`，`lastUpdatedTurn` 默认 0
- **Postconditions:** 新命名统一生效，旧数据向后兼容
- **Module Boundaries:** state.ts (Subtask, subtasks, deserializeState) → index.ts (tool schema, handlers)
- **Spec AC Coverage:** AC-3 全部

---

## UC-AC 覆盖映射表

| UC | 覆盖的 AC 条目 |
|----|---------------|
| UC-1 | AC-1 #1~#5（completedAtTurnIndex, widget 折叠, auto-clear, 清除, 快照写入） |
| UC-2 | AC-2 #1~#7（currentTurnIndex, lastUpdatedTurn×2, 停滞检查, 提醒内容, 重置, 边界） |
| UC-3 | AC-4 #1~#5（history 显示, 字段, 提示, 快照写入, entry 隔离） |
| UC-4 | AC-3 #1~#3（命名统一, action 名, deserializeState 兼容） |
