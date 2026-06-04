# 持久化与状态管理对比

## 持久化策略对比

| 维度 | Pi todo | Pi goal_manager | Codex update_plan | Codex Thread Goal |
|---|---|---|---|---|
| **存储方式** | Session entry 重建 | Session entry（custom type） | 无持久化 | SQLite（state_db） |
| **重建机制** | 扫描 toolResult entries | 扫描 goal-state entries | 无（瞬态） | SQL query |
| **跨 session** | 不保证 | 依赖 entry 留存 | 否 | 是（SQLite 文件） |
| **旧数据兼容** | migrateTodo 处理 done 字段 | deserializeState 兼容旧格式 | N/A | Schema 升级 |
| **并发安全** | 单线程闭包 | goalId snapshot 阻止旧回调 | 无 | Semaphore 串行化会计 |

## Pi 的持久化设计

### todo — entry 重建模式

```
session_start/session_tree
  └→ reconstructState()
       └→ 正向扫描 session entries
            └→ 找到最新的 toolResult(todo) entry
                 └→ 从 details.todos 重建 todos 数组
                 └→ 从 details.nextId 重建 nextId
            └→ 删除旧的 todo entries（保留最新一条）
```

**关键点**：
- 依赖 tool result 中返回的完整 todos 快照
- 不是真正的持久化——是"从对话历史重建"
- 重建后自动 GC 旧 entries

### goal_manager — custom entry 模式

```
persistGoalState():
  → pi.appendEntry("goal-state", serializeState(state))

reconstructGoalState():
  → 逆序遍历 entries
  → 找到最后一个 type="custom" && customType="goal-state" 的 entry
  → deserializeState(data) → 恢复到内存
  → GC 旧 goal-state entries（保留最新一条）
  → GC history entries（保留最近 20 条）
```

**关键点**：
- 每个持久化操作都会 append 一个新 entry（不是原地更新）
- 重建时只取最后一个（最新的）
- 非终态自动恢复为 active（session 重启后 resume）

### 双写问题防护

Pi 通过 `goalId snapshot` 防止旧回调覆盖新状态：

```typescript
const snapshotGoalId = session.state.goalId;
const checkStale = () => !session.state || session.state.goalId !== snapshotGoalId;

// 每个异步操作后检查
if (checkStale()) return;
```

## Codex 的持久化设计

### Thread Goal — SQLite 持久化

```rust
// state_db → thread_goals 表
// 通过 sqlx 操作 SQLite

// 读取
state_db.thread_goals().get_thread_goal(conversation_id).await?

// 创建（thread 内唯一）
state_db.thread_goals().insert_thread_goal(conversation_id, objective, Active, token_budget).await?

// 更新
state_db.thread_goals().update_thread_goal(conversation_id, GoalUpdate { objective, status, token_budget }).await?

// 会计（增量原子操作）
state_db.thread_goals().account_thread_goal_usage(
  conversation_id, time_delta, token_delta, mode, expected_goal_id
).await?
```

**关键设计**：
- `update_thread_goal` 使用 `expected_goal_id` 做乐观锁
- `account_thread_goal_usage` 返回 `GoalAccountingOutcome`（Updated/Unchanged），判断是否触发状态迁移
- 状态迁移自动：`tokens_used >= token_budget` → BudgetLimited

### Auto-Continuation 的持久化交互

```
Turn 结束
  → TurnFinished event
    → 会计（account_thread_goal_progress）
  → maybe_continue_goal_if_idle
    → maybe_start_goal_continuation_turn
      → 重新读 SQLite（double-check goal still Active）
      → 预留 turn slot
      → 再次读 SQLite（防止竞态）
      → 注入 continuation prompt
      → start_task（新 turn）

新 turn 开始
  → MarkThreadGoalTurnStarted
    → 从 SQLite 读 goal
    → 设置 token baseline
    → 标记 active goal
```

## 持久化设计权衡

| 方案 | 优点 | 缺点 |
|---|---|---|
| **Pi Session Entry** | 简单、无外部依赖、自带事件顺序 | 长 session 可能有 GC 压力、不支持跨 session |
| **Codex SQLite** | 持久可靠、支持复杂查询、原子操作 | 需要管理连接状态、引入外部依赖 |

## 状态管理关键差异

### Pi — "快照持久，内存操作"

```
每个工具调用 → 修改内存中的 state → persistGoalState() → append entry
agent_end     → 再次 persist
session_start → scan entries → reconstructState()
```

状态始终在内存中，持久化只是 append 快照。

### Codex — "数据库为中心"

```
create_goal     → SQLite INSERT
tool 完成       → SQLite UPDATE (accounting)
get_goal        → SQLite SELECT
continuation    → SQLite SELECT (double-check)
agent_end       → SQLite 已更新
resume          → SQLite SELECT
```

状态以数据库为准，内存中的 `GoalRuntimeState` 只是缓存。

### 差异根源

Pi 的设计目标是**轻量级扩展**——没有外部依赖，所有状态以"不可变事件日志"形式存储在 session 中。这决定了：
- 每次工具调用后 append 新 entry
- 重建时逆向扫描
- 没有 ACID 事务保障

Codex 的设计目标是**可靠的生产系统**——通过 SQLite 实现：
- 原子会计操作（并发安全）
- 持久化跨 session
- ACID 事务保障
- 指标收集
