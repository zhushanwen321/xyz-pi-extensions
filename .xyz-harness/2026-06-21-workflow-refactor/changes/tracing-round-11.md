# Tracing Round 11（收敛复核 — D-12/D-13 架构重写后的完整性验证）

## 追踪范围

- **spec/clarification/domain-models 版本**：Round 10 CONVERGED 后，主 agent 从架构前提重新审视，与用户确认 D-12（四层→三层）+ D-13（maxConcurrency 保持 4）+ D-11 修正（ApprovalPolicy 直接删除）。三文档已同步重写。本轮验证重写正确性和内部一致性。
- **追踪的视角**（完整重跑，非增量）：
  - P1 User Journey — 适用（AI / 用户 / 外部扩展 三类 actor）
  - P2 Data Lifecycle — 部分降级（架构重构，非 CRUD；仅追踪实体创建/删除边界 + 持久化）
  - P3 API Contract — 适用（tool/action + pi.__workflowRun 是接口契约）
  - P4 State Machine — 强适用（状态机简化 + runtime 生命周期是核心需求）
  - P5 Failure Path — 适用（worker retry / budget / agent retry / 持久化失败 / runtime 重建）

## 结论：**未收敛 — 4 个新 gap（全部低严重度，文档同步层）**

D-12/D-13 架构重写的**核心设计正确、内部一致**——三层依赖方向、状态机简化、WorkflowRun 不变式（assign/release/replaceRuntime）、G3-001/G5-001/G6-001 生命周期决策、Ports 3 计数、AC-1/2/3/4 grep 路径调整、maxConcurrency 保持 4——全部验证通过（详见 Part A）。

但重写在三处**周边文档**留下 4 个低严重度不一致，均为 Round 8-10 未检查过的新视角：

- **G11-001（F）**：clarification.md line 23 残留「maxConcurrency 4→5」，与 D-13「保持 4」矛盾（同 G8-001 模式：历史决策记录未随后续决策同步）
- **G11-002（F）**：clarification.md line 31 残留「9 个领域模型」，与 spec FR-1「8 个核心模型」（D-11 删除 ApprovalPolicy）矛盾
- **G11-003（F）**：spec.md line 41「notifyDone() ← 吞并 NotificationService」，但 domain-models.md「砍掉的伪抽象」清单不含 NotificationService（只有 3 个 Application Service + 5 个其他伪抽象）
- **G11-004（D）**：domain-models.md 层归属表 line 315 称 WorkflowScriptRegistry「保留 port」，但 Ports 节 / FR-4 / spec FR-1 注记都说「3 个 port」（不含 WorkflowScriptRegistry）——术语不一致

4 个 gap 全部集中在文档同步/术语层，不影响架构设计、可测性、代码正确性。但既然有新 gap，按收敛判定规则不标 CONVERGED。

**Stagnation 评估：未触发。**
- Round 7: 0 → Round 8: 3 → Round 9: 1 → Round 10: 0 → Round 11: 4
- 序列在 Round 10 收敛后，Round 11 反弹到 4。这是**架构重写（D-12/D-13）引入的新一波文档不一致**，非思维枯竭。4 个 gap 全是首次发现（Round 8-10 未检查过这些位置），性质集中于「重写后的历史记录同步 / 交叉文档计数 / 术语对齐」。非同一 gap 的重复提出。无需启动 Stagnation 保底。

---

## Part A：架构重写正确性逐项验证

### A1: 三层架构内部一致性 — **通过**

**三处描述对齐检查**：

| 描述位置 | 内容 | 一致？ |
|---------|------|-------|
| spec.md FR-2（line 33-54） | Interface / Engine / Infrastructure 三层架构图 + free functions + Infra 具体类 | ✓ |
| spec.md AC-1（line 107-114） | 「三层依赖方向严格向下」「Engine 不依赖 Pi SDK 但可用 node 原生类型」「不再要求 Domain 零依赖教条（无 Domain 层）；不再要求 Application 层不 import Infra（无 Application 层）」 | ✓ |
| domain-models.md 开头（line 3） | 「模型作为数据结构 + 不变式守卫存在于 Engine 层（非独立 Domain 层，D-12）」 | ✓ |
| domain-models.md 层归属表（line 306-317） | WorkflowRun/RunSpec/.../WorkflowScript → Engine；RunRuntime → Engine；WorkerHandle/ConcurrencyGate → Infra；3 Port → Engine+Infra | ✓ |

**残留四层措辞扫描**（`grep -nE "四层|DDD|Domain 层|Application 层|domain 零依赖"`）：

全部命中均为**否定/论证语境**（「从四层改为三层」「为满足 Domain 零依赖教条造的伪抽象」「不再要求 Domain 零依赖」「原四层 spec 的 Application 层 3 个 Service」），**无残留的活态四层措辞**。三层方向清晰。✓

### A2: 删除的抽象无遗漏「实际使用」引用 — **通过（含 G11-003 待澄清）**

**旧名扫描**（`grep -nE "IWorkerHandle|IConcurrencyGate|WorkerHandleImpl|ConcurrencyGateImpl|ApprovalStore|ApprovalPolicy|onConsume|softWarningSent|AgentCall.execute|RunLifecycleService|NodeOpsService|ErrorRecoveryService"`）：

全部命中均在以下语境：
1. **D-12 删除论证**（spec.md D-12 决策行、clarification.md D-12 条目、domain-models.md「砍掉的伪抽象」清单）✓
2. **Round 1-6 历史决策记录**（clarification.md 的 Round-by-round 记录，记录当时的决策如 G2-001/G2-002，后由 D-12 取代）✓
3. **domain-models.md 各模型的「设计决策（D-12）」注释**（说明为什么删 interface/回调/上帝方法）✓

**无任何位置将这些旧名当作「当前架构的实际组件」使用**。✓

**唯一例外**（G11-003）：spec.md line 41 `notifyDone() ← 吞并 NotificationService`。NotificationService 在 domain-models.md「砍掉的伪抽象」清单中**缺席**（清单只有 RunLifecycleService/NodeOpsService/ErrorRecoveryService 三个 Application Service）。spec.md line 40 的 `confirmTmp() ← 吞并 ApprovalPolicy (D-11)` 有明确决策引用，line 41 的 notifyDone() 无决策引用且不在删除清单中 → 术语悬空。详见 Part B P3。

### A3: Ports 计数一致性 — **通过（含 G11-004 待澄清）**

| 位置 | 计数 | 列举 |
|------|------|------|
| spec.md FR-4（line 77-80） | 3 | AgentRunner / RunStore / WorkerHost ✓ |
| spec.md FR-1 注记（line 30） | 3 | 「Ports 接口节（3 个 port）」✓ |
| domain-models.md Ports 节（line 240） | 3 | AgentRunner / RunStore / WorkerHost ✓ |
| domain-models.md「为什么只留 3 个 port」（line 257） | 3 | AgentRunner / RunStore / WorkerHost ✓ |

**核心 3 port 计数全部一致**。✓

**但 WorkflowScriptRegistry 的「port」定性存在术语不一致**（G11-004）：层归属表 line 315 称其「保留 port」，但 Ports 节 / FR-4 / FR-1 注记的「3 port」均不含它。§8 标题称其为「仓库接口」。详见 Part B P3。

### A4: 模型计数一致性 — **通过**

| 项目 | spec 声明 | domain-models.md 实际 | 一致？ |
|------|----------|---------------------|-------|
| FR-1 表格模型数 | 8（line 30）| 表格列 8 行（WorkflowRun/AgentCall/Budget/Trace/WorkflowScript/WorkflowScriptRegistry/WorkerHandle/RunRuntime）| ✓ |
| 编号类型总数 | 11（§1-§11，line 30）| §1-§11 共 11 个活跃编号节 + §12 删除线 | ✓ |
| §12 状态 | spec FR-1 注记「ApprovalPolicy 删除」| `## ~~12. ApprovalPolicy~~（删除 —— D-11/D-12）` | ✓ |
| 未上表的 3 个 | spec 注记「RunSpec §2 / RunState §3 / ConcurrencyGate §11」| §2 RunSpec / §3 RunState / §11 ConcurrencyGate 确实未在 FR-1 表格 | ✓ |

计数全部吻合。✓

### A5: 不变式保留完整性 — **通过**

**WorkflowRun 操作**（domain-models.md §1）：
- `transition(target, reason?)` — 状态机转换 ✓
- `assignRuntime(rt)` — run/resume 绑定（前置 runtime===undefined）✓
- `releaseRuntime()` — pause/done 解绑 ✓
- `replaceRuntime(newRt)` — retryNode/worker-error-retry 原地替换（G5-001，前置 status==="running" G6-001）✓

**状态机**（spec FR-3 + domain-models §3）：
- 3 态：running / paused / done ✓
- 5 reason：completed / failed / aborted / budget_limited / time_limited ✓
- 合法转换：(init)→running、running↔paused、running→done(reason)、paused→done(reason) ✓

**生命周期决策**：
- G3-001（pause/resume 整个 RunRuntime 丢弃重建）— domain-models.md line 194/198/209/279 保留 ✓
- G5-001（replaceRuntime 原子替换）— domain-models.md line 55/288 保留 ✓
- G6-001（retryNode 前置 status==="running"）— domain-models.md line 55/289/304 保留 ✓

### A6: AC grep 路径调整 — **通过**

| AC | grep 命令 | 路径 | 正确？ |
|----|---------|------|-------|
| AC-1 #1 | `grep -rnE "from ['\"]@mariozechner" extensions/workflow/src/engine/` | engine/（非 domain/）✓ | 仅查 @mariozechner（不含 node:*，因 Engine 允许 node 原生类型）✓ |
| AC-1 #2 | `grep -rn "OrchestratorCore" extensions/workflow/src/` | src/（全扫）✓ | ✓ |
| AC-2 #1-4 | 各种 terminateDeps / Context / cleanupFlag | src/（全扫）✓ | ✓ |
| AC-3 #1 | `grep -rnE "\.worker\s*=|\.controller\s*=|\.gate\s*=" extensions/workflow/src/interface/` | interface/（非 engine/application/）✓ | ✓ |
| AC-3 #2 | `grep -rn "currentWorker\|exitedWorker" extensions/workflow/src/interface/` | interface/ ✓ | ✓ |
| AC-4 | `grep -rn "wfResult\.status\|status: string" extensions/coding-workflow/lib/gates/` | coding-workflow/lib/gates/ ✓ | 实测匹配 10 行（5 处 × 2 文件），post-refactor 应为 0 ✓ |

**无任何 AC grep 残留 domain/ 或 application/ 路径**（`grep -nE "src/domain/|src/application/" spec.md` 无输出）。✓

### A7: maxConcurrency 一致性 — **通过**

| 位置 | 值 | 一致？ |
|------|-----|-------|
| spec.md FR-7（line 100） | 保持 4（D-13）✓ | ✓ |
| spec.md FR-2 架构图（line 52） | 保持 maxConcurrency=4, D-13 ✓ | ✓ |
| spec.md D-3（line 200） | 保持 maxConcurrency=4 ✓ | ✓ |
| spec.md D-13（line 210） | 保持 4 不改为 5 ✓ | ✓ |
| domain-models.md §11（line 225） | 保持 4（D-13）✓ | ✓ |
| clarification.md D-13 条目（line 113） | 保持 4 不改为 5 ✓ | ✓ |
| clarification.md line 23 | **4→5** ❌ | G11-001 |

6 处正确，1 处残留（G11-001）。

### A8: AC-4 gate caller 引用点 — **通过（沿用 Round 10 验证）**

重新确认 gate caller 文件结构未变：
- review-gate.ts: line 39（类型签名）/ 76（条件）/ 79（诊断）/ 80（details #1）/ 89（details #2）✓
- test-fix-loop.ts: line 39 / 76 / 79 / 80 / 89 ✓
- 两文件完全同构，AC-4 枚举的 5 处 × 2 文件 = 10 处全部准确 ✓
- grep 命令实测匹配 10 行，覆盖完整 ✓

---

## Part B：5 视角追踪（独立完整重跑，非增量）

### P1: User Journey

#### OP-U01: AI 启动 workflow（run action）
- Actor: AI agent
- Main Path: `workflow { action:"run" }` → fuzzy 匹配 + 确认 + 启动 → 后台执行 → completion notification 唤醒 [VERIFIED: tool-workflow-run.ts, index.ts]
- 强制检查项：成功下一步（notification）/ 中途放弃（signal abort）/ 重复（reentry-guard）/ 权限（RPC 降级）/ 超时（budgetTimeMs）全覆盖。
- 架构重写未触及用户路径行为。**无新 gap**（completion notification 的 `_render` 协议保留在 domain-models.md line 267「Interface 层 notifyDone() helper 保留」✓）。

#### OP-U02: 外部扩展程序化调用（pi.__workflowRun）
- Actor: coding-workflow gate
- Main Path: gate 调 `pi.__workflowRun(name,args,signal,timeoutMs)` → 返回 `{status:"done", reason, scriptResult?, error?, runId}` [VERIFIED: review-gate.ts:74, test-fix-loop.ts:74]
- AC-4 的 5 处引用点枚举完整（Part A8）。
- 强制检查项：成功下一步 / 中途放弃 / 超时全覆盖。
- **无新 gap**。

#### OP-U03: 用户交互式查看（/workflows）
- D-9 移除 restart 快捷键不变。WorkflowsView 适配新 Engine 接口（Out of Scope：TUI 不重新设计）。**无新 gap**。

#### OP-U04: pause / resume / abort 操作
- G3-001 整个 RunRuntime 丢弃/重建语义保留（domain-models.md line 209）。**无新 gap**。

#### OP-U05: retry-node / skip-node 操作
- G5-001 replaceRuntime 原子替换 + G6-001 前置 status==="running" 保留（domain-models.md line 55/289）。**无新 gap**。

#### OP-U06: workflow-script generate / lint / save / delete / list
- WorkflowScript §7 的 validate()/toExecutable()/save()/delete() 方法保留。**无新 gap**。

### P2: Data Lifecycle（部分降级）

**降级理由**：本需求是架构重构（spec：「不是功能扩展，是架构重建」）。实体创建/读取/更新/删除的语义未变更，仅追踪边界。

- E01 WorkflowRun：runId 生成、transition/assign/release/replaceRuntime、terminal run 保留到 session 结束 — 不变。**无新 gap**。
- E02 WorkflowScript / Registry：tmp > project > user 优先级、60s TTL、invalidate() — 不变。**无新 gap**。
- E03 ApprovalPolicy：D-11/D-12 降为 Interface 层 helper 函数（`requiresConfirmation(script, approved)`），domain-models.md §12 删除线标记 ✓。session_start 从 entries 重建 Set，RPC 降级在 Interface 层 — 不变。**无新 gap**。
- E04 trace / callCache：D-10 单一来源（instance.trace，RunState.trace）、callCache 跨 runtime（G3-001，RunState.calls Map）— 不变。**无新 gap**。

### P3: API Contract

#### OP-A01: workflow tool（7 actions: run/status/pause/resume/abort/retry-node/skip-node）
- FR-5 收口不变。**无新 gap**。

#### OP-A02: workflow-script tool（5 actions: generate/lint/save/delete/list）
- FR-5 收口不变。**无新 gap**。

#### OP-A03: pi.__workflowRun
- D-8 签名 `{status:"done", reason: DoneReason, scriptResult?, error?, runId}` 不变。
- AC-4 同步改动 5 处 × 2 文件完整（Part A8）。
- **无新 gap**。

#### OP-A04: /workflows command
- FR-6 仅保留 /workflows。**无新 gap**。

#### OP-A05: WorkflowScriptRegistry 接口 — **发现 G11-004**

domain-models.md §8 定义 `interface WorkflowScriptRegistry`（Engine 定义，Infra 实现 WorkflowScriptRegistryImpl），标题称「仓库接口」。

层归属表 line 315 称其「保留 port」：
> | WorkflowScriptRegistry | Engine interface + Infra 实现 | 需 mock（文件扫描），保留 port |

但 Ports 节（line 240）标题为「Ports（3 个，Engine 定义，Infra 实现）」，只列 AgentRunner / RunStore / WorkerHost，**不含 WorkflowScriptRegistry**。spec FR-4 / FR-1 注记也都说「3 个 port」。

WorkflowScriptRegistry 结构上是 port（Engine interface + Infra impl + 需 mock），但被分类为「仓库接口」（§8 标题）并排除在 3 port 计数外。层归属表的「保留 port」措辞与 §8「仓库接口」+ Ports 节「3 个」存在术语不一致。

→ **G11-004**

#### OP-A06: Interface 层 helper 函数 — **发现 G11-003**

spec.md FR-2 架构图（line 39-42）：
```
└─ helper 函数 (非类):
    • confirmTmp()   ← 吞并 ApprovalPolicy (D-11)
    • notifyDone()   ← 吞并 NotificationService
```

confirmTmp() 有决策引用 (D-11)，ApprovalPolicy 在 domain-models.md「砍掉的伪抽象」清单中 ✓。

notifyDone() 无决策引用，NotificationService **不在**「砍掉的伪抽象」清单中。清单列举的伪抽象：
1. IWorkerHandle / IConcurrencyGate interface
2. ApprovalStore port + ApprovalPolicy class
3. AgentCall.execute() 上帝方法
4. Budget.onConsume 回调
5. 原四层 spec 的 Application 层 3 个 Service（RunLifecycleService/NodeOpsService/ErrorRecoveryService）

NotificationService 缺席。两种可能：
- (a) NotificationService 是上述 3 个 Application Service 之外的第 4 个 Service/class，应补入清单
- (b) 「吞并 NotificationService」是借喻（notifyDone 接手通知职责），NotificationService 从未正式建模

当前 Phase 1 三文档无法判断（Phase 2 plan.md / plan-w4-iface.md 有 `class NotificationService` 引用，但那是 Phase 2 产物，本轮不追溯）。spec.md line 41 与 domain-models.md 清单的不对齐是事实。

→ **G11-003**

### P4: State Machine

#### RunStatus: running / paused / done（reason: completed/failed/aborted/budget_limited/time_limited）

- 合法转换：(init)→running、running↔paused、running→done(reason)、paused→done(reason) — 不变。**无新 gap**。
- 僵尸状态：done 不可离开；state_lost 按 D-4 移出状态机（标 failed + error="state lost"）。**无新 gap**。
- runtime 生命周期不变式 `status==="running" ⟺ runtime!==undefined`：
  - assignRuntime（run/resume）/ releaseRuntime（pause/done，G3-001 整个丢弃）/ replaceRuntime（retryNode/worker-error-retry，G5-001 原子替换，G6-001 前置 running-only）— 全部保留（domain-models.md line 49-55）。**无新 gap**。
- 不变式 `status==="done" ⟹ reason!==undefined` 与 AC-4 迁移目标一致。**无新 gap**。

### P5: Failure Path

#### 失败处理矩阵全覆盖

| 失败类型 | 重试上限 | 退避 | runtime 重建路径 | 状态 |
|---------|---------|------|----------------|------|
| Worker error/exit | 3 次 | 指数 1s/2s/4s | replaceRuntime（G5-001），重建前整个 RunRuntime 丢弃（G3-001）| ✓ |
| Script error | 3 次 | 指数 1s/2s/4s | retryCount 累加，超限转 failed | ✓ |
| Agent call 失败 | 3 次 | 指数 1s/2s/4s | 预算超限时不重试 | ✓ |
| Stale context | 0 次 | — | 命中 STALE_CONTEXT_PATTERNS 直接失败 | ✓ |
| Budget exceeded | 0 次 | — | 转 budget_limited 终态（Budget.isExceeded() 查询）| ✓ |
| Time exceeded | 0 次 | — | 转 time_limited 终态 | ✓ |

- Budget.onConsume 回调删除（D-12），改 isSoftLimitReached() 查询式 — soft limit 通知由 Engine 在 consume() 后查询发出（domain-models.md §4 line 107）。失败矩阵的 budget 路径不受影响。**无新 gap**。
- 其他路径：reentry 并发 / state_lost（D-4）/ kill -9 残留（reconstruct 转 failed）/ persistState 失败 / replaceRuntime 失败回滚 — 不变。**无新 gap**。

---

## Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G11-001 | F | API Contract | clarification.md:23 | clarification.md「已确认的核心决策」节 line 23 仍写「重命名 + maxConcurrency 4→5」，与 D-13（line 113）「保持 4 不改为 5」矛盾。spec.md 4 处（FR-2/FR-7/D-3/D-13）和 domain-models.md §11 都已改为「保持 4」，仅 clarification.md line 23 漏改。同 G8-001 模式（历史决策记录未随后续决策同步）。事实依据：`grep -n "maxConcurrency\|4→5\|保持 4" clarification.md` — line 23「4→5」vs line 113「保持 4 不改为 5」。 |
| G11-002 | F | Data Lifecycle | clarification.md:31 | clarification.md「已确认的核心决策」节 line 31 仍写「9 个领域模型」，与 spec.md FR-1（line 30）「8 个核心模型（ApprovalPolicy 删除——降为 Interface 层 helper，见 D-11）」矛盾。D-11 删除 ApprovalPolicy 使 9→8，line 31 漏改。同 G8-001 模式。事实依据：`grep -n "9 个领域模型\|8 个核心" clarification.md spec.md` — clarification.md:31「9 个」vs spec.md:30「8 个」。 |
| G11-003 | F | API Contract | spec.md:41 + domain-models.md 砍掉的伪抽象清单 | spec.md FR-2 架构图 line 41「notifyDone() ← 吞并 NotificationService」，但 domain-models.md「砍掉的伪抽象（D-12）」清单（line 318-323）不含 NotificationService——只列 IWorkerHandle/IConcurrencyGate/ApprovalStore+ApprovalPolicy/AgentCall.execute/Budget.onConsume + 3 个 Application Service（RunLifecycleService/NodeOpsService/ErrorRecoveryService）。line 40 的 confirmTmp() 有 (D-11) 引用，line 41 的 notifyDone() 无决策引用且不在删除清单。后果：读者无法判断 NotificationService 是第 4 个被砍的 Service（清单遗漏）还是借喻（spec 措辞不严谨）。事实依据：`grep -nE "NotificationService" spec.md domain-models.md` — spec.md:41 唯一命中，domain-models.md 0 命中（砍掉清单中无）。 |
| G11-004 | D | API Contract | domain-models.md:315 vs Ports 节 / FR-4 / FR-1 注记 | domain-models.md 层归属表 line 315 称 WorkflowScriptRegistry「保留 port」，但：(1) Ports 节（line 240）标题「Ports（3 个）」只列 AgentRunner/RunStore/WorkerHost；(2) spec FR-4 说「3 个 port」；(3) spec FR-1 注记说「Ports 接口节（3 个 port）」；(4) §8 标题称 WorkflowScriptRegistry「仓库接口」。WorkflowScriptRegistry 结构上是 port（Engine interface + Infra impl + 需 mock），但被排除在 3 port 计数外。层归属表的「保留 port」与 §8「仓库接口」+ Ports 节「3 个」存在术语不一致。决策：是否澄清 WorkflowScriptRegistry 是「第 4 个 port」（应入 Ports 节，计数改 4）还是「仓库接口（非 port）」（层归属表措辞改「保留 interface」）？ |

## 降级视角记录

| 视角 | 降级理由 | 依据 |
|------|---------|------|
| Data Lifecycle（部分） | 本需求是架构重构（spec：「不是功能扩展，是架构重建」）。WorkflowRun/WorkflowScript 的生命周期已在 domain-models 建模，实体 CRUD 语义未变更。仅追踪创建/删除边界 + 持久化路径。 | spec Background + Out of Scope；domain-models.md 模型关系图；clarification.md「待追踪 subagent 注意」节 |

## 验证依据

- `grep -nE "四层|DDD|Domain 层|Application 层|domain 零依赖" spec.md clarification.md domain-models.md` — 确认全部命中为否定/论证语境，无活态四层残留
- `grep -nE "IWorkerHandle|IConcurrencyGate|WorkerHandleImpl|ConcurrencyGateImpl|ApprovalStore|ApprovalPolicy|onConsume|softWarningSent|AgentCall.execute|NotificationService|ErrorRecoveryService|RunLifecycleService|NodeOpsService" spec.md clarification.md domain-models.md` — 确认全部旧名仅在 D-12 删除论证 / Round 1-6 历史记录 / 模型设计决策注释中出现（G11-003 的 NotificationService 除外）
- `grep -nE "class NotificationService|class ApprovalPolicy|class ApprovalStore|IWorkerHandle|IConcurrencyGate" extensions/workflow/src/` — 确认这些类在现有源码中均不存在（0 匹配，除 AgentPool 待重命名）
- `grep -nE "^## [0-9]+\." domain-models.md` — 确认 §1-§11 共 11 个活跃编号节
- `grep -nE "^## ~~12" domain-models.md` — 确认 §12 ApprovalPolicy 删除线标记
- `grep -nE "maxConcurrency|4→5|保持 4" spec.md clarification.md domain-models.md` — maxConcurrency 全部位置（G11-001）
- `grep -nE "9 个领域模型|8 个核心" spec.md clarification.md` — 模型计数（G11-002）
- `grep -nE "NotificationService|notifyDone" spec.md domain-models.md` — NotificationService 分布（G11-003）
- `grep -nE "保留 port" domain-models.md` — WorkflowScriptRegistry 层归属表措辞（G11-004）
- `grep -nE "验证：.*grep" spec.md` — 确认全部 AC grep 命令（路径无 domain/application 残留）
- `grep -nE "src/domain/|src/application/" spec.md` — 0 匹配，确认 AC grep 路径已全部调整为 engine/interface/
- `grep -rn "wfResult\.status\|status: string" extensions/coding-workflow/lib/gates/` — 实测 10 行匹配（5 处 × 2 文件），AC-4 grep 覆盖完整
- `grep -n "wfResult\|status: string" extensions/coding-workflow/lib/gates/review-gate.ts extensions/coding-workflow/lib/gates/test-fix-loop.ts` — 确认 line 39/76/79/80/89 引用点未变
- `grep -nE "assignRuntime|releaseRuntime|replaceRuntime|transition" domain-models.md` — 确认 WorkflowRun 4 操作 + G3-001/G5-001/G6-001 生命周期决策保留
- `grep -nE "G3-001|G5-001|G6-001" domain-models.md spec.md` — 确认三个关键生命周期决策在重写中完整保留
- `grep -rnE "from ['\"]@mariozechner" extensions/workflow/src/engine/` — 当前 3 处违反（core.ts/agent-call-handler.ts/trace-commit.ts），post-refactor 应为 0

## 修复建议（供主 agent 参考，非强制）

- **G11-001**：clarification.md line 23 改为「重命名（maxConcurrency 保持 4，D-13）」或加注「（D-13 修正：保持 4，不改 5）」保留历史脉络。同 G8-001 修法。
- **G11-002**：clarification.md line 31 改为「8 个核心模型（D-11 删除 ApprovalPolicy，原 9 个）」或加注。同 G8-001 修法。
- **G11-003**：两种修法选一：
  - 方案 A（NotificationService 是被砍的第 4 个 Service）：domain-models.md「砍掉的伪抽象」清单补入「NotificationService class（降为 Interface 层 notifyDone() helper）」，spec.md line 41 加决策引用
  - 方案 B（借喻）：spec.md line 41 改为「notifyDone() ← 发送 completion notification」（去掉 NotificationService 专有名词），与 domain-models.md 隐式契约清单 line 267「Interface 层 notifyDone() helper 保留」对齐
  - 推荐方案 B（更简单，且 domain-models.md 已用 notifyDone() 作为正式名）
- **G11-004**：两种修法选一：
  - 方案 A（WorkflowScriptRegistry 是第 4 个 port）：Ports 节标题改「4 个」，补入 WorkflowScriptRegistry；FR-4 / FR-1 注记 / 层归属表同步改 4
  - 方案 B（WorkflowScriptRegistry 是仓库非 port）：层归属表 line 315「保留 port」改为「保留 interface（仓库模式）」或「Engine interface + Infra 实现」，去掉「port」字样避免与 3 port 计数混淆
  - 推荐方案 B（FR-4 的「3 port」已是稳定共识，改 1 处措辞比改 4 处计数简单；§8 标题「仓库接口」本就支持此定性）

## 收敛状态

**未收敛**。4 个新 gap（G11-001 / G11-002 / G11-003 / G11-004），全部低严重度，集中在文档同步/术语层，不影响架构设计正确性（Part A 验证三层架构、状态机、不变式、Ports 计数、AC grep 路径、maxConcurrency 全部通过）。

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

11 轮累计发现 42 gap。Round 11 的 4 gap 是 D-12/D-13 架构重写引入的新一波文档不一致（历史决策记录未同步 / 删除清单不全 / 术语不对齐），均非设计缺陷。建议主 agent 处理后进入 Round 12 收敛复核。4 个 gap 均有明确修复建议（每个 2 个方案），修复成本低。

**重要说明**：本轮 4 个 gap **均不触及 D-12 三层架构或 D-13 maxConcurrency 决策本身的正确性**。三层 vs 四层的方向性决策是用户批准的（D-12），maxConcurrency 保持 4 是合理的（D-13）。本报告只验证重写的**执行完整性**（周边文档是否同步），不质疑决策方向。三层架构在 spec/clarification/domain-models 三文档中的核心描述（FR-2 架构图、AC-1 grep、层归属表、模型层注释）全部内部一致。
