---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-25T16:00:00"
  target: "workflow/ 目录（12 个文件：package.json, index.ts, src/index.ts, src/state.ts, src/config-loader.ts, src/agent-pool.ts, src/worker-script.ts, src/orchestrator.ts, src/execution-trace.ts, src/budget.ts, src/commands.ts, src/widget.ts）"
  verdict: fail
  summary: "编码评审完成，第1轮，6条MUST FIX，4条LOW，2条INFO，需修改后重审"

statistics:
  total_issues: 12
  must_fix: 6
  must_fix_resolved: 0
  low: 4
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "workflow/src/worker-script.ts:41-93"
    title: "$ARGS/$WORKSPACE/$BUDGET 未注入为 Worker 全局变量，FR1.3 违规"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "workflow/src/index.ts:78-99"
    title: "跨会话恢复 (FR4.5) 数据路径错位 — reconstructState 读了错误的数据源"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: MUST_FIX
    location: "workflow/src/index.ts:141-147"
    title: "session_shutdown 未自动暂停运行中的 workflow (FR6.4)"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: MUST_FIX
    location: "workflow/src/worker-script.ts:73-82"
    title: "agent() 返回 StateAgentResult 对象而非 spec 约定的 extracted content (parsedOutput ?? output)"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: MUST_FIX
    location: "workflow/src/orchestrator.ts:410-460"
    title: "Agent 调用自动重试 (FR7.1) 未实现 — 失败后直接传递给 Worker，无退避重试"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: MUST_FIX
    location: "workflow/src/orchestrator.ts:540-570"
    title: "90% 预算警告未实现 (FR8.2) — checkBudget 只在超限时处理，缺少独立 90% 阈值检查"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: LOW
    location: "workflow/src/index.ts:28-68"
    title: "summary-table _render 的 columns 格式与协议不匹配：传了 string[] 而非 TableColumn[]"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 8
    severity: LOW
    location: "workflow/src/orchestrator.ts:570"
    title: "budget-warning 消息的 budget 字段格式与 spec 不匹配"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 9
    severity: LOW
    location: "workflow/src/index.ts, workflow/src/commands.ts"
    title: "pollForCompletion 逻辑在 workflow-run tool 和 /workflow run 命令中重复实现"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 10
    severity: LOW
    location: "workflow/src/index.ts:166-298"
    title: "workflow tool 使用 isError: true 返回错误，偏离 CLAUDE.md 的 throw new Error() 约定"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 11
    severity: INFO
    location: "workflow/src/agent-pool.ts:46-52"
    title: "AgentPool 无单次调用的超时机制 — 阻塞的 agent 调用会永久占用池槽位"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 12
    severity: INFO
    location: "workflow/src/orchestrator.ts:330"
    title: "workerData.meta 始终为空 {}，未从 workflow 脚本提取"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 编码评审 v1

## 评审记录
- 评审时间：2026-05-25 16:00
- 评审类型：编码评审（模式二）
- 评审对象：`workflow/` 目录全部 12 个文件
- 参照文档：spec.md + plan.md + CLAUDE.md（架构约束 + 编码规范）

---

## AC 覆盖矩阵

| AC | 场景 | 覆盖状态 | 说明 |
|----|------|---------|------|
| AC1 | 最小可用验证（2 个 agent 顺序执行） | ✅ | 完整实现 |
| AC2 | 暂停/恢复 | ✅ | 暂停/恢复流程完整，但跨会话恢复有数据路径问题（见 MUST FIX #2） |
| AC3 | parallel 并发 | ✅ | Worker 的 parallel() + AgentPool 并发限制 |
| AC4 | 错误重试 | ⚠️ | 仅实现了 Worker 级重试（handleScriptError）；agent 级重试（FR7.1）未实现（见 MUST FIX #5） |
| AC5 | 多 workflow 并发 | ✅ | 独立 Worker + 共享 AgentPool |
| AC6 | Token 预算 | ⚠️ | 100% 终止已实现，90% 警告未实现（FR8.2，见 MUST FIX #6） |
| AC7 | Schema 结构化输出 | ✅ | AgentPool 追加 schema 指令 + JSON.parse |
| AC8 | CC 兼容性 | ✅ | meta 格式 + agent/parallel/pipeline API 签名兼容 |
| AC9 | _render 输出 | ✅ | task-list 格式正确 |

---

## 1. Spec 合规

### 1.1 FR1: Workflow 脚本定义

**FR1.1/FR1.2** ✅ 扫描 `.pi/workflows/` 和 `~/.pi/agent/workflows/` 目录，支持 JS 脚本 + meta 元数据。

**FR1.3 ⚠️ MUST FIX #1 — `$ARGS`/`$WORKSPACE`/`$BUDGET` 未注入为 Worker 全局变量**

Spec FR1.3 明确要求 Worker 线程注入以下全局变量：
- `$ARGS` — 从命令行或 tool 参数注入的对象
- `$WORKSPACE` — 当前 Pi 工作目录
- `$BUDGET` — `{ total, used, remaining }`，每次 agent 调用完成后更新
- `meta` — 脚本的 meta 块

实际实现中，`buildWorkerScript()` (`worker-script.ts`) 只注入了 `agent()`、`parallel()`、`pipeline()` 三个全局函数。`$ARGS`、`$WORKSPACE`、`$BUDGET` 虽然通过 `workerData` 传递给了 Worker 线程，但未作为全局变量暴露。

plan.md 中的 demo 脚本直接使用 `$ARGS.file`，这将导致 `ReferenceError: $ARGS is not defined`。

**影响**：所有 workflow 脚本无法按 spec 约定的 API 接收外部参数和访问预算信息。脚本必须自行通过 `require("worker_threads").workerData` 访问，这与 spec 的兼容性目标和 Claude Code Workflow 格式兼容（FR9）冲突。

**修复方向**：在 `buildWorkerScript()` 生成的 Worker 代码顶部注入全局变量：
```javascript
const $ARGS = workerData.args;
const $WORKSPACE = workerData.workspace;
const $BUDGET = workerData.budget;
const meta = workerData.meta;
```

**FR1.4** ✅ JS 脚本可用完整控制流（在 Worker 中执行，无限制）。

**FR1.5** ✅ `config-loader.ts` 用 Worker `import()` 提取 meta，失败时标记 `available=false` 不影响其他脚本。

### 1.2 FR2: Worker 线程执行模型

**FR2.1-FR2.5** ✅ 使用 `new Worker(code, { eval: true })` 独立 V8 isolate；agent() 通过 postMessage RPC 委托主线程；parallel() 用 Promise.all；trace 作为线性日志；AgentPool 默认并发上限 4。

### 1.3 FR3: DAG 执行轨迹

**FR3.1-FR3.4** ✅ `ExecutionTraceNode` 包含所有必需字段（stepIndex, agent, task, model, status, startedAt, completedAt, result, error）；序列线性节点序列；通过 `pi.appendEntry("workflow-trace")` 持久化。

### 1.4 FR4: 暂停与恢复

**FR4.1-FR4.4** ✅ 暂停通过 `worker.terminate()` + 保留 `callCache`；恢复创建新 Worker + callCache 重放；幂等重放语义已文档化。

**FR4.5 ⚠️ MUST FIX #2 — 跨会话恢复数据路径错位**

Spec FR4.5 要求：Pi 进程重启后，workflow 状态从 Session JSONL 恢复。

当前实现中：
1. 状态持久化通过 `orchestrator.persistState()` → `pi.appendEntry("workflow-state", serializeState(this.instances))`，写入的是 `custom` 类型 entry。
2. 但 `session_start` 中的 `reconstructState()` (`src/index.ts:78-99`) 只读取 `getBranch()` 中的 `message` 类型 entry，查找 `toolResult` 中 `details.instances`。
3. `message` 类型的 entry **不包含** `custom` entry 的数据。`details.instances` 存的是轻量 `InstanceSummary[]`（缺少 callCache、trace、budget 等关键字段），而非完整的 `serializeState` 输出。

**数据路径断裂**：write path 写入 custom entry，read path 从 tool result message 读取。跨会话恢复时：
- 无法恢复 `callCache` → 恢复后所有 agent 调用会重复执行
- 无法恢复 `trace` 节点 → 历史执行轨迹丢失
- 无法恢复 `budget.usedTokens/cost` → 预算控制从零开始

**修复方向**：`reconstructState` 改为从 custom entries 中读取。或者维持现有持久化方式但将序列化状态也写入 tool result 的 `details.instances` 中（确保是完整序列化状态而非 Summary）。

### 1.5 FR5: 用户交互

**FR5.1-FR5.4** ✅ 命令已注册（`/workflow` 含 run/list/abort；`/workflows` 交互面板）；`workflow-run` Tool 已注册；完成通知含 `_render`；TUI widget + 快捷键注册。

### 1.6 FR6: 后台运行 & 多 workflow 并发

**FR6.1-FR6.3** ✅ Workflow 后台运行（`pollInterval.unref()`）；多 workflow 独立 Worker + 共享 AgentPool。

**FR6.4 ⚠️ MUST FIX #3 — session_shutdown 未自动暂停运行中的 workflow**

Spec FR6.4 要求："主会话关闭时，所有运行中的 workflow 自动暂停。callCache 和 DAG 状态已持久化，下次会话可恢复。"

当前 `session_shutdown` handler (`src/index.ts:141-147`) 只做了：
```typescript
sessionStates.delete(sessionId);
orchestrators.delete(sessionId);
```

没有遍历运行中的 workflow 执行 `pause()` 操作（终止 Worker + 保留 callCache + 持久化）。这意味着：
- 主会话关闭时，运行中的 Worker 线程被直接丢弃（或随进程终止）
- `callCache` 可能未被持久化到最新状态
- 重新启动后，之前 running 状态的工作流无法恢复

**修复方向**：在 `session_shutdown` 中遍历 `orchestrators.get(sessionId).list()`，对 status 为 "running" 的实例执行 `pause()`（设置 pausedAt + 持久化，但不 terminate Worker 因为进程马上退出）。

### 1.7 FR7: 错误处理与重试

**FR7.1 ⚠️ MUST FIX #5 — Agent 调用自动重试未实现**

Spec FR7.1 要求："agent 子进程失败（exitCode != 0 或 stopReason === "error"）时，自动重试最多 3 次。每次重试间隔递增（1s → 3s → 9s）。"

当前 `orchestrator.ts` 的 `handleAgentCall()` 中：
```typescript
this.agentPool.enqueue(opts).then((poolResult) => {
  const result: StateAgentResult = { ... };
  instance.callCache.set(callId, result);
  this.postMessage(runId, { type: "agent-result", callId, result, cached: false });
  // 失败时直接转发结果，无重试
});
```

失败结果直接传递给 Worker，无重试逻辑。plan.md 中规划的 `retry.ts` 文件未创建。

注意：`handleScriptError()` 中存在的重试机制是处理 **Worker 脚本级别** 的错误（脚本运行时异常），而非 **agent 调用级别** 的子进程失败。

**修复方向**：在 `handleAgentCall` 中的 `.then()` 前添加重试循环（或委托给独立的 retry 模块），检测 `poolResult.success === false` 时按指数退避重试（1s → 3s → 9s），超过 3 次后才标记为 failed。

**FR7.2** ✅ Worker 崩溃 → `worker.on("error")` → handleWorkerError。

**FR7.3** ✅ 脚本运行时异常 → `handleScriptError`。

**FR7.4** ✅ `retryNode()` 清除 callCache 条目 + 重启 Worker。

**FR7.5** ✅ `skipNode()` 注入 placeholder。

### 1.8 FR8: 预算控制

**FR8.1** ✅ Token 预算追踪（`instance.budget.usedTokens` 累加，`checkBudget` 检查超限）。

**FR8.2 ⚠️ MUST FIX #6 — 90% 预算警告未实现**

Spec FR8.2 要求："消耗达 90% 时，主线程向 Worker 发送 budget-warning 消息。Worker 中的 JS 脚本可检查 `$BUDGET.remaining` 做收尾处理。"

当前实现中，`checkBudget()` 只检查是否 **已超限**（>= 100%），在超限时同时发送 `budget-warning`（命名误导）并终止 Worker。独立于终止的 **90% 阈值预警** 完全缺失。

虽然 `BudgetTracker` 类（`budget.ts`）有独立的 `isWarning()` 方法（使用 >= 0.9 判断），但 Orchestrator 未使用 `BudgetTracker` — 它直接操作 `instance.budget` 的原始字段。

`$BUDGET` 未注入为全局变量（见 MUST FIX #1），即使发送了 warning，Worker 也没有方式读取剩余预算。

**修复方向**：
1. 在 Orchestrator 中每 agent 完成后额外检查 90% 阈值（与 100% 检查分开），达到时发送 `{ type: "budget-warning" }` 消息但**不终止 Worker**。
2. 结合 MUST FIX #1，使 Worker 能通过 `$BUDGET` 读取剩余预算。

**FR8.3/FR8.4** ✅ 100% 超限标记为 `budget_limited`；时间预算通过 `scheduleTimeBudgetCheck` 实现。

### 1.9 FR9: Claude Code 兼容性

**FR9.1-FR9.3** ✅ meta 格式 + `agent()`/`parallel()`/`pipeline()` API 签名兼容；不兼容点（模型选择、子进程执行机制、预算单位）已明确。

### 1.10 FR10: GUI 兼容

**FR10.1-FR10.3** ✅ `workflow-run` Tool 返回 `_render`（type: "task-list"）；完成通知也包含 `_render`；增量字段不影响 TUI。

### 1.11 FR11: 生命周期

**FR11.1** ✅ 状态机完整（8 状态，终态不可逆转）。

**FR11.2** ✅ 完整历史保留在 JSONL（含节点、callCache、最终结果）。但是跨会话恢复有数据路径问题（见 MUST FIX #2）。

---

## 2. 代码质量

### 2.1 可读性
- 命名清晰，文件注释 JSDoc 完整，解释了各模块的 "为什么"
- `buildWorkerScript` 的内联代码使用 `"use strict"` + 注释段落，可读性好
- JSDoc 注释覆盖了大部分 public 函数

### 2.2 Worker agent() 返回值 ⚠️ MUST FIX #4

**Spec 约定的行为**（参考 spec.md 的 Worker 代理伪代码）：
```javascript
async function agent(opts) {
  // ...
  return new Promise((resolve, reject) => {
    parentPort.once("message", (msg) => {
      if (msg.result.success) resolve(msg.result.parsedOutput ?? msg.result.output);
      else reject(new Error(msg.result.error));
    });
  });
}
```
→ 返回 `string | parsedObject`

**实际实现**（`worker-script.ts`）：
```javascript
async function agent(opts) {
  if (_callCache.has(callId)) {
    return _callCache.get(callId);    // 返回 StateAgentResult
  }
  // ...
  pending.resolve(msg.result);         // 返回完整 StateAgentResult
}
```
→ 返回 `StateAgentResult { content, usage, durationMs, error }`

这导致两个问题：
1. 用户脚本期望 `agent()` 返回实际的 agent 输出内容（字符串或解析后的 JSON），但拿到的是 `{ content: "...", usage: {...}, ... }` 对象
2. 失败时 agent() 不 reject — 用户脚本无法用 try/catch 捕获 agent 失败

**修复方向**：Worker 的 agent() resolve 时提取 `parsedOutput ?? output`，失败时 reject Error。

### 2.3 错误处理
- ✅ `AgentPool.enqueue()` 始终 resolve（从不 reject），错误信息在 result 中
- ✅ 状态机转换参数校验 + 有意义错误消息
- ✅ Worker error/exit 事件处理覆盖了崩溃场景
- ⚠️ LOW #10: `workflow` tool 用 `isError: true` 返回错误，偏离 CLAUDE.md "用 `throw new Error()`" 的约定

### 2.4 边界条件
- ✅ `config-loader.ts` 处理不存在目录 → 静默返回空数组
- ✅ `BudgetTracker` 校验非正参数
- ✅ `reconstructState` 处理缺失/无效的 `details`

---

## 3. 架构合规

### 3.1 CLAUDE.md 约束对照

| 约束 | 状态 | 说明 |
|------|------|------|
| 扩展入口 `export default function xxxExtension(pi)` | ✅ | `workflowExtension(pi)` |
| `index.ts` 只做注册胶水 | ✅ | 注册 tool/command/events |
| 状态管理在 `state.ts` | ✅ | 状态模型 + 状态机 + 序列化 |
| TUI 渲染在 `widget.ts` | ✅ | 列表视图 + 详情 Overlay |
| Tool 参数用 typebox | ✅ | `Type.Object()`, `StringEnum()` |
| `execute` 返回 `{ content, details }` | ✅ | 结构正确 |
| 错误用 `throw new Error()` | ⚠️ LOW #10 | workflow tool 用了 `isError: true` |
| Session 隔离 + 闭包状态 | ✅ | `sessionStates: Map<sessionId, Map<runId, Instance>>` |
| 持久化用 `pi.appendEntry` | ✅ | 两种 entry type: "workflow-state", "workflow-trace" |
| `_render` 增量字段 | ✅ | summary-table + task-list |
| 禁止 `any` | ✅ | 未发现 `any` 使用 |
| 单文件 ≤ 1000 行 | ✅ | 最大文件 ~290 行 |

### 3.2 分层正确性

数据流完整性：✅

```
Worker (postMessage) → Orchestrator (handleWorkerMessage)
                     → AgentPool (enqueue)
                     → spawn pi --mode json
                     → stdout JSONL parsing
                     → StateAgentResult
                     → callCache set
                     → trace node update
                     → budget accumulation
                     → persistState (JSONL)
                     → postMessage back to Worker
```

依赖方向正确性：✅
- `worker-script.ts` → `state.ts`（引用 AgentResult 类型）
- `orchestrator.ts` → `agent-pool.ts`, `config-loader.ts`, `execution-trace.ts`, `state.ts`, `worker-script.ts`
- `commands.ts` → `config-loader.ts`, `orchestrator.ts`, `state.ts`
- `widget.ts` → `orchestrator.ts`, `state.ts`
- `src/index.ts` → `state.ts`, `orchestrator.ts`, `commands.ts`, `widget.ts`

没有跨层调用（如直接从 commands.ts 调用 agent-pool.ts）。

---

## 4. 安全和性能

### 4.1 安全
- ✅ Worker 线程在独立 V8 isolate 中运行，无法直接访问主线程进程/fs
- ✅ 无 eval 用户输入（脚本由用户自己编写，Worker 执行时没有额外安全沙箱约束 — 符合 spec 约定）

### 4.2 性能
- ✅ `AgentPool` 有并发上限（默认 4），防止子进程无限制增长
- ✅ JSONL 流式解析（buffer-based，O(1) 内存开销每事件）
- ✅ Worker 创建使用 `eval: true`（避免文件 I/O）
- ✅ `timer.unref()` 防止定时器阻塞进程退出
- ✅ 多 workflow 共享一个 AgentPool，进程复用

### 4.3 INFO #11 — AgentPool 无单次调用超时

如果某个 agent 子进程挂起，它会永久占用一个池槽位，降低有效并发。在极端情况下，如果所有 4 个槽位都被挂起的进程占据，所有 workflow 的 agent 调用都会停止。

**建议**：可在 `spawnAndParse` 中添加信号超时（如 `AbortSignal.timeout(300_000)`），超时后 kill 子进程并返回失败结果。

### 4.4 INFO #12 — workerData.meta 为空

`orchestrator.ts` 中创建 Worker 时传入 `meta: {}`，但未从 workflow 脚本提取实际的 meta 对象。FR1.3 要求 meta 作为全局变量注入，且应从脚本的 `const meta = {...}` 中读取。

---

## 5. 集成验证

### 5.1 事件注册 → 调用链

| 事件 | Handler | 动作 | 验证 |
|------|---------|------|------|
| `session_start` | `reconstructState` | 从 JSONL 恢复 + 创建 Orchestrator + setWidget | ✅ |
| `session_tree` | 同上 | 同上 | ✅ |
| `session_shutdown` | `sessionStates.delete()` + `orchestrators.delete()` | 清理 | ⚠️ 缺少自动暂停 (MUST FIX #3) |

### 5.2 Worker ↔ 主线程通信协议

协议覆盖对比：

| 消息类型 | Direction | Spec | 实现 | 状态 |
|----------|-----------|------|------|------|
| `agent-call` | Worker→Main | `{ type, callId, opts }` | `{ type: "agent-call", callId, opts }` | ✅ |
| `agent-result` | Main→Worker | `{ type, callId, result, cached }` | 同 spec | ✅ |
| `budget-warning` | Main→Worker | `{ type, budget: {total,used,remaining} }` | `{ type: "budget-warning", budget: WorkflowBudget, reason }` | ⚠️ LOW #8 |
| `abort` | Main→Worker | `{ type, reason }` | 同 spec | ✅ |
| `return` | Worker→Main | `{ type, runId, result }` | 同 spec | ✅ |
| `error` | Worker→Main | `{ type, runId, error }` | 同 spec | ✅ |

### 5.3 数据持久化路径

```
AgentPool 返回结果
  ↓
Orchestrator 更新 instance.callCache (内存)
  ↓
Orchestrator 更新 instance.trace (内存) + appendTraceNode (JSONL)
  ↓
Orchestrator 更新 instance.budget (内存)
  ↓
Orchestrator.persistState() → pi.appendEntry("workflow-state", serializeState(instances))
```

持久化路径完整。但恢复路径（`reconstructState`）未从 custom entry 读取，见 MUST FIX #2。

---

## 6. 其他问题

### 6.1 LOW #7 — _render summary-table 格式不匹配

`WorkflowDetails._render.data.columns` 传的是 `string[]`（`["Name", "Status", "Worker", "Duration"]`），但 `_render` 协议定义的 `SummaryTableData.columns` 应为 `TableColumn[]`，即 `{ key, label, width?, valueType? }[]`。

虽然客户端 fallback 可处理此问题，但这会使 xyz-agent GUI 无法正确渲染 summary table。

### 6.2 LOW #8 — budget-warning 消息中 budget 字段格式不匹配

发送的 `budget` 是 `WorkflowBudget`（`{ maxTokens, maxCost, usedTokens, usedCost }`），但 spec 要求 `{ total, used, remaining }` 格式。

### 6.3 LOW #9 — pollForCompletion 重复

`workflow-run` Tool 的 `execute` 内联了完整的轮询逻辑，与 `commands.ts` 中导出的 `pollForCompletion()` 函数功能完全一致。建议复用同一函数，减少维护负担。

### 6.4 LOW #10 — isError: true 模式偏离 CLAUDE.md

CLAUDE.md 约定："错误用 `throw new Error()`，不要返回 `{ content: [{ text: "错误: ..." }] }` 的错误成功模式"。当前 workflow tool 返回 `{ isError: true, content: [...], details: {...} }`。虽然 `isError: true` 比"错误成功模式"要好，但仍然偏离了 `throw new Error()` 约定，可能导致 TUI 错误展示不一致。

---

## 结论

**verdict: fail** — 存在 6 条 MUST FIX 问题。

### 问题汇总

| # | 优先级 | 文件/位置 | 描述 | 状态 |
|---|--------|----------|------|------|
| 1 | MUST FIX | `worker-script.ts:41-93` | `$ARGS/$WORKSPACE/$BUDGET` 未注入为 Worker 全局变量 (FR1.3) | open |
| 2 | MUST FIX | `src/index.ts:78-99` | 跨会话恢复数据路径错位 — reconstructState 读了错误的数据源 (FR4.5) | open |
| 3 | MUST FIX | `src/index.ts:141-147` | session_shutdown 未自动暂停运行中的 workflow (FR6.4) | open |
| 4 | MUST FIX | `worker-script.ts:73-82` | agent() 返回完整 StateAgentResult 而非 extracted content (spec 行为背离) | open |
| 5 | MUST FIX | `orchestrator.ts:410-460` | Agent 调用自动重试 (FR7.1) 未实现 | open |
| 6 | MUST FIX | `orchestrator.ts:540-570` | 90% 预算警告未实现 (FR8.2) | open |
| 7 | LOW | `src/index.ts:28-68` | _render summary-table columns 格式与协议不匹配 | open |
| 8 | LOW | `orchestrator.ts:570` | budget-warning 的 budget 字段格式与 spec 不匹配 | open |
| 9 | LOW | `src/index.ts`, `commands.ts` | pollForCompletion 逻辑重复 | open |
| 10 | LOW | `src/index.ts:166-298` | workflow tool 用 isError:true 偏离 throw Error 约定 | open |
| 11 | INFO | `agent-pool.ts:46-52` | AgentPool 无单次调用超时 | open |
| 12 | INFO | `orchestrator.ts:330` | workerData.meta 始终为空 | open |

### 修改方向总结

**核心修复（MUST FIX）：**
1. $ARGS/$WORKSPACE/$BUDGET 注入：在 `buildWorkerScript` 生成的代码顶部添加全局变量声明
2. 跨会话恢复：`reconstructState` 改为从 custom entry (ENTRY_TYPE) 读取，而非 tool result message
3. session_shutdown 自动暂停：遍历运行中的 workflow 执行 pause + persistState
4. agent() 返回值修复：Worker 中 resolve 时提取 `parsedOutput ?? output`，失败时 reject Error
5. agent 自动重试：在 handleAgentCall 中添加指数退避重试（1s→3s→9s），或创建缺失的 `retry.ts`
6. 90% 预算警告：每 agent 完成后额外检查 90% 阈值，发送 warning 消息但不终止 Worker

编码评审完成，第1轮，6条MUST FIX，需修改后重审。
