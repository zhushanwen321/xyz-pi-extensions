# Tracing Round 10（收敛复核 — 验证 Round 9 G9-001 修复）

## 追踪范围

- **spec/clarification/domain-models 版本**：含 Round 1-9 全部决策 + 主 agent 刚完成的 G9-001 修复（AC-4 扩展为枚举 5 处 `wfResult.status` 引用 + 新增 grep 验证命令）
- **追踪的视角**（完整重跑，非增量）：
  - P1 User Journey — 适用（AI / 用户 / 外部扩展 三类 actor）
  - P2 Data Lifecycle — 部分降级（架构重构，非 CRUD；仅追踪实体创建/删除边界 + 持久化）
  - P3 API Contract — 适用（tool/action + pi.__workflowRun 是接口契约；本轮重点验证 G9-001 修复）
  - P4 State Machine — 强适用（状态机简化是核心需求 FR-3）
  - P5 Failure Path — 适用（worker retry / budget / agent retry / 持久化失败 / runtime 重建）

## 结论：**CONVERGED — 无新 gap**

G9-001 修复**完全落地、事实正确、grep 覆盖完整**（详见 Part A）。本轮独立完整重跑 5 视角，未发现新 gap。按收敛判定规则标注 CONVERGED。

**Stagnation 评估：未触发（且呈单调下降）。**
- Round 5: 1 gap
- Round 6: 1 gap
- Round 7: 0 gap
- Round 8: 3 gap（修复反弹，文档/验证措辞层）
- Round 9: 1 gap（新视角，AC-4 契约同步完整性）
- Round 10: 0 gap
- 序列 1 → 1 → 0 → 3 → 1 → 0。从 Round 8 起单调下降（3 → 1 → 0），每轮发现不同性质的 gap（文档措辞 → 契约同步 → 收敛），非思维枯竭。无需启动 Stagnation 保底。

---

## Part A：G9-001 修复逐项验证

### 修复内容回顾

AC-4（spec.md line 147-152）从「只列条件判断 1 处」扩展为：

```
- coding-workflow 的 2 个 gate caller 文件（review-gate.ts / test-fix-loop.ts）同步改
  **全部 `wfResult.status` 引用**（每个文件 5 处，避免诊断/details 语义退化）：
  - 类型签名（line ~39）：`{ status: string; ... }` → `{ status: "done"; reason: DoneReason; ... }`
  - 条件判断（line ~76）：`status !== "completed"` → `reason !== "completed"`
  - 诊断消息（line ~79）：`status=${wfResult.status}` → `reason=${wfResult.reason}`（...）
  - details 字段（line ~80, ~89）：`status: wfResult.status` → `reason: wfResult.reason`（...）
  - 验证：`grep -rn "wfResult\.status\|status: string" extensions/coding-workflow/lib/gates/` 无输出
```

### 验证 1：5 处引用是否与代码事实一致 — **通过**

`grep -n "wfResult" extensions/coding-workflow/lib/gates/{review-gate,test-fix-loop}.ts` 实测：

| # | AC-4 描述 | AC-4 行号 | review-gate 实际 | test-fix-loop 实际 | 代码内容 |
|---|----------|----------|-----------------|-------------------|---------|
| 1 | 类型签名 | line ~39 | line 39 ✓ | line 39 ✓ | `) => Promise<{ status: string; scriptResult?: unknown; error?: string; runId: string }>;` |
| 2 | 条件判断 | line ~76 | line 76 ✓ | line 76 ✓ | `if (wfResult.status !== "completed" \|\| wfResult.error) {` |
| 3 | 诊断消息 | line ~79 | line 79 ✓ | line 79 ✓ | `fixGuidance: \`... failed (status=${wfResult.status}): ...\`` |
| 4 | details #1 | line ~80 | line 80 ✓ | line 80 ✓ | `details: { status: wfResult.status, runId: wfResult.runId, source: "workflow" },` |
| 5 | details #2 | line ~89 | line 89 ✓ | line 89 ✓ | `details: { status: wfResult.status, source: "workflow" },` |

- **每个 gate caller 确实 5 处** `wfResult.status` 引用 ✓
- **行号全部准确**（无偏差）✓
- **两个文件结构完全同构**（line 39/76/79/80/89 一一对应）✓

### 验证 2：迁移目标（status→reason）是否正确 — **通过**

| # | 现状（status 语义） | 迁移后（reason 语义） | 与 D-8 签名一致？ |
|---|-------------------|---------------------|------------------|
| 1 | `{ status: string; ... }` | `{ status: "done"; reason: DoneReason; ... }` | ✓ 与 spec.md AC-4 签名（line 135-145）完全一致 |
| 2 | `status !== "completed"` | `reason !== "completed"` | ✓ reason 取值集含 "completed"，语义保留 |
| 3 | `status=${wfResult.status}` | `reason=${wfResult.reason}` | ✓ 诊断消息显示 failed/aborted/budget_limited/time_limited 之一，不再退化为 "done" |
| 4-5 | `status: wfResult.status` | `reason: wfResult.reason` | ✓ 下游 gate-reviewer 消费 details.reason 能区分失败类型 |

- 所有迁移目标与 D-8 签名（`{status:"done", reason: DoneReason, scriptResult?, error?, runId}`）一致 ✓
- DoneReason 枚举（completed/failed/aborted/budget_limited/time_limited）覆盖现有所有失败类型 ✓

### 验证 3：grep 命令覆盖能力 — **通过**

**AC-4 grep 命令**（spec.md line 152）：
```
grep -rn "wfResult\.status\|status: string" extensions/coding-workflow/lib/gates/
```

**实测覆盖**（`grep -rn "wfResult\.status\|status: string" extensions/coding-workflow/lib/gates/`）：

| 形态 | review-gate 行 | test-fix-loop 行 | grep 命中？ |
|------|---------------|-----------------|-----------|
| 类型签名 `status: string` | 39 | 39 | ✓（由 `status: string` 子串匹配）|
| 条件 `wfResult.status !==` | 76 | 76 | ✓（由 `wfResult\.status` 匹配）|
| 诊断 `${wfResult.status}` | 79 | 79 | ✓ |
| details #1 `status: wfResult.status` | 80 | 80 | ✓ |
| details #2 `status: wfResult.status` | 89 | 89 | ✓ |

**总计 10 行匹配 = 5 处 × 2 文件**，无遗漏。

**广扫确认无其他形态**（`grep -rn "\.status\b\|wfResult" extensions/coding-workflow/lib/gates/` 排除 __tests__）：
- 所有 `.status` 引用都是 `wfResult.status`（无其他变量名）✓
- `wfResult.scriptResult`（line 84）是 scriptResult 字段，不是 status，无需迁移 ✓
- `WorkflowReviewResult`（review-gate.ts:20-24）和 `WorkflowTestFixResult`（test-fix-loop.ts:19-23）是 **scriptResult 的内层类型**（含 `passed`/`rounds`/`core.passed`），不含 status 字段，无需迁移 ✓

**grep 覆盖完整，无遗漏形态。** ✓

### 修复结论

G9-001 **完全解决**：
- AC-4 现枚举 5 处引用 × 2 文件 = 10 处，与代码事实精确一致 ✓
- 行号准确（无偏差）✓
- 迁移目标正确（与 D-8 签名一致）✓
- grep 验证命令覆盖全部 5 处引用形态 ✓
- 无遗漏的 status 消费点（其他 wfResult.* 字段和内层 scriptResult 类型都不含 status）✓

---

## Part B：5 视角追踪（独立完整重跑，非增量）

### P1: User Journey

#### OP-U01: AI 启动 workflow（run action）
- Actor: AI agent
- Main Path: `workflow { action:"run" }` → fuzzy 匹配 + 确认 + 启动 → 后台执行 → completion notification 唤醒 [VERIFIED: tool-workflow-run.ts, index.ts]
- 强制检查项：成功下一步（notification）/ 中途放弃（signal abort）/ 重复（reentry-guard）/ 权限（RPC 降级）/ 超时（budgetTimeMs）全覆盖。
- 修复未触及用户路径行为。**无新 gap**。

#### OP-U02: 外部扩展程序化调用（pi.__workflowRun）
- Actor: coding-workflow gate
- Main Path: gate 调 `pi.__workflowRun(name,args,signal,timeoutMs)` → 返回 `{status:"done", reason, scriptResult?, error?, runId}` [VERIFIED: review-gate.ts:74, test-fix-loop.ts:74]
- AC-4 现完整列出 5 处 `wfResult.status` 引用的同步改动。**G9-001 已解决**。
- 强制检查项：成功下一步（消费 scriptResult）/ 中途放弃（signal→aborted）/ 超时（timeoutMs→aborted+error）全覆盖。
- **无新 gap**。

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

#### OP-A03: pi.__workflowRun — **G9-001 已解决**

D-8 签名变更：`{status: "completed"|"failed"|...}` → `{status: "done", reason: DoneReason, ...}`。

**AC-4 同步改动清单完整性核对** — 参见 Part A 验证 1-3：
- 5 处引用 × 2 文件 = 10 处全部列出 ✓
- 行号准确（39/76/79/80/89）✓
- 迁移目标正确（status→reason）✓
- grep 覆盖完整（10 行匹配，无遗漏形态）✓

**无新 gap**。

#### OP-A04: /workflows command
- 修复未触及。**无新 gap**。

### P4: State Machine

#### RunStatus: running / paused / done（reason: completed/failed/aborted/budget_limited/time_limited）

- 合法转换：`(init)→running`、`running↔paused`、`running→done(reason)`、`paused→done(reason)` — 修复未触及。**无新 gap**。
- 僵尸状态检查：done 不可离开；state_lost 按 D-4 移出状态机。**无新 gap**。
- runtime 生命周期：assignRuntime（run/resume）/ releaseRuntime（pause/done，G3-001 整个丢弃）/ replaceRuntime（retryNode/worker-error-retry，G5-001 原子替换，G6-001 前置 running-only）— 修复未触及。**无新 gap**。
- reason 字段与 done 状态的蕴含关系（`status === "done" ⟹ reason !== undefined`）与 AC-4 迁移目标一致。**无新 gap**。

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
- **与 G9-001 修复的关联**：AC-4 现要求诊断消息和 details 字段都迁移到 `wfResult.reason`，使失败可诊断性完整保留——workflow 因 budget_limited/time_limited 终止时，AI 收到的 fixGuidance 和下游 gate-reviewer 都能精确区分失败类型，不会退化为 `status=done` 常量。修复强化了失败矩阵的可观测性。

---

## Gap 列表

无新 gap。G9-001 已在 Part A 验证完全解决。

## 降级视角记录

| 视角 | 降级理由 | 依据 |
|------|---------|------|
| Data Lifecycle（部分） | 本需求是架构重构（spec："不是功能扩展，是架构重建"）。WorkflowRun/WorkflowScript 的生命周期已在 domain-models 建模，实体 CRUD 语义未变更。仅追踪创建/删除边界 + 持久化路径。 | spec Background + Out of Scope；domain-models.md 模型关系图；clarification.md「待追踪 subagent 注意」节 |

## 验证依据

- `grep -n "wfResult\|AC-4\|gate caller\|reason:" spec.md` — 确认 AC-4 line 147-152 枚举 5 处引用 + grep 验证命令
- `grep -n "wfResult" extensions/coding-workflow/lib/gates/review-gate.ts extensions/coding-workflow/lib/gates/test-fix-loop.ts` — 确认各 5 处引用（line 76/79/80/89 + 类型签名 line 39）
- `review-gate.ts:33-39` / `test-fix-loop.ts:33-39` — WorkflowRunFn 类型签名 `{ status: string; ... }`，line 39 准确
- `grep -rn "wfResult\.status\|status: string" extensions/coding-workflow/lib/gates/` — 实测 10 行匹配 = 5 处 × 2 文件，grep 覆盖完整
- `grep -rn "\.status\b\|wfResult" extensions/coding-workflow/lib/gates/` — 广扫确认无其他 status 引用形态
- `review-gate.ts:20-24` / `test-fix-loop.ts:19-23` — WorkflowReviewResult / WorkflowTestFixResult 是 scriptResult 内层类型，不含 status，无需迁移
- `grep -rn "status: string\|status: \"done\"" extensions/coding-workflow/` — 确认只有 2 处 status: string（均在 line 39 类型签名）

## 收敛状态

**CONVERGED**。G9-001 完全解决（Part A 三项验证全部通过），5 视角独立完整重跑未发现新 gap。

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
- Round 10: 0 gap（本次收敛）

10 轮追踪累计发现 38 gap，全部已处理。每轮 gap 性质逐步深化（domain 建模 → 零依赖 → 生命周期 → runtime 重建 → 文档措辞 → 契约同步 → 收敛），无思维枯竭信号。从 Round 8 起呈单调下降（3 → 1 → 0），收敛稳固。

spec/clarification/domain-models 三文档内部一致，与代码事实一致，可进入 Phase 2（plan）。
