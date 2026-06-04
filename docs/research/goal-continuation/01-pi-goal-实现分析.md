# Pi Goal 扩展实现分析

> 源码路径：`extensions/goal/`（xyz-pi-extensions-workspace main 分支）

## 架构总览

Pi 的 Goal 系统是一个**事件驱动的扩展**，嵌入在 Pi 的 Agent 生命周期钩子中。

```
┌─────────────────────────────────────────────────────────┐
│                    Goal Extension                        │
│                                                          │
│  /goal 命令 ─→ parseGoalArgs ─→ handleGoalCommand        │
│                                                          │
│  goal_manager 工具 ─→ executeGoalAction                  │
│                                                          │
│  生命周期钩子:                                             │
│    before_agent_start → handleBeforeAgentStart            │
│    agent_start       → 记录 tasksCompletedAtAgentStart    │
│    turn_end          → 递增 currentTurnIndex              │
│    message_end       → token accounting                  │
│    agent_end         → handleAgentEnd (关键逻辑)           │
│    session_start     → reconstructGoalState               │
│                                                          │
│  持久化: session entry（custom entry）+ 反序列化重建       │
│  UI: setStatus / setWidget                               │
└─────────────────────────────────────────────────────────┘
```

## 状态定义（`state.ts`）

### GoalRuntimeState — 完整运行时状态

```typescript
interface GoalRuntimeState {
  goalId: string;               // UUID，隔离旧回调
  objective: string;            // 目标描述
  status: GoalStatus;           // 状态机
  tasks: GoalTask[];            // 任务清单（带 subtask）
  turnCount: number;            // 已消耗轮次
  stallCount: number;           // 连续无进展轮次
  tokensUsed: number;           // token 消耗
  timeStartedAt: number;        // 活跃段起始时间戳
  timeUsedSeconds: number;      // 累计秒数
  budget: BudgetConfig;         // 预算配置
  lastProgressTurn: number;     // 最后有进展的 turn
  budgetLimitSteeringSent: boolean;
  objectiveUpdatedAt: number;
  lastBlockerReason: string | null;
  budgetWarning70Sent: boolean;
  budgetWarning90Sent: boolean;
  lastTurnTokensUsed: number;   // 去抖检测
  currentTurnIndex: number;
  completedAtTurnIndex?: number;
}
```

### 状态机 — 7 种状态

```
                         ┌── Paused (用户暂停)
                         │
    Active ──────────────┼── Blocked (连续 stall 自动)
                         │
   (初始状态)             ├── Complete (goal_manager complete_goal)
                         │
                         ├── BudgetLimited (token 耗尽)
                         │
                         ├── TimeLimited (时间耗尽)
                         │
                         └── Cancelled (用户 clear / cancel_goal)
```

**终态规则**：Complete、BudgetLimited、TimeLimited、Cancelled 为终态，不可被任何其他状态覆盖。
Paused/Blocked 可被 `Active` 覆盖（用户 resume）。

### Task 数据结构

```typescript
interface GoalTask {
  id: number;
  description: string;          // 标准化：单行 ≤ 80 字符
  status: TaskStatus;           // pending | in_progress | completed | cancelled
  evidence?: string;            // completed 必须提供
  subtasks?: Subtask[];         // 嵌套子任务
  lastUpdatedTurn: number;      // 停滞检测用
}
```

## 命令解析（`commands.ts`）

`/goal <objective> [--tokens N] [--timeout N] [--max-turns N] [--max-stall N]`

子命令：
- `/goal` / `/goal status` — 查看状态
- `/goal pause` — 暂停
- `/goal resume` — 恢复（重置 stallCount）
- `/goal clear` — 清除（= cancelled）
- `/goal update <new-objective>` — 更新目标（清空 tasks）
- `/goal history` — 显示历史 goal 记录

## Tool 定义（`index.ts` → `tool-handler.ts`）

`goal_manager` 工具暴露给模型 10 个 action：

| Action | 功能 | 关键限制 |
|---|---|---|
| create_tasks | 首次拆分为任务清单 | 已有未完成任务时拒绝 |
| add_tasks | 追加新任务 | 无限制 |
| update_tasks | 批量更新状态 | **completed 必须带 evidence** |
| list_tasks | 查看进度+剩余预算 | 返回格式化的 task 列表 |
| complete_goal | 完成目标 | 所有任务必须完成 + 总体 evidence |
| cancel_goal | 取消目标 | 终态不可取消 |
| report_blocked | 报告阻塞 | 必须提供 reason |
| add_subtasks | 给 task 添加 subtask | 终态 task 不可添加 |
| update_subtasks | 更新 subtask 状态 | completed 不可回退 |
| delete_subtasks | 删除 subtask | — |

**证据强制门禁**是 Pi goal 系统的核心设计：
- `update_tasks(completed)` 必须提供 `evidence`（字符串）
- `complete_goal` 必须提供整体 `evidence`
- 不允许无证据地标记完成

## 生命周期（`index.ts`）

### before_agent_start

在每个 agent 运行之前注入 Goal 上下文。关键逻辑：

1. **终态自动清理**：进入终态 2 turn 后自动清除 widget
2. **停滞检测**：task 超过 10 turn 未更新，注入 `stalenessReminderPrompt`
3. **上下文空间检查**：若已用 > 85% 上下文窗口，自动暂停并注入收尾指令
4. **正常注入**：`contextInjectionPrompt` 包含 objective、进度、规则提醒

### agent_end — 核心循环逻辑

每次 agent 运行结束时执行（顺序严格）：

```
1. 终态处理 → persist / 通知
   ↓
2. 预算检查 (checkBudgetOnTurnEnd)
   ├── 70%/90% 预警
   ├── Token/time 耗尽 → BudgetLimited/TimeLimited 终止
   ├── 90% steering → 发送收尾指令
   ↓
3. turnCount++
4. 进展评估 (checkProgress)
   ├── 所有任务完成 → 提示 complete_goal 或自动结束
   ├── 无任务创建 → 提醒 create_tasks
   ├── 最大轮次 → 自动 cancelled
   ├── Stall 检测 → 累加 stallCount
   │   └── stallCount ≥ maxStallTurns → Blocked
   ├── 去抖（tokenDelta=0 不发 continuation）
   └── 正常 continuation → 注入 continuationPrompt
```

### message_end — Token Accounting

监听 `message_end` 事件，accumulate `usage.input + usage.output`（减去 cache_read）。

```typescript
session.state.tokensUsed += Math.max(input - cacheRead, 0) + output;
```

## 持久化机制

### 存储

使用 Pi 的 `pi.appendEntry()` 系统——custom type `"goal-state"` entry 存储在 session 中。

```typescript
pi.appendEntry("goal-state", serializeState(state));
```

### 重建（session_start / session_tree）

```typescript
function reconstructGoalState() {
  // 逆序遍历 session entry，找最近的 goal-state
  // 非终态且非 paused → 恢复为 active
  // 清理旧 goal-state entries（保留最新一条）
  // GC goal-history entries（保留最近 MAX_HISTORY_ENTRIES 条）
}
```

### 关键设计：兼容 Legacy

`deserializeState()` 处理旧格式的 `subTodos` 字段，确保数据格式变更不丢失旧 session。

## Budget 策略（`budget.ts`）

两层预警 + 一层 steering：

```
 0% ───────────────────────────── 70% ───────────────── 90% ── 100%
    │                              │                      │      │
    │                              ↓                      ↓      ↓
    │                         warning70           warning90   exceeded
    │                         (info 通知用户)     (warning 通知)  (终止)
    │                                                    │
    │                                         budgetLimitSteering
    │                                         (向模型发送收尾指令)
    │
    resume 时若已超过 100% → 直接拒绝恢复
```

## UI 集成

- **Status bar**：`◆ Goal | 3/50 | 2/5 任务 | 45% tokens | ⚠ 2轮无进展`
- **Widget**：展开的面板，含 objective、task 列表、progress bar

## 与 Codex 的主要架构差异

| Pi Goal | Codex Thread Goal |
|---|---|
| 纯事件驱动（hook 模式） | 内核集成（Session 方法） |
| 通过 sendUserMessage 实现"类 continuation" | 系统级 auto-continuation（new_default_turn） |
| session entry 持久化 | SQLite 持久化（state_db） |
| evidence 验证在工具执行层 | 验证落在 prompt 指令中 |
| cancelled 用户级取消 | 无 cancelled，只有 system-controlled 终态 |
