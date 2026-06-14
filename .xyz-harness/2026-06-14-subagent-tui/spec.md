---
verdict: pass
---

# Subagent TUI 增强 — 对话流执行 block 重设计

## Background

当前 subagents 扩展有两条展示通道：

1. **对话流背景色 block**（`SubagentResultComponent`）：sync 模式渲染为背景色 block，显示 spinner + eventLog。但 eventLog 是纯文本罗列（无 thinking、无截断滚动、无 model 信息），且 **background 模式启动后 block 静止不刷新**（detached 执行，事件不回流）。
2. **inline widget**（`AgentWidgetManager`）：**渲染层已停用**（`src/index.ts:35` 注释明确不再调 `attachWidgetUI()`），仅 `WidgetAgentState` 作为 `/subagents list` 的数据载体保留。近 200 行渲染代码（`renderWidget`/`renderStatusLine`）成了死代码。

本次增强重新设计对话流 block 的展示，统一 sync + background 两种模式的视觉体验，并删除已停用的 inline widget 渲染代码。

**设计参考**：nicobailon/pi-subagents 的 `renderSubagentResult`（种子帧 spinner、compact/expanded 双视图、recentTools + recentOutput 混合流水）。

### 本次范围

- **需求 A（本期）**：重新设计 sync + background 模式的对话流 block 展示（见 FR-2）
- **需求 B（本期）**：删除 inline widget 渲染层（见 FR-2.0）
- `/subagents list` 全屏视图不在本期讨论范围（已有 FR-3 实现，保持不变）

## Functional Requirements

### FR-1: 事件日志（ring buffer）— 共享数据基础

对话流 block 和 `/subagents list` 共享同一数据结构。事件采集从"覆盖式"改为"追加式"，并新增 thinking delta 采集。

#### FR-1.1: AgentEventLogEntry 类型

事件日志条目类型（已实现，本次扩展 type 联合）：

```typescript
interface AgentEventLogEntry {
  readonly type: "tool_start" | "tool_end" | "turn_end" | "thinking" | "text_output";  // 新增 thinking / text_output
  readonly label: string;
  readonly ts: number;
  readonly status?: "running" | "done" | "failed";  // tool_end 带状态
}
```

- `tool_start`：label = `toolName + args摘要`（如 `"read extensions/subagents/src/index.ts"`）。若 args 为空则 label = toolName
- `tool_end`：label = 同 tool_start 的 label，status = isError ? `"failed"` : `"done"`
- `turn_end`：label = 该 turn 的文本摘要（截断到 ~80 字符）
- **`thinking`（新增）**：label = reasoning delta 片段（截断到 ~100 字符）。由 event-bridge 从 SDK `assistantMessageEvent.reasoning` 提取
- **`text_output`（新增）**：label = assistant 文本输出片段（截断到 ~100 字符）。由 text_delta 累加后定期切片产生（非每 delta 一条，避免刷屏）

#### FR-1.1a: event-bridge 增强（thinking delta 提取）

当前 event-bridge.ts:59-64 的 `message_update` 只从 `assistantMessageEvent.delta` 提取 text 增量，**丢弃了 reasoning/thinking 增量**。需增强为同时提取 reasoning：

```typescript
case "message_update": {
  const delta = raw.assistantMessageEvent?.delta;
  if (delta) onEvent({ type: "text_delta", delta });
  // 新增：提取 reasoning delta（字段名需在实现时验证 SDK 版本）
  const reasoningDelta = raw.assistantMessageEvent?.reasoning
    ?? raw.assistantMessageEvent?.reasoningDelta;
  if (reasoningDelta) onEvent({ type: "thinking_delta", delta: reasoningDelta });
  break;
}
```

AgentEvent 新增 `thinking_delta` variant：`{ type: "thinking_delta"; delta: string }`。

**实现时验证**：SDK `assistantMessageEvent` 的 reasoning 字段名（`reasoning` / `reasoningDelta` / `thinking`）需打印实际事件结构确认。若 SDK 不暴露 reasoning delta，则 thinking 类型条目不产生（降级，不阻塞）。

#### FR-1.1b: text_delta / thinking_delta 累加与切片

新增 `thinking_delta` 处理 + text_output 节流切片（避免每 delta 一条 log entry）：

```typescript
case "text_delta":
  s._currentTurnText = (s._currentTurnText ?? "") + event.delta;
  // 节流：每 ~100 字符切片一次产生 text_output 条目，避免刷屏
  if (s._currentTurnText.length >= TEXT_OUTPUT_CHUNK) {
    s.eventLog.push({ type: "text_output", label: s._currentTurnText.slice(0, 100), ts: Date.now() });
    s._currentTurnText = "";
  }
  break;
case "thinking_delta":
  s._currentThinking = (s._currentThinking ?? "") + event.delta;
  if (s._currentThinking.length >= THINKING_CHUNK) {
    s.eventLog.push({ type: "thinking", label: s._currentThinking.slice(0, 100), ts: Date.now() });
    s._currentThinking = "";
  }
  break;
case "turn_end":
  // flush 残留缓冲
  if (s._currentTurnText) {
    s.eventLog.push({ type: "text_output", label: s._currentTurnText.slice(0, 100), ts: Date.now() });
    s._currentTurnText = "";
  }
  s.eventLog.push({ type: "turn_end", label: "(turn end)", ts: Date.now() });
  s.turns = (s.turns ?? 0) + 1;
  break;
```

新增常量：`TEXT_OUTPUT_CHUNK = 100`、`THINKING_CHUNK = 100`（可调）。

#### FR-1.2: SubagentToolDetails 扩展（替代 WidgetAgentState）

inline widget 删除后，对话流 block 的数据载体是 `SubagentToolDetails`（`tui/subagent-render.ts`）。扩展为：

```typescript
interface SubagentToolDetails {
  eventLog: AgentEventLogEntry[];
  status: "running" | "done" | "failed" | "cancelled";
  agent: string;
  turns: number;
  totalTokens: number;
  elapsedSeconds: number;
  result?: string;
  error?: string;
  backgroundId?: string;
  // 新增字段：
  model?: string;           // "provider/modelId" 格式（来自 ResolvedModel）
  thinkingLevel?: string;   // thinking level（来自 ResolvedModel）
}
```

`WidgetAgentState` 不再用于渲染（FR-2.0 删除），仅 `/subagents list` 的数据合并保留最小字段。

#### FR-1.3: 事件采集统一（sync + background）

**sync 模式**（已实现于 `subagent-tool.ts:226-260`）：onEvent 回调内构建 eventLog，push 后调 `pushUpdate("running")` 驱动 onUpdate → Component 刷新。

**background 模式（改造）**：当前 `startBackground`（runtime.ts:408-490）detached 执行，事件不回流。改为：`startBackground` 接受可选的 `onUpdate` 回调，执行时把事件推回调用方的 onUpdate，使 background block 也能滚动刷新。

```typescript
// runtime.ts startBackground 改造
startBackground(opts: BackgroundOptions & { onUpdate?: (details: SubagentToolDetails) => void }): BackgroundHandle {
  // ... detached runAgent 内部，onEvent 同时推给 opts.onUpdate
}
```

`subagent-tool.ts` 的 background 分支（:170-194）改为传入 onUpdate，使对话流 block 持续刷新。

### FR-2: 对话流执行 block 重设计

#### FR-2.0: 删除 inline widget 渲染层

inline widget 的**渲染层已停用**（`src/index.ts:35` 注释），删除以下死代码：

- `src/tui/agent-widget.ts`：删除 `renderWidget`、`renderStatusLine`、`AgentWidgetManager`（attachUI/detach/render/轮询定时器）、`WidgetUI` 接口
- 保留 `WidgetAgentState` 接口（缩小为最小字段）作为 `/subagents list` 的数据载体
- `src/index.ts`：删除注释，不再引用 widget 渲染
- `runtime.ts`：`AgentWidgetManager` 实例化代码删除；`updateWidgetFromEvent` 重命名或内联为 eventLog 构建逻辑（供 sync tool + background 共用）
- 相关测试同步更新

**不删除**：`/subagents list` 的 `getAllRecords`（`subagents-view.ts:404-457`）仍从 widget listAgents() 取 running agent 数据，需改为从 runtime 的 running agent map 取（见 FR-1.3 改造）。

#### FR-2.1: 对话流 block 压缩视图布局（默认）

sync 和 background 模式采用**完全相同**的布局。压缩视图固定 6 行（status + model + 4 行滚动区），背景色随状态变化：

```
⠹ reviewer │ 2 turns │ 8.2k │ 12s          ← 第1行 status（黄背景）
anthropic/claude-sonnet-4.5 │ thinking: medium   ← 第2行 model（黄背景）
read auth.ts ✓                              ← 第3行 滚动区（最近4条）
bash grep -r catch src/auth/ ✗              ← 第4行
I'll scan the error handling patterns...    ← 第5行（text_output 片段）
analyzing session.ts:42 for uncaught...     ← 第6行（thinking 片段，dim）
```

**第 1 行 — status summary**：
```
{glyph} {agentName} │ {turns} turns │ {tokens} │ {elapsed}s
```
- `glyph`：running → 种子帧 spinner（`⠹` 等，见 FR-2.3）；done → 绿色 `✓`；failed → 红色 `✗`；cancelled → `■`
- `agentName`：来自 agent.md 的 name 字段
- `turns`：完成的 turn 数；`tokens`：累计 token（`8.2k` / `1.2M` 格式）；`elapsed`：秒

**第 2 行 — model + thinking**：
```
{provider/modelId} │ thinking: {level}
```
- `provider/modelId`：来自 `ResolvedModel.model.id`（完整显示，如 `anthropic/claude-sonnet-4.5`）
- `level`：来自 `ResolvedModel.thinkingLevel`（如 `medium` / `high`）。无 thinking 时不显示 `│ thinking: ...`

**第 3-6 行 — 滚动区（混合流水）**：
显示 eventLog 中**最近 4 条**，按时间正序，每条一行，超宽截断（`truncateToWidth` + `…`）：
- `tool_start` → `{toolName} {args摘要}`（**无标记**，去掉 ⏳）
- `tool_end` → `{toolName} {args摘要} {✓|✗}`（done 绿色 ✓，failed 红色 ✗）
- `thinking` → dim 灰色显示 reasoning 片段
- `text_output` → 正常色显示 assistant 文本片段
- `turn_end` → 不在滚动区显示（仅在 alt+o 展开时作为分隔）

超过 4 条时，旧的向上滚出（只保留最近 4 条可见）。

#### FR-2.2: alt+o 展开（完整视图）

利用 Pi 内置的 tool result expanded 机制（`ToolRenderResultOptions.expanded`，全局切换，由 Pi runtime 管理 keybinding）。`renderResult` 根据 `options.expanded` 决定渲染压缩版还是完整版：

- **`expanded: false`（默认）**：FR-2.1 的 6 行压缩视图。执行中、成功、失败**都不展开**。
- **`expanded: true`**：完整视图，展示全部 eventLog（不限制 4 行）+ 完整 result/error 文本 + usage 统计。

执行中、成功、失败三种状态都支持 alt+o 切换。

#### FR-2.3: spinner 种子帧机制（无定时器）

参考 pi-subagents 的 `runningGlyph(seed)`，spinner 帧由种子数决定，靠 onUpdate 事件频率自然驱动：

```typescript
const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function spinnerGlyph(details: SubagentToolDetails): string {
  const seed = (details.elapsedSeconds + details.totalTokens + details.turns) | 0;
  return RUNNING_FRAMES[Math.abs(seed) % RUNNING_FRAMES.length];
}
```

- `elapsedSeconds` 持续增长 → 每次 onUpdate 推送（事件来）时种子变 → spinner 转一格
- 静默思考期（无事件）spinner 停住（与 pi-subagents 一致，可接受）
- 不引入 `setInterval`，避免 Component 生命周期管理的复杂性

#### FR-2.4: 背景色（theme token）

背景色用 Pi theme 的现有 token，不硬编码 ANSI：

| 状态 | theme token | 备注 |
|------|-------------|------|
| running（执行中） | `toolPendingBg` | 黄色 |
| done（成功） | `toolSuccessBg` | 绿色 |
| failed / cancelled | `toolErrorBg` | 红色 |
| 未执行（极短暂） | `muted` / `dim` | 灰色，仅 background 启动后首个事件到达前的毫秒级窗口 |

未执行状态极短暂（startBackground 返回到第一个 onEvent 之间），归入 running 也可接受。

#### FR-2.5: background 模式 block 实时刷新

当前 background 模式的对话流 block 启动后静止（`subagent-tool.ts:170-194` 仅 onUpdate 一次）。改造后：
- `startBackground` 接受 `onUpdate` 回调（FR-1.3）
- detached 的 runAgent 执行时，onEvent 同时推给 onUpdate
- background block 与 sync block 视觉行为完全一致（同样的滚动区、spinner、背景色）
- 完成时背景色变绿/红，追加 result/error

### FR-3: `/subagents list` 全屏两级视图

参考 `extensions/workflow` 的 `WorkflowsView.ts` 模式（`ctx.ui.custom()` overlay）。

#### FR-3.0: 执行记录留存机制（G-005/G-006/G-012 解决）

> **连带影响（FR-2.0 删除 widget 后）**：以下 FR-3.0 ~ FR-3.5 中所有"widget 数据源"（`widget.listAgents()`、`widget.agents`、`WIDGET_LINGER_MS` 淡出回调）需改为从 runtime 的 running agent map / `_completedAgents` / `_bgRecords` 取。本期 FR-2.0 删除 widget 渲染层时一并调整 `getAllRecords`（`subagents-view.ts:404-457`）的数据源，FR-3 的交互逻辑（j/k/Enter/x/q）保持不变。

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

### AC-1: 对话流 block 压缩视图（sync 模式）

1. 调用 `subagent` 工具（sync 模式）时，对话流出现背景色 block，显示 6 行：status + model + 4 行滚动区
2. 第 1 行 spinner 用种子帧（elapsedSeconds + tokens + turns），随 onUpdate 切换帧
3. 第 2 行显示完整 `provider/modelId │ thinking: level`
4. 第 3-6 行混合显示最近的 thinking / toolcall / text_output，按时间正序，超宽截断
5. tool_end 带绿色 ✓（done）或红色 ✗（failed）；tool_start 无标记（无 ⏳）
6. 执行中背景黄色（`toolPendingBg`）；成功绿色（`toolSuccessBg`）；失败红色（`toolErrorBg`）

### AC-2: 对话流 block 压缩视图（background 模式）

1. 调用 `subagent` 工具（`wait: false`）时，对话流 block **持续刷新**（与 sync 一致），不再是静止的 "Started background..."
2. background 执行期间滚动区实时更新（thinking / toolcall / text_output）
3. 完成时背景色变绿/红，追加 result/error
4. 用 `backgroundId` 查询时，若仍在运行显示 running block（滚动区有内容），已完成显示 done/failed block

### AC-3: alt+o 展开

1. Pi 内置 keybinding（由 runtime 管理）切换 `options.expanded`
2. `expanded: true` 时显示完整 eventLog（不限制 4 行）+ 完整 result/error + usage
3. 执行中、成功、失败三种状态都支持切换
4. 默认（`expanded: false`）所有状态都显示 6 行压缩视图

### AC-4: inline widget 删除

1. `agent-widget.ts` 的 `renderWidget` / `renderStatusLine` / `AgentWidgetManager` 已删除
2. `src/index.ts` 不再引用 widget 渲染
3. `/subagents list` 仍能正常列出 running agent（数据源改为 runtime running map）
4. 相关测试通过

### AC-5: 全屏列表视图（需求 2，保持不变）

1. `/subagents list` 打开全屏 overlay
2. 列出当前 session 内所有子 agent 执行记录（sync + background 合并）
3. running 优先排序，然后按 startedAt 降序
4. 无记录时显示空状态提示
5. j/k 导航高亮选中行

### AC-6: 全屏详情视图（需求 2，保持不变）

1. 列表中 Enter 进入详情
2. 详情展示完整 eventLog（可滚动）+ result/error
3. running 状态的 agent 详情实时刷新
4. q/Esc 返回列表

### AC-7: hasUI 守卫

1. print/RPC 模式下 `/subagents list` 报错，不崩溃

## Constraints

- **Pi SDK API**：对话流 block 用 `renderResult` 返回 Component；全屏视图用 `ctx.ui.custom()` overlay 模式
- **展开机制**：用 Pi 内置 `ToolRenderResultOptions.expanded`（全局切换），不自行注册 keybinding
- **spinner**：种子帧机制（无 `setInterval`），靠 onUpdate 事件频率驱动
- **背景色**：用 theme token（`toolPendingBg`/`toolSuccessBg`/`toolErrorBg`），不硬编码 ANSI
- **数据范围**：仅当前 Pi session（进程内 Map），不持久化跨 session
- **滚动区行数**：压缩视图固定 4 行（最近 4 条事件）；全屏视图可滚动但受终端高度约束
- **事件日志上限**：每个 agent 最多保留 20 条（ring buffer），防止内存无限增长
- **thinking delta**：依赖 SDK 暴露 reasoning 字段；若 SDK 不支持则 thinking 条目降级为不产生（不阻塞核心功能）
- **测试可测性**：渲染逻辑（`buildRenderLines`）和事件日志逻辑应可独立测试（不依赖真实 TUI）

## 业务用例

### UC-1: 开发者实时观察 sync 子 agent 执行过程

- **Actor**: 开发者（在 Pi 对话中）
- **场景**: 开发者委派一个多步骤任务给 reviewer agent（如"审查 src/auth/ 的错误处理"）。reviewer 正在执行时，开发者想在对话流里实时看到它在思考什么、调用了哪些工具、输出了什么
- **预期结果**: 对话流出现黄色背景 block：第 1 行 spinner + reviewer + turns/tokens/elapsed；第 2 行 model + thinking level；第 3-6 行滚动显示 thinking 片段（dim）、toolcall（带 ✓/✗）、text output 片段。无需打开全屏视图即可了解执行进度

### UC-2: 开发者观察 background 子 agent 执行

- **Actor**: 开发者
- **场景**: 开发者用 `wait: false` 启动一个 researcher agent 做后台调研，然后继续与父 agent 对话。过程中想瞄一眼 researcher 进展
- **预期结果**: 启动时的对话流 block **持续滚动刷新**（与 sync 视觉一致），显示 researcher 的 thinking/toolcall/text。完成后背景变绿，显示结果摘要

### UC-3: 开发者全屏查看所有子 agent 执行情况

- **Actor**: 开发者
- **场景**: 开发者并行启动了多个子 agent（2 个 sync + 1 个 background），想在一个全屏视图中查看所有 agent 的状态、事件流水和结果
- **预期结果**: `/subagents list` 打开全屏视图，列出 3 条记录。开发者用 j/k 导航，Enter 查看某个 agent 的完整事件日志和结果，q 返回列表

### UC-4: 开发者展开查看完整执行细节

- **Actor**: 开发者
- **场景**: 开发者看到一个已完成的 subagent block，想看完整的 eventLog 和 result（而非 4 行摘要）
- **预期结果**: 按 Pi 内置展开 keybinding，block 切换为完整视图（全部 eventLog + 完整 result + usage）。再按一次收起回 6 行压缩视图

### UC-5: 开发者排查失败的子 agent

- **Actor**: 开发者
- **场景**: 一个 background 子 agent 失败了，开发者想知道哪一步出错
- **预期结果**: 对话流 block 背景变红，滚动区可见失败的 toolcall（✗ 标记）。展开或进 `/subagents list` 详情可看完整 error 信息

## 实现依赖

- `extensions/subagents/src/tui/subagent-render.ts`：`SubagentResultComponent` + `buildRenderLines`（重写压缩/展开布局）
- `extensions/subagents/src/tui/agent-widget.ts`：删除渲染层，保留 `WidgetAgentState` 最小字段
- `extensions/subagents/src/tools/subagent-tool.ts`：sync + background 的 onUpdate 回调统一
- `extensions/subagents/src/core/event-bridge.ts`：新增 `thinking_delta` 提取（message_update 增强）
- `extensions/subagents/src/runtime.ts`：`startBackground` 接受 onUpdate；删除 `AgentWidgetManager` 实例化
- `extensions/subagents/src/types.ts`：`AgentEvent` 新增 `thinking_delta` variant；`SubagentToolDetails` 新增 model/thinkingLevel 字段
- 参考：`~/GitApp/pi-ecosystem/pi-subagents/src/tui/render.ts`（种子帧 spinner、compact/expanded 双视图）
