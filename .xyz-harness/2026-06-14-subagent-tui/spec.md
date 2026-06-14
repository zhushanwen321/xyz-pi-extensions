---
verdict: pass
---

# Subagent TUI 增强 — 运行时滚动消息 + 全屏执行视图

## Background

当前 subagents 扩展的 TUI 能力有基础但不够用：

1. **运行时 loading 区域（inline widget）只显示静态状态**：spinner + agent 名 + turns/tokens/activity。其中 `activity` 是覆盖式单字段（如 `"thinking…"` / 当前 toolName），**不保留历史流水**——用户看不到子 agent 调用了哪些工具、每个 turn 做了什么。
2. **无全屏执行视图**：`/subagents` 命令只显示配置摘要或配置向导，无法查看所有子 agent 的执行情况。对比 `extensions/workflow` 的 `/workflows` 已有成熟的全屏三级 TUI。

根因分析：事件采集管道已存在（event-bridge 映射了 `tool_start`/`tool_end`/`turn_end`/`message_end`），但 `updateWidgetFromEvent` 把事件**折叠成单个 `activity` 字符串**（覆盖式 `=` 赋值），数据在采集时被丢弃。

本次增强解决两个需求：
- **需求 1**：运行时 inline widget 展示**工具调用流水 + turn 级文本摘要**的滚动消息
- **需求 2**：`/subagents list` 全屏两级视图（列表 → 详情），展示所有子 agent 执行情况

## Functional Requirements

### FR-1: 事件日志（ring buffer）— 共享数据基础

需求 1 和需求 2 共享同一数据结构。改事件采集从"覆盖式"为"追加式"。

#### FR-1.1: AgentEventLogEntry 类型

新增事件日志条目类型，记录每条事件的展示信息：

```typescript
interface AgentEventLogEntry {
  readonly type: "tool_start" | "tool_end" | "turn_end";
  readonly label: string;   // 可展示的摘要文本（toolName + args 摘要，或 turn 文本摘要）
  readonly ts: number;       // 时间戳（由 updateWidgetFromEvent 内 Date.now() 生成，AgentEvent 无此字段）
  readonly status?: "running" | "done" | "failed";  // tool_end 带状态
}
```

- `tool_start`：label = `toolName + args摘要`（如 `"read extensions/subagents/src/index.ts"`）。args 来自 SDK 原始 `tool_execution_start` 事件——当前 event-bridge.ts:42 丢弃了 args，**需增强 event-bridge 透传 args**（至少提取文件路径/命令等关键字段）。若 args 为空则 label = toolName
- `tool_end`：label = 同 tool_start 的 label，status = isError ? `"failed"` : `"done"`
- `turn_end`：label = 该 turn 的文本摘要（截断到 ~80 字符）。**turn_end 事件本身不携带文本**——需在 updateWidgetFromEvent 内**累加 `text_delta` 事件**的增量文本，turn_end 时切片生成摘要

#### FR-1.1a: event-bridge 增强（U1 解决）

当前 event-bridge.ts:42 映射 `tool_execution_start` 时丢弃了 args。改为透传：

```typescript
// event-bridge.ts 修改前
onEvent({ type: "tool_start", toolName: e.toolName });
// 修改后
onEvent({ type: "tool_start", toolName: e.toolName, args: e.args });
```

AgentEvent 的 `tool_start` variant 增加 `args?: unknown` 字段。event-bridge 从 SDK 原始事件提取 args 并透传。updateWidgetFromEvent 从 args 中提取文件路径/命令等关键字段构造 label。

#### FR-1.1b: text_delta 累加（U2 解决）

updateWidgetFromEvent 新增 text_delta 处理：

```typescript
case "text_delta":
  s._currentTurnText = (s._currentTurnText ?? "") + event.delta;
  break;
case "turn_end":
  // 切片生成 turn 摘要
  const summary = (s._currentTurnText ?? "").slice(0, TURN_SUMMARY_MAX);
  s.eventLog.push({ type: "turn_end", label: summary, ts: Date.now() });
  s._currentTurnText = "";  // 重置供下一 turn 累加
  s.turns = (s.turns ?? 0) + 1;
  break;
```

#### FR-1.2: WidgetAgentState 扩展

`WidgetAgentState` 新增字段：

```typescript
eventLog: AgentEventLogEntry[];           // 有界数组，最多 MAX_EVENT_LOG_ENTRIES = 20 条。初始值 = []
_currentTurnText?: string;                 // text_delta 累加缓冲（内部字段，不展示）
```

- eventLog 初始值 = `[]`（runtime.ts:191-196 创建 widgetState 时初始化）
- 超过上限时移除最旧条目（FIFO ring buffer）
- `_currentTurnText` 是内部累加缓冲，turn_end 时切片后重置为 `""`

#### FR-1.3: updateWidgetFromEvent 改为追加式

当前 `updateWidgetFromEvent`（runtime.ts）对 tool_start/tool_end/turn_end 只更新 `activity` 单字段。改为：

1. 仍更新 `activity`（保持向后兼容）
2. **同时**构建 `AgentEventLogEntry` 并 push 到 `widgetState.eventLog`
3. push 后若超过 `MAX_EVENT_LOG_ENTRIES`，`shift()` 移除最旧条目

`message_end` 事件继续只更新 `totalTokens`（不产生 log entry——它是用量统计，不是可展示动作）。

### FR-2: 增强 inline widget 渲染

#### FR-2.1: widget 内容布局

inline widget（`ui.setWidget("subagents", lines)`）渲染改为：

```
⠹ worker │ 3 turns │ 12.3k tok │ 45s
├─ read extensions/subagents/src/index.ts
├─ edit extensions/subagents/src/runtime.ts        ✓
├─ turn 2: "Fixed the handler signature..."
└─ bash npm test                                  ⟳ running
```

- 第 1 行：status summary（现有逻辑，不变）
- 后续行：eventLog 的最近 N 条，按时间正序，受 `MAX_WIDGET_LINES`（12 行）限制
- tool_start 显示 `├─ {toolName} {args摘要}` + `⟳ running`
- tool_end 显示 `├─ {toolName} {args摘要}` + `✓`（done）或 `✗`（failed）
- turn_end 显示 `├─ turn {N}: "{摘要前80字符}"`

#### FR-2.2: 行数限制与截断（多 agent 分配）

当多个 running agent 并存时（G-001），12 行分配策略：
- 每个 running agent 至少占 2 行（1 行 status summary + 至少 1 行最新 event）
- 剩余行数按 agent 顺序轮流分配给 eventLog
- 若超过 3 个 running agent，每个只显示 status summary 行（不展开 eventLog）
- 全屏视图（FR-3）不受此限——它是独立的全量展示

- widget 总行数 ≤ `MAX_WIDGET_LINES`（12 行，现有常量）
- 第 1 行固定为 status summary
- 剩余 11 行给 eventLog（显示最近的 11 条）
- 超出时省略最旧的（不显示省略号——inline widget 空间有限）

### FR-3: `/subagents list` 全屏两级视图

参考 `extensions/workflow` 的 `WorkflowsView.ts` 模式（`ctx.ui.custom()` overlay）。

#### FR-3.0: 执行记录留存机制（G-005/G-006/G-012 解决）

**问题**：widget 5 秒淡出后 `removeAgent` 删除 agent（含 eventLog）。已完成 agent 在全屏视图中不可见，UC-3（排查失败）无法满足。

**方案 A（用户确认）**：双层留存：

1. **扩展 BgRecord**（background agent）：新增 `eventLog: AgentEventLogEntry[]` + `agent: string` 字段。background agent 完成时，widget 淡出前把 eventLog 转移到 BgRecord（在 removeAgent 回调或 startBackground 的 .then 链中）
2. **新增 `_completedAgents` Map**（sync agent）：SubagentRuntime 新增 `private readonly _completedAgents = new Map<string, CompletedAgentRecord>()`。sync runAgent 完成且 widget 淡出前，把 `{ id, agent, status, eventLog, turns, totalTokens, result, startedAt, endedAt }` 存入此 Map

```typescript
interface CompletedAgentRecord {
  readonly id: string;
  readonly agent: string;
  status: "done" | "failed" | "cancelled";
  eventLog: AgentEventLogEntry[];
  turns?: number;
  totalTokens?: number;
  result?: AgentResult;
  error?: string;
  startedAt: number;
  endedAt?: number;
}
```

留存时机：修改 runtime.ts 的 `setTimeout(() => this.widget.removeAgent(widgetId), WIDGET_LINGER_MS)` 回调——removeAgent 前先把数据转移到 BgRecord 或 _completedAgents。

**容量上限**：_completedAgents 最多保留 50 条（FIFO，超出移除最旧）。防止长 session 内存无限增长。

#### FR-3.0a: agent 名持久化（G-013 解决）

BgRecord 和 CompletedAgentRecord 都需要 `agent` 字段（列表 "Agent" 列数据源）。
- BgRecord：`startBackground` 时存 `opts.agent ?? "default"` 到 record
- CompletedAgentRecord：从 widgetState.agent 取

#### FR-3.1: 命令入口（G-014 解决）

`/subagents list` 触发全屏视图。命令解析逻辑（config.ts:19-22 的 if/else 需调整）：

```
/subagents          → 配置摘要（现有，不变）
/subagents config   → 配置向导（现有，不变）
/subagents list     → 全屏执行视图（新增）
/subagents list <id>→ 直接进入指定 agent 详情
```

解析优先级：`args[0] === "list"` 优先判断（在现有 config/摘要分支之前）。

**G-002 解决**（bad id）：`/subagents list <id>` 的 id 不存在时，`ctx.ui.notify("Subagent '{id}' not found", "warning")` + 回退到列表视图（Level 0），不报错退出。

**G-016 解决**（runtime 未初始化）：复用现有 config.ts:14-17 的 `getRuntime()` 守卫。runtime 未初始化时 notify error。

**G-017 解决**（防 overlay 叠加）：SubagentRuntime 新增 `private _activeView: { close: () => void } | null`。`/subagents list` 检测到 `_activeView` 非空时，先 close 现有视图再打开新的（不叠加）。

#### FR-3.2: Level 0 — 列表视图（G-023 去重 + G-019 cancelled + G-020 排序）

全屏 overlay，展示所有当前 session 内的子 agent 执行记录：

```
┌─ Subagents ─────────────────────────────────────────┐
│  ID            Agent        Status     Turns  Tokens │
│  run-3         worker       ✓ done     5      23k    │
│  bg-1-xyz      researcher   ⟳ running  2      8k     │
│  run-2         scout        ✗ failed   1      1k     │
│  run-1         worker       ■ cancelled 0     0      │
│                                                      │
│  j/k 导航 · Enter 详情 · q 退出                      │
└──────────────────────────────────────────────────────┘
```

**数据源合并 + 去重（G-023 解决，G-024 修正）**：
- 来源 1：`_bgRecords`（background，running + done/failed/cancelled）
- 来源 2：`widget.agents`（进行中 + 5s 内完成的）
- 来源 3：`_completedAgents`（sync agent 归档）
- **去重规则**：以 `id` 为键合并。优先级：**cancelled 状态优先**（G-024 修正）——如果 _bgRecords/_completedAgents 中某 agent 是 cancelled，覆盖 widget 的 running/failed 状态（因为 cancelBackground 设 _bgRecords.status="cancelled" 但 widget 可能因 abort 显示 failed）。其余状态 widget 优先（更新更频繁）。合并后 Map 以 id 去重。

**状态图标（G-019 解决）**：
- ✓ done（绿色）
- ⟳ running（spinner 动画色）
- ✗ failed（红色）
- ■ cancelled（灰色）

**排序（G-020 解决）**：running 优先 → failed（排查优先）→ cancelled → done。同状态内按 startedAt 降序。

无记录时显示空状态提示：`"No subagent executions in this session."`

#### FR-3.3: Level 1 — 详情视图（G-018 组件契约）

选中某条记录后 Enter 进入详情：

```
┌─ bg-1-xyz researcher (running) ──────────────────────┐
│  3 turns │ 8.2k tok │ 23s │ started 14:32             │
│                                                        │
│  Event log:                                           │
│  ├─ web_search "monorepo pnpm workspace"              │
│  ├─ read https://pnpm.io/workspaces                  │
│  ├─ turn 1: "A monorepo is..."                        │
│  ├─ web_search "monorepo vs polyrepo"                 │
│  └─ turn 2: ...                                       │
│                                                        │
│  Result (if done):                                    │
│  A monorepo is a... [完整结果文本]                     │
│                                                        │
│  q 返回                                                │
└───────────────────────────────────────────────────────┘
```

展示内容：
1. **头部**：ID + agent 名 + status + turns/tokens/耗时/启动时间
2. **Event log 区域**：完整 eventLog（不截断到 11 条，可滚动——超出终端高度时 j/k 滚动）。数据来源：running agent 从 widget.agents 取；已完成从 BgRecord.eventLog 或 CompletedAgentRecord.eventLog 取
3. **Result 区域**（仅 done/failed）：完整结果文本（`AgentResult.text`）或错误信息

#### FR-3.4: 实时刷新 — 事件总线（G-003 解决）

**问题**：widget 现有的 200ms timer 只调 `ui.setWidget`，不触发 overlay 的 `requestRender()`。

**方案**（用户确认：事件总线）：SubagentRuntime 新增轻量事件总线：

```typescript
// SubagentRuntime 新增
private readonly _changeListeners = new Set<() => void>();

/** 订阅 runtime 数据变更（overlay 视图用） */
onChange(fn: () => void): () => void {
  this._changeListeners.add(fn);
  return () => this._changeListeners.delete(fn);
}

/** 通知数据变更（widget updateAgent / startBackground / cancelBackground 时调用） */
private notifyChange(): void {
  for (const fn of this._changeListeners) fn();
}
```

- `updateWidgetFromEvent` 后调 `notifyChange()`
- `startBackground` 的 `.then`/`.catch` 回填后调 `notifyChange()`
- `cancelBackground` 后调 `notifyChange()`（G-027 解决——注释已提及，触达点列表补全）
- `toggleYolo` / `setSessionAgentModel` 等状态变更后调 `notifyChange()`（可选，影响配置摘要刷新）
- overlay 视图在 `createSubagentsView` 内订阅：`const unsub = runtime.onChange(() => requestRender())`，退出时 `unsub()`
- 参考 WorkflowsView.ts:107-109 的 `orchestrator.events.subscribe(runId, ...)` 模式

#### FR-3.5: 键盘交互（G-007 widget 取消 + G-008 超时）

| 键 | Level 0 | Level 1 |
|----|---------|---------|
| j/k | 上下导航 | 滚动 event log |
| Enter | 进入详情 | — |
| x | 取消选中的 running agent（cancelBackground） | 取消当前 agent |
| q | 退出视图 | 返回列表 |
| Esc | 退出视图 | 返回列表 |

**G-007 解决**（widget 取消交互）：全屏视图 Level 0/1 按 `x` 取消 running agent（调 `rt.cancelBackground(id)`，仅对 background 有效；sync runAgent 的取消依赖 AbortController，通过 runAgent 的 signal 传递）。

**G-025 解决**（sync cancelled 产生路径）：sync runAgent 被 abort 时，event-bridge 发 `error` 事件（aborted → error），runAgent catch 设 status="failed"。但如果是**用户主动取消**（通过 x 键或外部 abort），应在归档到 _completedAgents 时检查 abort reason——若 signal 是用户 abort（非 SDK 错误），status 记为 `"cancelled"` 而非 `"failed"`。实现方式：runAgent 的 catch 块检查 `signal.aborted`——若 true 则 status="cancelled"，否则 status="failed"。这样 _completedAgents 能正确记录 cancelled 状态。

**G-008 解决**（widget 超时兜底）：inline widget 新增超时检测——若 agent running 超过 5 分钟无新事件（eventLog 最后一条 ts 距今 > 5min），widget 显示 `⚠ possibly stalled`。不自动取消（留给用户决定）。

#### FR-3.6: hasUI 守卫

`/subagents list` 在 `!ctx.hasUI`（print/RPC 模式）时报错：`"/subagents list requires interactive mode"`。

### FR-4: 新增文件与组件契约（G-018 解决）

#### FR-4.1: `tui/subagents-view.ts`

全屏视图组件，仿 `WorkflowsView.ts` 结构。**组件必须返回完整契约**（参考 WorkflowsView.ts:118-139）：

```typescript
createSubagentsView(runtime, theme, ctx, directId?): Promise<void>
// 内部返回 ctx.ui.custom() 的组件对象：
{
  invalidate(): void,           // 清除渲染缓存（width/lines cache 失效）
  render(width: number): string[],  // 返回行数组，自动适配终端宽度
  handleInput(data: string): void,  // 处理按键；内部修改 state 后调 invalidate + 由外部 requestRender
  dispose?(): void,             // 可选：视图关闭时清理（unsubscribe）
}
```

- `ViewState`：`{ level: 0|1, selectedIdx: number, scrollOffset: number, disposed: boolean }`
- `done()` 调用时机（G-015 解决）：q/Esc 退出时调 `wrappedDone()`（设 disposed=true + unsubscribe onChange + **`runtime._activeView = null`**（G-026 解决）+ done()）
- `renderView(runtime, theme, width, state, terminalRows)`：渲染逻辑（纯函数，可独立测试）
- `processKey(...)`：键盘处理，返回 boolean（是否需要重渲染）

**G-022 解决**（终端过小降级）：`renderView` 计算最小高度 `minHeight = 8`（header 3 + 至少 3 行内容 + footer 2）。若 `terminalRows < minHeight`，显示提示 `"Terminal too small (need ≥8 rows)"` + 缩减内容。参考 WorkflowsView.ts:557-558 的 `minBodyHeight` 模式。

## Acceptance Criteria

### AC-1: 运行时滚动消息（需求 1）

1. 调用 `subagent` 工具（sync 模式）时，聊天界面上方的 widget 展示工具调用流水（tool_start → tool_end 带 ✓/✗）和 turn 摘要
2. 流水行随事件实时追加，spinner 动画不中断
3. widget 总行数 ≤ 12 行，超出时省略最旧条目
4. agent 完成后 widget 淡出（现有 `WIDGET_LINGER_MS` 逻辑不变）

### AC-2: 全屏列表视图（需求 2）

1. `/subagents list` 打开全屏 overlay
2. 列出当前 session 内所有子 agent 执行记录（sync + background 合并）
3. running 优先排序，然后按 startedAt 降序
4. 无记录时显示空状态提示
5. j/k 导航高亮选中行

### AC-3: 全屏详情视图（需求 2）

1. 列表中 Enter 进入详情
2. 详情展示完整 eventLog（可滚动）+ result/error
3. running 状态的 agent 详情实时刷新
4. q/Esc 返回列表

### AC-4: hasUI 守卫

1. print/RPC 模式下 `/subagents list` 报错，不崩溃

## Constraints

- **Pi SDK API**：全屏视图用 `ctx.ui.custom()` overlay 模式（与 workflow 一致）
- **数据范围**：仅当前 Pi session（进程内 Map），不持久化跨 session
- **行数限制**：inline widget ≤ 12 行；全屏视图可滚动但受终端高度约束
- **事件日志上限**：每个 agent 最多保留 20 条（ring buffer），防止内存无限增长
- **现有兼容**：不破坏现有 widget 的 status summary 行、spinner、淡出逻辑
- **测试可测性**：渲染逻辑（renderView）和事件日志逻辑应可独立测试（不依赖真实 TUI）

## 业务用例

### UC-1: 开发者实时观察子 agent 执行过程

- **Actor**: 开发者（在 Pi 对话中）
- **场景**: 开发者委派一个多步骤任务给 worker agent（如"修复 auth 模块的类型错误"）。worker 正在执行时，开发者想实时看到它调用了哪些工具、每个 turn 的进展
- **预期结果**: 聊天界面上方的 widget 滚动展示 worker 的工具调用流水和 turn 摘要，开发者无需打开全屏视图即可了解执行进度

### UC-2: 开发者全屏查看所有子 agent 执行情况

- **Actor**: 开发者
- **场景**: 开发者并行启动了多个子 agent（2 个 sync + 1 个 background），想在一个全屏视图中查看所有 agent 的状态、事件流水和结果
- **预期结果**: `/subagents list` 打开全屏视图，列出 3 条记录。开发者用 j/k 导航，Enter 查看某个 agent 的完整事件日志和结果，q 返回列表

### UC-3: 开发者排查失败的子 agent

- **Actor**: 开发者
- **场景**: 一个 background 子 agent 失败了，开发者想知道哪一步出错
- **预期结果**: `/subagents list` → 选中 failed 记录 → Enter 详情 → 在 event log 中看到失败的工具调用（✗ 标记）和 error 信息

## 实现依赖

- `extensions/workflow/src/interface/views/WorkflowsView.ts`：`ctx.ui.custom()` overlay 模式的参考实现
- `extensions/subagents/src/tui/agent-widget.ts`：现有 widget 机制（`WidgetAgentState`、`AgentWidgetManager`、`renderWidget`）
- `extensions/subagents/src/runtime.ts`：`updateWidgetFromEvent`（需改为追加式）、`_bgRecords`（background 数据源）
- `extensions/subagents/src/types.ts`：`AgentEvent` discriminated union（事件数据源）
