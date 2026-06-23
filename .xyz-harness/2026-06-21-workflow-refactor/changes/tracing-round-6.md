# Tracing Round 6

## 追踪范围
- spec 初稿版本：2026-06-21 最终版（含 D-1~D-11 决策、9 个 domain 模型、失败处理矩阵）
- clarification.md：Round 1~5 全部决策已登记
- domain-models.md：含 G5-001 引入的 `WorkflowRun.replaceRuntime(newRt)` 方法
- 追踪的视角：User Journey（全）、Data Lifecycle（全）、API Contract（全）、State Machine（全）、Failure Path（全）

## 结论：**未收敛 — 1 个新 gap（G6-001）**

G5-001 引入 `replaceRuntime` 处理 retryNode/worker-error-retry 的"status 不变原地替换"，但只覆盖了 `status === "running"` 场景。现有代码（`lifecycle.ts:219`）允许 retryNode 在 `paused` 状态调用，而 `replaceRuntime` 的不变式声明（`status==="running" ⟺ runtime!==undefined`）在 paused 场景下会被违反。这是 G5-001 的适用范围遗漏。

## 追踪视角详情

### P1: User Journey

#### OP-U01: AI 启动 workflow（run action）
- Actor: AI agent
- Main Path: AI 调用 `workflow { action:"run" }` → fuzzy 匹配 + 确认 + 启动 → 后台执行 → completion notification 唤醒 [VERIFIED: tool-workflow-run.ts, index.ts:101]
- 强制检查项全覆盖：成功/放弃/重复（reentry-guard）/权限（RPC 降级）/超时（budgetTimeMs）。无新 gap。

#### OP-U02: 外部扩展程序化调用（pi.__workflowRun）
- Actor: coding-workflow gate
- Main Path: gate 调用 `pi.__workflowRun(name,args,signal,timeoutMs)` → 等待 → 返回 `{status, scriptResult, error, runId}` [VERIFIED: index.ts:103]
- D-8 已处理签名变更（status → reason）。无新 gap。

#### OP-U03: 用户交互式查看（/workflows）
- Actor: 人类用户
- UC-3 已定义；spec Out of Scope "TUI 完全重新设计"，仅适配新 domain 接口。无新 gap。

#### OP-U04: retry-node 操作 ⚠️ **发现 G6-001**
- Actor: AI agent
- Main Path（running 状态）: 删除 callCache[callId] → 重置 trace node → replaceRuntime 重建 worker → worker 重跑 → 已完成调用从 cache replay
- **Branch B1（paused 状态 retry）**:
  - When: workflow 已 pause，AI 观察到某 agent call 失败（trace 有 failed node），主动调用 `workflow { action:"retry-node" }`
  - 现有行为（lifecycle.ts:219）：`if (instance.status !== "running" && instance.status !== "paused") throw` —— **允许 paused retryNode**
  - 现有代码执行：terminateWorker → recreateRunAbortController → startWorker，**无 transitionStatus**，status 保持 paused
  - 重构后走 `replaceRuntime`：绑定新 runtime 使 `runtime !== undefined`，但 status 仍为 `"paused"` → **违反 WorkflowRun 核心不变式 `status==="running" ⟺ runtime!==undefined`**
  - [GAP G6-001]

#### OP-U05: abort / skip-node 操作
- abort：P1-4 已覆盖 running/paused → aborted。无新 gap。
- skipNode：无状态检查，只设 callCache + trace node，不涉及 runtime 生命周期，不违反不变式。paused 状态 skip 后 resume 时 worker replay cache。无新 gap。

### P2: Data Lifecycle

#### E01: WorkflowRun（聚合根）
- Create: run action，runId = `wf-<timestamp>-<base36>` [VERIFIED: lifecycle.ts:generateRunId]
- Update: transition / assignRuntime / releaseRuntime / replaceRuntime（G5-001）
- Delete: restart 已废弃（D-9）；terminal run 保留到 session 结束（现有行为）
- 唯一性、外键、数据量增长均无新 gap。

#### E02: WorkflowScript（实体）/ E03: WorkflowScriptRegistry（仓库）
- 第 7/8 节已定义 tmp > project > user 优先级、60s TTL、workspaceRoot 分桶。无新 gap。

#### E03': ApprovalPolicy（值对象）
- G2-001 已处理持久化解耦（ApprovalStore port + session_start loadApproved）。无新 gap。

#### E04: trace / callCache
- D-10（trace 单一来源）、G3-001（callCache 跨 runtime 存活）已处理。无新 gap。

### P3: API Contract

#### OP-A01: workflow tool
- actions: run / status / pause / resume / abort / retry-node / skip-node（FR-5）
- 错误码：pre-flight reject invalid transitions（tool-workflow.ts）。幂等性：retry-node 非幂等但 reentry-guard 防并发（非契约要求）。无新 gap。

#### OP-A02: workflow-script tool
- actions: generate / lint / save / delete / list（FR-5）。无新 gap。

#### OP-A03: pi.__workflowRun
- D-8 已处理。无新 gap。

### P4: State Machine

#### RunStatus: running / paused / done（reason: completed/failed/aborted/budget_limited/time_limited）

合法转换全部覆盖（spec FR-3 + domain-models）：
- (init)→running / running↔paused / running→done / paused→done(aborted)

**僵尸状态检查**：done 不可离开（终态）。无僵尸状态。

**replaceRuntime 与状态机交互** ⚠️ **确认 G6-001**：
- domain-models 第 1 节 replaceRuntime 定义："原子释放旧 runtime + 绑定新 runtime，**全程保持不变式 `status==="running" ⟺ runtime!==undefined`**。**不改变 status（保持 running）**"
- 该定义**假设调用时 status === "running"**，但未声明此前置条件
- paused 状态下调用 replaceRuntime 会违反不变式（runtime 绑定但 status 非 running）
- [GAP G6-001]

### P5: Failure Path

#### F-run / F-worker / F-budget / F-time / F-reentry / F-state-lost
- 全部已覆盖（失败处理矩阵 + G3-001 runtime 重建 + reentry-guard + D-4 state_lost）。无新 gap。

#### F-retry-paused: paused 状态 retryNode 的不变式违反 ⚠️ **确认 G6-001**
- Source: P1/OP-U04 Branch B1
- Failure Type: 数据不一致（不变式违反）
- Condition: paused 状态调用 retry-node
- Detection: 无（重构后不变式违反是静默的，除非有运行时断言）
- Recovery: 需要决策（见 G6-001 选项）
- [GAP G6-001]

## Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G6-001 | D | User Journey / State Machine / Failure Path | P1/OP-U04-B1, P4, P5 | retryNode 在 paused 状态的语义：replaceRuntime 假设 status==="running"，但现有代码允许 paused retryNode。重构后 paused 状态调用 replaceRuntime 会违反不变式 `status==="running" ⟺ runtime!==undefined`。需决策：(A) retryNode 前置检查改为 running only（禁止 paused retry，行为变化）；(B) paused 状态 retryNode 先 transition(running) 再 replaceRuntime（隐式 resume 语义）；(C) replaceRuntime 内部根据当前 status 决定是否转换。 |

## 降级视角记录

无降级视角。本需求虽为架构重构，但 5 视角均适用（状态机简化是核心需求 + tool/action 是接口契约 + WorkflowRun/WorkflowScript 有生命周期 + 有用户操作和失败路径），全部完整追踪。

## 验证依据

- `extensions/workflow/src/engine/lifecycle.ts:219` —— retryRunNode 前置检查 `status !== "running" && status !== "paused"`
- `extensions/workflow/src/engine/lifecycle.ts:233-242` —— retryRunNode 无 transitionStatus（status 不变）
- `extensions/workflow/src/engine/lifecycle.ts:188-222`（resumeRun）—— 对比：resume 显式 transitionStatus(instance, "running")
- `extensions/workflow/src/engine/error-handlers.ts:handleWorkerExit` —— worker exit retry 明确跳过 paused（`if (status === "paused" || isTerminal) return`），证明 worker error retry 只在 running（G5-001 适用范围正确）
- `domain-models.md` 第 1 节 WorkflowRun.replaceRuntime —— "不改变 status（保持 running）"假设未覆盖 paused 场景
