# 架构设计 — 核心层与展示层分层 + 统一状态模型

> 本文件定义 extension 的内部架构，解决历史问题：状态散落在 11 个形状里、3 条路径各自投影导致字段丢失、展示逻辑泄漏进执行逻辑。

---

## 1. 缺陷根因（为什么要重构）

历史架构的**根本问题**：没有单一的 agent 状态对象。三条执行路径（sync / background-live / poll）各自独立从事件流累积状态到自己的存储形状里，然后用各自的 transform chain 投影到 SubagentToolDetails，每条路径有不同的字段遗漏。

### 量化诊断

| 指标 | 现状 | 目标 |
|------|------|------|
| 状态形状数 | 11 种（EventBridge, AgentResult, WidgetAgentState×2, BgRecord, CompletedAgentRecord, 闭包局部, PersistedAgentRecord, SubagentToolDetails, SubagentRecord, BackgroundStatus） | 3 种（AgentExecutionState, AgentResult, PersistedAgentRecord） |
| SubagentToolDetails 构造点 | 6 处手工构造 | 1 处 `toDetails()` |
| turns 计数独立累加器 | 6 个（bridge, widgetState, toolState, bgTurns closure, record.turns, AgentResult.turns） | 2 个（EventBridge 累积 → AgentExecutionState.turns） |
| elapsedSeconds 计算点 | 6 处（Math.floor vs Math.round 混用） | 1 处（投影时从 startedAt 算） |
| eventLog 构建点 | 2 处（sync 双构建：widgetState + toolState） | 1 处（AgentExecutionState.onEvent） |
| 数据丢失 bug | 4 个已确认（poll 无 model、bg eventLog chunking 坏、list 丢 turns、elapsed 不一致） | 0（单一数据源消除整类问题） |

### "修不完"的机制

你不是在修 bug，你是在 6 个不一致的投影点之间打地鼠。每修一个投影点的遗漏，就暴露下一个被掩盖的不一致。要止血，必须**统一数据源**。

---

## 2. 统一状态模型：AgentExecutionState

**所有执行路径的唯一 agent 状态对象。** 不管 sync/background/poll，一个 agent 的执行状态就是这一个对象。

### 类型定义

```typescript
/**
 * 统一的 agent 执行状态。核心层的唯一状态对象。
 * sync: 存于 runtime._runningAgents（Map<id, AgentExecutionState>）
 * background: 内嵌于 BgRecord（BgRecord 持有此对象的引用）
 * poll: getBackground 返回的 BackgroundStatus 内含此对象
 *
 * 生命周期：runAgent onEvent 创建/更新 → 完成时冻结（endedAt 写入）
 * 持久化：完成后投影为 PersistedAgentRecord（history.jsonl）
 */
interface AgentExecutionState {
  /** 唯一 ID（sync: "run-N"，bg: "bg-N-xxx"，orchestration step: "step-N"） */
  readonly id: string;

  // ── 身份（创建时确定，不可变）──
  /** agent 名（来自 opts.agent ?? "default"） */
  readonly agent: string;
  /** "provider/modelId"（来自 resolveModelForAgent，**创建时即填**，不再丢失） */
  readonly model: string;
  /** thinking level（来自 resolveModelForAgent） */
  readonly thinkingLevel: string | undefined;

  // ── 状态（实时更新）──
  /** 当前状态 */
  status: "running" | "done" | "failed" | "cancelled";
  /** 事件日志（ring buffer，max 20，onEvent 时构建，**唯一构建点**） */
  eventLog: AgentEventLogEntry[];
  /** 已完成 turn 数（onEvent turn_end 时 +1） */
  turns: number;
  /** 累计 token 数（onEvent message_end 时累加） */
  totalTokens: number;

  // ── 时间（存时间戳，不存 elapsedSeconds）──
  /** 启动时间（ms epoch） */
  readonly startedAt: number;
  /** 结束时间（ms epoch，running 时 undefined） */
  endedAt: number | undefined;

  // ── 结果（完成时填）──
  /** agent 输出文本（done 时） */
  result: string | undefined;
  /** 错误描述（failed 时） */
  error: string | undefined;
  /** 完整 AgentResult（done/failed 时，含 usage/toolCalls 详情） */
  agentResult: AgentResult | undefined;
}
```

### 关键设计决策

| 决策 | 理由 |
|------|------|
| `model`/`thinkingLevel` 是 `readonly`，创建时确定 | 消灭 poll 路径 model 丢失（Bug #2 根因） |
| `eventLog` 在此对象上构建，唯一构建点 | 消灭 sync 双构建 + bg chunking 坏（sink reset bug） |
| 存 `startedAt` 时间戳，**不存 elapsedSeconds** | 消灭 6 个计算点 + floor/round 不一致。投影时统一算 |
| `turns`/`totalTokens` 在此对象累积 | 消灭 6 个独立累加器。EventBridge 是初始源，但 state 是展示源 |
| `agentResult` 完成时填入 | done 后 poll 读 agentResult.turns/usage（权威），running 时读 state.turns/totalTokens（实时） |

### 唯一投影方法

```typescript
/**
 * 投影到 AnyToolDetails（核心层→展示层唯一桥梁）。
 * 每种状态对象有且只有这一个方法。消灭 6 个手工构造点。
 *
 * elapsedSeconds 在此计算（唯一计算点），用 Math.floor。
 */
function executionStateToDetails(state: AgentExecutionState): SubagentToolDetails {
  return {
    kind: "single",
    eventLog: state.eventLog,
    status: state.status,
    agent: state.agent,
    model: state.model,              // 不再 undefined
    thinkingLevel: state.thinkingLevel,
    turns: state.turns,
    totalTokens: state.totalTokens,
    elapsedSeconds: state.endedAt
      ? Math.floor((state.endedAt - state.startedAt) / 1000)
      : Math.floor((Date.now() - state.startedAt) / 1000),  // 唯一计算点
    result: state.result,
    error: state.error,
  };
}
```

---

## 3. 数据流（重构后）

```
SDK AgentSession.subscribe(rawSdkEvent)
        │
        ▼
EventBridge.handle()          ← 唯一事件翻译（turnCount/toolCalls/usageAccum）
        │ onEvent(AgentEvent)
        ▼
AgentExecutionState.onEvent()  ← 唯一状态更新点（eventLog/turns/tokens 都在此累积）
        │
   ┌────┴────────────────────────────────┐
   │                                     │
 sync 路径                         background 路径
 state 存于                         state 内嵌于 BgRecord
 runtime._runningAgents            runtime._bgRecords
   │                                     │
 execute() 每次 onUpdate            startBackground onUpdate 回流
 调 executionStateToDetails()       调 executionStateToDetails()
   │                                     │
   │          poll 路径                   │
   │   getBackground() 返回 BgRecord      │
   │   调 executionStateToDetails()       │
   │   （读同一个 state 对象）             │
   └──────────────┬──────────────────────┘
                  │
                  ▼
          AnyToolDetails（唯一投影类型）
                  │
                  ▼
          展示层（纯函数渲染）
          buildRenderLines(details, width, theme)
```

### 对比：重构前的数据流（已废弃）

重构前同一个 "turn count" 要经历 4-7 跳，每跳独立累加：

```
bridge.turnCount → onEvent → toolState.turns++ → buildDetails.turns → Component → render
                              ↓（并行重复）
                              widgetState.turns → result.turns → （死分支，unused）
```

重构后：

```
bridge.turnCount → state.turns（唯一累积）→ toDetails().turns → Component → render
```

---

## 4. 存储层（重构后：3 种）

| # | 对象 | 生命周期 | 角色 | 持久化 |
|---|------|---------|------|--------|
| 1 | **AgentExecutionState** | runAgent 期间 → 完成后冻结 | **执行期唯一状态源** | 不持久化（完成后投影为 #3） |
| 2 | **AgentResult** | 完成时由 collectResult 构建 | **完成后权威结果** | 内嵌于 state.agentResult |
| 3 | **PersistedAgentRecord** | 完成后写入 history.jsonl | **当前 session 查询源**（按 sessionId 过滤） | history.jsonl（L1）+ session file（L2） |

PersistedAgentRecord 新增字段：`sessionId?`（过滤用）、`model?`、`thinkingLevel?`（详情区展示用）。

### 辅助容器（不是独立状态形状，是 state 的持有者）

| 容器 | 持有什么 | 用于 |
|------|---------|------|
| `runtime._runningAgents` | `Map<id, AgentExecutionState>` | sync 执行期间 + /subagents list 右列详情 |
| `runtime._bgRecords` | `Map<id, BgRecord>` | background 任务（BgRecord 内嵌 state，getBackground 展平 model/thinkingLevel） |
| `runtime._completedAgents` | `Map<id, CompletedAgentRecord>` | sync 完成后归档（flat 结构含 model/thinkingLevel，cap 50 FIFO） |
| `history.jsonl` | `PersistedAgentRecord[]` | 跨 session 历史（`/subagents list` 按 `sessionId` 过滤只显示当前 session） |

`BgRecord` 持有 `AgentExecutionState` 的引用（实时状态）。`CompletedAgentRecord` 是 **flat 结构**（归档时从 state 展平，不再持有 state 引用）——两者都带 `model?`/`thinkingLevel?` 供 /subagents list 详情区展示。

---

## 5. 层契约（不可违反）

### 核心层的义务

| 规则 | 具体 |
|------|------|
| 产出 AnyToolDetails | 每次状态变化（onEvent/完成/取消），通过 onUpdate 或 execute 返回推送 AnyToolDetails |
| 不画 UI | 核心 `.ts` 文件不 import pi-tui 的 Box/Text/Spacer/color。不产出 ANSI 序列 |
| 唯一投影 | `executionStateToDetails(state)` 是唯一投影入口。禁止在 tool execute() 里手工构造 details |
| 时间戳 | 存 startedAt/endedAt，不存 elapsedSeconds。投影时算 |
| model 即时填 | AgentExecutionState 创建时 model 字段必填（从 resolveModelForAgent 获取） |
| model 传播 | model/thinkingLevel 从 AgentExecutionState 传播到 BgRecord（getBackground 展平）、CompletedAgentRecord（scheduleSyncArchive 展平）、PersistedAgentRecord（buildPersistedRecord 写入），供 /subagents list 详情区展示 |
| sessionId 过滤 | runtime 在 session_start 时 `setSessionId(ctx.sessionManager.getSessionId())`。`listHistory()` 按 sessionId 过滤，`buildPersistedRecord` 写入 sessionId |

### 展示层的义务

| 规则 | 具体 |
|------|------|
| 纯函数 | buildRenderLines/buildStatusLine/formatEventLogLine 是纯函数。输入 details + width + theme，输出 string[] |
| 不回写 | 展示层绝不修改 details。不调 runtime 方法（除了 /subagents list overlay 的 cancel） |
| 不解析 model | 展示层不调 resolveModelForAgent。model 字符串来自 details，原样显示 |
| 不计数 | 展示层不自己数 turn/token。读 details.turns/totalTokens |
| 宽度安全 | 所有输出行经 truncLine（ANSI 保留）截断到 width。不依赖外部兜底 |

### AnyToolDetails 类型（层间契约）

```typescript
/** 核心层→展示层的唯一数据类型。展示层按 kind 路由渲染。 */
type AnyToolDetails = SubagentToolDetails | OrchestrationToolDetails;

interface SubagentToolDetails {
  kind: "single";  // G-038: 必填，用于路由
  eventLog: AgentEventLogEntry[];
  status: "running" | "done" | "failed" | "cancelled";
  agent: string;
  model: string;              // 必填（创建时确定）
  thinkingLevel?: string;
  turns: number;
  totalTokens: number;
  elapsedSeconds: number;     // 投影时计算
  result?: string;
  error?: string;
  backgroundId?: string;
}

interface OrchestrationToolDetails {
  kind: "orchestration";
  mode: "parallel" | "chain" | "fanout";
  status: "running" | "done" | "failed" | "cancelled";
  runId: string;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  elapsedSeconds: number;
  totalTokens: number;
  graph: OrchestrationGraphNode[];  // 每个 node 内嵌 step 的 AgentExecutionState 快照
  result?: string;
  error?: string;
}
```

---

## 6. 执行路径详解（重构后）

### Path A: single sync

```
execute({task, agent})
  → resolveModelForAgent(agent) → model, thinkingLevel
  → runtime.runAgent({..., onEvent})
      → 创建 AgentExecutionState（model/thinkingLevel 即时填）→ 存入 _runningAgents
      → EventBridge.subscribe → onEvent → state.onEvent() 更新 eventLog/turns/tokens
      → 每次 onEvent: executionStateToDetails(state) → onUpdate → Pi 重渲染
      → 完成: collectResult → state.agentResult = result → state.status = done/failed
  → executionStateToDetails(state) → 返回给 Pi
  → 归档: _completedAgents.set(id, snapshot(state))
```

### Path B: single background

```
execute({task, agent, wait:false})
  → resolveModelForAgent → model, thinkingLevel
  → runtime.startBackground({..., onUpdate})
      → 创建 BgRecord（内嵌 AgentExecutionState，model 即时填）
      → detached runAgent({... onEvent: state.onEvent()})
      → 每次 onEvent:
          state 更新 + executionStateToDetails(state)
          → onUpdate 回流给 execute 的闭包 → Pi 重渲染
      → 完成: state.agentResult = result → sendMessage 回注通知
  → 立即返回 { backgroundId }
```

### Path C: poll

```
execute({backgroundId})
  → runtime.getBackground(id) → BgRecord（含 AgentExecutionState）
  → executionStateToDetails(bgRecord.state) → 返回给 Pi
  // running: state.turns/totalTokens 实时（onEvent 累积的）
  // done: state.agentResult.turns（权威）
  // model: state.model（创建时填的，不再丢失）
```

**三条路径读的是同一个 AgentExecutionState 对象**（或其快照）。数据天然一致。

---

## 7. 迁移策略（不一次性重写）

| 阶段 | 范围 | 验证 |
|------|------|------|
| **Wave 0** | 定义 AgentExecutionState 类型 + executionStateToDetails() | typecheck pass |
| **Wave 1** | background 路径：BgRecord 内嵌 state，poll 读 state | AC-STATE #1,2,3 通过（消灭 poll model 丢失 + turns 不一致） |
| **Wave 2** | sync 路径：_runningAgents 存 state，消灭 toolState 双构建 | AC-STATE #4,5 通过（消灭 eventLog 双构建） |
| **Wave 3** | 修复 updateRecordEventLog 的 sink reset bug | background eventLog 完整（text_output/thinking 不丢） |
| **Wave 4** | 删除 WidgetAgentState 的渲染用途 + FR-2.0：删除 AgentWidgetManager（renderWidget/renderStatusLine/poll-timer 等已废弃的 async widget 渲染层）。WidgetAgentState 保留最小字段仅作 /subagents list 数据载体 | 代码量减少，无功能退化 |
| **Wave 5** | 删除 _render（GUI 描述符，TUI 从不读它）+ mapRenderStatus 双状态枚举（running|done|failed|cancelled ↔ pending|in_progress|completed|failed|cancelled） | 消灭并行状态词汇，减少 6 个构造点 |

每个 Wave 独立可验证、可回滚。Wave 1 是 ROI 最高的（解决 poll 路径整类 bug）。

### 已废弃概念清单（重构后删除）

| 废弃概念 | 原位置 | 替代 | 理由 |
|---------|--------|------|------|
| AgentWidgetManager（async widget） | tui/agent-widget.ts | 对话流 block（FR-2.0 已删） | 已废弃，渲染统一到对话流 block |
| `_render` task-list 描述符 | SubagentToolDetails | 删除（TUI 不读） | GUI 专用，TUI 死代码，维护并行状态枚举 |
| `mapRenderStatus` | subagent-tool.ts | 删除 | 双状态枚举同步负担 |
| toolState（sync 路径独立 onEvent） | subagent-tool.ts execute() | AgentExecutionState（runtime 持有） | 消灭 eventLog 双构建 |
| bgTurns/bgTokens 闭包 | runtime.ts startBackground | AgentExecutionState.turns/totalTokens | 消灭独立累加器 |
| `elapsedSeconds` 字段（存于 details） | 6 处计算 | `startedAt` 时间戳 + 投影时算 | 消灭 floor/round 不一致 |
