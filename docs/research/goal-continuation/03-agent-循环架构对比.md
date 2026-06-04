# Agent 循环架构对比 — Pi vs Codex

## 核心差异：谁负责"继续工作"

```
Pi 架构：响应式循环
  用户消息 → Agent 运行 → 完成 → 等待用户

Codex 架构：主动式循环
  用户消息 → Agent 运行 → 完成 → [Goal Active?]
    → Yes: 系统自动创建新 turn → Agent 继续运行
    → No: 等待用户
```

## Pi 的 Agent 循环

```
┌──────────────┐
│ 用户发送消息  │
└──────┬───────┘
       ↓
┌──────────────────────┐
│ before_agent_start   │ ← Goal extension 注入 context
│   (注入 goal context)│
└──────┬───────────────┘
       ↓
┌──────────────────────┐
│ agent_start          │ ← Goal: 记录 tasksCompletedAtAgentStart
└──────┬───────────────┘
       ↓
┌──────────────────────┐
│  Agent 运行           │ ← 模型调用工具（todo / goal_manager）
│  (模型工具调用)        │
└──────┬───────────────┘
       ↓
┌──────────────────────┐
│ turn_end              │ ← Goal: 递增 currentTurnIndex
└──────┬───────────────┘
       ↓
┌──────────────────────┐
│ message_end           │ ← Goal: token accounting
└──────┬───────────────┘
       ↓
┌──────────────────────┐
│ agent_end             │ ← Goal: 预算检查 + 进展评估 + continuation
│   (budget check,      │
│    progress eval,     │
│    send continuation  │
│    if applicable)     │
└──────┬───────────────┘
       ↓
  ┌────┴────┐
  │  wait   │ ← Pi 等待用户的下一条消息
  └─────────┘
```

### Pi 的"类 continuation"机制

Pi 通过 `pi.sendUserMessage(continuationPrompt(...))` 在 `agent_end` 中模拟 continuation。

但这不是真正的 continuation——它是一个**用户消息**，必须经过用户的 approval 流转。

```typescript
// Pi 的方式：发送一条"用户消息"到队列
pi.sendUserMessage(continuationPrompt(state), { deliverAs: "followUp" });
```

这意味着：
- **用户可见**：这条消息会显示在聊天历史中
- **需要用户 approval**：取决于 approval 模式，可能要用户确认
- **不是真正的系统级续跑**：Pi 内核不会自动启动新 turn

## Codex 的 Agent 循环

```
┌──────────────┐
│ 用户发送消息  │
└──────┬───────┘
       ↓
┌──────────────────────┐
│ ... (conversation)   │
└──────┬───────────────┘
       ↓
┌──────────────────────┐
│ TurnStarted event    │ ← Goal: mark_thread_goal_turn_started
│   (token baseline)   │     (记录 token 基线 + active goal)
└──────┬───────────────┘
       ↓
┌──────────────────────┐
│ Agent 运行            │ ← 模型调用工具
│  (每次 tool 调用后)    │ ← Goal: ToolCompleted → 会计
└──────┬───────────────┘
       ↓
┌──────────────────────┐
│ TurnFinished event   │ ← Goal: finish account + 准备 continuation
└──────┬───────────────┘
       ↓
┌──────────────────────────────────┐
│ maybe_continue_goal_if_idle      │ ← 内核自动调用
│                                  │
│ if goal == Active &&              │
│    no active turn &&              │
│    no pending mailbox input:      │
│                                  │
│  → new_default_turn_with_sub_id()│ ← 真正的系统级新 turn
│  → start_task()                  │ ← 模型无用户输入继续工作
└──────────────────────────────────┘
       ↓
  ┌────┴────┐
  │  wait   │ ← 等待用户或... 下一个 continuation
  └─────────┘
```

### Codex 的 Auto-Continuation 细节

```rust
async fn goal_continuation_candidate_if_active() -> Option<GoalContinuationCandidate> {
  // 1. Goals feature 是否启用
  if !self.enabled(Feature::Goals) return None;

  // 2. Plan mode 忽略 Goal
  if should_ignore_goal_for_mode(self.collaboration_mode().await.mode) return None;

  // 3. 不能有活跃 turn
  if self.active_turn.lock().await.is_some() return None;

  // 4. Input queue 没有 pending mailbox items
  if self.input_queue.has_trigger_turn_mailbox_items().await return None;

  // 5. 从 SQLite 读取 goal，检查 Active 状态
  let goal = state_db.thread_goals().get_thread_goal(conversation_id).await?;
  if goal.status != Active return None;

  // 6. 再次检查（避免竞态）
  if self.active_turn.lock().await.is_some() return None;

  // 返回 continuation prompt 作为 response items
  Some(GoalContinuationCandidate {
    goal_id,
    items: vec![goal_context_input_item(continuation_prompt(&goal))],
  })
}

async fn maybe_start_goal_continuation_turn() {
  let candidate = self.goal_continuation_candidate_if_active().await?;

  // 保留 turn_state（非活跃 turn slot）
  let turn_state = self.active_turn.lock().await.get_or_insert_with(ActiveTurn::default);

  // 再次验证 goal 没有在预留期间改变
  // ...

  // 将 continuation prompt 注入 input_queue
  self.input_queue.extend_pending_input(...);

  // 创建新 turn 并启动 agent
  let turn_context = self.new_default_turn_with_sub_id(uuid::new_v4()).await;
  self.start_task(turn_context, Vec::new(), RegularTask::new()).await;
}
```

## 关键架构差异

| 方面 | Pi | Codex |
|---|---|---|
| **Agent 循环类型** | 响应式（用户驱动） | 主动式（系统可自主延伸） |
| **Continuation 实现** | sendUserMessage（消息队列） | start_task（新 turn） |
| **Continuation 可见性** | 用户可见、需 approval | 系统级、隐式 |
| **Agent 结束条件** | agent_end 事件 | TurnFinished + maybe_continue |
| **上下文管理** | before_agent_start 注入 | goal_context_input_item 注入 |
| **多 turn 协调** | 依赖 extension 钩子序列 | 内核级 RuntimeEvent 分发 |
| **预算管理位置** | agent_end 中 checkBudgetOnTurnEnd | tool 完成后会计 + turn 结束时 |
| **Stall 检测** | 轮次级别 task 进度比较 | token_delta 去抖 + 3-turn blocked audit |
| **扩展性** | extension（插件式） | 内核集成（非插件） |

## 设计哲学差异

### Pi — "用户始终在循环中"

Pi 的设计假设用户是**主动参与者**：
- 用户通过 `/goal` 启动目标
- 模型执行，用户观察
- 每个 turn 结束时如果 goal 还 active，Pi 发送一条"用户消息"建议继续
- 用户可以选择不继续、修改、或暂停

### Codex — "模型持续工作直到完成"

Codex 的设计假设模型是**自主执行者**：
- 用户设定目标后可以离开
- 系统自动续跑，模型持续工作
- 只有在遇到 blocker 或完成时才需要用户介入
- 系统管理预算，超限自动收尾

## 对用户的影响

| 场景 | Pi 体验 | Codex 体验 |
|---|---|---|
| **长期任务** | 每轮结束询问"要继续吗" | 自动继续，用户回来看结果 |
| **预算控制** | 预警通知，模型收尾或用户决定 | 自动 BudgetLimited 状态 + steering |
| **阻塞处理** | report_blocked + /goal resume 手动恢复 | 3-turn audit 自动 blocked + resume 后重审计 |
| **进度跟踪** | goal_manager 工具显式更新 | get_goal 查看 + completion audit prompt |
| **用户干预** | 任何时刻可 /pause /clear /update | 任何时刻可修改或清除 goal |
