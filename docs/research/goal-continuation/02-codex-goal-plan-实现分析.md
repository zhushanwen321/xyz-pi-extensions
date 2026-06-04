# Codex Goal/Plan 实现分析

> 源码路径：`codex-rs/core/src/` + `codex-rs/protocol/src/` + `codex-rs/prompts/`

## 架构总览

Codex 提供两个独立的概念：

1. **`update_plan`** — 瞬态 TODO 清单，由模型在每个 turn 内管理
2. **Thread Goal** — 持久化目标系统，由内核管理生命周期

```
┌─────────────────────────────────────────────────────────────┐
│                       Codex Core                            │
│                                                             │
│  ┌─────────────────────┐    ┌──────────────────────────┐    │
│  │     update_plan      │    │      Thread Goal          │    │
│  │  (工具: update_plan) │    │  (工具: create_goal,      │    │
│  │                      │    │         update_goal,      │    │
│  │  瞬态 TODO 清单      │    │         get_goal)         │    │
│  │  事件 → UI 渲染      │    │                          │    │
│  │  非持久化            │    │  SQLite 持久化            │    │
│  │  本 turn 生命周期    │    │  跨 turn 生命周期          │    │
│  └─────────────────────┘    │  Auto-continuation        │    │
│                              │  Budget accounting        │    │
│                              │  Steering prompts         │    │
│                              └──────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## update_plan — TODO/Checklist 工具

### 参数定义（`protocol/src/plan_tool.rs`）

```rust
struct UpdatePlanArgs {
  explanation: Option<String>,   // 可选变更说明
  plan: Vec<PlanItemArg>,        // 完整 plan 快照
}

struct PlanItemArg {
  step: String,                  // 步骤描述
  status: StepStatus,            // Pending | InProgress | Completed
}
```

### 核心逻辑（`core/src/tools/handlers/plan.rs`）

```rust
// 1. 检查是否在 Plan mode（禁止使用）
if turn.collaboration_mode.mode == ModeKind::Plan {
  return Err("update_plan is a TODO/checklist tool and is not allowed in Plan mode");
}

// 2. 解析参数并发送事件
let args = parse_update_plan_arguments(&arguments)?;
session.send_event(turn.as_ref(), EventMsg::PlanUpdate(args)).await;
```

**关键特征**：
- **全量快照替换**：每次调用传入完整的 plan 数组，不是增量 diff
- **无持久化**：只是通过 EventMsg 推送到 CLI UI 渲染
- **模型规则**：prompt 要求同一时间只有一个 in_progress，不能跳过 pending 直接到 completed
- **与 Plan mode 互斥**：Plan mode 下禁止使用

### Prompt 中的使用说明（`gpt_5_2_prompt.md`）

> A tool named `update_plan` is available to you. You can use it to keep an up‑to‑date, step‑by‑step plan for the task.
> When steps have been completed, use `update_plan` to mark each finished step as `completed` and the next step you are working on as `in_progress`.
> There should always be exactly one in_progress step until everything is done.

## Thread Goal — 持久化目标系统

### 协议定义（`protocol/src/protocol.rs`）

```rust
enum ThreadGoalStatus {
  Active,
  Paused,
  Blocked,
  UsageLimited,
  BudgetLimited,
  Complete,
}

struct ThreadGoal {
  thread_id: ThreadId,
  objective: String,           // 最大 4000 字符
  status: ThreadGoalStatus,
  token_budget: Option<i64>,
  tokens_used: i64,
  time_used_seconds: i64,
  created_at: i64,
  updated_at: i64,
}
```

### 三个工具（`core/src/tools/handlers/goal/`）

#### create_goal
```
- 创建一个 Active 状态的 goal
- 如果 thread 已有一个 goal → 失败
- 支持可选 token_budget
- 模型调用时不能"从普通任务推断 goal"
```

#### update_goal
```
- 只能设置 status 为 `complete` 或 `blocked`
- Pause/Resume/BudgetLimited/UsageLimited 只能由用户/系统控制
- Blocked 审计：同一阻塞条件必须持续 3+ 个连续 goal turn
- 标记 complete 时系统会要求报告最终 token 使用
```

#### get_goal
```
- 只读返回当前 goal 信息
- 用于模型查看进度
```

### 状态机

```
                 用户/系统 ─→ Paused
                 用户/系统 ─→ BudgetLimited (token budget 耗尽)
        ┌───    系统 ─────→ UsageLimited (使用量上限)
        │
    Active ────── 模型 update_goal(complete) ──→ Complete
        │
        └───     模型 update_goal(blocked) ────→ Blocked

    模型不可控：Pause / Resume / BudgetLimited / UsageLimited
    模型可控：  complete / blocked
```

### SQLite 持久化（`state/src/model/thread_goal.rs`）

```rust
// 表结构（SQLite）
struct ThreadGoalRow {
  thread_id: String,
  goal_id: String,
  objective: String,
  status: String,                // "active" / "paused" / ...
  token_budget: Option<i64>,
  tokens_used: i64,
  time_used_seconds: i64,
  created_at_ms: i64,
  updated_at_ms: i64,
}
```

### 核心运行时（`core/src/goals.rs`）

#### GoalRuntimeState

```rust
struct GoalRuntimeState {
  state_db: Mutex<Option<StateDbHandle>>,     // SQLite 连接
  budget_limit_reported_goal_id: Mutex<Option<String>>,
  accounting_lock: Semaphore,                  // 确保会计操作串行化
  accounting: Mutex<GoalAccountingSnapshot>,
  continuation_lock: Semaphore,                // 控制续跑并发
}
```

#### 会计系统

```rust
struct GoalAccountingSnapshot {
  turn: Option<GoalTurnAccountingSnapshot>,     // 当前 turn 的会计
  wall_clock: GoalWallClockAccountingSnapshot,  // 物理时间会计
}

struct GoalTurnAccountingSnapshot {
  turn_id: String,
  last_accounted_token_usage: TokenUsage,       // 上次会计时的 token 基线
  active_goal_id: Option<String>,
}
```

会计逻辑：
```
每完成一个工具调用 → account_thread_goal_progress()
  → 计算 token_delta (当前 - last_accounted)
  → 计算 time_delta (wall clock)
  → 调用 state_db.thread_goals().account_thread_goal_usage()
  → 检查是否超过 budget → BudgetLimited
```

#### Event 驱动的运行时

```rust
fn goal_runtime_apply(event: GoalRuntimeEvent) {
  match event {
    TurnStarted { turn_context, token_usage } → mark_thread_goal_turn_started()
    ToolCompleted { tool_name } → account_thread_goal_progress() (except update_goal)
    ToolCompletedGoal { turn_context } → account with suppressed budget steering
    TurnFinished { turn_completed } → finish_thread_goal_turn()
    MaybeContinueIfIdle → maybe_start_goal_continuation_turn()
    TaskAborted → handle_thread_goal_task_abort()
    UsageLimitReached → usage_limit_active_thread_goal()
    ExternalMutationStarting → account before external change
    ExternalSet { external_set } → apply_external_thread_goal_status()
    ExternalClear → clear_stopped_thread_goal_runtime_state()
    ThreadResumed → restore_thread_goal_runtime_after_resume()
  }
}
```

#### Auto-Continuation（关键设计）

```rust
async fn maybe_start_goal_continuation_turn() {
  // 条件：
  // 1. Goal 是 Active
  // 2. 没有活跃 turn
  // 3. Input queue 没有 mailbox items

  // 构建 continuation_prompt
  let items = vec![goal_context_input_item(continuation_prompt(&goal))];

  // 创建新的 turn（没有用户消息）
  let turn_context = self.new_default_turn_with_sub_id(...);
  self.start_task(turn_context, Vec::new(), RegularTask::new()).await;
  // ↑ 模型在无用户输入的情况下被唤醒，看到 continuation prompt
}
```

### 三套 Steering Prompts（`prompts/src/goals.rs`）

#### continuation.md — Auto-continuation 时注入

```
Continue working toward the active thread goal.

<objective>{{ objective }}</objective>

Continuation behavior:
- 此 goal 跨 turn 持久，结束当前 turn 不需要缩小目标
- 临时粗糙可以接受，完成仍需要最终状态通过验证

Budget:
- Tokens used: {{ tokens_used }}
- Token budget: {{ token_budget }}
- Tokens remaining: {{ remaining_tokens }}

Work from evidence:
- 使用当前 worktree 和外部状态作为权威来源
- 之前对话上下文可用于定位，但要检查当前状态后使用

Completion audit:
- 从 objective 推导具体需求
- 对每个需求检查权威证据
- 不满足的证据 = 未完成
- 只有所有需求满足才可标记 complete

Blocked audit:
- 不在一开始就标记 blocked
- 只在同一阻塞条件重复 3+ 个连续 goal turn 时才 blocked
- resume 后重新开始计数
```

#### budget_limit.md — 预算耗尽时注入

```
The active thread goal has reached its token budget.

Budget:
- Time spent: {{ time_used_seconds }} seconds
- Tokens used: {{ tokens_used }}
- Token budget: {{ token_budget }}

系统已将 goal 标记为 budget_limited。
不要开始新的实质性工作，收尾当前 turn。
```

#### objective_updated.md — 目标更新时注入

```
The active thread goal objective was edited.

<untrusted_objective>{{ new_objective }}</untrusted_objective>

旧的 objective 被取代，调整当前工作方向。
```

### 与其他系统的集成

#### Plan Mode 与 Goal 互斥

Plan mode 下 Goal 自动忽略：
```rust
if should_ignore_goal_for_mode(turn_context.collaboration_mode.mode) {
  self.clear_active_goal_accounting(turn_context).await;
  return;
}
```

#### 指标收集

Codex 为 goal 生成了丰富的遥测指标：
```
GOAL_CREATED_METRIC
GOAL_RESUMED_METRIC
GOAL_BLOCKED_METRIC
GOAL_BUDGET_LIMITED_METRIC
GOAL_USAGE_LIMITED_METRIC
GOAL_COMPLETED_METRIC
GOAL_TOKEN_COUNT_METRIC
GOAL_DURATION_SECONDS_METRIC
```
