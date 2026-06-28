# Tracing Round 12（收敛复核 — Round 11 G11-001~004 修复验证）

## 追踪范围

- **spec/clarification/domain-models 版本**：Round 11 报告 4 个文档同步 gap（G11-001~004）后，主 agent 已全部修复。本轮验证修复正确性 + 完整重跑 5 视角确认无新矛盾。
- **追踪的视角**（完整重跑，非增量）：
  - P1 User Journey — 适用（AI / 用户 / 外部扩展 三类 actor）
  - P2 Data Lifecycle — 部分降级（架构重构，非 CRUD；仅追踪实体创建/删除边界 + 持久化）
  - P3 API Contract — 适用（tool/action + pi.__workflowRun + Interface helper + WorkflowScriptRegistry 接口契约）
  - P4 State Machine — 强适用（状态机简化 + runtime 生命周期是核心需求）
  - P5 Failure Path — 适用（worker retry / budget / agent retry / 持久化失败 / runtime 重建）

## 结论：**未收敛 — 1 个新 gap（G12-001，极低严重度，Round 11 G11-003 修复尾巴）**

Round 11 报告的 4 个 gap **全部正确落地、事实正确、交叉一致**（详见 Part A）：
- G11-001 ✓ clarification.md:23 加注「后修正：D-13 改为保持 4」+ 交叉引用 line 113 D-13 决策
- G11-002 ✓ clarification.md:31 改为「核心模型（原提 9 个，D-11 删 ApprovalPolicy 后 8 个，D-12 归 Engine 层）」
- G11-003 ✓ domain-models.md:321 砍掉清单加「NotificationService class（降为 Interface 层 notifyDone helper）」
- G11-004 ✓ domain-models.md:315 层归属表 WorkflowScriptRegistry 改为「repository interface，不是 Ports 节的注入 port」+ line 316「3 个注入 Port（在 Ports 节）」明确区分

但完整重跑发现 **1 个新 gap**：

- **G12-001（F，极低严重度）**：clarification.md D-12 条目的「具体砍掉」6 项清单（line 112）未同步加 NotificationService，与 domain-models.md「砍掉的伪抽象」清单（line 318-323，已含 NotificationService）不一致。这是 Round 11 G11-003 修复的尾巴——主 agent 修了 domain-models 清单（让 spec.md:41 notifyDone 不再术语悬空），但漏了 clarification D-12 条目里同样是「D-12 砍掉内容」的对应清单。

**为什么报告这个极低严重度 gap**：按收敛判定规则，发现新 gap 就不标 CONVERGED。虽然 G12-001 是文档同步层、不影响架构设计，但两个清单都自称描述「D-12 砍掉内容」，NotificationService 在一清单有、另一清单无，读者会疑惑。修复成本极低（ clarification.md:112 加一项即可）。

**Stagnation 评估：未触发。**
- Round 7: 0 → Round 8: 3 → Round 9: 1 → Round 10: 0 → Round 11: 4 → Round 12: 1
- 序列从 Round 11 的 4 降到 Round 12 的 1（4 → 1），单调下降。Round 12 的 1 个 gap 是 Round 11 G11-003 修复的遗漏位置（Round 11 未检查 clarification D-12 条目的清单），非思维枯竭，非同一 gap 重复提出。无需启动 Stagnation 保底。

---

## Part A：Round 11 修复逐项验证

### A1: G11-001（maxConcurrency）— **通过**

**修复内容**：clarification.md:23「重命名 + maxConcurrency 4→5（**后修正：D-13 改为保持 4，无数据支撑变更**）」。

**交叉一致性验证**（`grep -nE "maxConcurrency|4→5|保持 4" spec.md clarification.md domain-models.md`）：

| 位置 | 内容 | 一致？ |
|------|------|-------|
| clarification.md:23 | 「4→5（**后修正：D-13 改为保持 4，无数据支撑变更**）」| ✓ 加注保留历史脉络 + 明确最终值 |
| clarification.md:113 | 「D-13 maxConcurrency 保持 4（不改为 5）」| ✓ |
| spec.md:52 (FR-2 架构图) | 「保持 maxConcurrency=4, D-13」| ✓ |
| spec.md:100 (FR-7) | 「保持 4（D-13）」| ✓ |
| spec.md:200 (D-3) | 「保持 maxConcurrency=4」| ✓ |
| spec.md:210 (D-13) | 「保持 4（不改为 5）」| ✓ |
| domain-models.md:225 (§11) | 「保持 4（D-13）」| ✓ |

7 处描述全部对齐「保持 4」。line 23 字面虽含「4→5」字样，但括号加注明确「后修正：保持 4」+ 交叉引用 line 113 D-13 决策，读者能正确解读。**G11-001 完全解决。**

### A2: G11-002（模型计数）— **通过**

**修复内容**：clarification.md:31「核心模型（原 Round 1 提 9 个领域模型；D-11 删 ApprovalPolicy 后为 8 个；D-12 改三层后归 Engine 层而非独立 Domain 层）」。

**交叉一致性验证**：

| 项目 | spec.md | domain-models.md | clarification.md | 一致？ |
|------|---------|------------------|------------------|-------|
| 核心模型数 | FR-1 表格 8 行 + 注记「8 个核心模型」（line 30）| §1-§11 活跃编号 + §12 删除线 | line 31「8 个」 | ✓ |
| 编号类型总数 | 注记「11 个编号类型（§1-§11）」（line 30）| 实测 §1-§11 共 11 节（`grep -nE "^## [0-9]+\." domain-models.md`）| — | ✓ |
| §12 状态 | 注记「ApprovalPolicy 删除」（line 30）| `## ~~12. ApprovalPolicy~~（删除 —— D-11/D-12）` | — | ✓ |
| 未上表 3 个 | 注记「RunSpec §2 / RunState §3 / ConcurrencyGate §11」（line 30）| §2 RunSpec / §3 RunState / §11 ConcurrencyGate 确实未在 FR-1 表格 | — | ✓ |
| FR-1 表格行数 | 8 行（WorkflowRun/AgentCall/Budget/Trace/WorkflowScript/WorkflowScriptRegistry/WorkerHandle/RunRuntime）| — | — | ✓ |

**计数全部吻合**：8 核心 + 3 未上表 = 11 编号 + §12 删除 = 12 个编号节（§1-§12）。clarification.md:31 的脉络（9→8）与 spec.md:30 + domain-models.md §12 一致。**G11-002 完全解决。**

### A3: G11-003（NotificationService 入砍掉清单）— **通过（但发现 G12-001 尾巴）**

**修复内容**：domain-models.md:321 砍掉清单加「NotificationService class（降为 Interface 层 notifyDone helper）」。

**交叉一致性验证**（spec.md:41 ↔ domain-models.md 清单 ↔ domain-models.md 隐式契约保留清单）：

| 位置 | 内容 | 一致？ |
|------|------|-------|
| spec.md:40 | `confirmTmp() ← 吞并 ApprovalPolicy (D-11)` | ✓（砍掉清单第 2 项 ApprovalStore port + ApprovalPolicy class）|
| spec.md:41 | `notifyDone() ← 吞并 NotificationService` | ✓（砍掉清单第 3 项 NotificationService class）|
| domain-models.md:267（隐式契约保留清单）| `Interface 层 notifyDone() helper 保留` | ✓ |
| domain-models.md:321（砍掉清单）| `NotificationService class（降为 Interface 层 notifyDone helper）` | ✓ 新加 |

**spec.md line 41 不再术语悬空**——NotificationService 在 domain-models 砍掉清单有明确归属。**G11-003 在 spec ↔ domain-models 层面完全解决。**

**但**：clarification.md D-12 条目的「具体砍掉」6 项清单（line 112）未同步加 NotificationService（详见 Part B P3 OP-A06 G12-001）。这是 G11-003 修复时只改 domain-models、未同步 clarification D-12 条目的遗漏。

### A4: G11-004（WorkflowScriptRegistry 术语区分）— **通过**

**修复内容**：
- domain-models.md:315（层归属表 WorkflowScriptRegistry 行）改为「Engine repository interface + Infra 实现 | 需 mock（文件扫描），是 repository（§8）不是 Ports 节的注入 port」
- domain-models.md:316（层归属表 3 Port 行）改为「3 个注入 Port（AgentRunner / RunStore / WorkerHost）| Engine 定义，Infra 实现 | 需 mock 测试的真依赖（在 Ports 节）」

**交叉一致性验证**（§8 定义 ↔ Ports 节 ↔ 层归属表 ↔ spec FR-4 ↔ spec FR-1 注记 ↔ spec FR-2 架构图）：

| 位置 | 对 WorkflowScriptRegistry 的定性 | 对 3 个 Port 的定性 | 一致？ |
|------|-------------------------------|-------------------|-------|
| domain-models.md:160（§8 标题）| 「仓库接口，新增」| — | ✓ |
| domain-models.md:163-168（§8 定义）| `interface WorkflowScriptRegistry` + 「实现在 Infrastructure 层（WorkflowScriptRegistryImpl）」| — | ✓ |
| domain-models.md:240（Ports 节标题）| — | 「Ports（3 个，Engine 定义，Infra 实现）」只列 AgentRunner/RunStore/WorkerHost | ✓ |
| domain-models.md:257（为什么只留 3 port）| — | 「AgentRunner / RunStore / WorkerHost 是真需要 mock 测试的依赖」| ✓ |
| domain-models.md:315（层归属表）| 「repository interface，是 repository（§8）**不是 Ports 节的注入 port**」| — | ✓ 明确区分 |
| domain-models.md:316（层归属表）| — | 「3 个注入 Port（**在 Ports 节**）」| ✓ 明确区分 |
| spec.md:30（FR-1 注记）| — | 「Ports 接口节（3 个 port）」| ✓ |
| spec.md:51（FR-2 架构图）| — | 「3 个 Port 实现: WorkerHostImpl / SubprocessRunner / JsonlRunStore」| ✓ |
| spec.md:78-82（FR-4）| — | 「3 个 port: AgentRunner / RunStore / WorkerHost」| ✓ |
| spec.md:54（FR-2 架构图）| WorkflowScriptRegistryImpl 在 Infra | — | ✓ |

**WorkflowScriptRegistry 与 3 个注入 Port 的术语区分在 6 个位置全部一致**：WorkflowScriptRegistry = repository interface（§8，需 mock 但不在 Ports 节）；3 个 Port = 注入 Port（在 Ports 节，AgentRunner/RunStore/WorkerHost）。**G11-004 完全解决。**

**附带观察（非 gap）**：spec.md:51 的 3 个 Port 实现命名（WorkerHostImpl / SubprocessRunner / JsonlRunStore）与 FR-4 的 3 个 Port 名（AgentRunner/RunStore/WorkerHost）非 1:1 字面对应——SubprocessRunner 是 AgentRunner 的实现（按实现手段命名），JsonlRunStore 是 RunStore 的实现（按格式命名），WorkerHostImpl 是 WorkerHost 的实现（按 Port 名 + Impl 命名）。这是实现命名惯例差异（描述实现手段 vs 按 Port 接口命名），非文档矛盾，不计为 gap。Round 11 也未视为 gap。

---

## Part B：5 视角追踪（独立完整重跑，非增量）

### P1: User Journey

#### OP-U01: AI 启动 workflow（run action）
- Actor: AI agent
- Main Path: `workflow { action:"run" }` → fuzzy 匹配 + 确认 + 启动 → 后台执行 → notifyDone 唤醒 [VERIFIED: tool-workflow-run.ts]
- 强制检查项：成功下一步（notification）/ 中途放弃（signal abort）/ 重复（reentry-guard）/ 权限（RPC 降级）/ 超时（budgetTimeMs）全覆盖。
- Round 11 修复未触及用户路径行为。notifyDone 的 `_render` 协议保留（domain-models.md:267「Interface 层 notifyDone() helper 保留」✓）。**无新 gap**。

#### OP-U02: 外部扩展程序化调用（pi.__workflowRun）
- Actor: coding-workflow gate
- Main Path: gate 调 `pi.__workflowRun(name,args,signal,timeoutMs)` → 返回 `{status:"done", reason, scriptResult?, error?, runId}` [VERIFIED: review-gate.ts:74, test-fix-loop.ts:74]
- AC-4 的 5 处引用点枚举完整（line 39/76/79/80/89 × 2 文件，实测 `grep -n "wfResult" review-gate.ts` 确认）。**无新 gap**。

#### OP-U03: 用户交互式查看（/workflows）
- D-9 移除 restart 快捷键不变。WorkflowsView 适配新 Engine 接口（Out of Scope）。**无新 gap**。

#### OP-U04: pause / resume / abort 操作
- G3-001 整个 RunRuntime 丢弃/重建语义保留（domain-models.md:209）。**无新 gap**。

#### OP-U05: retry-node / skip-node 操作
- G5-001 replaceRuntime 原子替换 + G6-001 前置 status==="running" 保留（domain-models.md:55/289）。**无新 gap**。

#### OP-U06: workflow-script generate / lint / save / delete / list
- WorkflowScript §7 的 validate()/toExecutable()/save()/delete() 方法保留。**无新 gap**。

### P2: Data Lifecycle（部分降级）

**降级理由**：本需求是架构重构（spec：「不是功能扩展，是架构重建」）。实体创建/读取/更新/删除的语义未变更，仅追踪边界。

- E01 WorkflowRun：runId 生成、transition/assign/release/replaceRuntime、terminal run 保留到 session 结束 — 不变。**无新 gap**。
- E02 WorkflowScript / Registry：tmp > project > user 优先级、60s TTL、invalidate() — 不变。**无新 gap**。
- E03 ApprovalPolicy：D-11/D-12 降为 Interface 层 helper 函数（`requiresConfirmation(script, approved)`），domain-models.md §12 删除线标记 ✓。**无新 gap**。
- E04 trace / callCache：D-10 单一来源（RunState.trace）、callCache 跨 runtime（RunState.calls Map，G3-001）— 不变。**无新 gap**。

### P3: API Contract

#### OP-A01: workflow tool（7 actions: run/status/pause/resume/abort/retry-node/skip-node）
- FR-5 收口不变。**无新 gap**。

#### OP-A02: workflow-script tool（5 actions: generate/lint/save/delete/list）
- FR-5 收口不变。**无新 gap**。

#### OP-A03: pi.__workflowRun
- D-8 签名 `{status:"done", reason: DoneReason, scriptResult?, error?, runId}` 不变。
- AC-4 同步改动 5 处 × 2 文件完整（实测 review-gate.ts line 39/76/79/80/89 引用点未变）。**无新 gap**。

#### OP-A04: /workflows command
- FR-6 仅保留 /workflows。**无新 gap**。

#### OP-A05: WorkflowScriptRegistry 接口
- G11-004 修复后：§8 标题「仓库接口」+ 层归属表「repository interface，不是 Ports 节的注入 port」+ Ports 节 3 个 port（AgentRunner/RunStore/WorkerHost）— 全部对齐（Part A4）。**无新 gap**。

#### OP-A06: D-12 砍掉内容清单一致性 — **发现 G12-001**

两个文档各自维护一份「D-12 砍掉内容」清单：

**清单 A：domain-models.md:318-323「砍掉的伪抽象（D-12）」**（Round 11 G11-003 修复后含 6 项）：
1. IWorkerHandle / IConcurrencyGate interface
2. ApprovalStore port + ApprovalPolicy class
3. **NotificationService class（降为 Interface 层 notifyDone helper）** ← Round 11 新加
4. AgentCall.execute() 上帝方法
5. Budget.onConsume 回调
6. 原四层 spec 的 Application 层 3 个 Service（RunLifecycleService/NodeOpsService/ErrorRecoveryService）

**清单 B：clarification.md:112 D-12 条目「具体砍掉」**（Round 11 未触及，仍 6 项）：
1. Domain 层整层 → 模型归 Engine
2. Application 层 3 个 Service → Engine free functions
3. IWorkerHandle/IConcurrencyGate interface → Infra 直接具体类
4. ApprovalPolicy class + ApprovalStore port → Interface 层 helper 函数
5. AgentCall.execute() 上帝方法 → Engine executeAgentCall() 函数
6. Budget.onConsume 回调 → 查询式 isSoftLimitReached()

**差异分析**：
- 清单 A 有 NotificationService（第 3 项），清单 B 没有
- 清单 B 有「Domain 层整层」（第 1 项），清单 A 没有（因 Domain 层是整层删除，非单个「伪抽象」，不列入「伪抽象」清单合理）
- NotificationService 不归清单 B 任何类别——既不是 Domain 层整层，也不在 Application 层 3 个 Service（明确列举 RunLifecycleService/NodeOpsService/ErrorRecoveryService，不含 NotificationService），也不是 IWorkerHandle/IConcurrencyGate/ApprovalPolicy/AgentCall.execute/Budget.onConsume 任一项

**NotificationService 在 clarification.md 完全无记录**（`grep -nE "NotificationService|notifyDone" clarification.md` 0 命中），而 domain-models.md 已将其登记为 D-12 砍掉项。两个都自称描述「D-12 砍掉内容」的清单在 NotificationService 上不对齐。

**这是 Round 11 G11-003 修复的尾巴**：主 agent 修 domain-models 清单（让 spec.md:41 notifyDone 不再术语悬空）时，未同步 clarification D-12 条目的对应清单。Round 11 G11-003 的 Source 标注为「spec.md:41 + domain-models.md 砍掉的伪抽象清单」，未覆盖 clarification D-12 条目位置。

→ **G12-001**

#### OP-A07: Interface 层 helper 函数（confirmTmp / notifyDone）
- G11-003 修复后：spec.md:40-41 ↔ domain-models.md:321（砍掉清单）↔ domain-models.md:267（隐式契约保留清单）三层对齐（Part A3）。**无新 gap**（G12-001 是 clarification D-12 条目未同步，非此层）。

### P4: State Machine

#### RunStatus: running / paused / done（reason: completed/failed/aborted/budget_limited/time_limited）

- 合法转换：(init)→running、running↔paused、running→done(reason)、paused→done(reason) — 不变。**无新 gap**。
- 僵尸状态：done 不可离开；state_lost 按 D-4 移出状态机（标 failed + error="state lost"）。**无新 gap**。
- runtime 生命周期不变式 `status==="running" ⟺ runtime!==undefined`：
  - assignRuntime（run/resume）/ releaseRuntime（pause/done，G3-001 整个丢弃）/ replaceRuntime（retryNode/worker-error-retry，G5-001 原子替换，G6-001 前置 running-only）— 全部保留（domain-models.md:49-55）。**无新 gap**。
- 不变式 `status==="done" ⟹ reason!==undefined` 与 AC-4 迁移目标一致。**无新 gap**。

### P5: Failure Path

#### 失败处理矩阵全覆盖

| 失败类型 | 重试上限 | 退避 | runtime 重建路径 | 状态 |
|---------|---------|------|----------------|------|
| Worker error/exit | 3 次 | 指数 1s/2s/4s | replaceRuntime（G5-001），重建前整个 RunRuntime 丢弃（G3-001）| ✓ |
| Script error | 3 次 | 指数 1s/2s/4s | retryCount 累加，超限转 failed | ✓ |
| Agent call 失败 | 3 次 | 指数 1s/2s/4s | 预算超限时不重试 | ✓ |
| Stale context | 0 次（不重试）| — | 命中 STALE_CONTEXT_PATTERNS 直接失败 | ✓ |
| Budget exceeded | 0 次 | — | 转 budget_limited 终态（Budget.isExceeded() 查询）| ✓ |
| Time exceeded | 0 次 | — | 转 time_limited 终态 | ✓ |

- Budget.onConsume 回调删除（D-12），改 isSoftLimitReached() 查询式（domain-models.md §4 line 107）。失败矩阵的 budget 路径不受影响。**无新 gap**。
- 其他路径：reentry 并发 / state_lost（D-4）/ kill -9 残留 / persistState 失败 / replaceRuntime 失败回滚 — 不变。**无新 gap**。

---

## Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G12-001 | F | API Contract | clarification.md:112 vs domain-models.md:318-323 | clarification.md D-12 条目的「具体砍掉」6 项清单（line 112）未含 NotificationService，而 domain-models.md「砍掉的伪抽象（D-12）」清单（line 318-323，6 项）已在 Round 11 G11-003 修复时加入 NotificationService（line 321）。两清单都自称描述「D-12 砍掉内容」，在 NotificationService 上不对齐。NotificationService 不归 clarification 清单任一类别（既非 Domain 层整层，也非 Application 层 3 个 Service 之一，也非 IWorkerHandle/IConcurrencyGate/ApprovalPolicy/AgentCall.execute/Budget.onConsume）。这是 Round 11 G11-003 修复的尾巴——主 agent 修 domain-models 清单让 spec.md:41 不再悬空，但漏了 clarification D-12 条目的对应清单。事实依据：`grep -nE "NotificationService" clarification.md` — 0 命中；`grep -nE "NotificationService" domain-models.md` — line 321 命中（砍掉清单）。 |

## 降级视角记录

| 视角 | 降级理由 | 依据 |
|------|---------|------|
| Data Lifecycle（部分） | 本需求是架构重构（spec：「不是功能扩展，是架构重建」）。WorkflowRun/WorkflowScript 的生命周期已在 domain-models 建模，实体 CRUD 语义未变更。仅追踪创建/删除边界 + 持久化路径。 | spec Background + Out of Scope；domain-models.md 模型关系图；clarification.md「待追踪 subagent 注意」节 |

## 验证依据

- `grep -nE "maxConcurrency|4→5|保持 4" spec.md clarification.md domain-models.md` — 7 处全部「保持 4」，clarification.md:23 加注「后修正：D-13 改为保持 4」（G11-001）
- `grep -nE "9 个领域模型|8 个核心|核心模型" clarification.md spec.md` — clarification.md:31「8 个」与 spec.md:30「8 个核心模型」一致（G11-002）
- `grep -nE "^## [0-9]+\." domain-models.md` — §1-§11 共 11 个活跃编号节
- `grep -nE "^## ~~12" domain-models.md` — §12 ApprovalPolicy 删除线标记
- `grep -nE "NotificationService|notifyDone|吞并" spec.md domain-models.md clarification.md` — spec.md:41 + domain-models.md:267/321 含，clarification.md 0 命中（G11-003 spec↔domain-models 已对齐；G12-001 clarification 未同步）
- `grep -nE "WorkflowScriptRegistry|保留 port|仓库|repository|注入 Port|Ports 节" domain-models.md spec.md` — 6 处描述 WorkflowScriptRegistry = repository interface（§8），3 Port = 注入 Port（Ports 节），全部对齐（G11-004）
- `grep -nE "3 个 port|AgentRunner|RunStore|WorkerHost" spec.md domain-models.md` — FR-4 / FR-1 注记 / Ports 节 / 层归属表 / FR-2 架构图全部「3 个 port」
- `grep -nE "src/domain/|src/application/|src/engine/|src/interface/|src/infra/" spec.md` — AC grep 路径全部 engine/ 或 interface/，无 domain/application 残留
- `grep -nE "assignRuntime|releaseRuntime|replaceRuntime|transition" domain-models.md` — WorkflowRun 4 操作保留
- `grep -nE "G3-001|G5-001|G6-001" domain-models.md` — 三个生命周期决策保留（line 55/194/198/209/279/286-289/304）
- `grep -nE "onConsume|softWarningSent|isSoftLimitReached" domain-models.md` — Budget 设计决策（D-12 删 onConsume/softWarningSent，改 isSoftLimitReached）保留
- `grep -n "wfResult\|status: string" extensions/coding-workflow/lib/gates/review-gate.ts` — 实测 line 39/76/79/80/89 引用点未变（AC-4 覆盖完整）
- `grep -nE "NotificationService" clarification.md` — 0 命中（G12-001 事实依据）
- `grep -rnE "class NotificationService" extensions/workflow/src/ extensions/coding-workflow/lib/` — 0 命中（NotificationService 非当前架构组件，仅 spec/plan 设想的被砍 class）

## 修复建议（供主 agent 参考，非强制）

- **G12-001**：两种修法选一：
  - **方案 A（推荐，同步加项）**：clarification.md:112 D-12 条目「具体砍掉」清单在 (4) ApprovalPolicy 之后或 (6) Budget.onConsume 之前补一项「NotificationService class → Interface 层 notifyDone() helper 函数」，与 domain-models.md 砍掉清单对齐。修改 1 处，成本低。
  - **方案 B（注明非穷举）**：clarification.md:112 清单末尾加注「（清单为代表性概括，完整伪抽象清单见 domain-models.md「砍掉的伪抽象」节）」，明确两清单的粒度差异。修改 1 处，成本低。
  - 推荐方案 A——两清单粒度相似（都 6 项），直接同步比对「Domain 层整层」更直观，且 NotificationService 是独立被砍的 class（不归任何类别），单独列更准确。

## 收敛状态

**未收敛**。1 个新 gap（G12-001），极低严重度（文档同步层，不影响架构设计正确性），是 Round 11 G11-003 修复的尾巴（主 agent 修 domain-models 清单时漏同步 clarification D-12 条目对应清单）。

**收敛历程**：
- Round 1: 28 gap（首次追踪，domain 建模层）
- Round 2: 2 gap（domain 零依赖层）
- Round 3: 1 gap（runtime 生命周期）
- Round 4: 1 gap（G3-001 遗漏）
- Round 5: 1 gap（replaceRuntime 语义）
- Round 6: 1 gap（retryNode 前置条件）
- Round 7: 0 gap（首次收敛）
- Round 8: 3 gap（修复反弹，文档/验证措辞）
- Round 9: 1 gap（AC-4 契约同步完整性）
- Round 10: 0 gap（二次收敛）
- Round 11: 4 gap（D-12/D-13 架构重写后的文档同步遗漏）
- Round 12: 1 gap（Round 11 G11-003 修复尾巴）

12 轮累计发现 43 gap。Round 12 的 1 个 gap 是 Round 11 G11-003 修复的不完整（只改 domain-models，漏 clarification D-12 条目），性质为「修复遗漏的同步位置」，非设计缺陷、非新视角。Round 11 的 4 个 gap 中 3 个（G11-001/002/004）完全收敛，G11-003 在 spec↔domain-models 层面收敛但 clarification 层面遗漏。建议主 agent 用方案 A 修复 G12-001（1 处编辑），Round 13 应能收敛。

**重要说明**：本轮 1 个 gap **不触及 D-12 三层架构或 D-13 maxConcurrency 决策本身的正确性**，也不触及 Round 11 的 4 个修复（Part A 验证全部通过）。三层架构在 spec/clarification/domain-models 三文档中的核心描述（FR-2 架构图、AC-1 grep、层归属表、模型层注释、Ports 计数、砍掉清单）全部内部一致。G12-001 只是 clarification D-12 条目的「具体砍掉」清单缺一项 NotificationService，修复成本极低。
