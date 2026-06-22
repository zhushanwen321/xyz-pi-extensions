# Tracing Round 9（收敛复核 — 验证 Round 8 后的 3 处修复）

## 追踪范围

- **spec/clarification/domain-models 版本**：含 Round 1-8 全部决策 + 主 agent 刚完成的 3 处修复（G8-001 clarification.md:75、G8-002 FR-1 注记、G8-003 AC-2 grep 1）
- **追踪的视角**（完整重跑，非增量）：
  - P1 User Journey — 适用（AI / 用户 / 外部扩展 三类 actor）
  - P2 Data Lifecycle — 部分降级（架构重构，非 CRUD；仅追踪实体创建/删除边界 + 持久化）
  - P3 API Contract — 适用（tool/action + pi.__workflowRun 是接口契约；本轮重点验证 AC-4 同步改动的完整性）
  - P4 State Machine — 强适用（状态机简化是核心需求 FR-3）
  - P5 Failure Path — 适用（worker retry / budget / agent retry / 持久化失败 / runtime 重建）

## 结论：**未收敛 — 1 个新 gap**

Round 8 的 3 处修复（G8-001 / G8-002 / G8-003）**全部正确落地**，事实正确性与文档一致性均验证通过（详见 Part A）。

但本轮独立重跑 API Contract 视角时，发现 AC-4 的「同步改动清单」描述不完整——这是前 8 轮从未检查过的新视角（前 8 轮关注 caller 数量计数 / 文档措辞 / grep 覆盖，未深入 gate caller 内部的 `status` 字段全部引用点）。

- **G9-001（F）**：AC-4 说「同步改 `status !== "completed"` → `reason !== "completed"`」，但每个 gate caller 实际有 **5 处** 引用 `wfResult.status`（类型签名 + 条件判断 + 诊断消息 + 2 处 details 字段），AC-4 只列了条件判断 1 处。其余 4 处若不同步改，会导致类型编译失败（部分被 AC-6 typecheck 兜底）和诊断消息退化（`status=done` 丢失失败原因，typecheck 抓不到）。

1 个 gap，中等严重度，集中在契约同步完整性层。既然有新 gap，按收敛判定规则不标 CONVERGED。

**Stagnation 评估：未触发。**
- Round 5: 1 gap
- Round 6: 1 gap
- Round 7: 0 gap
- Round 8: 3 gap（修复反弹，文档/验证措辞层）
- Round 9: 1 gap（新视角，AC-4 契约同步完整性）
- 序列 1 → 1 → 0 → 3 → 1。每轮发现不同性质的 gap（domain 建模 → 零依赖 → 生命周期 → runtime 重建 → 文档措辞 → 契约同步），非思维枯竭。Round 9 的 gap 是首次深入 gate caller 内部引用点，属新视角下的新发现。无需启动 Stagnation 保底。

---

## Part A：Round 8 的 3 处修复逐项验证

### 修复 G8-001：clarification.md:75「3 个」→「2 个」 — **通过**

**修复文本验证**（`grep -n "gate caller" clarification.md`）：
- Line 75 现为：`D-8: pi.__workflowRun 签名改为 ..., 同步改 2 个 gate caller（review-gate.ts / test-fix-loop.ts；gate.ts:32 仅注释不算）（用户选方案 C）` ✓

**与 spec.md 一致性**：
- spec.md:132「同步修改 2 个 gate caller 文件」✓
- spec.md:147「coding-workflow 的 2 个 gate caller 文件（review-gate.ts / test-fix-loop.ts）」✓
- spec.md:161「同步修改 2 个 gate caller」✓
- spec.md:196（D-8 决策行）「同步改 2 个 gate caller 文件（review-gate.ts / test-fix-loop.ts）」✓
- clarification.md:35「被 2 个外部 caller 使用」✓

**与代码事实一致性**（`grep -rn "__workflowRun\|workflowRun(" extensions/coding-workflow/`）：
- `review-gate.ts:74` — `await workflowRun(workflowName, args, ctx.signal, ReviewGate.WORKFLOW_TIMEOUT_MS)` — 实际调用 ✓
- `test-fix-loop.ts:74` — `await workflowRun(workflowName, args, ctx.signal, TestFixLoopGate.WORKFLOW_TIMEOUT_MS)` — 实际调用 ✓
- `gate.ts:32` — `/** Pi ExtensionAPI（用于 pi.__workflowRun / pi.__goalInit） */` — 仅注释 ✓
- 其余 `__workflowRun` 引用为类型守卫（`typeof api.__workflowRun === "function"`）、类型签名、README/CHANGELOG 文档，非实际调用。

**修复正确**。spec.md 4 处 + clarification.md 2 处（line 35 / line 75）全部统一为「2 个」，与代码事实（仅 review-gate.ts:74 + test-fix-loop.ts:74 实际调用）一致。✓

### 修复 G8-002：FR-1 注记改为「12 个编号类型 + 独立 Ports 节」 — **通过**

**修复文本验证**（spec.md:31）：
> 表格列出 9 个核心模型。domain-models.md 定义 12 个编号类型（§1-§12，含未上表的 RunSpec §2 / RunState §3 / ConcurrencyGate §11）+ 独立的 Ports 接口节。ConcurrencyGate 实现详见 FR-7。

**与 domain-models.md 实际结构一致性**（`grep -nE "^## " domain-models.md`）：

| § | 名称 | 在 FR-1 表格？ | 注记归因 |
|---|------|--------------|---------|
| 1 | WorkflowRun | ✓ | — |
| 2 | RunSpec | ✗ | 注记标注「未上表 §2」✓ |
| 3 | RunState | ✗ | 注记标注「未上表 §3」✓ |
| 4 | Budget | ✓ | — |
| 5 | AgentCall | ✓ | — |
| 6 | Trace | ✓ | — |
| 7 | WorkflowScript | ✓ | — |
| 8 | WorkflowScriptRegistry | ✓ | — |
| 9 | WorkerHandle | ✓ | — |
| 10 | RunRuntime | ✓ | — |
| 11 | ConcurrencyGate | ✗（注记指向 FR-7）| 注记标注「未上表 §11」✓ |
| 12 | ApprovalPolicy | ✓ | — |
| — | Ports（line 250）| 独立未编号节 | 注记标注「独立的 Ports 接口节」✓ |

- 计数「12 个编号类型」= §1-§12 ✓
- 排除项归因：§2 RunSpec / §3 RunState / §11 ConcurrencyGate 全部正确标注 ✓
- Ports 节定位：line 250，`## Ports（Domain 定义，Infra 实现）`，**未编号**，与注记「独立的 Ports 接口节」一致 ✓
- ConcurrencyGate（§11）既在 12 个编号内，又交叉引用 FR-7（实现细节），无矛盾 ✓

**修复正确**。计数（12）+ 归因（§2/§3/§11 未上表）+ Ports 定位（独立节）全部与 domain-models.md 实际结构吻合。✓

### 修复 G8-003：AC-2 grep 1 改为 `grep -rn "terminateDeps"` — **通过**

**修复文本验证**（spec.md:114）：
> 验证：`grep -rn "terminateDeps" extensions/workflow/src/` 无输出（覆盖 adapter / factory 函数定义 / bare 调用 / interface 声明 / 方法实现 / 调用点 全部形态）

**grep 覆盖能力验证**（实测 `grep -rn "terminateDeps" extensions/workflow/src/`，17 行匹配）：

| 形态 | 文件:行 | 匹配？ |
|------|--------|-------|
| adapter 定义 | orchestrator-budget.ts:29 `function terminateDepsFromBudget` | ✓ |
| adapter 定义 | error-handlers.ts:43 `function terminateDepsFromCtx` | ✓ |
| adapter 调用 | orchestrator-budget.ts:93, 133 | ✓ |
| adapter 调用 | error-handlers.ts:74, 113, 187 | ✓ |
| factory 函数定义 | worker-manager.ts:226 `export function terminateDeps(core: OrchestratorCore)` | ✓ |
| bare 调用 | orchestrator.ts:283 `return terminateDeps(this)` | ✓ |
| import | orchestrator.ts:50 `terminateDeps,` | ✓ |
| interface 声明 | core.ts:60 `terminateDeps(): TerminateDeps;` | ✓ |
| 方法实现 | orchestrator.ts:282 `terminateDeps() {` | ✓ |
| 调用点 | lifecycle.ts:178, 267, 391（`core.terminateDeps()`）| ✓ |
| 调用点 | worker-manager.ts:98, 272（`core.terminateDeps()`）| ✓ |

全部 6 种形态（adapter / factory 函数定义 / bare 调用 / interface 声明 / 方法实现 / 调用点）被覆盖。无约束子串匹配 `terminateDeps` 捕获所有 `terminateDeps*` 变体。**修复正确**。✓

---

## Part B：5 视角追踪（独立重跑，非增量）

### P1: User Journey

#### OP-U01: AI 启动 workflow（run action）
- Actor: AI agent
- Main Path: `workflow { action:"run" }` → fuzzy 匹配 + 确认 + 启动 → 后台执行 → completion notification 唤醒 [VERIFIED: tool-workflow-run.ts, index.ts]
- 强制检查项：成功下一步（notification）/ 中途放弃（signal abort）/ 重复（reentry-guard）/ 权限（RPC 降级）/ 超时（budgetTimeMs）全覆盖。
- 修复未触及用户路径行为。**无新 gap**。

#### OP-U02: 外部扩展程序化调用（pi.__workflowRun）
- Actor: coding-workflow gate
- Main Path: gate 调 `pi.__workflowRun(name,args,signal,timeoutMs)` → 返回 `{status:"done", reason, scriptResult?, error?, runId}` [VERIFIED: review-gate.ts:74, test-fix-loop.ts:74]
- 修复 G8-001 确认实际 caller 仅 2 个，文档已统一。
- **本轮深入检查 gate caller 内部 status 引用** → 发现 G9-001（详见 P3 OP-A03）。
- 其余路径（成功下一步 / 中途放弃 / 超时）不变。**仅 G9-001**。

#### OP-U03: 用户交互式查看（/workflows）
- 修复未触及 TUI 行为。D-9 移除 restart 快捷键不变。**无新 gap**。

#### OP-U04: pause / resume / abort 操作
- 修复未触及 lifecycle 前置条件。**无新 gap**。

#### OP-U05: retry-node / skip-node 操作
- retryNode 前置条件 `status==="running"` only（G6-001）不变。replaceRuntime 不变式（G5-001）不变。**无新 gap**。

#### OP-U06: workflow-script generate / lint / save / delete / list
- 修复未触及 script 操作。**无新 gap**。

### P2: Data Lifecycle（部分降级）

**降级理由**：本需求是架构重构（spec："不是功能扩展，是架构重建"）。实体创建/读取/更新/删除的语义未变更，仅追踪边界。

- E01 WorkflowRun：runId 生成、transition/assignRuntime/releaseRuntime/replaceRuntime、terminal run 保留到 session 结束 — 修复未触及。**无新 gap**。
- E02 WorkflowScript / Registry：tmp > project > user 优先级、60s TTL、invalidate() — 修复未触及。**无新 gap**。
- E03 ApprovalPolicy：持久化经 ApprovalStore port（G2-001）— 修复未触及。**无新 gap**。
- E04 trace / callCache：D-10 单一来源、callCache 跨 runtime（G3-001）— 修复未触及。**无新 gap**。

### P3: API Contract

#### OP-A01: workflow tool（7 actions）
- 修复未触及 tool schema。**无新 gap**。

#### OP-A02: workflow-script tool（5 actions）
- 修复未触及。**无新 gap**。

#### OP-A03: pi.__workflowRun — **发现 G9-001**

D-8 签名变更：`{status: "completed"|"failed"|...}` → `{status: "done", reason: DoneReason, ...}`。

**AC-4 同步改动清单完整性核对**（`grep -n "wfResult.status\|wfResult\.status" review-gate.ts test-fix-loop.ts`）：

每个 gate caller 有 **5 处** 引用 `wfResult.status`：

| # | 文件:行 | 代码 | AC-4 覆盖？ | 不同步改的后果 |
|---|--------|------|-----------|--------------|
| 1 | review-gate.ts:39 | `type WorkflowRunFn = ... Promise<{ status: string; ... }>` | ✗ | TypeScript：访问 `wfResult.reason` 报错（AC-6 typecheck 兜底） |
| 2 | review-gate.ts:76 | `if (wfResult.status !== "completed" \|\| wfResult.error)` | ✓ | 逻辑错误：新签名下 status 永远是 "done"，条件永真 |
| 3 | review-gate.ts:79 | `fixGuidance: ... failed (status=${wfResult.status}): ...` | ✗ | **诊断退化**：显示 `status=done`，丢失 failed/aborted/budget_limited/time_limited 区分 |
| 4 | review-gate.ts:80 | `details: { status: wfResult.status, ... }` | ✗ | **details 退化**：下游消费方（gate-reviewer）拿到 `status:"done"` 常量，无法判断失败类型 |
| 5 | review-gate.ts:89 | `details: { status: wfResult.status, ... }`（无 scriptResult 分支）| ✗ | 同 #4 |

test-fix-loop.ts 完全同构（line 39 类型签名 + 76 条件 + 79 诊断 + 80 details + 89 details），同样 5 处。

**AC-4 原文**（spec.md:148）：
> coding-workflow 的 2 个 gate caller 文件（review-gate.ts / test-fix-loop.ts）同步改：`status !== "completed"` → `reason !== "completed"`

AC-4 只列了 **#2（条件判断）** 1 处，遗漏了 **#1（类型签名）、#3（诊断消息）、#4/#5（details 字段）** 共 4 处 × 2 文件 = 8 处。

**后果分析**：
- #1 类型签名：会被 AC-6 typecheck 捕获（访问不存在的 `reason` 字段报错）—— 间接保护
- #3 诊断消息：`status=${wfResult.status}` 显示 `status=done`，typecheck 抓不到，用户体验退化（AI 收到的 fixGuidance 丢失失败原因）
- #4/#5 details：`status: "done"` 常量，typecheck 抓不到，下游 gate-reviewer 消费 details 时无法区分失败类型

→ **G9-001**

#### OP-A04: /workflows command
- 修复未触及。**无新 gap**。

### P4: State Machine

#### RunStatus: running / paused / done（reason: completed/failed/aborted/budget_limited/time_limited）

- 合法转换：`(init)→running`、`running↔paused`、`running→done(reason)`、`paused→done(reason)` — 修复未触及。**无新 gap**。
- 僵尸状态检查：done 不可离开；state_lost 按 D-4 移出状态机。**无新 gap**。
- runtime 生命周期：assignRuntime（run/resume）/ releaseRuntime（pause/done，G3-001 整个丢弃）/ replaceRuntime（retryNode/worker-error-retry，G5-001 原子替换，G6-001 前置 running-only）— 修复未触及。**无新 gap**。

### P5: Failure Path

#### 失败处理矩阵全覆盖

| 失败类型 | 重试上限 | 退避 | runtime 重建路径 | 状态 |
|---------|---------|------|----------------|------|
| Worker error/exit | 3 次 | 指数 1s/2s/4s | replaceRuntime（G5-001）| ✓ |
| Script error | 3 次 | 指数 1s/2s/4s | retryCount 累加，超限转 failed | ✓ |
| Agent call 失败 | 3 次 | 指数 1s/2s/4s | 预算超限时不重试 | ✓ |
| Stale context | 0 次 | — | 命中 STALE_CONTEXT_PATTERNS 直接失败 | ✓ |
| Budget exceeded | 0 次 | — | 转 budget_limited 终态 | ✓ |
| Time exceeded | 0 次 | — | 转 time_limited 终态 | ✓ |

- 其他路径：reentry 并发 / state_lost（D-4）/ kill -9 残留 / persistState 失败 / replaceRuntime 失败回滚 — 修复未触及。**无新 gap**。
- **与 G9-001 的关联**：gate caller 的诊断消息退化（#3）会影响失败可诊断性——当 workflow 因 budget_limited 终止时，AI 收到的 fixGuidance 只显示 `status=done` 而非 `reason=budget_limited`，无法区分「该加预算」vs「代码有 bug」。这强化了 G9-001 的严重度。

---

## Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G9-001 | F | API Contract | spec.md AC-4（line 148）+ review-gate.ts / test-fix-loop.ts | AC-4 的同步改动清单不完整。每个 gate caller 有 5 处引用 `wfResult.status`（类型签名 line 39 + 条件判断 line 76 + 诊断消息 line 79 + 2 处 details 字段 line 80/89），AC-4 只列了条件判断 1 处（`status !== "completed"` → `reason !== "completed"`），遗漏其余 4 处 × 2 文件 = 8 处。后果：(a) 类型签名不改会导致访问 `wfResult.reason` 时 TS 编译错误（AC-6 typecheck 兜底）；(b) 诊断消息 `status=${wfResult.status}` 会显示 `status=done`，丢失 failed/aborted/budget_limited/time_limited 的区分（typecheck 抓不到，用户/AI 诊断退化）；(c) details 字段 `status: wfResult.status` 退化为常量 `"done"`，下游 gate-reviewer 无法判断失败类型。事实依据：`grep -n "wfResult.status" review-gate.ts test-fix-loop.ts` 各返回 4 处（line 76/79/80/89），加上类型签名 line 39 共 5 处。 |

## 降级视角记录

| 视角 | 降级理由 | 依据 |
|------|---------|------|
| Data Lifecycle（部分） | 本需求是架构重构（spec："不是功能扩展，是架构重建"）。WorkflowRun/WorkflowScript 的生命周期已在 domain-models 建模，实体 CRUD 语义未变更。仅追踪创建/删除边界 + 持久化路径。 | spec Background + Out of Scope；domain-models.md 模型关系图；clarification.md「待追踪 subagent 注意」节 |

## 验证依据

- `grep -n "gate caller" clarification.md` — 确认 line 75 已改为「2 个」（G8-001 修复）
- `grep -rn "__workflowRun\|workflowRun(" extensions/coding-workflow/` — 确认实际 caller 仅 review-gate.ts:74 + test-fix-loop.ts:74（gate.ts:32 仅注释）
- `grep -nE "^## " domain-models.md` — 确认 12 个编号节 + 独立未编号 Ports 节（line 250）
- `grep -rn "terminateDeps" extensions/workflow/src/` — 确认 17 行匹配，覆盖全部 6 种形态（G8-003 修复）
- `grep -n "wfResult.status" extensions/coding-workflow/lib/gates/review-gate.ts extensions/coding-workflow/lib/gates/test-fix-loop.ts` — 各 4 处引用（line 76/79/80/89）
- `extensions/coding-workflow/lib/gates/review-gate.ts:33-39` — WorkflowRunFn 类型签名（`{ status: string; ... }`，无 reason）
- `extensions/coding-workflow/lib/gates/test-fix-loop.ts:33-39` — 同上
- `extensions/coding-workflow/lib/gates/review-gate.ts:74-89` — runViaWorkflow 实现（5 处 status 引用）
- `extensions/coding-workflow/lib/gates/test-fix-loop.ts:74-89` — 同上
- spec.md FR-1 注记（line 31）、AC-2 grep（line 114）、AC-4（line 148）、D-8 决策行（line 196）

## 修复建议（供主 agent 参考，非强制）

**G9-001**：AC-4 的同步改动描述应扩展为覆盖 `wfResult.status` 的全部引用点，而非仅条件判断。两种修法选一：

- **方案 A（最小措辞调整）**：AC-4 改为「coding-workflow 的 2 个 gate caller 文件（review-gate.ts / test-fix-loop.ts）同步改全部 `wfResult.status` 引用：条件判断 `status !== "completed"` → `reason !== "completed"`；类型签名加 `reason: DoneReason`；诊断消息 `status=${wfResult.status}` → `reason=${wfResult.reason}`；details 字段 `status: wfResult.status` → `reason: wfResult.reason`」
- **方案 B（信任实现者判断）**：AC-4 保持当前措辞，但加一句「类型签名和诊断消息中所有 `wfResult.status` 引用同步迁移到 `wfResult.reason`（保持失败原因可诊断）」

推荐方案 A（显式枚举，避免实现者遗漏诊断消息和 details 字段——这两处不被 typecheck 兜底，是最容易遗漏的语义退化点）。

## 收敛状态

**未收敛**。1 个新 gap（G9-001），中等严重度，集中在 AC-4 契约同步完整性层。不影响 D-8 决策本身的正确性（签名变更是对的），只是 AC-4 的验证清单描述不完整。建议主 agent 处理后进入 Round 10 收敛复核。

注：Round 8 的 3 处修复全部验证通过，本轮无回退、无反弹。新 gap 来自首次深入的 gate caller 内部引用点视角，属逐步深化的正常追踪过程。
