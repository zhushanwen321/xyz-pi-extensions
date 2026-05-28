---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-28T12:00:00"
  target: ".xyz-harness/2026-05-28-evolve-summarizer-pipeline/spec.md"
  verdict: fail
  summary: "计划评审完成，第1轮，共8条问题（3条MUST FIX，3条LOW，2条INFO），需修改后重审"

statistics:
  total_issues: 8
  must_fix: 3
  must_fix_resolved: 0
  low: 3
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md — 整体结构"
    title: "缺少 Task Breakdown（任务分解）要素"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "spec.md — Constraints 第2条 vs FR-5/FR-6"
    title: "约束 'LLM Judge 逻辑不改' 与 FR-5/FR-6 存在矛盾"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "spec.md — FR-1.1 压缩策略表"
    title: "top-N 截断的 N 值未定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null

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

# 计划评审 v1

## 评审记录

- 评审时间：2026-05-28 12:00
- 评审类型：计划评审（spec 完整性审查）
- 评审对象：`.xyz-harness/2026-05-28-evolve-summarizer-pipeline/spec.md`

## 1. Spec 六要素完整性检查

| 要素 | 状态 | 评估 |
|------|------|------|
| **Outcomes（目标）** | ✅ 基本覆盖 | Background 描述了 5 个问题，UC-1/UC-2 描述了业务场景。但缺少一个显式的、"一段话说清楚"的目标总结段落。当前目标分散在 Background 末尾和 FR 中。 |
| **Scope Boundaries（边界）** | ⚠️ 部分覆盖 | Constraints 定义了"不改什么"（Python analyzer、LLM Judge 逻辑），但没有显式的 **In Scope / Out of Scope** 边界。例如：是否涉及 usage-tracker 的其他数据采集点？summarizer 部署路径是否需要新增 `package.json` entry？这些边界没有明确。 |
| **Constraints（约束）** | ✅ 完整 | 8 条约束，涵盖技术栈、模块规范、代码质量、解耦要求。 |
| **Decisions Made（决策）** | ✅ 完整 | FR-1 到 FR-6 明确记录了 6 组设计决策。 |
| **Task Breakdown（任务分解）** | ❌ **缺失** | spec 中没有任务分解。FR 和 AC 已足够描述需求和验收条件，但没有将实现工作拆分为具体的实施任务。这会导致 plan 阶段无法验证 plan 是否覆盖了 spec 全部内容。 |
| **Verification（验证）** | ✅ 完整 | AC-1 到 AC-9 提供了 9 条验收标准，覆盖功能、性能、代码质量三个维度。 |

**结论**：5/6 要素覆盖。"Outcomes" 需要显式总结段落，"Scope Boundaries" 需要显式列出 In/Out，"Task Breakdown" 完全缺失（MUST FIX）。

## 2. AC 可测试性逐条审查

| AC | 可测试？ | 说明 |
|----|---------|------|
| AC-1 | ✅ | 明确的上限（<=10KB），可写自动化断言 |
| AC-2 | ⚠️ | 以否定式表述（"不再报错误"）。建议改为正向表述："/evolve 命令成功输出 0-N 条改进建议，不再抛出 'Empty Judge output' 异常"。同时需明确：如果 Judge 因其他原因（如网络、模型不可用）失败，是否也算 AC-2 失败？ |
| AC-3 | ✅ | 数值明确（最多 30 条，超出删除最老），可测试 |
| AC-4 | ✅ | 条件（±20%）和数据源（metrics-history.json）明确 |
| AC-5 | ⚠️ | 可测试但前置条件重：需要执行 evolve → apply → 再次 evolve 的序列。测试脚本需要管理状态文件。这不是 spec 问题，但 plan 需要为此分配足够的时间。 |
| AC-6 | ✅ | 数值明确（不超过 3/30 份），可测试 |
| AC-7 | ✅ | 可通过代码审查 / 进程监控验证 |
| AC-8 | ✅ | 可直接运行 `npx tsc --noEmit` 验证 |
| AC-9 | ✅ | 可直接运行 `npm run lint` 验证 |

**结论**：AC-2 建议改为正向表述（INFO）。AC-5 可接受但 plan 需考虑其测试复杂性。

## 3. FR 之间的一致性审查

### 潜在矛盾：Constraints 「LLM Judge 逻辑不改」 vs FR-5/FR-6

**MUST FIX：约束与功能需求存在矛盾**

Constraints 第 2 条明确声明：
> **LLM Judge 逻辑不改**：只改输入来源（从原始报告改为信号摘要）和 spawn 方式

但 FR-5 和 FR-6 做了以下改动：

| 需求 | 改动内容 | 是否与约束矛盾 |
|------|---------|--------------|
| FR-5.1 | Judge 调用方式从 args 改为 stdin | 这是调用方式（invocation），不改变 Judge 内部逻辑 — **可解释为不矛盾** |
| FR-5.2 | Judge 读取路径从 reports/ 改为 signals/ | 这是输入源变更，不改变 Judge 内部逻辑 — **可解释为不矛盾** |
| FR-6.1 | 空输出时将 stderr 写入日志 | 这是外围诊断增强，不改变 Judge 内部逻辑 — **可解释为不矛盾** |
| FR-6.2 | 空 JSON 时重试 1 次，使用更短的 prompt | 这里 **改变了 Judge 子进程的行为**（重试 + prompt 变更），与约束存在张力 |

**建议**：将约束措辞从 "LLM Judge 逻辑不改" 调整为更精确的表述，例如：

> **LLM Judge 核心分析逻辑不改**：Judge 的 prompt 模板、分析维度、输出格式不变。Judge 的调用方式（args→stdin）、外围容错（stderr 日志、空输出重试）可以修改。重试时提供的 prompt 应只做格式强调，不做语义缩减。

### 其它一致性观察

- **FR-1.3 vs FR-2**：FR-1.3 的"趋势对比"依赖 FR-2 定义的 `metrics-history.json`。FR-1.3 排在 FR-2 之前，但实现上依赖于 FR-2。建议在 FR-1.3 中标注 `[Depends: FR-2]` 或调整 FR 排序（INFO）。
- **FR-1.1 vs AC-1**：FR-1.1 目标 ~5KB，AC-1 上限 <=10KB。一致，无矛盾。
- **FR-4 vs FR-1.3**：FR-4.1 规定 metrics-history.json 保留 30 个数据点，FR-1.3 假设该文件存在且可读取。一致。
- **FR-3 vs FR-2**：FR-3.1 要求 apply 记录增加 `metricsSnapshotDate` 字段，FR-2 定义了快照模型。一致。

**结论**：存在 1 条 MUST FIX（约束 vs FR-5/FR-6 矛盾），其余 FR 之间无矛盾。

## 4. 模糊语言（AMBIGUOUS/未定义项）检查

| 位置 | 原文 | 问题 |
|------|------|------|
| **FR-1.1 压缩策略表** | "top-N 截断，每条保留 `{key, count, example}`" | **MUST FIX：N 值未定义。** N=5？N=10？没有数值上限，实现者无据可依。 |
| **FR-1.2 异常检测** | "Skill 从未触发（dormant skills）" | **LOW：缺少时间窗口。** "从未"是指分析窗口内从未触发，还是自安装以来从未触发？建议改为 "在分析窗口内触发次数 = 0"。 |
| **FR-6.1 空 stderr 诊断** | "将 stderr 内容写入日志" | **LOW：日志路径未指定。** 是写入 `daily/*.json` 日志文件？还是独立的 `judge-error.log`？建议明确路径。 |
| **FR-6.2 重试机制** | "使用更短的 prompt 提示 LLM 只输出 JSON" | **LOW：'更短的 prompt' 定义模糊。** 是移除 Background 段落？还是只保留 "Output JSON only" 指令？建议明确定义 fallback prompt 的结构。 |

## 5. 其它观察

### 副作用（Side Effects）确认清单

根据项目 CLAUDE.md 的集成验证要求，以下事项当前 spec 未覆盖：

| 检查项 | 状态 | 说明 |
|--------|------|------|
| `metrics-history.json` 首次创建 | 未覆盖 | 首次 evolve 时文件不存在，FR-2 是否要处理 file-not-found？ |
| 多 session 并发写 metrics-history.json | 未覆盖 | Pi 同一进程多 session 时，GC 是否有竞争条件？ |
| summarize 失败的回退行为 | 未覆盖 | 如果 summarizer 抛出异常，是否 fallback 到原流程直接传原始报告给 Judge？ |

这些不阻塞 spec 评审（属于 plan 层面的设计决策），但建议在 spec 中标注 `[待决议]` 项。

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | spec.md — 整体结构 | **缺少 Task Breakdown。** Spec 六要素中完全缺失任务分解，导致 plan 阶段无法验证覆盖度。 | 在 spec 末尾增加 Task Breakdown 章节，将 6 个 FR 分解为可实施的子任务，每个 task 注明对应的 FR ID。 |
| 2 | MUST FIX | Constraints 第2条 vs FR-5/FR-6 | **约束与需求矛盾。** "LLM Judge 逻辑不改" 与 FR-6.2（重试+prompt 变更）冲突。 | 调整约束表述为 "LLM Judge 核心分析逻辑不改"，明确调用方式/容错机制可以修改。FR-6.2 需明确定义重试 prompt 的限制范围。 |
| 3 | MUST FIX | FR-1.1 压缩策略表 | **top-N 截断的 N 值未定义。** 实现者无法确定 N 的取值。 | 为每种列表类型指定 N 值。建议：duplicate_reads N=20, repeated_requests N=10, common_tool_sequences N=10。 |
| 4 | LOW | FR-1.2 异常检测 | **"Skill 从未触发"缺少时间窗口。** | 改为 "分析窗口内触发次数 = 0" 或 "最近 90 天内未触发"。 |
| 5 | LOW | FR-6.1 空 stderr 诊断 | **stderr 写入日志的目标路径未指定。** | 明确路径，如 `judge-errors/` 目录或追加到 `daily/` 日志。 |
| 6 | LOW | FR-6.2 重试机制 | **"更短的 prompt" 定义模糊。** | 定义 retry prompt 的固定格式或变化规则（如只保留 "Output JSON only" 作为 system prompt 后缀）。 |
| 7 | INFO | AC-2 | **否定式表述。** "不再报 'Empty Judge output' 错误" 不利于测试设计。 | 改为正向表述："/evolve 命令成功输出 0-N 条建议，不再抛出 'Empty Judge output' 异常"。 |
| 8 | INFO | FR-1.3 vs FR-2 排序 | **FR-1.3 依赖 FR-2 但排在 FR-2 之前。** | 标注 `[Depends: FR-2]` 或调整排序。 |

> **优先级定义：**
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，不阻塞
> - **INFO**：观察记录，无需操作

## 结论

**需修改后重审。** 存在 3 条 MUST FIX：

1. 缺少 Task Breakdown（六要素缺失）
2. 约束 "LLM Judge 逻辑不改" 与 FR-6.2 矛盾
3. top-N 截断的 N 值未定义

此外 3 条 LOW 建议（时间窗口、日志路径、重试 prompt 定义）和 2 条 INFO（AC 表述、FR 排序）可在本轮一并处理，但已解决的 MUST FIX 足以通过重审。

## Summary

计划评审完成，第1轮，3条 MUST FIX，需修改后重审。
