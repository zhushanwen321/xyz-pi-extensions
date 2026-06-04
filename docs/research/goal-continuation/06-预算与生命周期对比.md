# Goal 预算与生命周期管理对比

## 预算控制对比

| 维度 | Pi goal_manager | Codex Thread Goal |
|---|---|---|
| **Token 预算** | 软限制：预警 + steering | 硬限制：系统自动 BudgetLimited |
| **时间预算** | 软限制：预警 + 终止 | 仅有 wall-clock 会计，无自动时间限制 |
| **轮次上限** | 硬限制：maxTurns 到后自动 cancelled | 无（自动 continuation 可无限） |
| **预警机制** | 70%/90% 两层 warning | goal_budget_limit_prompt（>100% 时） |
| **耗尽行为** | 自动进入 BudgetLimited/TimeLimited 终态 | 系统标记 BudgetLimited + 注入 steering prompt |
| **收尾指令** | budgetLimitPrompt 要求使用 complete_goal | budget_limit_prompt 要求 wrap up |
| **Stall 检测** | 轮次级别的 task progress 对比 | token_delta 去抖 + blocked audit |
| **上下文限制** | 85% context window → 自动暂停 | 无 |

## Pi 的预算策略详解

### 三层控制

```
1. Token 软限制
   70% → warning70 (info 通知)
   90% → warning90 (warning 通知) + budgetLimitSteering (收尾指令)
   100% → budget_limited (终止，不可恢复)

2. 时间软限制
   70%/90% → 同上预警
   100% → time_limited (终止，不可恢复)

3. 轮次硬限制
   达到 maxTurns → cancelled (不可恢复)
   无论任务完成情况
```

### Budget Check 逻辑（`budget.ts`）

```typescript
function checkBudgetOnTurnEnd(state): BudgetCheckResult {
  // Token 检查
  if (tokenPct >= 1 && budgetLimitSteeringSent) → terminal = "token"
  if (tokenPct >= 0.9 && !budgetLimitSteeringSent) → steering
  if (tokenPct >= 0.9 && !warning90Sent) → warning90
  else if (tokenPct >= 0.7 && !warning70Sent) → warning70

  // 时间检查（独立于 token）
  if (elapsed >= budget) → terminal = "time"
  if (timePct >= 0.9 && !warning90Sent) → warning90
  else if (timePct >= 0.7 && !warning70Sent) → warning70

  // Token 预算优先于时间预算
  // steering 发送后，下次 check 直接终端
}
```

### Resume 时的预算重检

```typescript
function checkBudgetOnResume(state) {
  if (tokensUsed >= tokenBudget) → exceeded("token")
  if (elapsed >= timeBudgetMinutes * 60) → exceeded("time")
  // 任一超过就拒绝恢复
}
```

## Codex 的预算策略详解

### Token 会计

```rust
// 每个工具调用后的会计
fn account_thread_goal_progress() {
  // 计算 token delta（从上次会计到现在）
  let delta = current - last_accounted;

  // 计算 wall clock delta
  let time_delta = since_last_accounting;

  if time_delta == 0 && delta == 0 -> return;  // 无操作

  // 原子更新：accumulate to SQLite
  let outcome = state_db.account_thread_goal_usage(
    conversation_id, time_delta, delta, mode, expected_goal_id
  );

  match outcome {
    Updated(goal) if goal.status == BudgetLimited => {
      // 首次 → 注入 budget_limit_prompt
      // 之后的会计 BudgetLimitSteering::Suppressed → 不再注入
    }
    Updated(goal) if goal.status == Active => {
      // 正常 update
    }
    Unchanged(_) => return,
  }
}
```

### Budget Limit Steering

第一次超出 budget 时，系统注入 `budget_limit_prompt`：

```
The active thread goal has reached its token budget.
<objective>...</objective>
系统已标记 goal 为 budget_limited。
不要开始新工作，收尾。
```

之后即使继续会计，BudgetLimitSteering 被 Suppressed，不会重复注入。

### 与 Pi 的关键差异

```
Pi：超出 budget → 终止，不可恢复
Codex：超出 budget → BudgetLimited（终态），但模型仍有机会在一个 turn 内收尾

Pi：Resume 时重检 budget，已耗尽则拒绝
Codex：Resume 时从 SQLite 读取，如果已 BudgetLimited 则保持终态
```

## Stall / Blocked 检测对比

### Pi — 轮次级 Progress 检测

```typescript
// 每次 agent_end 检测
const progressThisRound = completedCount - tasksCompletedAtAgentStart;
const isStalled = progressThisRound === 0;

if (isStalled) {
  stallCount++;  // 累加
} else {
  stallCount = 0;  // 重置
  lastProgressTurn = turnCount;
}

if (stallCount >= maxStallTurns) {
  status = "blocked";
}
```

**特点**：
- 基于 task 完成数对比（粗粒度）
- 5 轮连续无进展 → blocked（可配置）
- /goal resume 重置 stallCount

### Codex — Token-delta 去抖 + 3-turn Blocked Audit

```rust
// 去抖：tokenDelta=0 不发 continuation
let token_delta = state.tokens_used - last_turn_tokens_used;
if token_delta == 0 {
  // 不发 continuation，静默结束
  return;
}
```

Blocked 由模型通过 `update_goal(status: "blocked")` 触发，系统要求：

> 同一阻塞条件必须重复 3+ 个连续 goal turn
> 包括原始 turn 和 auto-continuation
> Resume 后重新审计

**特点**：
- 模型自主判断是否 blocked（不是系统自动）
- 严格的 3-turn 重复条件验证
- 重新计数策略防止滥用 resume

## 生命周期状态转换对比

### Pi 状态图

```
                  ┌──── /goal set
                  ↓
    ┌──────────────────┐
    │     Active        │ ←────────── /goal resume ────┐
    └──┬──┬──┬──┬──┬───┘                              │
       │  │  │  │  │                                  │
       │  │  │  │  └── stallCount ≥ maxStallTurns ──→ Blocked ──┘
       │  │  │  └───── /goal pause ────────────────→ Paused ────┘
       │  │  └──────── complete_goal (all done) ───→ Complete
       │  └─────────── token/time budget limit ───→ BudgetLimited / TimeLimited
       └─────────────── cancel_goal / clear ─────→ Cancelled
```

### Codex 状态图

```
                       ┌── User/System Pause ──→ Paused ──┐
                       │                                  │
    Active ────────────┼── User Resume ───────────────────┘
                       │
                       ├── System: budget exhausted ──→ BudgetLimited
                       │
                       ├── System: usage limit ──────→ UsageLimited
                       │
                       ├── Model: update_goal(complete) ──→ Complete
                       │
                       └── Model: update_goal(blocked) ───→ Blocked ──┐
                            (仅 3+连续 blocked audit)                 │
                              User Resume ────────────────────────────┘
```

### 关键状态差异

| 状态 | Pi | Codex |
|---|---|---|
| **Active** | 初始状态，通过 /goal set | 初始状态，通过 create_goal |
| **Paused** | 用户 /goal pause | 用户/系统控制 |
| **Blocked** | 自动（5轮 stall） | 模型 update_goal（3-turn audit） |
| **Complete** | complete_goal(evidence) | update_goal(complete) |
| **Cancelled** | 用户 cancel/clear | **不存在** |
| **BudgetLimited** | token 耗尽 | token budget 耗尽 |
| **TimeLimited** | 时间耗尽 | **不存在**（wall clock 仅用于会计） |
| **UsageLimited** | **不存在**（上下文 85% 暂停，非终态） | 系统使用量上限 |
