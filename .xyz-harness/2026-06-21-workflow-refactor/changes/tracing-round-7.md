# CONVERGED

# Tracing Round 7（收敛复核）

## 追踪范围

- **spec/clarification/domain-models 版本**：含 Round 1-6 全部决策（D-1 ~ D-11、G2-001/002、G3-001、G4-001、G5-001、G6-001）
- **追踪的视角**（完整重跑，非增量）：
  - P1 User Journey — 适用（AI / 用户 / 外部扩展 三类 actor）
  - P2 Data Lifecycle — 部分降级（架构重构，非 CRUD；仅追踪实体创建/删除边界 + 持久化）
  - P3 API Contract — 适用（tool/action + pi.__workflowRun 是接口契约）
  - P4 State Machine — 强适用（状态机简化是核心需求 FR-3）
  - P5 Failure Path — 适用（worker retry / budget / agent retry / 持久化失败 / runtime 重建）

## 结论

**收敛 — 0 个新 gap。**

Round 1-6 累计处理 28 + 2 + 1 + 1 + 1 + 1 = 34 个 gap，全部已在 domain-models.md 各节落地。本轮独立完整重跑 5 视角，未发现新 gap。

**Stagnation 评估：未触发。**
- Round 5: 1 gap (G5-001)
- Round 6: 1 gap (G6-001)
- Round 7: 0 gap（本轮，下降）
- 序列 1 → 1 → 0，第 7 轮出现下降，不满足"连续 3 轮不降"条件。无需启动 Stagnation 保底。

## 已追踪视角清单

| 视角 | 状态 | 核心验证点 |
|------|------|-----------|
| P1 User Journey | ✅ 全追踪 | OP-U01~06 六类操作（run / pi.__workflowRun / /workflows / pause-resume-abort / retry-skip / script-generate-lint-save-delete-list），强制检查项全覆盖 |
| P2 Data Lifecycle | ✅ 部分降级 | WorkflowRun / WorkflowScript / ApprovalPolicy / trace / callCache 生命周期边界 |
| P3 API Contract | ✅ 全追踪 | workflow tool（7 actions）+ workflow-script tool（5 actions）+ pi.__workflowRun（D-8）+ /workflows command |
| P4 State Machine | ✅ 全追踪 | 3 态 + doneReason，合法转换，replaceRuntime 不变式（G5-001/G6-001） |
| P5 Failure Path | ✅ 全追踪 | Worker/Script/Agent/Stale/Budget/Time 失败矩阵，runtime 重建路径，reentry-guard，state_lost |

## 追踪视角详情

### P1: User Journey

#### OP-U01: AI 启动 workflow（run action）
- Actor: AI agent
- Main Path: `workflow { action:"run" }` → fuzzy 匹配 + 确认 + 启动 → 后台执行 → completion notification 唤醒 [VERIFIED: tool-workflow-run.ts, index.ts:101]
- 强制检查项：
  - 成功下一步：completion notification → AI 处理 scriptResult ✓
  - 中途放弃：signal abort → `abortRun` ✓
  - 重复操作：reentry-guard（隐式契约保留清单登记 "2 tool 共享 → Interface 层"）✓
  - 权限：RPC 降级（非交互场景 sendUserMessage，留 Interface 层）✓
  - 超时：budgetTimeMs → scheduleTimeBudgetCheck → time_limited ✓
- 无新 gap。

#### OP-U02: 外部扩展程序化调用（pi.__workflowRun）
- Actor: coding-workflow gate
- Main Path: `pi.__workflowRun(name,args,signal,timeoutMs)` → 等待 → 返回 `{status:"done", reason, scriptResult, error, runId}` [VERIFIED: index.ts:103, D-8]
- 强制检查项：
  - 成功下一步：gate 消费 scriptResult 判断 pass/fail ✓
  - 中途放弃：signal → aborted（reason 字段）✓
  - 超时：timeoutMs → aborted + error message 区分 ✓
- 无新 gap。

#### OP-U03: 用户交互式查看（/workflows）
- Actor: 人类用户
- UC-3 已定义；spec Out of Scope "TUI 完全重新设计"，仅适配新 domain 接口。
- TUI 快捷键：pause/resume/abort 保留，restart 移除（D-9）。[VERIFIED: WorkflowsView.ts:538-541 当前有 "r restart"，spec D-9 删除]
- 无新 gap。

#### OP-U04: pause / resume / abort 操作
- Actor: AI agent / 用户
- Main Path：pre-flight check（tool-workflow.ts:182-198）→ orchestrator 委托 → A4 顺序（cleanup before status）[VERIFIED: lifecycle.ts pauseRun/resumeRun/abortRun]
- 强制检查项：
  - pause 前置：status==="running" only ✓
  - resume 前置：status==="paused" only ✓
  - abort 前置：running 或 paused ✓
- 无新 gap。

#### OP-U05: retry-node / skip-node 操作
- Actor: AI agent
- **retry-node**：
  - Main Path（running 状态）: 删除 callCache[callId] → 重置 trace node → `replaceRuntime` 重建 worker → worker 重跑 → 已完成调用从 cache replay
  - 前置条件：`status==="running"` only（G6-001）—— paused 下拒绝（要 retry 先 resume）
  - [VERIFIED: domain-models.md 第 1 节 replaceRuntime 前置条件 + 失败处理矩阵 "retryNode 前置条件：status==='running'"]
- **skip-node**：
  - Main Path：无状态检查，注入 placeholder 到 callCache + 重置 trace node → completed，不涉及 runtime 生命周期
  - paused 下 skip：仅设 cache，resume 时 worker replay cache 生效（不违反不变式，Round 6 已闭合）
  - done 下 skip：理论上可调用但语义无害（terminal run 的 cache 不会被消费），与现状行为一致
  - [VERIFIED: lifecycle.ts:318-350 skipRunNode 无 status guard + Round 6 分析]
- 强制检查项：
  - 重复操作：reentry-guard 覆盖（retry-node/skip-node 在 workflow tool 内部，共享 guard）✓
  - 权限：tool 层无特殊限制 ✓
- 无新 gap。

#### OP-U06: workflow-script generate / lint / save / delete / list
- Actor: AI agent
- generate：写 .tmp/ + SKILL.md 注入迁移到 "generate action 的 execute 内部"（G-010，隐式契约保留清单登记）[VERIFIED: index.ts:170-192 当前用 tool_call 事件钩子，迁移到 execute 内部是 spec 决策]
- lint：静态检查（合并 script-lint.ts）✓
- save：tmp → saved（rename，仅 project scope，workflow-files.ts 决策 2）✓
- delete：检查 `isRunning(name)` 防止删除在途脚本 ✓
- list：从 WorkflowScriptRegistry（tmp > project > user 优先级，60s TTL）✓
- 无新 gap。

### P2: Data Lifecycle（部分降级）

**降级理由**：本需求是架构重构（spec："不是功能扩展，是架构重建"）。WorkflowRun/WorkflowScript 的生命周期已在 domain-models 建模，实体创建/读取/更新/删除的语义未变更。仅追踪边界。

#### E01: WorkflowRun（聚合根）
- Create：run action，runId = `wf-<timestamp>-<base36>` [VERIFIED: lifecycle.ts:generateRunId]
- Update：transition / assignRuntime / releaseRuntime / replaceRuntime（G5-001）
- Delete：restart 已废弃（D-9）；terminal run 保留到 session 结束（现有行为）
- 无新 gap。

#### E02: WorkflowScript / E03: WorkflowScriptRegistry
- tmp > project > user 优先级，60s TTL，workspaceRoot 分桶 [VERIFIED: domain-models 第 8 节]
- 缓存失效：save/delete 调 `invalidate()` ✓
- 无新 gap。

#### E03': ApprovalPolicy（值对象）
- 持久化经 `ApprovalStore` port 解耦（G2-001），session_start 时 Application 调 `store.loadApproved()` 注入 Set ✓
- 无新 gap。

#### E04: trace / callCache
- trace 单一来源 = instance.trace（D-10，废弃 appendEntry workflow-trace 双写）[VERIFIED: execution-trace.ts 当前有双写，D-10 移除]
- callCache 在 RunState 里跨 runtime 存活（G3-001），worker 重跑时 replay ✓
- 无新 gap。

### P3: API Contract

#### OP-A01: workflow tool
- actions: run / status / pause / resume / abort / retry-node / skip-node（FR-5，不包含 restart）
- 错误处理：pre-flight reject invalid transitions（tool-workflow.ts 模式）✓
- 幂等性：retry-node 非幂等但 reentry-guard 防并发（非契约要求）✓
- 边界值：runId 缺失 → isError:true；未知 action → isError:true ✓
- 无新 gap。

#### OP-A02: workflow-script tool
- actions: generate / lint / save / delete / list（FR-5）✓
- 无新 gap。

#### OP-A03: pi.__workflowRun
- D-8 签名：`{status:"done", reason: DoneReason, scriptResult?, error?, runId}` ✓
- 同步改 3 个 gate caller（review-gate / test-fix-loop）：`status !== "completed"` → `reason !== "completed"` ✓
- 无新 gap。

#### OP-A04: /workflows command
- 仅保留 `/workflows`（FR-6），移除 `/workflow run|list|abort|save|delete` ✓
- 无新 gap。

### P4: State Machine

#### RunStatus: running / paused / done（reason: completed/failed/aborted/budget_limited/time_limited）

合法转换全部覆盖（spec FR-3 + domain-models）：
- `(init) → running`
- `running ↔ paused`
- `running → done(reason)`
- `paused → done(reason)`（仅 aborted）

**僵尸状态检查**：done 不可离开（终态）。state_lost 按 D-4 移出状态机（reconstruct 时标 failed + error="state lost"）。无僵尸状态。

**runtime 生命周期与状态机交互**：
- `assignRuntime`：run/resume 时绑定（前置：runtime===undefined）✓
- `releaseRuntime`：pause/done 时解绑（G3-001：整个 RunRuntime 丢弃）✓
- `replaceRuntime`：retryNode/worker-error-retry 原地替换（G5-001），前置条件 status==="running"（G6-001）✓

**worker-error-retry 退避延迟期间的不变式**（本轮重点验证）：
- 现状代码（error-handlers.ts:155-170）：`terminateWorker` → setTimeout(delay) → `recreateRunAbortController` + `startWorker`，全程 status 保持 running
- 新架构语义：WorkerHandle.terminate() 设 isCurrent=false 但 handle 对象保留（domain-models 第 9 节："terminate 后 isCurrent=false，旧 handle 的 exit 事件被忽略"）
- 退避延迟期间：runtime 仍存在（持 dead WorkerHandle），不变式 `status==="running" ⟺ runtime!==undefined` 保持
- 延迟结束后：创建新 WorkerHandle + 新 gate + 新 controller → `replaceRuntime` 原子替换
- [VERIFIED: domain-models 第 9 节 WorkerHandle 不变式 + 第 1 节 replaceRuntime 定义 + error-handlers.ts:155-170]
- 无新 gap。

### P5: Failure Path

#### 失败处理矩阵全覆盖

| 失败类型 | 重试上限 | 退避 | runtime 重建路径 | 状态 |
|---------|---------|------|----------------|------|
| Worker error/exit（非零） | 3 次 | 指数 1s/2s/4s | replaceRuntime（G5-001）| ✓ |
| Script error（type:"error"） | 3 次 | 指数 1s/2s/4s | retryCount 累加，超限转 failed | ✓ |
| Agent call 失败 | 3 次 | 指数 1s/2s/4s | 预算超限时不重试 | ✓ |
| Stale context | 0 次 | — | 命中 STALE_CONTEXT_PATTERNS 直接失败 | ✓ |
| Budget exceeded | 0 次 | — | 转 budget_limited 终态 | ✓ |
| Time exceeded | 0 次 | — | 转 time_limited 终态 | ✓ |

#### 其他失败路径
- **reentry 并发**：reentry-guard 防护 ✓
- **state_lost**：D-4 移出状态机，reconstruct 标 failed ✓
- **kill -9 残留 running**：reconstruct 时转 failed（隐式契约保留清单）✓
- **persistState 失败**：terminateInstance 的 await 冒泡（现状语义保留）✓
- **replaceRuntime 失败回滚**：若新 runtime 创建失败（Worker 构造抛错），replaceRuntime 不调用，旧 runtime 保留（dead worker），workflow 卡在 zombie 状态——属现状同等限制（startWorker 抛错后 worker=undefined），非新引入 gap
- 无新 gap。

## Gap 列表

无。

## 降级视角记录

| 视角 | 降级理由 | 依据 |
|------|---------|------|
| Data Lifecycle（部分） | 本需求是架构重构（spec："不是功能扩展，是架构重建"）。WorkflowRun/WorkflowScript 的生命周期已在 domain-models 建模，实体 CRUD 语义未变更。仅追踪创建/删除边界 + 持久化路径。 | spec Background + Out of Scope；domain-models.md 模型关系图 |

## 验证依据

- `extensions/workflow/src/engine/lifecycle.ts:271-315` —— retryRunNode 前置检查（G6-001 改为 running-only）
- `extensions/workflow/src/engine/lifecycle.ts:318-350` —— skipRunNode 无 status guard（Round 6 已分析）
- `extensions/workflow/src/engine/error-handlers.ts:155-170` —— handleScriptError 退避延迟路径（本轮验证不变式保持）
- `extensions/workflow/src/engine/worker-manager.ts:134-155` —— terminateWorker 清 worker handle
- `extensions/workflow/src/domain/state.ts` —— VALID_TRANSITIONS 现状 8 态（spec FR-3 简化为 3 态 + doneReason）
- `extensions/workflow/src/engine/terminate-instance.ts` —— TerminateOptions 4 个 boolean flag（spec AC-2 消除）
- `extensions/workflow/src/engine/core.ts` —— OrchestratorCore 5 个重叠 interface（spec FR-4 收敛为 3 port）
- `extensions/workflow/src/interface/tool-workflow.ts` —— 当前 workflow tool 仅 pause/resume/abort/status（spec FR-5 新增 retry-node/skip-node）
- `extensions/workflow/src/interface/views/WorkflowsView.ts:538-541` —— TUI 当前有 "r restart" 快捷键（spec D-9 移除）
- `extensions/workflow/src/index.ts:170-192` —— tool_call SKILL.md 注入（迁移到 generate execute 内部，G-010）
- `domain-models.md` 第 1/9/10 节 —— replaceRuntime + WorkerHandle.isCurrent + RunRuntime.release 语义

## 收敛确认

- 5 视角完整重跑，0 新 gap
- Stagnation 未触发（序列 1→1→0，第 7 轮下降）
- **CONVERGED**
