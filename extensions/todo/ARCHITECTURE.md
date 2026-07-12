# todo 扩展架构

> 现状架构文档。v2 历史计划见 `PLAN.md`（已 SUPERSEDED）。对外契约见 `README.md`。

## 1. 模块依赖

```
                    ┌─────────────┐
                    │  index.ts   │  工厂入口：创建 state + 注册全部
                    └──────┬──────┘
        ┌──────────┬───────┼────────┬──────────┐
        ▼          ▼       ▼        ▼          ▼
   ┌─────────┐ ┌────────┐ ┌──────┐ ┌───────┐ ┌──────────┐
   │ state   │ │handlers│ │ tool │ │render │ │ commands │
   └────┬────┘ └───┬────┘ └──┬───┘ └───┬───┘ └────┬─────┘
        │          │         │        │          │
        │    ┌─────┘    ┌────┘        │          ▼
        ▼    ▼          ▼             │     ┌──────────┐
      ┌─────────────────────┐         │     │component │
      │      model.ts       │◄────────┴─────┤  (TUI)   │
      │  (纯函数数据层)      │◄──────────────┤          │
      └─────────────────────┘               └──────────┘
```

- `model.ts` 是依赖底座（纯函数，无 Pi 运行时依赖），被 state/tool/handlers/render/component 引用
- `tool.ts` 依赖 `render`（renderTodoResult）+ `model` + `state`
- `commands.ts` 依赖 `component`（TUI 视图）+ `render`（renderDualColumn 复用）
- `state.ts` 只依赖 `model` 的 `Todo` 类型

## 2. 会话状态（TodoSessionState）

闭包内创建，被 tool / handlers / commands 共享同一引用（原地修改）。

| 字段 | 类型 | 用途 |
|------|------|------|
| `todos` | `Todo[]` | 当前任务列表 |
| `nextId` | `number` | 自增 ID 计数器（clear 重置为 1） |
| `userMessageCount` | `number` | **agent 轮次计数**（命名误导，仅在 `agent_start` 递增，非"用户消息数"）。所有 steer 阈值的基准 |
| `lastTodoCallCount` | `number` | 上次 todo tool 调用时的轮次（在 `tool.ts` 的 `executeTodoAction` 入口赋值）。stall/reminder 的差值基准 |
| `stallNotified` | `boolean` | stall 提醒单次锁（整个 session 只触发一次） |
| `allCompletedAtCount` | `number\|null` | 首次全 completed 时的轮次锚点，用于 auto-clear 延迟判定 |
| `completionSteered` | `boolean` | completion steer 单次锁（防重复注入"检查交付质量"） |
| `pendingSteerMessage` | `string\|null` | **跨 turn steer 载体**：`agent_end` 写，`before_agent_start` 读 |

## 3. 事件生命周期

注册点：`index.ts` → `registerTodoEventHandlers(pi, state, refreshDisplay)`。

```
[session_start]  reconstructState + refreshDisplay    （冷启动 / 子会话，仅恢复）
[session_tree]   同上

  用户消息
    │
    ▼
[agent_start]           userMessageCount++             （轮次计数，唯一递增点）
    │
    ▼
[before_agent_start]    ① setStatus("todo", "📋 N pending")
                        ② pendingSteerMessage 非空？→ 消费它（display:false，用户不可见）
                           否则 → buildBeforeAgentStartMessage（全量 pending 注入 todo_context）
    │
    ▼
  agent 执行             （可能调用 todo tool）
                           executeTodoAction 入口:
                             lastTodoCallCount = userMessageCount
                             stallNotified = false
    │
    ▼
[agent_end]             四机制判定 → 可能设置 pendingSteerMessage
    │
    └──► 下一 turn 的 [before_agent_start] 消费 pendingSteerMessage（延迟一拍）
```

**核心设计**：steer 延迟注入。`agent_end` 设置变量，**下一个** `before_agent_start` 消费，确保 steer 影响下一轮 agent 行为而非已结束的当前轮。

## 4. Steer 机制详解

### 4.1 `agent_end` 判定流程

```
if todos.length === 0 → return                       （无任务不处理）

handleCompletionSteer(state)   ← 不短路！继续往下
    条件: !completionSteered && 全 completed
    动作: completionSteered = true
          pendingSteerMessage = "检查交付质量"

{handled, cleared} = handleAutoClear(state)
    if !全completed: allCompletedAtCount=null; return {false,false}
    if allCompletedAtCount===null: allCompletedAtCount = userMessageCount
    if userMessageCount - allCompletedAtCount >= 2:
        清空 todos + 重置标记; return {true,true}      ← handled 短路
    else: return {true,false}                          ← handled 短路
if handled → (cleared 则 refreshDisplay) return

if handleStallDetection(state): return                 ← 短路
    条件: !stallNotified && userMessageCount - lastTodoCallCount >= 5
    动作: stallNotified = true; pendingSteerMessage = reminder

handleReminder(state)                                  ← 最后，不短路
    条件: userMessageCount - lastTodoCallCount >= 2
    动作: pendingSteerMessage = reminder
```

### 4.2 四机制阈值

| 机制 | 常量 | 值 | 设计意图 |
|------|------|----|---------|
| auto-clear | `AUTO_CLEAR_DELAY_ROUNDS` | 2 | 全完成后给 2 轮缓冲（让 completion steer 有机会消费）再清空 |
| stall | `STALL_THRESHOLD` | 5 | 空闲 5 轮判定为停滞，单次强提醒 |
| reminder | `REMINDER_INTERVAL` | 2 | 温和持续提醒，比 stall 频繁但语气轻 |

### 4.3 反直觉点

1. **`agent_end` 短路顺序不对称**：completion-steer 不 `return`，auto-clear / stall / reminder 各自 `return`。即使即将 auto-clear，本轮 completion steer 仍会先被置位。
2. **completion-steer 与 auto-clear 的竞态**：全 completed 后 completion-steer 先置 steer，但 auto-clear 可能在 steer 被 `before_agent_start` 消费前就清空 todos。下一 turn 消费 steer 时 todos 已空，"检查交付质量"steer 仍有意义。
3. **`userMessageCount` 命名误导**：实为 agent 轮次计数，只在 `agent_start` 递增。
4. **两个计数器跨文件协作**：`userMessageCount`（handlers.ts 的 `agent_start`）与 `lastTodoCallCount`（tool.ts 的 `executeTodoAction` 入口）。这条跨文件计数链是 stall/reminder 的基准。

## 5. 持久化与重建

todo **不调用 `appendEntry`**（全 src 零调用），复用 Pi 框架自动记录的 toolResult entry：

```
tool execute 返回 {content, details:{todos, nextId, __gui__?(RPC 模式)}}
        │
        ▼  Pi 框架自动序列化为 toolResult entry 落盘

session_start / session_tree
        │
        ▼
reconstructState:
  1. 遍历 getEntries()，找最后一条 role=toolResult && toolName=todo 的 entry
  2. 用其 details.todos（每条过 migrateTodo）+ details.nextId 重建 state
  3. nextId 缺失 → fallback max(id)+1 或 1
  4. entry GC: 收集该 entry 之前所有 todo toolResult 的索引，从后往前 splice
     （避免删除时索引漂移），只删 todo toolResult，不动其他 entry
```

**隐含前提**：所有状态变更必须走 todo tool（成立，因为只有 tool 能改 state.todos），故"最后一条 toolResult 快照"等价完整状态。

`migrateTodo` 向后兼容三路：
1. `status ∈ VALID_STATUSES` → 直接用
2. 旧五态：`verifying → in_progress`、`failed → pending`
3. 极旧：`done:true → completed`、`done:false → pending`

## 6. 渲染常量

| 常量 | 值 | 含义 |
|------|----|------|
| `WIDGET_MAX_LINES` | 9 | Pi 限制 widget 10 行，保守 -1 |
| `SINGLE_COLUMN_BUDGET` | 8 | ≤8 项单列，≥9 项双列 |
| `MAX_COLLAPSED_ITEMS` | 5 | tool result collapsed 显示前 5 项 + `... N more` |
| `FALLBACK_TERM_WIDTH` | 80 | 无 TTY 时的终端宽度兜底 |

## 7. 错误处理约定

handler 失败**直接 `throw new Error()`**，不返回错误成功模式（见 CLAUDE.md「Tool 设计」）。

- `model.ts` 纯函数（`addTodos`/`updateTodos`）返回 `{error, resultText}` 的 Result 对象——这是合法的函数式模式，不是"错误成功模式"
- `tool.ts` 的 handler 拿到 model 层 error 时 `throw new Error(r.resultText)`，把友好文案交给 Pi 框架
- `TodoDetails` 接口**不含 `error` 字段**（已移除），`renderTodoResult` 无 error 分支
