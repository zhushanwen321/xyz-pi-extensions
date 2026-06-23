# Tracing Round 13（收敛复核 — Round 12 G12-001 修复验证）

**状态：CONVERGED**

## 追踪范围

- **spec/clarification/domain-models 版本**：Round 12 报告 1 个 gap（G12-001：clarification.md:112 D-12 清单漏 NotificationService）后，主 agent 已修复——clarification.md:112「具体砍掉」清单补第 (7) 项「NotificationService class → Interface 层 notifyDone() helper 函数」。本轮验证修复正确性 + 完整重跑 5 视角确认无新矛盾。
- **追踪的视角**（完整重跑，非增量）：
  - P1 User Journey — 适用（AI / 用户 / 外部扩展 三类 actor）
  - P2 Data Lifecycle — 部分降级（架构重构，非 CRUD；仅追踪实体创建/删除边界 + 持久化）
  - P3 API Contract — 适用（tool/action + pi.__workflowRun + Interface helper + WorkflowScriptRegistry + D-12 砍掉清单一致性）
  - P4 State Machine — 强适用（状态机简化 + runtime 生命周期是核心需求）
  - P5 Failure Path — 适用（worker retry / budget / agent retry / 持久化失败 / runtime 重建）

## 结论：**收敛 — 0 个新 gap**

Round 12 报告的 G12-001 **完全解决**（详见 Part A3）：

- clarification.md:112 D-12 条目的「具体砍掉」清单现在 7 项，第 (7) 项明确登记 NotificationService class → Interface 层 notifyDone() helper 函数 ✓
- 与 domain-models.md:321「砍掉的伪抽象」清单第 3 项（NotificationService class 降为 Interface 层 notifyDone helper）对齐 ✓
- 与 spec.md:41 FR-2 架构图「notifyDone() ← 吞并 NotificationService」对齐 ✓
- 与 domain-models.md:267 隐式契约保留清单「Interface 层 notifyDone() helper 保留」对齐 ✓

**D-12 砍掉清单 7 项 + Ports 6→3 在三文档逐项核对全部对齐**（详见 Part B P3 OP-A06）：每一项（Domain 层整层 / Application 层 3 Service / IWorkerHandle+IConcurrencyGate / ApprovalPolicy+ApprovalStore / AgentCall.execute / Budget.onConsume / NotificationService）在 clarification.md:112 清单、domain-models.md 砍掉清单、spec.md 对应位置（FR-2 架构图 / FR-2 后论证 / D-12 决策表 / 各模型 §）都能找到一致描述。

**附带观察（非 gap）**：spec.md:57（FR-2 后「为什么不套四层 DDD」论证）和 spec.md:209（D-12 决策表理由列）是概括性论证而非穷举清单，仅举例 IWorkerHandle/IConcurrencyGate + ApprovalStore port + AgentCall.execute + Budget.onConsume 作为代表性伪抽象，未单独列 NotificationService 和 Application 层 3 Service。这是合理的概括差异——决策表理由列本就是概括，穷举清单在 clarification.md:112 + domain-models.md:318-323 两处已完整对齐。非新 gap（详见 Part B P3 OP-A06 附带观察）。

**Stagnation 评估：未触发。**
- Round 7: 0 → Round 8: 3 → Round 9: 1 → Round 10: 0 → Round 11: 4 → Round 12: 1 → Round 13: 0
- 序列从 Round 11 的 4 降到 Round 12 的 1 再到 Round 13 的 0（4 → 1 → 0），单调下降至收敛。Round 13 是第三次收敛（Round 7 / Round 10 / Round 13），无重复 gap，无思维枯竭信号。无需启动 Stagnation 保底。

---

## Part A：Round 12 修复逐项验证

### A1: G12-001（NotificationService 入 clarification D-12 清单）— **通过**

**修复内容**：clarification.md:112 D-12 条目「具体砍掉」清单从 6 项扩为 7 项，新增第 (7) 项：

> (7) NotificationService class → Interface 层 notifyDone() helper 函数

**修复后完整清单**（clarification.md:112）：
1. Domain 层整层 → 模型归 Engine
2. Application 层 3 个 Service → Engine free functions
3. IWorkerHandle/IConcurrencyGate interface → Infra 直接具体类
4. ApprovalPolicy class + ApprovalStore port → Interface 层 helper 函数
5. AgentCall.execute() 上帝方法 → Engine executeAgentCall() 函数
6. Budget.onConsume 回调 → 查询式 isSoftLimitReached()
7. **NotificationService class → Interface 层 notifyDone() helper 函数** ← Round 12 修复新增
8. （末尾）Ports 6→3（只留 AgentRunner/RunStore/WorkerHost）

**交叉一致性验证**（NotificationService 在三文档的描述）：

| 位置 | 内容 | 一致？ |
|------|------|-------|
| spec.md:41（FR-2 架构图 helper 函数） | `notifyDone() ← 吞并 NotificationService` | ✓ |
| clarification.md:112(7)（D-12 具体砍掉清单） | `NotificationService class → Interface 层 notifyDone() helper 函数` | ✓ Round 12 新加 |
| domain-models.md:267（隐式契约保留清单） | `Interface 层 notifyDone() helper 保留`（_render descriptor 归属） | ✓ |
| domain-models.md:321（砍掉的伪抽象清单） | `NotificationService class（降为 Interface 层 notifyDone helper）` | ✓ |

四处描述完全对齐：NotificationService class 被砍，降为 Interface 层 notifyDone() helper 函数，_render descriptor 由此 helper 保留。**G12-001 完全解决。**

事实依据：`grep -nE "NotificationService|notifyDone" spec.md clarification.md domain-models.md` — 4 处命中（spec.md:41 / clarification.md:112 / domain-models.md:267 / domain-models.md:321），全部描述一致。

---

## Part B：5 视角追踪（独立完整重跑，非增量）

### P1: User Journey

#### OP-U01: AI 启动 workflow（run action）
- Actor: AI agent
- Main Path: `workflow { action:"run" }` → fuzzy 匹配 + 确认 + 启动 → 后台执行 → notifyDone 唤醒 [VERIFIED: tool-workflow-run.ts]
- 强制检查项：成功下一步（notification）/ 中途放弃（signal abort）/ 重复（reentry-guard）/ 权限（RPC 降级）/ 超时（budgetTimeMs）全覆盖。
- Round 12 修复未触及用户路径行为。notifyDone 的 `_render` 协议保留（domain-models.md:267「Interface 层 notifyDone() helper 保留」✓）。**无新 gap**。

#### OP-U02: 外部扩展程序化调用（pi.__workflowRun）
- Actor: coding-workflow gate
- Main Path: gate 调 `pi.__workflowRun(name,args,signal,timeoutMs)` → 返回 `{status:"done", reason, scriptResult?, error?, runId}` [VERIFIED: review-gate.ts:74, test-fix-loop.ts:74]
- AC-4 的 5 处引用点枚举完整（line 39/76/79/80/89 × 2 文件）。**无新 gap**。

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
- AC-4 同步改动 5 处 × 2 文件完整。**无新 gap**。

#### OP-A04: /workflows command
- FR-6 仅保留 /workflows。**无新 gap**。

#### OP-A05: WorkflowScriptRegistry 接口
- G11-004 修复后（Round 11）：§8 标题「仓库接口」+ 层归属表「repository interface，不是 Ports 节的注入 port」+ Ports 节 3 个 port（AgentRunner/RunStore/WorkerHost）— 全部对齐。**无新 gap**。

#### OP-A06: D-12 砍掉内容清单一致性 — **G12-001 修复后完全对齐**

三文档各自维护 D-12 砍掉内容的描述，分两类：

**（a）两份明确穷举清单**（都带序号/项目符号，自称描述完整 D-12 砍掉内容）：

| # | clarification.md:112（7 项 + Ports 6→3） | domain-models.md:318-323（6 项） | 对齐？ |
|---|----------------------------------------|--------------------------------|-------|
| 整层删除 | (1) Domain 层整层 → 模型归 Engine | （不含，因整层删除不归「伪抽象」范畴，合理排除）| ✓ 合理差异 |
| Service 降级 | (2) Application 层 3 个 Service → Engine free functions | 第 6 项：原四层 spec 的 Application 层 3 个 Service（RunLifecycleService/NodeOpsService/ErrorRecoveryService）降为 Engine free function | ✓ |
| interface 双层 | (3) IWorkerHandle/IConcurrencyGate interface → Infra 直接具体类 | 第 1 项：IWorkerHandle / IConcurrencyGate interface（只有一个实现，不需多态）| ✓ |
| class + port → helper | (4) ApprovalPolicy class + ApprovalStore port → Interface 层 helper 函数 | 第 2 项：ApprovalStore port + ApprovalPolicy class（降为 Interface 层 helper）| ✓ |
| 上帝方法 | (5) AgentCall.execute() 上帝方法 → Engine executeAgentCall() 函数 | 第 4 项：AgentCall.execute() 上帝方法（提为 Engine free function executeAgentCall）| ✓ |
| 值对象回调 | (6) Budget.onConsume 回调 → 查询式 isSoftLimitReached() | 第 5 项：Budget.onConsume 回调（改查询式 isSoftLimitReached）| ✓ |
| class → helper | **(7) NotificationService class → Interface 层 notifyDone() helper 函数** | **第 3 项：NotificationService class（降为 Interface 层 notifyDone helper）** | ✓ **Round 12 G12-001 修复点** |
| Port 计数 | 末尾：Ports 6→3（只留 AgentRunner/RunStore/WorkerHost） | Ports 节：3 个 port（AgentRunner/RunStore/WorkerHost）+ line 257「其余 3 个原 port（ApprovalStore / IWorkerHandle / IConcurrencyGate）」| ✓ |

**两份清单在 NotificationService 上完全对齐**（Round 12 G12-001 已解决）。其余 6 项也一一对应，仅有的差异是 clarification 含「Domain 层整层」而 domain-models 不含——这是合理差异：domain-models 清单标题是「砍掉的伪抽象」，整层删除不归「伪抽象」范畴。

**（b）spec.md 的概括性描述**（3 处，非穷举清单，是论证/决策表理由）：

| 位置 | 性质 | 提及的砍掉项 | 覆盖度 |
|------|------|------------|--------|
| spec.md:41（FR-2 架构图 helper） | 具体项（非清单） | `notifyDone() ← 吞并 NotificationService` + `confirmTmp() ← 吞并 ApprovalPolicy (D-11)` | 2 个 helper 的直接归属 ✓ |
| spec.md:57（FR-2 后「为什么不套四层」论证） | 概括论证（举例） | IWorkerHandle/IConcurrencyGate 双层 interface + ApprovalStore port（作为伪抽象例子）| 代表性举例，非穷举 |
| spec.md:209（D-12 决策表理由列） | 概括描述（类别） | 砍空壳层 + 伪 port + 上帝对象方法（AgentCall.execute）+ 值对象副作用（Budget.onConsume）| 4 类概括，非穷举 |

spec.md:57 和 :209 是**概括性论证而非穷举清单**——spec.md:57 用「只有一个实现的 interface 是伪抽象」作为论证 IWorkerHandle/IConcurrencyGate/ApprovalStore 的例子；spec.md:209 用 4 个类别词组（空壳层/伪 port/上帝方法/副作用）概括 D-12 砍掉的主要类别。两处均未单独列 NotificationService 和 Application 层 3 Service，但这是合理的概括选择：
- 决策表理由列聚焦于「DDD 教条催生的伪抽象」类别（interface/port/上帝方法/值对象副作用）
- Application Service 和 NotificationService 是「为四层架构服务的 class」，与上述类别是不同维度的砍掉项
- 穷举清单在 clarification.md:112 + domain-models.md:318-323 已完整对齐，决策表理由列无需重复穷举

这与 Round 12 G12-001 性质不同：G12-001 是两份**明确清单**不对齐（一份带序号「(1)...(7)」、一份带项目符号，都自称完整）；spec.md:57/209 是概括论证，读者不会期望其列举所有项。**非新 gap**。

**附带观察**：若主 agent 追求极致一致性，可在 spec.md:209 D-12 决策表理由列末尾补「+ Application Service class + NotificationService class（→ Interface helper / Engine function）」。但这是优化（让决策表理由列与两份穷举清单 1:1 对应），非必需——决策表理由列的概括性质决定了它不必穷举。**不计为 gap**。

#### OP-A07: Interface 层 helper 函数（confirmTmp / notifyDone）
- G11-003 + G12-001 修复后：spec.md:40-41 ↔ clarification.md:112(4)(7) ↔ domain-models.md:267（隐式契约保留清单）↔ domain-models.md:320-321（砍掉清单）四层对齐。**无新 gap**。

### P4: State Machine

#### RunStatus: running / paused / done（reason: completed/failed/aborted/budget_limited/time_limited）

- 合法转换：(init)→running、running↔paused、running→done(reason)、paused→done(reason) — 不变。**无新 gap**。
- 僵尸状态：done 不可离开；state_lost 按 D-4 移出状态机（标 failed + error="state lost"）。**无新 gap**。
- runtime 生命周期不变式 `status==="running" ⟺ runtime!==undefined`：
  - assignRuntime（run/resume）/ releaseRuntime（pause/done，G3-001 整个丢弃）/ replaceRuntime（retryNode/worker-error-retry，G5-001 原子替换，G6-001 前置 running-only）— 全部保留（domain-models.md:49-55/194/198/209/279/286-289/304）。**无新 gap**。
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

（无）

本轮 0 个新 gap。

## 降级视角记录

| 视角 | 降级理由 | 依据 |
|------|---------|------|
| Data Lifecycle（部分） | 本需求是架构重构（spec：「不是功能扩展，是架构重建」）。WorkflowRun/WorkflowScript 的生命周期已在 domain-models 建模，实体 CRUD 语义未变更。仅追踪创建/删除边界 + 持久化路径。 | spec Background + Out of Scope；domain-models.md 模型关系图；clarification.md「待追踪 subagent 注意」节 |

## 验证依据

- `grep -nE "NotificationService|notifyDone" spec.md clarification.md domain-models.md` — 4 处命中（spec.md:41 / clarification.md:112 / domain-models.md:267 / domain-models.md:321），全部描述一致（G12-001 修复验证）
- `sed -n '108,120p' clarification.md` — D-12 条目「具体砍掉」清单现为 7 项，第 (7) 项 NotificationService 已加入
- `sed -n '318,325p' domain-models.md` — 砍掉的伪抽象清单 6 项，第 3 项 NotificationService 保留（Round 11 G11-003 加入）
- `grep -nE "maxConcurrency|4→5|保持 4" spec.md clarification.md domain-models.md` — 7 处全部「保持 4」，clarification.md:23 含「后修正：D-13 改为保持 4」加注
- `grep -nE "9 个领域模型|8 个核心|核心模型|11 个编号" spec.md clarification.md domain-models.md` — clarification.md:31「8 个」与 spec.md:30「8 个核心模型」一致
- `grep -nE "WorkflowScriptRegistry|仓库|repository|注入 Port|Ports 节" spec.md clarification.md domain-models.md` — WorkflowScriptRegistry = repository interface（§8），3 Port = 注入 Port（Ports 节），全部对齐
- `grep -nE "3 个 port|3 个 Port|3 Port|Ports 6→3|Ports 接口节" spec.md clarification.md domain-models.md` — FR-4 / FR-1 注记 / Ports 节 / 层归属表 / FR-2 架构图 / clarification D-12 末尾全部对齐
- `grep -nE "assignRuntime|releaseRuntime|replaceRuntime|G3-001|G5-001|G6-001" domain-models.md` — WorkflowRun 4 操作 + 三个生命周期决策保留（line 49/53/54/55/194/198/209/279/286-289/304）
- `grep -nE "RunStatus|DoneReason|running.*paused.*done|completed.*failed.*aborted" spec.md domain-models.md` — 状态机 3 态 + 5 reason 一致
- `grep -nE "onConsume|softWarningSent|isSoftLimitReached|isExceeded" domain-models.md spec.md` — Budget 设计决策（D-12 删 onConsume/softWarningSent，改 isSoftLimitReached）保留
- `grep -nE "src/domain/|src/application/" spec.md` — 0 匹配（exit code 1），AC grep 路径无 domain/application 残留
- `sed -n '38,44p' spec.md` — FR-2 架构图 Interface 层 helper 函数 confirmTmp/notifyDone 描述不变
- `sed -n '209p' spec.md` — D-12 决策表理由列概括性描述（砍空壳层 + 伪 port + 上帝方法 + 副作用），非穷举清单
- D-12 清单 7 项在三文档逐项核对（详见 Part B P3 OP-A06 表格）：clarification.md:112（7 项 + Ports 6→3）↔ domain-models.md:318-323（6 项）↔ spec.md 各模型 § + FR-2 架构图 + FR-2 后论证 + D-12 决策表 — 全部一一对应

## 收敛状态

**已收敛（CONVERGED）**。0 个新 gap。Round 12 的 G12-001 完全解决——clarification.md:112 D-12 清单补第 (7) 项 NotificationService 后，与 domain-models.md:321 砍掉清单、spec.md:41 FR-2 架构图、domain-models.md:267 隐式契约保留清单四处完全对齐。D-12 砍掉清单的 7 项（Domain 层整层 / Application 层 3 Service / IWorkerHandle+IConcurrencyGate / ApprovalPolicy+ApprovalStore / AgentCall.execute / Budget.onConsume / NotificationService）+ Ports 6→3 在三文档逐项核对全部一致。

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
- Round 13: 0 gap（三次收敛）

13 轮累计发现 43 gap。本轮是第三次收敛（Round 7 / 10 / 13），序列从 Round 11 的 4 单调下降至 Round 13 的 0（4 → 1 → 0），无重复 gap、无思维枯竭信号。

**重要说明**：本轮收敛**不触及 D-12 三层架构或 D-13 maxConcurrency 决策本身的正确性**（方向性决策由用户批准，追踪 subagent 只验证执行完整性）。三层架构在 spec/clarification/domain-models 三文档中的核心描述（FR-2 架构图、AC-1 grep、层归属表、模型层注释、Ports 计数、D-12 砍掉清单 7 项）全部内部一致。Phase 1 spec 已具备进入 Phase 2（plan）的条件。
