# Tracing Round 8（收敛复核 — 验证 Round 7 后的 5 处修复）

## 追踪范围

- **spec/clarification/domain-models 版本**：含 Round 1-7 全部决策 + 主 agent 刚完成的 5 处修复（D-8 caller 数量 3→2、AC-1/2/3 grep 命令、AC-2 措辞、FR-1 表格注记、FR-1 ApprovalPolicy 行）
- **追踪的视角**（完整重跑，非增量）：
  - P1 User Journey — 适用（AI / 用户 / 外部扩展 三类 actor）
  - P2 Data Lifecycle — 部分降级（架构重构，非 CRUD；仅追踪实体创建/删除边界 + 持久化）
  - P3 API Contract — 适用（tool/action + pi.__workflowRun 是接口契约，本轮重点验证 D-8 修复）
  - P4 State Machine — 强适用（状态机简化是核心需求 FR-3）
  - P5 Failure Path — 适用（worker retry / budget / agent retry / 持久化失败 / runtime 重建）

## 结论：**未收敛 — 3 个新 gap**

主 agent 的 5 处修复方向正确（均提升了 spec 的可验证性），但修复执行不彻底，引入了 3 处新不一致：

- **G8-001（F）**：clarification.md line 75 残留「3 个 gate caller」，与 spec.md 4 处和 clarification.md line 35 的「2 个」矛盾
- **G8-002（F）**：FR-1 表格注记的「12 个类型」分解与 domain-models.md 实际结构不符（Ports 是独立节、ConcurrencyGate 才是 §11）
- **G8-003（D）**：AC-2 grep `\.terminateDeps()` 只捕获 5 个调用点，遗漏 factory 方法定义和 bare function 调用（backup 覆盖存在但措辞误导）

3 个 gap 均为低-中严重度，集中在验证/可追溯层，不涉及设计本身。但既然有新 gap，按收敛判定规则不标 CONVERGED。

**Stagnation 评估：未触发。**
- Round 5: 1 gap
- Round 6: 1 gap
- Round 7: 0 gap（当时收敛）
- Round 8: 3 gap（本轮，修复后反弹）
- 序列 1 → 1 → 0 → 3，第 8 轮反弹是「修复引入新不一致」的典型模式，非思维枯竭。无需启动 Stagnation 保底。

---

## Part A：5 处修复的逐项验证

### 修复 1：D-8 caller 数量 3→2 — **部分通过（spec 全改，clarification 漏改一处）**

**代码事实验证**（`grep -rn "__workflowRun" extensions/`）：
- `review-gate.ts:74` — `await workflowRun(workflowName, args, ctx.signal, ReviewGate.WORKFLOW_TIMEOUT_MS)` — **实际调用** ✓
- `test-fix-loop.ts:74` — `await workflowRun(workflowName, args, ctx.signal, TestFixLoopGate.WORKFLOW_TIMEOUT_MS)` — **实际调用** ✓
- `gate.ts:32` — `/** Pi ExtensionAPI（用于 pi.__workflowRun / pi.__goalInit） */` — **仅注释**，不实际调用 ✓

确认：**只有 2 个实际 caller**。「2 个」是正确数字。

**spec.md 一致性**：4 处全部已改为「2 个」✓
- Line 132: "同步修改 2 个 gate caller 文件"
- Line 147: "coding-workflow 的 2 个 gate caller 文件（review-gate.ts / test-fix-loop.ts）"
- Line 161: "同步修改 2 个 gate caller"
- Line 196（D-8 决策行）: "同步改 2 个 gate caller 文件（review-gate.ts / test-fix-loop.ts）"

**clarification.md 一致性**：**❌ 漏改 line 75**
- Line 35: "被 2 个外部 caller 使用" ✓
- **Line 75（Round 1 历史决策记录）: "同步改 3 个 gate caller（用户选方案 C）" ❌ 仍为「3 个」**

→ **G8-001**

**附带发现**：`tracing-round-7.md:140`（收敛轮记录）也写「同步改 3 个 gate caller（review-gate / test-fix-loop）」—— 同行内自身矛盾（说 3 个但只列 2 个文件名）。属过程产物，非 normative 文档，未单列为 gap，但反映出 Round 7 当时未察觉此计数错误。

---

### 修复 2：AC-1/2/3 grep 验证命令 — **语法全部正确，AC-2 grep 1 覆盖不全**

逐条验证命令的 shell 转义和路径正确性：

**AC-1 grep 1**: `grep -rnE "from ['\"](@mariozechner|node:worker_threads|node:child_process)" extensions/workflow/src/domain/`
- shell 转义：双引号内 `['\"]` → `['"]`（`'` literal + `\"` 转义为 `"`），grep 解释为字符类匹配单/双引号 ✓
- `-E` 启用 ERE，`|` 分隔正常 ✓
- 路径 `extensions/workflow/src/domain/` 存在 ✓
- 实测：匹配 `domain/run-resources.ts:17: import type { Worker } from "node:worker_threads"`（现状违反，重构后应消失）✓
- **能正确检测声称的属性** ✓

**AC-1 grep 2**: `grep -rn "from ['\"].*infra/" extensions/workflow/src/application/`
- 路径 `application/` 当前不存在（重构后才有），但命令本身正确 ✓
- `.*infra/` 匹配 `../infra/` 和 `../infrastructure/`（兼容命名）✓
- **能正确检测声称的属性** ✓

**AC-1 grep 3** / **AC-2 grep 3**: `grep -rn "OrchestratorCore" extensions/workflow/src/`
- 简单字符串匹配，无 regex 陷阱 ✓
- 实测当前 29 处匹配（重构后应为 0）✓

**AC-2 grep 2**: `grep -rn "errorHandlerContext\|agentCallContext\|budgetCallbacks" extensions/workflow/src/`
- BRE + GNU `\|` 扩展，正常 ✓

**AC-2 grep 4**: `grep -rn "cleanupWorker\|keepController\|cleanupTempFiles\|deletePool" extensions/workflow/src/`
- 实测匹配 terminate-instance.ts / lifecycle.ts / orchestrator-budget.ts / worker-manager.ts / error-handlers.ts / core.ts 多处 ✓

**AC-2 grep 1**: `grep -rn "terminateDepsFrom\|\.terminateDeps()" extensions/workflow/src/` — **❌ 覆盖不全**
- `terminateDepsFrom` 匹配 2 个 adapter（terminateDepsFromBudget / terminateDepsFromCtx）✓
- `\.terminateDeps()` 匹配 5 个**调用点**（`core.terminateDeps()`）✓
- **遗漏**：
  - `worker-manager.ts:226`: `export function terminateDeps(core: OrchestratorCore): TerminateDeps {` — factory **函数定义**（无前导 `.`，参数非空 `()`）
  - `orchestrator.ts:283`: `return terminateDeps(this);` — bare function **调用**（无前导 `.`）
  - `core.ts:60`: `terminateDeps(): TerminateDeps;` — interface **方法声明**（无前导 `.`）
  - `orchestrator.ts:282`: `terminateDeps() {` — 方法**实现**（无前导 `.`）
- backup 覆盖：`grep -rn "OrchestratorCore"` 会间接捕获前两项（引用了 OrchestratorCore 类型）；interface 声明也在 OrchestratorCore 接口内。但 AC-2 措辞「`terminateDeps()` factory method 全部消失」由**单独一条 grep 验证**的承诺不成立。

→ **G8-003**

**AC-3 grep 1**: `grep -rnE "\.worker\s*=|\.controller\s*=|\.gate\s*=" extensions/workflow/src/engine/ extensions/workflow/src/application/`
- 实测匹配 4 处实际赋值（`run.worker = worker` / `run!.worker = undefined` 等）✓
- **潜在精度问题**（未列为 gap）：pattern `.worker\s*=` 也匹配 `===` 比较运算符。当前代码无此 false positive；post-refactor 若出现 `rt.worker === undefined` 比较会误报。属保守方向（可能 over-report，不会 under-report），可接受。

**AC-3 grep 3**: `grep -rn "currentWorker\|exitedWorker" extensions/workflow/src/engine/ extensions/workflow/src/application/`
- 实测匹配 error-handlers.ts:83,92,93 的竞态防护代码 ✓
- 注意：也匹配 `__tests__/error-handlers.test.ts` 的测试代码。AC-5 已要求旧测试全部重写，所以测试中的引用会随之消失，不构成问题。

---

### 修复 3：AC-2 改为「2 个 adapter + 1 个 factory method」 — **通过**

代码事实验证：
- **2 个 adapter** ✓：`terminateDepsFromBudget`（orchestrator-budget.ts:29）+ `terminateDepsFromCtx`（error-handlers.ts:43）
- **1 个 factory method** ✓：`OrchestratorCore.terminateDeps()`（core.ts:60 声明，orchestrator.ts:282 实现，worker-manager.ts:226 提供 standalone function）

措辞与代码现状一致。**通过**（但参见 G8-003：grep 覆盖不全）。

---

### 修复 4：FR-1 表格注记「12 个类型」 — **❌ 分解与 domain-models.md 不符**

domain-models.md 实际编号节（`grep -nE "^## [0-9]+\." domain-models.md`）：

| § | 名称 | 是否在 FR-1 表格 |
|---|------|-----------------|
| 1 | WorkflowRun | ✓ |
| 2 | **RunSpec** | ✗ |
| 3 | **RunState** | ✗ |
| 4 | Budget | ✓ |
| 5 | AgentCall | ✓ |
| 6 | Trace | ✓ |
| 7 | WorkflowScript | ✓ |
| 8 | WorkflowScriptRegistry | ✓ |
| 9 | WorkerHandle | ✓ |
| 10 | RunRuntime | ✓ |
| 11 | **ConcurrencyGate** | ✗（但 spec 说「详见 FR-7」）|
| 12 | ApprovalPolicy | ✓ |

另有独立 `## Ports（Domain 定义，Infra 实现）` 节（**未编号**，含 6 个 interface：AgentRunner / RunStore / WorkerHost / ApprovalStore / IWorkerHandle / IConcurrencyGate）。

**spec FR-1 注记原文**：
> 表格列出 9 个核心模型。完整的 12 个类型定义（含 RunSpec / RunState 值对象、Ports 接口）见 domain-models.md。ConcurrencyGate 详见 FR-7。

**不一致点**：
1. 注记说「12 个类型定义（含...Ports 接口）」—— 但 Ports 是**独立未编号节**，不在 §1-§12 之内。把它算入 12 与实际结构不符。
2. 注记说「ConcurrencyGate 详见 FR-7」—— 但 ConcurrencyGate **是 §11**，属于 12 个编号节之一。把它排除在 12 之外与实际结构不符。
3. 实际 12 = 9 表格 + RunSpec(§2) + RunState(§3) + ConcurrencyGate(§11)。Ports 是额外节。

**计数本身（12）巧合正确**（编号节数确实是 12），但括号内的分解错误，会误导读者去查 Ports 当作第 12 个类型。

→ **G8-002**

---

### 修复 5：FR-1 表格 ApprovalPolicy 改为「值对象（D-11 降级）」 — **通过**

对比：
- spec FR-1 表格：`| ApprovalPolicy | 值对象（D-11 降级） | 裸 Set + 散落条件分支 |`
- domain-models.md §12：`## 12. ApprovalPolicy（值对象，非 service —— D-11 降级）`

核心分类（「值对象」）和决策引用（「D-11 降级」）一致 ✓。domain-models 多了「非 service」澄清，是更详细版本，不构成矛盾。**通过**。

---

## Part B：5 视角追踪（确认除上述 3 gap 外无其他新 gap）

### P1: User Journey

#### OP-U01: AI 启动 workflow（run action）
- Actor: AI agent
- Main Path: `workflow { action:"run" }` → fuzzy 匹配 + 确认 + 启动 → 后台执行 → completion notification 唤醒 [VERIFIED: tool-workflow-run.ts, index.ts:101]
- 强制检查项：成功下一步（notification）/ 中途放弃（signal abort）/ 重复（reentry-guard）/ 权限（RPC 降级）/ 超时（budgetTimeMs）全覆盖。
- 修复未触及用户路径行为。**无新 gap**。

#### OP-U02: 外部扩展程序化调用（pi.__workflowRun）
- Actor: coding-workflow gate
- Main Path: gate 调 `pi.__workflowRun(name,args,signal,timeoutMs)` → 返回 `{status:"done", reason, scriptResult?, error?, runId}` [VERIFIED: review-gate.ts:74, test-fix-loop.ts:74]
- **本轮重点验证**：确认实际 caller 仅 2 个（review-gate / test-fix-loop），gate.ts:32 仅注释。D-8 签名与两个 caller 的消费模式（`status !== "completed"` → `reason !== "completed"`）一致。
- 强制检查项：成功下一步 / 中途放弃（signal→aborted）/ 超时（timeoutMs→aborted+error）全覆盖。
- 仅有的问题：clarification.md line 75 / tracing-round-7.md:140 的「3 个」残留（见 G8-001）。
- **无其他新 gap**。

#### OP-U03: 用户交互式查看（/workflows）
- 修复未触及 TUI 行为。D-9 移除 restart 快捷键的决策不变。**无新 gap**。

#### OP-U04: pause / resume / abort 操作
- 修复未触及 lifecycle 前置条件。pre-flight check 不变。**无新 gap**。

#### OP-U05: retry-node / skip-node 操作
- retryNode 前置条件 `status==="running"` only（G6-001）不变。replaceRuntime 不变式（G5-001）不变。**无新 gap**。

#### OP-U06: workflow-script generate / lint / save / delete / list
- 修复未触及 script 操作。**无新 gap**。

### P2: Data Lifecycle（部分降级）

**降级理由**：本需求是架构重构（spec："不是功能扩展，是架构重建"）。实体创建/读取/更新/删除的语义未变更，仅追踪边界。

- E01 WorkflowRun：runId 生成、transition/assignRuntime/releaseRuntime/replaceRuntime、terminal run 保留到 session 结束 — 修复未触及。**无新 gap**。
- E02 WorkflowScript / Registry：tmp > project > user 优先级、60s TTL、invalidate() — 修复未触及。**无新 gap**。
- E03 ApprovalPolicy：持久化经 ApprovalStore port（G2-001）— 修复仅改了 FR-1 表格的分类标签（「值对象（D-11 降级）」），与 §12 一致。**无新 gap**。
- E04 trace / callCache：D-10 单一来源、callCache 跨 runtime（G3-001）— 修复未触及。**无新 gap**。

### P3: API Contract

#### OP-A01: workflow tool（7 actions）
- 修复未触及 tool schema。**无新 gap**。

#### OP-A02: workflow-script tool（5 actions）
- 修复未触及。**无新 gap**。

#### OP-A03: pi.__workflowRun
- D-8 签名：`{status:"done", reason: DoneReason, scriptResult?, error?, runId}` ✓
- 同步改 2 个 gate caller（review-gate.ts / test-fix-loop.ts）：`status !== "completed"` → `reason !== "completed"` ✓
- **与 G8-001 相关**：文档侧残留「3 个」，但实际契约和代码事实是 2 个。契约本身无误。

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

---

## Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G8-001 | F | API Contract | clarification.md:75 | clarification.md 第 75 行（Round 1 历史决策记录）仍写「同步改 3 个 gate caller」，与 spec.md 4 处（line 132/147/161/196）和 clarification.md line 35 的「2 个」矛盾。代码事实验证：实际 caller 仅 2 个（review-gate.ts:74 / test-fix-loop.ts:74），gate.ts:32 仅注释。修复执行不彻底，line 75 漏改。 |
| G8-002 | F | Data Lifecycle | spec.md FR-1 注记 | FR-1 表格注记「完整的 12 个类型定义（含 RunSpec / RunState 值对象、Ports 接口）」的分解与 domain-models.md 实际结构不符：(1) Ports 是独立未编号节，不在 §1-§12 之内；(2) ConcurrencyGate 是 §11（属于 12 个编号节），但注记说「详见 FR-7」暗示排除在 12 之外。实际 12 = 9 表格模型 + RunSpec(§2) + RunState(§3) + ConcurrencyGate(§11)。计数「12」巧合正确但括号内归因错误，误导读者。 |
| G8-003 | D | API Contract | spec.md AC-2 grep 1 | AC-2 grep `terminateDepsFrom\|\.terminateDeps()` 只捕获 5 个 `.terminateDeps()` 调用点 + 2 个 `terminateDepsFrom*` adapter，遗漏：(a) `worker-manager.ts:226` 的 `export function terminateDeps(core: OrchestratorCore)` factory 函数定义；(b) `orchestrator.ts:283` 的 `terminateDeps(this)` bare 调用；(c) `core.ts:60` 的 interface 方法声明。AC-2 措辞「factory method 全部消失」由这一条 grep 验证的承诺不成立。backup：`grep OrchestratorCore` 间接覆盖 (a)(c)，TypeScript 编译会捕获孤儿引用。决策：是否收紧 grep 为 `terminateDeps`（去掉 `\.` 和 `()` 约束）以覆盖全部形态？ |

## 降级视角记录

| 视角 | 降级理由 | 依据 |
|------|---------|------|
| Data Lifecycle（部分） | 本需求是架构重构（spec："不是功能扩展，是架构重建"）。WorkflowRun/WorkflowScript 的生命周期已在 domain-models 建模，实体 CRUD 语义未变更。仅追踪创建/删除边界 + 持久化路径。 | spec Background + Out of Scope；domain-models.md 模型关系图；clarification.md「待追踪 subagent 注意」节 |

## 验证依据

- `grep -rn "__workflowRun" extensions/` — 确认实际 caller 仅 review-gate.ts:74 + test-fix-loop.ts:74（gate.ts:32 仅注释）
- `extensions/coding-workflow/lib/gates/review-gate.ts:160-168` — getWorkflowRun 返回函数引用，:74 实际调用
- `extensions/coding-workflow/lib/gates/test-fix-loop.ts:164-167` — 同上模式
- `grep -rn "terminateDeps" extensions/workflow/src/` — 确认 2 adapter + 5 调用点 + 1 factory 函数定义 + interface 声明 + bare 调用
- `extensions/workflow/src/engine/core.ts:25,60` — OrchestratorCore 接口 + terminateDeps() 声明
- `extensions/workflow/src/engine/worker-manager.ts:226` — `export function terminateDeps(core: OrchestratorCore)`
- `grep -nE "^## [0-9]+\." domain-models.md` — 确认 12 个编号节
- `grep -nE "^## " domain-models.md | grep -v "^[0-9]*:## [0-9]"` — 确认 Ports 是独立未编号节
- spec.md FR-1 注记（line 31）、AC-1/2/3 grep 命令、AC-4 签名、D-8 决策行
- clarification.md line 35（「2 个外部 caller」）vs line 75（「3 个 gate caller」）
- tracing-round-7.md:140（过程产物，同样残留「3 个」但仅列 2 个文件名）

## 修复建议（供主 agent 参考，非强制）

- **G8-001**：clarification.md line 75 的「3 个」改为「2 个」（或在括号中加注「后修正为 2 个，gate.ts:32 仅注释」保留历史脉络）
- **G8-002**：FR-1 注记改为「表格列出 9 个核心模型。domain-models.md 定义 12 个编号类型（§1-§12，含未上表的 RunSpec §2 / RunState §3 / ConcurrencyGate §11）+ 独立的 Ports 接口节。ConcurrencyGate 实现详见 FR-7。」
- **G8-003**：AC-2 grep 1 改为 `grep -rn "terminateDeps" extensions/workflow/src/`（去掉 `\.` 和 `()` 约束，覆盖全部形态）；或在 grep 后注明「配合 AC-2 OrchestratorCore grep 一起验证」

## 收敛状态

**未收敛**。3 个新 gap（G8-001 / G8-002 / G8-003），均为低-中严重度，集中在文档/验证措辞层，不影响设计正确性。建议主 agent 处理后进入 Round 9 收敛复核。
