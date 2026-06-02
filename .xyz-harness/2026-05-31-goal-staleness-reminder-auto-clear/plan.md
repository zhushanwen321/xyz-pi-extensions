---
verdict: pass
complexity: L1
---

# Goal Staleness Reminder & Auto-Clear Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Goal 扩展添加终态自动清理、task/subtask 停滞提醒、命名统一（subTodo→subtask）、/goal history 历史查看四项功能。

**Architecture:** 在现有 7 态状态机上增加"终态保留窗口"（2 轮后自动清理），新增 `turn_end` 计数器和 per-task/subtask `lastUpdatedTurn` 追踪实现停滞检测，新增 `goal-history` entry type 存储终态快照。所有改动局限在 `goal/` 扩展目录内，无跨扩展依赖。

**Tech Stack:** TypeScript, Pi Extension API, typebox, pi-tui

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `goal/src/constants.ts` | modify | BG1 | 新增 TASK_STALL_TURN_THRESHOLD, AUTO_CLEAR_TURNS, MAX_HISTORY_ENTRIES |
| `goal/src/state.ts` | modify | BG1 | SubTodo→Subtask 重命名 + 新增 currentTurnIndex/lastUpdatedTurn/completedAtTurnIndex 字段 + serialize/deserialize 兼容 |
| `goal/src/index.ts` | modify | BG1 | turn_end 递增计数器 + before_agent_start 停滞提醒/自动清理 + history 命令 + 所有 subTodo 引用重命名 + tool schema 重命名 + goal-history entry |
| `goal/src/templates.ts` | modify | BG1 | 新增 stalenessReminderPrompt + 所有 subTodo 引用重命名 |
| `goal/src/widget.ts` | modify | BG1 | 终态折叠渲染 + subTodo 引用重命名 |
| `goal/src/commands.ts` | modify | BG1 | 新增 history 子命令解析 |

---

## Interface Contracts

### Module: state.ts

#### Type: Subtask（重命名自 SubTodo）

| Field | Type | Description |
|-------|------|-------------|
| id | number | subtask 唯一 ID |
| text | string | subtask 描述 |
| status | SubtaskStatus | pending / in_progress / completed |
| lastUpdatedTurn | number | 最近状态变更时的 currentTurnIndex，默认为创建时的值 |

#### Type: SubtaskStatus（重命名自 SubTodoStatus）

`"pending" | "in_progress" | "completed"`

#### Type: GoalTask（扩展）

| Field | Type | Description |
|-------|------|-------------|
| subtasks | Subtask[] | 替代原 subTodos |
| lastUpdatedTurn | number | 新增。task 最近状态变更时的 currentTurnIndex，默认 0 |

#### Type: GoalRuntimeState（扩展）

| Field | Type | Description |
|-------|------|-------------|
| currentTurnIndex | number | 新增。turn_end 粒度计数器，初始 0 |
| completedAtTurnIndex | number \| undefined | 新增。进入终态时的 currentTurnIndex，undefined 表示非终态 |

#### Function: serializeState(state) → GoalRuntimeState

| Parameter | Type | Returns | Edge Cases | Spec Ref |
|-----------|------|---------|------------|----------|
| state | GoalRuntimeState | GoalRuntimeState | 新字段直接展开 | AC-2 |

#### Function: deserializeState(data) → GoalRuntimeState

| Parameter | Type | Returns | Edge Cases | Spec Ref |
|-----------|------|---------|------------|----------|
| data | Record<string, unknown> | GoalRuntimeState | currentTurnIndex 缺失→0, lastUpdatedTurn 缺失→0, completedAtTurnIndex 缺失→undefined, subTodos 旧名→映射到 subtasks | AC-2, AC-3 |

#### Function: createInitialState(objective, budget?) → GoalRuntimeState

| Parameter | Type | Returns | Edge Cases | Spec Ref |
|-----------|------|---------|------------|----------|
| objective | string | GoalRuntimeState | currentTurnIndex=0, completedAtTurnIndex=undefined | AC-2 |

### Module: constants.ts

| Constant | Type | Value | Description |
|----------|------|-------|-------------|
| TASK_STALL_TURN_THRESHOLD | number | 10 | task/subtask 停滞提醒阈值 |
| AUTO_CLEAR_TURNS | number | 2 | 终态后自动清理轮数 |
| MAX_HISTORY_ENTRIES | number | 20 | goal-history entry GC 上限 |

### Module: templates.ts

#### Function: stalenessReminderPrompt(state) → string

| Parameter | Type | Returns | Edge Cases | Spec Ref |
|-----------|------|---------|------------|----------|
| state | GoalRuntimeState | string | 全部 task 已终态→complete_goal 提醒 | AC-2 |

### Module: widget.ts

#### Function: renderTerminalStatusLine(state, theme) → string

| Parameter | Type | Returns | Edge Cases | Spec Ref |
|-----------|------|---------|------------|----------|
| state | GoalRuntimeState | string | cancelled 状态→返回空串 | AC-1 |

### Module: index.ts

#### Function: handleTurnEnd(session)

| Parameter | Type | Returns | Edge Cases | Spec Ref |
|-----------|------|---------|------------|----------|
| session | GoalSession | void | session.state 为 null→跳过 | AC-2 |

#### Function: checkStaleness(state) → { staleTasks, allTerminal }

| Parameter | Type | Returns | Edge Cases | Spec Ref |
|-----------|------|---------|------------|----------|
| state | GoalRuntimeState | { staleTasks: Array<{task, staleTurns, subtaskSummary}>, allTerminal: boolean } | 无非终态 task→allTerminal=true | AC-2 |

#### Function: writeGoalHistoryEntry(pi, session, ctx)

| Parameter | Type | Returns | Edge Cases | Spec Ref |
|-----------|------|---------|------------|----------|
| pi | ExtensionAPI | void | session.state 为 null→跳过 | AC-1, AC-4 |

#### Function: checkAutoClear(session, ctx) → boolean

| Parameter | Type | Returns | Edge Cases | Spec Ref |
|-----------|------|---------|------------|----------|
| session | GoalSession | boolean | 非终态→false, 轮数不足→false | AC-1 |

#### Function: handleGoalHistory(pi, ctx)

| Parameter | Type | Returns | Edge Cases | Spec Ref |
|-----------|------|---------|------------|----------|
| pi | ExtensionAPI | void | 无 history entries→显示提示 | AC-4 |

---

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1: completedAtTurnIndex | GoalRuntimeState.completedAtTurnIndex | createInitialState → transitionStatus → checkAutoClear | Task 4 |
| AC-1: widget 折叠 | renderTerminalStatusLine | transitionStatus → updateWidget | Task 4 |
| AC-1: before_agent_start 自动清理 | checkAutoClear | handleBeforeAgentStart → clearGoalSession | Task 4 |
| AC-1: goal-history 快照 | writeGoalHistoryEntry | transitionStatus → appendEntry | Task 4 |
| AC-2: currentTurnIndex | GoalRuntimeState.currentTurnIndex | handleTurnEnd → increment | Task 3 |
| AC-2: GoalTask.lastUpdatedTurn | GoalTask.lastUpdatedTurn | update_tasks → set | Task 3 |
| AC-2: Subtask.lastUpdatedTurn | Subtask.lastUpdatedTurn | update_subtasks → set | Task 3 |
| AC-2: 停滞 >= 10 turn 提醒 | checkStaleness + stalenessReminderPrompt | handleBeforeAgentStart → return message | Task 3 |
| AC-2: 提醒内容列所有非终态 | stalenessReminderPrompt | checkStaleness → format | Task 3 |
| AC-2: 重置 lastUpdatedTurn | checkStaleness | 提醒后 reset | Task 3 |
| AC-2: 边界 allTerminal | checkStaleness.allTerminal | handleBeforeAgentStart | Task 3 |
| AC-3: subTodo→subtask 重命名 | 类型+字段+工具参数全改 | state.ts → index.ts → templates.ts → widget.ts | Task 1 |
| AC-3: deserializeState 兼容 | deserializeState | 旧 subTodos → 映射到 subtasks | Task 2 |
| AC-4: /goal history | handleGoalHistory | handleGoalCommand → readEntries | Task 5 |
| AC-4: goal-history entry | writeGoalHistoryEntry | transitionStatus → appendEntry("goal-history") | Task 4 |
| AC-4: 不被 clearGoalSession 清理 | goal-history entry type 隔离 | reconstructGoalState 只清理 goal-state | Task 4 |

---

## Spec Metrics Traceability

| Spec AC | 采纳状态 | 对应 Task |
|---------|---------|----------|
| AC-1: 终态自动清理 | adopted | Task 4 |
| AC-1: widget 折叠 | adopted | Task 4 |
| AC-1: goal-history 快照 | adopted | Task 4 |
| AC-2: currentTurnIndex | adopted | Task 2, Task 3 |
| AC-2: lastUpdatedTurn (task) | adopted | Task 2, Task 3 |
| AC-2: lastUpdatedTurn (subtask) | adopted | Task 2, Task 3 |
| AC-2: 停滞提醒 | adopted | Task 3 |
| AC-2: 提醒内容 | adopted | Task 3 |
| AC-2: 重置计数 | adopted | Task 3 |
| AC-2: 边界 allTerminal | adopted | Task 3 |
| AC-3: 命名统一 | adopted | Task 1 |
| AC-3: 工具参数名变更 | adopted | Task 1 |
| AC-3: deserializeState 兼容 | adopted | Task 2 |
| AC-4: /goal history | adopted | Task 5 |
| AC-4: goal-history entry | adopted | Task 4 |
| AC-4: 不被 clear 清理 | adopted | Task 4 |

---

## Task List

### Task 1: 重命名 subTodo → subtask（全量机械替换）

**Type:** backend

**Files:**
- Modify: `goal/src/state.ts` — 类型名、字段名、常量名、导出
- Modify: `goal/src/index.ts` — import、tool schema、case handlers、renderCall/renderResult、promptGuidelines
- Modify: `goal/src/templates.ts` — continuationPrompt、contextInjectionPrompt、formatTaskList 中的引用
- Modify: `goal/src/widget.ts` — renderWidgetLines 中的引用

**替换规则（精确映射）：**

| 旧名 | 新名 | 位置 |
|------|------|------|
| `SubTodoStatus` | `SubtaskStatus` | state.ts type, index.ts import |
| `SubTodo` | `Subtask` | state.ts interface, index.ts import/usage |
| `SUB_TODO_STATUSES` | `SUBTASK_STATUSES` | state.ts const, index.ts import/schema |
| `subTodos` (字段) | `subtasks` | state.ts GoalTask, index.ts 所有引用, templates.ts, widget.ts |
| `add_sub_todos` (action) | `add_subtasks` | index.ts StringEnum + case |
| `update_sub_todos` (action) | `update_subtasks` | index.ts StringEnum + case |
| `delete_sub_todos` (action) | `delete_subtasks` | index.ts StringEnum + case |
| `"sub-todo"` (字符串) | `"subtask"` | index.ts error messages, promptGuidelines, descriptions |
| `newSubTodos` (变量) | `newSubtasks` | index.ts add case |
| `rawSubTodos` (变量) | `rawSubtasks` | state.ts deserialize |
| `subItems` (_render data key) | `subtasks` | index.ts makeGoalResult |

**验证:** `npx tsc --noEmit` 通过。`grep -rn "subTodo\|sub_todo\|SubTodo\|SUB_TODO" goal/src/` 返回 0 行。`grep -n "subItems" goal/src/index.ts` 返回 0 行（确认 _render key 已改为 subtasks）。

---

### Task 2: 新增状态字段 + 常量 + 序列化兼容

**Type:** backend

**Files:**
- Modify: `goal/src/constants.ts` — 新增 3 个常量
- Modify: `goal/src/state.ts` — GoalRuntimeState 新增 2 字段、GoalTask 新增 1 字段、Subtask 新增 1 字段、serializeState/deserializeState/createInitialState 更新

**具体变更：**

`constants.ts` 新增：
- `TASK_STALL_TURN_THRESHOLD = 10` — 停滞提醒阈值
- `AUTO_CLEAR_TURNS = 2` — 终态后自动清理轮数
- `MAX_HISTORY_ENTRIES = 20` — history entry GC 上限

`state.ts` 类型扩展：
- `GoalRuntimeState` 新增 `currentTurnIndex: number`（默认 0）、`completedAtTurnIndex?: number`（默认 undefined）
- `GoalTask` 新增 `lastUpdatedTurn: number`（默认 0）
- `Subtask` 新增 `lastUpdatedTurn: number`（默认 0）

`state.ts` 函数更新：
- `serializeState` — 新字段的深拷贝
- `deserializeState` — 新字段缺失时给默认值；旧 `subTodos` 字段名映射到 `subtasks`（兼容层：检测 `data.tasks[].subTodos` 存在但 `subtasks` 不存在时，映射并赋默认 `lastUpdatedTurn=0`）
- `createInitialState` — `currentTurnIndex: 0`, `completedAtTurnIndex: undefined`

**验证:** `npx tsc --noEmit` 通过。

---

### Task 3: 停滞提醒（turn_end 计数 + before_agent_start 检查）

**Type:** backend

**Files:**
- Modify: `goal/src/index.ts` — turn_end handler + before_agent_start 扩展 + update_tasks/add_subtasks/update_subtasks 中更新 lastUpdatedTurn
- Modify: `goal/src/templates.ts` — 新增 stalenessReminderPrompt 函数

**turn_end handler 变更：**

在现有 `pi.on("turn_end", ...)` 中，`session.state` 非 null 时递增 `session.state.currentTurnIndex++`。

**before_agent_start 变更：**

在 `handleBeforeAgentStart` 中，`isActiveStatus` 检查之前插入：
1. 终态自动清理检查（见 Task 4）
2. 终态折叠渲染（见 Task 4）
3. 停滞提醒检查（本 task）

停滞提醒逻辑（仅在 goal active 时）：
1. 遍历所有 task，计算 `currentTurnIndex - task.lastUpdatedTurn`
2. 对非终态 task，如果停滞 >= TASK_STALL_TURN_THRESHOLD，加入 staleTasks 列表
3. 对每个非终态 task 的 subtasks，同样计算停滞 turn 数
4. 如果 staleTasks 非空，调用 `stalenessReminderPrompt(state, staleTasks)` 生成提醒内容，注入为 `return { message: { customType: "goal-staleness-reminder", content, display: false } }`
5. 提醒后重置所有被列出 task 及其 subtasks 的 `lastUpdatedTurn = currentTurnIndex`
6. 边界情况：所有 task 已终态但 goal 仍 active → 注入 "所有任务已完成，请调用 complete_goal 或 cancel_goal"

**lastUpdatedTurn 更新时机：**

在 `executeGoalAction` 中：
- `create_tasks`：新 task 的 `lastUpdatedTurn = state.currentTurnIndex`
- `add_tasks`：新 task 的 `lastUpdatedTurn = state.currentTurnIndex`
- `update_tasks`：被更新的 task 的 `lastUpdatedTurn = state.currentTurnIndex`
- `add_subtasks`：新 subtask 的 `lastUpdatedTurn = state.currentTurnIndex`
- `update_subtasks`：被更新的 subtask 的 `lastUpdatedTurn = state.currentTurnIndex`

**stalenessReminderPrompt 函数签名：**

`(state: GoalRuntimeState, staleTasks: StaleTaskInfo[]) => string`

返回 `<goal_context>` XML 格式的提醒文本，列出每个停滞 task 的 ID、描述、停滞 turn 数、subtask 状态摘要。

**新增 message renderer：**

注册 `goal-staleness-reminder` customType 的 renderer，前缀 `[GOAL 提醒]`。

**验证:** 启动 Pi，设置 goal 后观察 staleness 提醒是否在 10 turn 后触发。

---

### Task 4: 终态自动清理 + widget 折叠 + goal-history 快照

**Type:** backend

**Files:**
- Modify: `goal/src/index.ts` — auto-clear 逻辑、终态快照写入、widget 折叠
- Modify: `goal/src/widget.ts` — 新增 renderTerminalStatusLine 函数

**auto-clear 逻辑（before_agent_start）：**

在 `handleBeforeAgentStart` 最前面（isActiveStatus 检查之前）：
1. 如果 `session.state` 非 null 且 `isTerminalStatus(session.state.status)`：
   a. 检查 `currentTurnIndex - completedAtTurnIndex >= AUTO_CLEAR_TURNS`
   b. 如果满足 → `clearGoalSession(session, ctx)` 并 return（不注入任何内容）
   c. 如果不满足 → 调用 `renderTerminalStatusLine` 渲染折叠 status bar，return

**completedAtTurnIndex 记录：**

在 `transitionStatus` 结果为终态时，设置 `state.completedAtTurnIndex = state.currentTurnIndex` 并调用 `writeGoalHistoryEntry`。具体位置：
- `complete_goal` case 中 `transitionStatus` 后
- `cancel_goal` case 中（注意：cancel_goal 后紧跟 clearGoalSession，快照写入必须在 clear 之前）
- `handleAgentEnd` 中 budget exceeded / maxTurns / auto-complete 触发终态后
- `handleGoalCommand` "clear" case 中 `state.status = "cancelled"` 之后、`clearGoalSession` 之前
- `handleGoalCommand` "set" case 中取消旧 goal 的 `state.status = "cancelled"` 之后、`persistGoalState` 之前

**goal-history 快照写入：**

在终态设置后、`clearGoalSession` 之前调用 `writeGoalHistoryEntry(pi, session, ctx)`：
```typescript
pi.appendEntry("goal-history", {
  goalId: state.goalId,
  objective: state.objective,
  status: state.status,
  completedTasks: getCompletedCount(state.tasks),
  totalTasks: state.tasks.length,
  elapsedSeconds: Math.floor(getElapsedTimeSeconds(state)),
  timestamp: Date.now(),
});
```

GC：在 `reconstructGoalState` 中，读取所有 `goal-history` entries，保留最近 `MAX_HISTORY_ENTRIES` 条，删除多余。

**renderTerminalStatusLine：**

在 widget.ts 新增函数，渲染单行 status bar：终态状态图标 + 完成任务数 + 预算百分比。不渲染 task 列表。`cancelled` 返回空串。

**widget 折叠触发：**

终态 but 未 auto-clear 时，`updateWidget` 改为调用 `renderTerminalStatusLine` 而非完整 widget。

**`handleBeforeAgentStart` 结构变更：**

```
handleBeforeAgentStart:
  if (!session.state) return
  // 新增：终态处理（auto-clear 或折叠 status bar）
  if isTerminalStatus:
    if checkAutoClear → clearGoalSession, return
    else → renderTerminalStatusLine, updateStatus, return
  // 新增：停滞提醒（仅 active）
  if isActiveStatus:
    check staleness → if stale, return staleness message
    // 原有：context injection
    return context injection message
```

**注意：** staleness reminder 返回后，本轮不再注入常规 context injection（staleness prompt 已包含足够 goal 上下文）。

**`updateWidget` 结构变更：**

新增 `isTerminalStatus` 分支：终态时调用 `renderTerminalStatusLine` 设置 status bar，不设置 widget（task 列表不渲染）。

**验证:** 启动 Pi，完成 goal 后观察 status bar 折叠 → 2 轮后自动消失。

---

### Task 5: /goal history 命令

**Type:** backend

**Files:**
- Modify: `goal/src/commands.ts` — 新增 history action 解析
- Modify: `goal/src/index.ts` — handleGoalCommand 新增 history case

**commands.ts 变更：**

在 `parseGoalArgs` 中新增 `history` 子命令识别：
```typescript
if (trimmed === "history") {
  return { action: "history" };
}
```

**index.ts handleGoalCommand 变更：**

新增 `case "history"`：
1. 从 `ctx.sessionManager.getEntries()` 读取 type === "custom" && customType === "goal-history" 的 entries
2. 按时间倒序排列
3. 格式化为列表：每条显示序号、objective（截断 80 字符）、状态图标、任务完成数/总数、用时
4. 无 history 时显示 "暂无历史 Goal"
5. 使用 `ctx.ui.notify()` 显示

**command description 更新：**

`/goal` 命令 description 中追加 `| /goal history`。

**验证:** 启动 Pi，完成一个 goal，输入 `/goal history` 查看输出。

---

## Execution Groups

#### BG1: Goal 扩展功能增强

**Description:** 所有 task 都在同一组——全部修改 `goal/src/` 目录下的文件，无跨扩展依赖，task 之间严格串行（后续 task 依赖前置 task 的类型变更）。

**Tasks:** Task 1, Task 2, Task 3, Task 4, Task 5

**Files (预估):** 6 个文件（0 create + 6 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high、tdd-coder: medium、reviewer: medium） |
| 注入上下文 | spec.md FR-1~FR-4 + AC-1~AC-4 + state.ts 类型定义 + templates.ts prompt 模板规范 |
| 读取文件 | goal/src/state.ts, goal/src/index.ts, goal/src/templates.ts, goal/src/widget.ts, goal/src/commands.ts, goal/src/constants.ts |
| 修改/创建文件 | 同上 6 个文件 |

**Execution Flow (BG1 内部):** 串行派遣，每个 Task 走完整 subagent 链后再开始下一个 Task。

  Task 1 (subTodo→subtask 重命名):
    1. general-purpose → 机械替换所有 61 处引用
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查（AC-3）

  Task 2 (新增字段 + 常量):
    1. general-purpose → 修改 state.ts + constants.ts
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查（AC-2 部分字段）

  Task 3 (停滞提醒):
    1. general-purpose → 修改 index.ts + templates.ts
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查（AC-2 全部）

  Task 4 (自动清理 + widget + 快照):
    1. general-purpose → 修改 index.ts + widget.ts
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查（AC-1 全部）

  Task 5 (history 命令):
    1. general-purpose → 修改 commands.ts + index.ts
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查（AC-4 全部）

**Dependencies:** 无

**设计细节:** 直接写在上方各 Task 描述中（L1 模式）。

---

## Dependency Graph & Wave Schedule

```
Task 1 (重命名) ──→ Task 2 (新字段) ──→ Task 3 (停滞提醒) ──→ Task 4 (自动清理) ──→ Task 5 (history)
```

| Wave | Tasks | 说明 |
|------|-------|------|
| Wave 1 | Task 1 | 命名统一，所有后续 task 依赖新命名 |
| Wave 2 | Task 2 | 状态字段扩展，Task 3/4/5 依赖新字段 |
| Wave 3 | Task 3 | 停滞提醒功能，独立于 Task 4/5 |
| Wave 4 | Task 4 | 自动清理 + widget 折叠，独立于 Task 5 |
| Wave 5 | Task 5 | history 命令，依赖 Task 4 的 goal-history entry |

注意：Task 3 和 Task 4 理论上可以并行（它们修改 index.ts 的不同区域），但同一个文件不建议多 subagent 并行修改。保持串行更安全。
