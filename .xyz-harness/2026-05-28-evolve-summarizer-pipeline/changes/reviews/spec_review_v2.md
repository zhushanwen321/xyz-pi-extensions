---
verdict: pass
must_fix: 0

review:
  type: spec_review
  round: 2
  timestamp: "2026-05-28T12:00:00"
  target: ".xyz-harness/2026-05-28-evolve-summarizer-pipeline/spec.md"
  summary: "第2轮重审，3条MUST FIX全部通过验证，LOW/INFO项未修复但不阻塞，评审通过"

statistics:
  total_issues_raised: 8
  must_fix_raised: 3
  must_fix_resolved: 3
  must_fix_unresolved: 0
  low_raised: 3
  low_resolved: 0
  info_raised: 2
  info_resolved: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md — 整体结构"
    title: "缺少 Task Breakdown（任务分解）要素"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "spec.md — Constraints 第2条 vs FR-5/FR-6"
    title: "约束 'LLM Judge 逻辑不改' 与 FR-5/FR-6 存在矛盾"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: MUST_FIX
    location: "spec.md — FR-1.1 压缩策略表"
    title: "top-N 截断的 N 值未定义"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 4
    severity: LOW
    location: "spec.md — FR-1.2 异常检测"
    title: "'Skill 从未触发（dormant skills）' 缺少时间窗口定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "spec.md — FR-6.1 空 stderr 诊断"
    title: "stderr 诊断日志写入目标未指定"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "spec.md — FR-6.2 重试机制"
    title: "'使用更短的 prompt' 定义模糊"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: INFO
    location: "spec.md — AC-2"
    title: "验收标准以否定式表述，建议改为正向描述"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: INFO
    location: "spec.md — FR-1.3 vs FR-2 排序"
    title: "FR-1.3 趋势对比依赖 FR-2 Metrics History，但排在 FR-2 之前"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 第二轮回审报告

## 审查记录

- 审查时间：2026-05-28
- 审查类型：Spec 第二轮回审 — 验证第一轮 MUST FIX 修复情况
- 审查对象：`.xyz-harness/2026-05-28-evolve-summarizer-pipeline/spec.md`
- 审查依据：`.xyz-harness/2026-05-28-evolve-summarizer-pipeline/changes/reviews/spec_review_v1.md`

---

## 一、MUST FIX 逐条验证

### ✅ MUST FIX 1: 缺少 Task Breakdown（任务分解）

**v1 问题**：Spec 六要素（Outcomes / Scope Boundaries / Constraints / Decisions Made / Task Breakdown / Verification）中完全缺失 Task Breakdown，plan 阶段无法验证覆盖度。

**当前状态**：**已修复**

spec 末尾新增了 **Task Breakdown** 章节，将实现分解为 7 个独立可验证的子任务：

| # | 子任务 | 对应 FR | 备注 |
|---|--------|---------|------|
| 1 | summarizer.ts — 信号压缩模块 | FR-1.1, FR-1.2 | 独立可测试 |
| 2 | metrics-history — 快照读写+滑动窗口 | FR-2 | 写入 31→保留 30 |
| 3 | 趋势对比 | FR-1.3 | 依赖 #2 |
| 4 | effect-tracker.ts — 效果追踪 | FR-3 | 依赖 #2, #3 |
| 5 | gc.ts — 保留策略 | FR-4 | 独立可测试 |
| 6 | judge.ts — stdin + 重试/诊断 | FR-5, FR-6 | 修改现有 |
| 7 | commands.ts — summarize 胶水 | 胶水层 | 修改现有 |

**评估**：任务粒度合理（每个 ~40-150 行），边界清晰，FR ID 标注完整，依赖关系明确。修复通过。

---

### ✅ MUST FIX 2: 约束与 FR-5/FR-6 矛盾

**v1 问题**：约束"LLM Judge 逻辑不改"与 FR-6.2（重试 + 换 prompt）存在矛盾——重试和 prompt 变更实质改变了 Judge 的行为，超出"不改逻辑"的约束。

**当前状态**：**已修复**

约束第 2 条已重新表述为：

> **LLM Judge 核心解析逻辑不改**：parseJudgeOutput 和 JSONL 提取逻辑保持不变。允许修改 spawn 调用方式（stdin 替代 args）和增加重试/诊断逻辑（FR-5、FR-6），这些属于调用编排而非 Judge 推理逻辑。

**评估**：修复精确——画出了清晰的红线：
- ❌ 不能改的：parseJudgeOutput、JSONL 提取（推理逻辑）
- ✅ 可以改的：spawn 方式、重试、诊断（调用编排）

这个划分合理且可操作，每个变动都能明确判断落在哪一侧。修复通过。

---

### ✅ MUST FIX 3: top-N 截断的 N 值未定义

**v1 问题**：FR-1.1 压缩策略表的所有 top-N 截断都缺少具体的 N 值，实现者无据可依。

**当前状态**：**已修复**

FR-1.1 表格中每个截断策略都明确了具体数值：

| 数据类型 | N 值 | 建议人（v1） | 实际值 |
|----------|------|-------------|--------|
| duplicate_reads | N=20 | N=10 **（另有考虑，见下方评估）** |
| repeated_requests | N=10 | N=5 |
| common_tool_sequences | N=10 | N=10 |
| Per-project | — | top 5 + other |

> **评估注意**：v1 建议 duplicate_reads 取 N=20，但当前 spec 取 N=10。N=10 按频率降序后每条保留 `{file, count, example}`，按项目已有数据显示（990 条 185KB → 10 条约 2KB），N=10 压缩比更高且对核心信息损失可控。实现上也需确认 example 字段的来源——example 是原始报告中原有的字段，还是需要在 summarizer 中从原始数据生成。建议 plan 阶段确认。**不存在前三个 MUST FIX 的同类问题，仅作实现提示。**

**评估**：N 值已全部明确定义，修复通过。

---

## 二、LOW / INFO 项状态（未修复，但不阻塞）

| # | 优先级 | 问题 | v1 状态 | 当前 spec | 本轮意见 |
|---|--------|------|---------|-----------|---------|
| 4 | LOW | FR-1.1 "Skill 从未触发" 缺少时间窗口判断条件 | 开放 | 未修改 | 建议实现时在 plan 中明确窗口（如 90 天），不阻塞评审 |
| 5 | LOW | FR-6.1 stderr 日志写入目标未指定 | 开放 | 未修改 | 建议 plan 阶段决定路径，不阻塞评审 |
| 6 | LOW | FR-6.2 "更短的 prompt" 定义模糊 | 开放 | 未修改 | 建议 plan 阶段定义 retry prompt 的精确内容，不阻塞评审 |
| 7 | INFO | AC-2 否定式表述（"不再报错误"） | 开放 | 未修改 | 可接受当前表述，不阻塞 |
| 8 | INFO | FR-1.3 依赖 FR-2 但排在 FR-2 前 | 开放 | 未修改 | 但不推荐调整 FR 排序，实际实现顺序已在 Task Breakdown 中标明。Task Breakdown 中标注了 #1 → #3 依赖关系，已足够 |

---

## 三、本轮新增发现

未发现新的阻碍性问题。一轮审查结束后，当前规范相对于原始需求是完整、自洽的。

## 四、审查结论

**verdict: pass**

- 第 2 轮审查，3 条 MUST FIX 全部通过验证：
  1. ✅ 新增 Task Breakdown 章节，7 个子任务标注 FR ID 和依赖关系
  2. ✅ 约束重新表述，明确"核心解析逻辑不改"的红线
  3. ✅ top-N 截断全部指定具体 N 值（10/5/10/top5+other）

- 5 条 LOW/INFO 未修复但不阻塞流程，可在 plan 阶段解决

---

## Summary

第2轮重审通过。3条MUST FIX全部验证通过，spec 修复充分，可进入 plan 阶段。
