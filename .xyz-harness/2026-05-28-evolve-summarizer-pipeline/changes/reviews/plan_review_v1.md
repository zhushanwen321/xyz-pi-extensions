---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-28T12:00:00"
  target: ".xyz-harness/2026-05-28-evolve-summarizer-pipeline/plan.md"
  verdict: fail
  summary: "计划评审完成，第1轮，1条MUST FIX，需修改后重审"

statistics:
  total_issues: 6
  must_fix: 1
  must_fix_resolved: 0
  low: 4
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Spec Coverage Matrix 表格, AC-3 行"
    title: "Spec Coverage Matrix AC-3 引用了错误的 Task"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: LOW
    location: "plan.md:Spec Coverage Matrix 表格, AC-6 行"
    title: "Spec Coverage Matrix AC-6 引用了错误的 Task"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: LOW
    location: "plan.md:BG1 Execution Group"
    title: "BG1 文件数（11）超过 10 文件指南"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "plan.md:Dependency Graph (Task 5 → Task 6)"
    title: "Task 5（commands wiring）应当在 Task 6（signalsDir）之后执行以避免重复修改"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "plan.md:Task 3（gc.ts）"
    title: "GcResult 类型定义位置未在 plan 中明确指定"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: INFO
    location: "plan.md:Execution Groups — Wave 3"
    title: "Wave 3 将 Task 5 和 Task 6 置于同 Wave（暗示并行），但依赖图显示串行依赖"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-28 12:00
- 评审类型：计划评审
- 评审对象：`plan.md`（Evolve Summarizer Pipeline 实施计划）

## 1. Spec 完整性

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 目标明确 | ✅ | "Fix 'Empty Judge output' error by inserting a summarizer layer" — 一段话说清楚 |
| 范围合理 | ✅ | FR-1 到 FR-6 边界清晰，Constraints 章节明确排除了 Python analyzer 改动和 Judge 解析逻辑改动 |
| 验收标准可量化 | ✅ | AC-1 到 AC-9 全部可量化（size limits、file counts、零错误等），无模糊描述 |
| [待决议]项 | ✅ | 无未决议项 |

**结论：spec 完整性良好。** 无问题。

---

## 2. Plan 可行性

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 任务拆分粒度 | ✅ | 7 个 task，每个可由 subagent 独立完成。Task 1（核心模块）虽含 8 个子步骤但逻辑内聚，3 个文件 |
| 依赖关系 | ⚠️ | 基本正确，但有 Task 5/Task 6 的排序问题（见 Issue #4） |
| 工作量估算 | ✅ | ~400 行新增 + ~50 行修改，4 个 Wave，估算现实 |
| 遗漏 Task | ✅ | 对照 spec FR-1~FR-6，所有需求已覆盖 |

### 详细分析

**Task 1（summarizer core）** — 3 个文件（create summarizer.ts, modify types.ts + state.ts），8 个子步骤。粒度和范围合理。`extractMetricsSnapshot` 需要 walk 原始报告的多个子字段（`tool_stats`、`token_stats`、`error_stats`、`user_patterns`、`skill_stats`、`satisfaction`），这些字段名依赖 analyzer 的实际输出格式——计划中已提及但未提供 analyzer 输出样例，执行 subagent 需要读取一份实际报告来确认字段名。

**Task 2（effect-tracker）** — 2 个文件（create effect-tracker.ts, modify types.ts）。范围明确，合理。

**Task 3（gc）** — 1 个文件（create gc.ts）。范围明确。但 `GcResult` 类型的位置在 plan 中未指定——可能 inline 在 gc.ts，也可能加入 types.ts。建议在 Task 1 的 types.ts 变更中包含 `GcResult`，或在 Task 3 中明确说明。（见 Issue #5）

**Task 4（judge fix）** — 2 个文件（modify judge.ts + templates）。关键改动：stdin spawn、retry 机制、stderr 日志。合理。

**Task 5（commands wiring）** — 1 个文件。合理。

**Task 6（dirs）** — 3 个文件（modify types.ts, index.ts, commands.ts）。增加 `signalsDir` 到 Dirs。可与 Task 1 或 Task 5 合并以简化。

**Task 7（lint）** — 全量验证。合理。

---

## 3. Spec-Plan 一致性

逐条对照 AC 与 plan Task：

| AC | Plan Task | 覆盖状态 | 说明 |
|----|-----------|----------|------|
| AC-1（745KB → ≤10KB） | Task 1 | ✅ | `compressTopN`、`compressByProject`、`summarizeReport` 完整覆盖 |
| AC-2（No Empty Judge output） | Task 4 | ✅ | stdin + retry 机制覆盖 |
| AC-3（metrics-history ≤30） | Task 1（Step 2） | ⚠️ | **Sliding window 实现在 Task 1，但 Coverage Matrix 写了 Task 2（MUST_FIX）** |
| AC-4（trend ±20%） | Task 1 | ✅ | `computeTrends` 覆盖，含阈值过滤 |
| AC-5（effectReview） | Task 2 | ✅ | `buildEffectReview` 覆盖，含 7 天窗口 |
| AC-6（GC limits） | Task 3 | ✅ | `runGc` 覆盖 reports/signals/daily 三个目录 |
| AC-7（stdin spawn） | Task 4 | ✅ | spawn 修改为 stdin pipe |
| AC-8（tsc --noEmit） | Task 7 | ✅ | 最终验证 |
| AC-9（lint 0 error） | Task 7 | ✅ | 最终验证 |

**发现一个 MUST_FIX 问题：** Spec Coverage Matrix 中 AC-3 引用了 "Task 2"（`saveMetricsSnapshot (sliding window)`），但实际的 sliding window 实现在 **Task 1 Step 2**（state.ts 的 `loadMetricsHistory` / `saveMetricsSnapshot` 函数）。Task 2 只追加了 `metricsSnapshotDate` 字段到 HistoryEntry，不负责滑动窗口。

---

## 4. Execution Groups 合理性

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 分组数量 | 1 个（BG1） | 所有 7 个 task 均为后端 TypeScript，功能紧密关联，合理 |
| 文件数（≤10 指南） | ⚠️ 11 个（4 create + 7 modify） | 略超 10 文件指南。考虑到功能紧凑、全部在后端，可接受但仍建议关注（Issue #3） |
| 类型划分 | ✅ | 全部后端，无混合类型 |
| 功能关联度 | ✅ | summarizer → effect-tracker → gc → judge → commands → dirs，关联紧密 |
| Wave 编排 | ⚠️ | Wave 3 将 Task 5 和 Task 6 并列但依赖图显示 Task 5 → Task 6（Issue #6） |
| Subagent 配置 | ✅ | Agent、Model 自动选择、注入上下文、读取/修改文件均已标注 |
| 上下文充分性 | ✅ | 注入 spec.md FR 段 + AC + Constraints + Interface Contracts，足够 subagent 独立完成 |
| 文件数预估 | ✅ | 11 个文件的估算与 Task 列表一致 |

**Subagent 配置完整性分析：**
- 每个 Task 都列出了 Agent（general-purpose）、模型选择策略（taskComplexity）
- 读取文件和修改/创建文件列表清晰
- 注入上下文引用 spec 和 plan 的特定章节，不含糊
- Task 间的串行执行策略明确

---

## 5. Interface Contracts 审查

由于 plan 标记为 **L1**（非 L2），不需要检查 data_flows cross-reference 和类型传递一致性。L1 要求检查：

| 检查项 | 结果 |
|--------|------|
| plan.md 总纲完整性 | ✅ — 目标、架构、task 列表、依赖关系完整 |
| AC 覆盖矩阵完整性 | ⚠️ — 存在错误（Issue #1），postponed AC 无（全部 adopted） |

Contract 定义的函数签名、参数、返回值都已覆盖 spec AC。Edge cases 也标注了（空数组、缺失文件等）。这是好的实践。

**后端设计充分性（L1 后端 checklist）：**

由于 plan 中所有 task 都是后端，适用 L1 后端检查：

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 是否说明了"为什么" | ✅ | plan 的 "Background" 和 "Goal" 段落清晰说明了改造原因 |
| 存储变更选型理由 | ✅ | metrics-history.json 使用 JSON 文件（而非 DB），理由隐含在"与现有 state.ts 模式一致" |
| API 端点设计 | ✅ | 不涉及外部 API，所有函数签名已定义 |
| 边界条件和异常处理 | ⚠️ | 大部分已标注 edge cases（空输入、缺失文件），但 Task 5（commands.ts wiring）的异常处理未详细说明 |
| 非功能性要求对应 Task | ✅ | AC-8 和 AC-9 由 Task 7 覆盖 |

---

## 结论

需修改后重审。

**1 条 MUST_FIX：**
1. **Spec Coverage Matrix AC-3 引用了错误的 Task** — 矩阵中 AC-3 行写的是 "Task 2"，但 metrics-history sliding window 实现在 Task 1 Step 2。应当修正为 "Task 1"（或 "Task 1"）。

**4 条 LOW 建议修复：**
2. **Spec Coverage Matrix AC-6 行** — "Task 5" 应改为 "Task 3"（runGc 实现在 Task 3，Task 5 仅负责 wiring）。
3. **BG1 文件数略超 10 文件指南**（11 个）— 虽有合理性，仍建议关注是否可将高度内聚的 Task 合并以简化。
4. **Task 5 与 Task 6 执行顺序** — 依赖图 Task 5 → Task 6 导致 commands.ts 被修改两次（Task 5 硬编码路径、Task 6 替换为 dirs.signalsDir）。建议调整顺序为 Task 6 → Task 5，或合并。
5. **GcResult 类型位置未指定** — 建议在 Task 1 的 types.ts 变更中包含 `GcResult`，或在 Task 3 中 inline 定义并注明。

**1 条 INFO：**
6. **Wave 3 的 Wave 定义与依赖图矛盾** — Wave 3 将 Task 5 和 Task 6 放在同一 Wave（暗示可并行），但依赖图显示 Task 5 → Task 6 串行。实际执行"单 subagent 串行"可绕过此问题，但 Wave 定义与依赖图应保持一致。

### Summary

计划评审完成，第1轮，1条MUST FIX，需修改后重审。整体设计质量良好，spec 完整性和 plan 覆盖度为合格水平。主要问题集中在 Spec Coverage Matrix 的准确性和 Task 5/6 的执行顺序优化。修正后即可通过。
