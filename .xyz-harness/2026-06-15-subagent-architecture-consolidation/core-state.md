# 核心层 — 统一状态管理

> 定义 AgentExecutionState（唯一状态对象）、存储容器、完成归档、history 持久化。
> 源：rethink 架构分析 + subagent-tui FR-3.0

---

## 1. AgentExecutionState（唯一状态对象）

完整类型定义见 [architecture.md §2](./architecture.md)。本文件定义其**管理逻辑**。

### 创建

```typescript
function createExecutionState(id: string, opts: {
  agent: string;
  model: string;        // resolveModelForAgent 的结果，创建时必填
  thinkingLevel?: string;
  startedAt: number;
}): AgentExecutionState
```

创建时 `model` **必须提供**。这是 Bug #2（poll 路径 model 丢失）的架构修复——model 在源头确定，不再依赖闭包捕获。

### onEvent 更新（唯一更新点）

```typescript
function updateStateFromEvent(state: AgentExecutionState, event: AgentEvent, startTime: number): void {
  // 1. eventLog 构建（唯一构建点，复用 appendEventLogEntries）
  appendEventLogEntries(state, event, startTime);
  // 2. turns 累积
  if (event.type === "turn_end") state.turns += 1;
  // 3. tokens 累积
  if (event.type === "message_end" && event.usage) {
    state.totalTokens += event.usage.input + event.usage.output + event.usage.cacheRead + event.usage.cacheWrite;
  }
}
```

**关键**：EventBridge 是事件的初始翻译器（turnCount/toolCalls/usageAccum），但 `AgentExecutionState` 是**展示用的权威状态**。EventBridge 的累积器不再被展示层直接读。

### 完成

```typescript
function completeState(state: AgentExecutionState, result: AgentResult, status: "done" | "failed" | "cancelled"): void {
  state.status = status;
  state.endedAt = Date.now();
  state.agentResult = result;
  state.result = result.text;
  state.error = result.error;
}
```

完成后 `turns`/`totalTokens` 优先读 `agentResult`（权威），但 `state.turns`/`totalTokens` 保持一致（同一事件流的累积）。

---

## 2. 存储容器

### `_runningAgents`（sync 执行期）

```typescript
// runtime.ts
private readonly _runningAgents = new Map<string, AgentExecutionState>();
```

- `runAgent()` 创建 state 后 `set(id, state)`，完成后保留（供 /subagents list），归档到 `_completedAgents` 后删除
- `listRunningAgents()`: 返回 `Array.from(_runningAgents.values())`

### `_bgRecords`（background 任务）

```typescript
interface BgRecord {
  readonly id: string;
  /** 内嵌统一状态对象（唯一状态源） */
  state: AgentExecutionState;
  result?: AgentResult;
  error?: string;
  startedAt: number;
  endedAt?: number;
  status: BackgroundStatus["status"];
  controller?: AbortController;
  _settled?: boolean;
}

private readonly _bgRecords = new Map<string, BgRecord>();
```

- `BgRecord` 的状态字段（eventLog/turns/totalTokens/model/thinkingLevel）委托给内嵌 `state`
- `getBackground(id)` 返回 `BackgroundStatus`——从 `state` **展平** model/thinkingLevel（不再是 hardcoded undefined）
- `BackgroundStatus` 类型新增 `model?` / `thinkingLevel?` 字段，供 /subagents list 详情区展示
- FIFO cap 50，淘汰时**跳过 running**（D-P0-01）

### `_completedAgents`（sync 归档）

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
  /** 详情区展示用 */
  model?: string;
  thinkingLevel?: string;
}

private readonly _completedAgents = new Map<string, CompletedAgentRecord>();
```

- sync 完成后，从 `_runningAgents` 移到 `_completedAgents`（`scheduleSyncArchive` 从 `AgentExecutionState` 展平 model/thinkingLevel）
- `CompletedAgentRecord` 是**flat 结构**（非 `{state}` 引用）——因为归档时 state 已冻结，不再需要实时引用
- cap 50 FIFO

---

## 3. eventLog 构建（修复 sink reset bug）

### 问题（历史）

`updateRecordEventLog`（background 路径）每次事件创建**新的 EventLogSink**，导致 `_currentTurnText`/`_currentThinking` 缓冲**永不累积**——text_output/thinking 条目几乎不生成。

### 修复

`AgentExecutionState` 持有**持久的** EventLogSink 字段（buffer 跨事件累积）：

```typescript
interface AgentExecutionState {
  // ... 其他字段
  /** eventLog 构建缓冲（持久，不每次重置） */
  _eventLogSink: EventLogSink;  // { _currentTurnText, _currentThinking }
}
```

`appendEventLogEntries(state, event, startTime)` 读写 `state._eventLogSink`，不再每次创建新 sink。

### chunking 常量

- `TEXT_OUTPUT_CHUNK = 100`：累积 text_delta ≥ 100 字符时 push 一条 `text_output`
- `THINKING_CHUNK = 100`：累积 thinking_delta ≥ 100 字符时 push 一条 `thinking`
- ring buffer max 20 条（超出淘汰最旧）

---

## 4. HistoryStore（跨 session 持久化）

### PersistedAgentRecord（history.jsonl 一行）

```typescript
interface PersistedAgentRecord {
  readonly id: string;
  readonly agent: string;
  status: "done" | "failed" | "cancelled";
  mode: "sync" | "background";
  taskPreview: string;      // task 前 ~100 字符
  startedAt: number;
  endedAt?: number;
  turns?: number;
  totalTokens?: number;
  error?: string;
  resultPreview?: string;   // result 前 ~200 字符
  sessionFile?: string;     // AgentResult.sessionFile basename
  cwd: string;
  /** 当前 session id（/subagents list 按此过滤） */
  sessionId?: string;
  /** 详情区展示用 */
  model?: string;
  thinkingLevel?: string;
}
```

**持久化 model + thinkingLevel**：供 /subagents list 右列详情区展示。`buildPersistedRecord` 接受并输出这两个字段。

**不持久化**：完整 eventLog（太大）、完整 result（读 session file）。

### sessionId 过滤

`/subagents list` 只显示当前 session 的记录。`history-store.read(sessionId?)` 和 `recent(limit, sessionId?)` 按 sessionId 过滤。`runtime.listHistory()` 内部透传 `this._sessionId`（session_start 时由 `setSessionId()` 注入）。

旧记录（无 sessionId 字段）在过滤时被排除——不迁移旧数据。

### GC

- history.jsonl：append-only，确定性 GC（每 10 次写检查，超 `HISTORY_MAX_RECORDS` 重写保留最近 N 条）
- session file：跟随主 session 生命周期（Pi SDK 原生 GC）
- `/subagents list` 读 history 时按 sessionId 过滤 + endedAt desc 排序，cap 显示 100 条

---

## 5. /subagents list 数据合并（getAllRecords）

```typescript
function getAllRecords(runtime): SubagentRecord[] {
  // 4 源合并 + 去重（by id）
  const map = new Map<string, SubagentRecord>();

  // 1. running sync agents（内存源，天然当前 session）
  for (const state of runtime.listRunningAgents())
    map.set(state.id, { ...state, model: state.model, thinkingLevel: state.thinkingLevel });

  // 2. background records（内存源，getBackground 从 state 展平 model/thinkingLevel）
  for (const b of runtime.listBackground())
    map.set(b.id, { ...b, model: b.model, thinkingLevel: b.thinkingLevel });

  // 3. completed sync agents（内存源，flat 结构含 model/thinkingLevel）
  for (const c of runtime.listCompleted())
    map.set(c.id, { ...c, model: c.model, thinkingLevel: c.thinkingLevel });

  // 4. history（跨进程持久化，runtime.listHistory 内部已按 this._sessionId 过滤）
  for (const h of runtime.listHistory(100))
    if (!map.has(h.id)) map.set(h.id, { ...h, model: h.model, thinkingLevel: h.thinkingLevel });

  return Array.from(map.values());
}
```

**修复**：background records 的 turns/tokens 从 `rec.state` 读取，不再 hardcoded `undefined`（历史 bug #3）。

**sessionId 过滤**：源 4（history）由 `runtime.listHistory()` 内部按 `this._sessionId` 过滤。源 1-3 是内存数据源，天然属于当前 session。`/resume /fork /new` 时 `setSessionId(newId)` 切换过滤范围。

### 去重优先级

同一 id 出现在多个源：cancelled 状态优先（G-024），其余 running > completed > history。
