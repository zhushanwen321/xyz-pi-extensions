---
verdict: pass
---

# E2E Test Plan — goal-staleness-reminder-auto-clear

## Test Scenarios

### TS-1: 终态自动清理（对应 AC-1）

**前置条件：** Pi 运行中，goal 扩展已加载。

1. 用户输入 `/goal test auto-clear --max-turns 10`
2. AI 创建 task 并完成（调用 create_tasks → update_tasks → complete_goal）
3. 验证：goal 进入 `complete` 终态后，status bar 折叠为单行（`◆ Goal ✓ 完成 | N/N 任务`）
4. 用户发送 2 条无关消息
5. 验证：第 2 条消息后，goal widget 和 status 完全消失
6. 验证：goal-history entry 已写入（可通过 `/goal history` 检查）

### TS-2: Task 停滞提醒（对应 AC-2）

**前置条件：** Pi 运行中，goal 扩展已加载。

1. 用户输入 `/goal test staleness --max-turns 100`
2. AI 创建 3 个 task
3. AI 完成 task #1，但不再操作 task #2 和 #3
4. 模拟 10+ turn_end 事件（通过发送消息触发 AI 响应）
5. 验证：before_agent_start 注入 staleness 提醒，内容包含 task #2 和 #3 的停滞 turn 数
6. 验证：提醒后 task #2 和 #3 的 lastUpdatedTurn 已重置

### TS-3: 边界情况 — 所有 task 终态但 goal 未终结（对应 AC-2 第 7 条）

1. 用户输入 `/goal test boundary`
2. AI 创建 2 个 task，都标记为 completed
3. AI 不调用 complete_goal
4. 验证：10 turn 后注入 "所有任务已完成，请调用 complete_goal 或 cancel_goal" 提醒

### TS-4: 命名统一（对应 AC-3）

1. 启动 Pi，调用 goal_manager 的 add_subtasks（新 action 名）
2. 验证：成功添加 subtask
3. 调用 update_subtasks（新 action 名）
4. 验证：状态更新成功
5. 调用 delete_subtasks（新 action 名）
6. 验证：删除成功
7. 加载旧格式 session（含 subTodos 字段的 entry），验证 deserializeState 兼容

### TS-5: /goal history（对应 AC-4）

1. 完成一个 goal（创建 → 完成 → 等待自动清理）
2. 再创建一个 goal 并取消
3. 输入 `/goal history`
4. 验证：显示 2 条历史记录（第一条 complete，第二条 cancelled）
5. 验证：每条显示 objective（截断 80 字符）、状态、任务数、用时

### TS-6: 无 history 时的提示

1. 启动新 session（无历史）
2. 输入 `/goal history`
3. 验证：显示 "暂无历史 Goal"

### TS-7: 非终态取消的 auto-clear

1. 用户输入 `/goal test cancel`
2. AI 创建 task
3. 用户输入 `/goal clear`（cancel 状态）
4. 验证：goal 立即清除（cancel 已在 cancel_goal handler 中 clearGoalSession，无需等待）

### TS-8: budget_limited / time_limited 终态的 auto-clear

1. 用户输入 `/goal test budget-limit --tokens 1000`
2. AI 创建 task 并工作直到 token 预算耗尽
3. 验证：goal 进入 `budget_limited` 状态，widget 折叠
4. 发送 2 条消息后验证 widget 消失
5. `/goal history` 显示 budget_limited 记录

## Test Environment

- **运行环境：** Pi coding agent（本地安装）
- **前置配置：** goal 扩展已 symlink 到 `~/.pi/agent/extensions/goal`
- **验证工具：** 手动输入命令 + 观察 TUI widget/status bar 变化
- **状态检查：** `/goal status` 查看当前状态，`/goal history` 查看历史
- **向后兼容测试：** 需要准备一个包含旧格式（subTodos 字段）的 session entry 用于反序列化验证
