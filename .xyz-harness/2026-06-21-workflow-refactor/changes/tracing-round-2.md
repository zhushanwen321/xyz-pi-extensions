# Tracing Round 2

## 收敛判定：NOT CONVERGED

重新跑完 5 视角后发现 **2 个新 gap**（均为 D 类，domain/infra 层归属决策）。Round 1 的 28 个 gap 均已被主 agent 处理（domain-models.md 字段定义 + D-8/9/10/11 + 隐式契约保留清单覆盖），未重复报告。

新 gap 的共同根因：**domain-models.md 把"带 Pi SDK 副作用的模型"（ApprovalPolicy、WorkerHandle、ConcurrencyGate）与纯 domain 模型混列在"9 个领域模型"标题下，未明确这些模型的层归属如何满足 AC-1（domain 零依赖）**。spec FR-2 把 ConcurrencyGate/WorkerHandle 归到 Infrastructure，但 RunRuntime（聚合内）仍直接引用这两个 Infra 类型——跨层依赖未澄清。

## 追踪范围

- **spec 版本**：spec.md（verdict: pass）+ domain-models.md（9+ 模型字段定义，Round 1 G-016 已补齐）+ clarification.md（含 Round 1 新增决策 D-8/9/10/11）
- **追踪的视角**（完整重跑，非增量）：
  - P1 User Journey — 适用（AI/外部扩展/人类 3 类 actor）
  - P2 Data Lifecycle — 部分适用（WorkflowRun/WorkflowScript/AgentCall 有生命周期，非 CRUD）
  - P3 API Contract — 适用（2 个 tool 收口 + pi.__workflowRun）
  - P4 State Machine — 强适用（FR-3 状态机简化）
  - P5 Failure Path — 适用（重试/budget/abort 路径密集）

无降级视角——本重构同时变更数据模型/API 表面/状态机，5 视角都是核心审查对象。

## Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G2-001 | D | Data Lifecycle | P2 / domain-models ApprovalPolicy × AC-1 | **ApprovalPolicy 的 Pi SDK 依赖与 domain 零依赖矛盾**。domain-models 把 ApprovalPolicy 列在 domain（"值对象，非 service —— D-11 降级"），但 `recordApproval(name)` 注释写"写 Set + appendEntry"，`rehydrate(entries: SessionEntry[])` 入参是 Pi SDK 类型。当前代码：recordApproval 调 `pi.appendEntry("workflow-approval-memory", ...)`（tool-workflow-run.ts:120），rehydrate 读 `ctx.sessionManager.getEntries()` 返回的 `SessionEntry[]`（index.ts:63）。AC-1 明确"Domain 层零依赖（不 import Pi SDK）"。矛盾未解：(a) ApprovalPolicy 留 domain 则 recordApproval/rehydrate 必须通过 port/回调注入持久化能力（类似 AgentCall.execute 接受 `runner: AgentRunner`）；(b) ApprovalPolicy 移到 Interface/Application层（与 D-11 已说的"RPC 降级留 Interface 层"合并）。D-11 只处理了 RPC 降级（sendUserMessage），未覆盖 appendEntry 持久化这条 Pi SDK 依赖路径。 |
| G2-002 | D | Data Lifecycle | P2 / domain-models RunRuntime × WorkerHandle × AC-1 | **RunRuntime（聚合内）直接引用 Infra 类型，跨层依赖未澄清**。domain-models RunRuntime 持 `worker: WorkerHandle` + `gate: ConcurrencyGate`。spec FR-2 明确把 WorkerHandle（属 WorkerHostImpl）和 ConcurrencyGate 归到 Infrastructure 层。但 RunRuntime 是 WorkflowRun 聚合的一部分（domain-models 注释"聚合内，仅 running 时存在"），若 RunRuntime 属 domain，则 domain→Infra 跨层引用违反 AC-1。进一步：domain-models 把 WorkerHandle 定义为 `class`（持 `private worker: Worker` = node:worker_threads），不是 interface——它无法是 domain 类型。Ports 节定义了 `interface WorkerHost { start(...): WorkerHandle }`，返回值是 WorkerHandle，若 WorkerHandle 是 Infra 具体类则 port 返回类型也跨层。需决策：(a) WorkerHandle 拆为 domain interface + Infra 实现类（RunRuntime 持 interface 类型）；(b) RunRuntime 整体移出 domain（归 Application/Infra），WorkflowRun.runtime 字段类型改为 domain interface。 |

## 追踪明细（验证 Round 1 闭合点 + 新发现）

### P1: User Journey

- **OP-U01 AI 启动 run（UC-1）**：run → fuzzy 匹配 → confirm → 后台 → completion notification。reentry-guard（G-009 已处理，隐式契约清单登记"2 tool 共享 → Interface 层"）、tmp/unapproved confirm（G-008/D-11）、completion notification（G-011，_render 保留）均闭合。retry-node/skip-node 在 workflow tool 内部，自然被 reentry-guard 覆盖——非新 gap。
- **OP-U02 外部扩展 pi.__workflowRun（UC-2）**：D-8 签名 `{status:"done", reason: DoneReason, ...}` 闭合 G-001/G-004/G-026 的核心。timeout/unknown 边缘值映射到哪个 reason（time_limited？failed？）未显式说，但属 plan 实现细节（DoneReason 枚举已含 time_limited/failed，映射是 1 行决策）——非 spec 级 gap。
- **OP-U03 /workflows 交互（UC-3）**：spec Out of Scope 已声明"WorkflowsView 适配新 domain 接口即可"。restart 快捷键随 D-9 删除，save 进 tool，'S' trace 导出是 TUI 适配细节——G-014 在 spec 级已闭合。

### P2: Data Lifecycle（新 gap 集中在此视角）

- **WorkflowRun**：Create/Read/Update 闭合（RunLifecycleService + transition/assignRuntime/releaseRuntime）。Delete：当前唯一 deleteRun 调用者是 restartRun（lifecycle.ts:430），D-9 废弃 restart 后 deleteRun 无调用者——但这不是 gap（restart 的"替代"语义消失，终态 run 随 session 结束清理，与现有行为一致，domain-models service 列表无 delete 操作是 consistent）。
- **WorkflowScript**：validate/toExecutable/save/delete 闭合。delete 的 isRunning 回调签名保留（domain-models），新 tool 如何注入是 plan 细节（G-007 已覆盖）。
- **AgentCall/Budget/Trace/WorkerHandle/RunRuntime/ConcurrencyGate/ApprovalPolicy**：字段定义齐全。**但 ApprovalPolicy（G2-001）和 RunRuntime→WorkerHandle/ConcurrencyGate（G2-002）的层归属与 AC-1 矛盾**——见 gap 列表。
- **callCache 持久化性能**（G-019）：domain-models 改为 `calls: Map<number, AgentCall>`，rewrite 模式保留。长 trace 性能是现有代码也有的问题，重构不引入也不解决——非 gap。

### P3: API Contract

- **workflow tool**（run/status/pause/resume/abort/retry-node/skip-node）：FR-5 列出 actions。retry-node/skip-node 参数 schema（runId+callId）未显式定义，但与现有 pause/resume/abort 同等对待（spec 级只列 action 名）——consistent，非 gap。
- **workflow-script tool**（generate/lint/save/delete/list）：FR-5 列出。list 输出 schema 未定义，但 WorkflowScriptRegistry.loadAll() 返回 WorkflowScript[]，list 自然投影——plan 细节，非 gap。
- **pi.__workflowRun**：D-8 闭合。
- **/workflows command**：仅查看，闭合。

### P4: State Machine

- **3 态 + doneReason**：FR-3 + D-6 + domain-models WorkflowRun.transition 闭合。合法转换表、非法转换抛错、终态不可离开均明确。
- **state_lost**：D-4 移出状态机，reconstruct 时标 failed + error="state lost"。重建时 spec/meta 占位字段（如 scriptSource:"(lost)"）是 plan 实现细节——非 gap（G-002 在 spec 级已闭合）。
- **doneReason 存储**：RunState.reason 字段（domain-models 模型 3）闭合 G-004。

### P5: Failure Path

- **失败处理矩阵**（domain-models 登记表）：Worker 3 次重试、Script error 3 次重试、Agent call 3 次重试、Stale context 0 次、Budget/Time 0 次——全部参数明确，闭合 G-021/G-022/G-023。
- **AbortController 重建**：RunRuntime.controller + release(mode) 闭合 G-025。
- **per-call timeoutMs**：AgentCallOpts.timeoutMs 归 AgentCall 实体（domain-models 模型 5 注释 G-027）闭合。
- **soft limit**：Budget.isSoftLimitReached + onConsume 回调（domain-models 模型 4）闭合 G-024。

## 追踪统计

- 总新 gap 数：**2**
- 类型分布：D（Decision）= 2，F = 0，K = 0
- 视角分布：Data Lifecycle = 2（根因相同：domain/infra 层归属）
- 阻塞型：0（均为层归属决策，plan 阶段可定，但不明确会导致实现时违反 AC-1）
- 非阻塞但影响架构合规：2（G2-001/G2-002 直接关系 AC-1 "Domain 层零依赖"能否通过）

## 建议

两个 gap 根因相同——**domain-models 需补充一节"层归属与依赖注入策略"**，明确：
1. ApprovalPolicy 的 appendEntry/SessionEntry 如何通过 port/回调与 domain 解耦（或整体移出 domain）
2. WorkerHandle 是否拆为 domain interface + Infra 实现类；RunRuntime 是留 domain（持 interface）还是移出 domain

主 agent 处理后，Round 3 复核应能收敛。
