---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-27T11:00:00"
  target: ".xyz-harness/2026-05-27-session-analyzer-phase2/spec.md"
  verdict: fail
  summary: "Spec 评审完成，第1轮，2条MUST FIX，需补充 reporter Sampling 传递机制和 Top-N 建议操作生成规则后重审"

statistics:
  total_issues: 6
  must_fix: 2
  must_fix_resolved: 0
  low: 3
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-4 + FR-3 (reporter API 签名)"
    title: "Sampling 标识无法传递到 reporter"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "spec.md:FR-2 (generate_actionable_issues)"
    title: "Top-N 问题建议操作生成缺乏可实现的规则定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: LOW
    location: "spec.md:AC-1"
    title: "CLI 错误处理行为未定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "spec.md:FR-4 (--sample 参数)"
    title: "—sample 参数超出 session 总数时的行为未定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "spec.md:FR-5, FR-6"
    title: "FR-5 和 FR-6 属于运维/部署操作，不宜混在功能需求中"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: INFO
    location: "spec.md:AC-5"
    title: "性能测试条件未指定测试机器规格"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 评审 v1

## 评审记录
- 评审时间：2026-05-27 11:00
- 评审类型：Spec 评审（计划评审模式 第1项：spec 完整性）
- 评审对象：`.xyz-harness/2026-05-27-session-analyzer-phase2/spec.md`

## 审查方法论

依据 xyz-harness-expert-reviewer 模式一「计划评审」的 Spec 完整性维度，检查以下六要素：
1. **Outcomes** — 产出物是否明确
2. **Scope boundaries** — 范围是否合理且有明确边界
3. **Constraints** — 约束条件是否充分
4. **Decisions made** — 决策记录是否清晰
5. **Task breakdown** — 任务分解是否可推导（spec 层面到 FR 粒度即可）
6. **Verification** — 验收标准是否可测试

同时检查：功能需求可测试性、约束完备性、遗漏的边界场景。

检查背景：项目的 CLAUDE.md 定义了扩展架构约束（Pi 进程内执行、Session 隔离、状态持久化等），但 spec 开发的是独立 Python 脚本，这些约束不直接适用。已确认 spec 的约束声明与项目架构无矛盾。

---

## 要素检查结果

### 1. Outcomes ✅
**明确**。三个产出模块：miner.py（模式聚合）、reporter.py（报告生成）、analyze.py（CLI 入口）。6 个功能需求（FR-1 到 FR-6）清晰描述了各模块的职责。

### 2. Scope Boundaries ✅
**合理且有明确边界**。Background 明确 "缺失 3 个模块"，Constraints 明确 "已有代码不重写：parser.py 和 7 个 extractor 保持现有实现"。明确声明 "Phase 2 是纯统计分析，不涉及任何 AI/LLM 调用。全部用 Python 标准库实现"。

### 3. Constraints ✅
**充分**。6 条约束涵盖技术栈（Python 3.10+）、依赖限制（标准库）、已有代码保护（不重写）、性能（< 120s）、安装路径、报告输出路径。约束与 CLAUDE.md 中的项目规范无冲突。

### 4. Decisions Made ✅
**清晰**。关键决策：只新增 3 个模块、不调用外部 API、纯统计分析。

### 5. Task Breakdown
Spec 层面不要求细粒度 task 分解（这是 plan 的工作）。FR-1 到 FR-6 按模块划分，粒度适中，可直接映射到 plan 的 task。

### 6. Verification ✅
**所有 AC 均可测试**。7 个 AC 覆盖了：
- CLI 行为验证（AC-1）
- 报告内容完整性（AC-2）
- Top-N 问题有效性（AC-3）
- Skill 健康度评分有效性（AC-4）
- 性能基准（AC-5）
- 文件产出（AC-6, AC-7）

每个 AC 都有明确的量化标准或可观察的证据。

---

## 发现的问题

### MUST FIX

#### 1. Sampling 标识无法传递到 reporter

| 字段 | 内容 |
|------|------|
| 严重程度 | **MUST FIX** |
| 位置 | spec.md: FR-4 + FR-3 (reporter API 签名) |
| 状态 | open |

**问题描述**：
FR-4 明确要求："抽样结果应标记为'抽样报告'以区分全量报告"。但 FR-3 定义的 reporter API 签名是：
```python
def to_markdown(aggregated_result) -> str:
```
该函数仅接收 `aggregated_result`（miner 的输出），但 spec **没有定义 aggregated_result 的接口结构**，也没有要求包含 `is_sample` 标记。如果 aggregated_result 不携带抽样信息，reporter 将无法区分抽样/全量模式，导致 FR-4 的要求无法实现。

同样的 `to_json()` 也存在同样问题。

**影响**：FR-4 的需求将无法被满足，抽样报告与全量报告无法区分。

**修改方向**：
方案 A：在 `mine_patterns()` 返回结构中增加元数据字段，如 `{"_meta": {"is_sample": bool, "sample_size": int | None, "total_sessions": int}}`
方案 B：为 reporter 函数增加参数，如 `to_markdown(aggregated_result, is_sample=False, sample_size=None)`
方案 C：在 FR-3 中定义 `AggregatedResult` 接口，要求包含分析元信息

建议方案 A，因为 reporter 的职责就是格式化 miner 的输出，元数据由 miner 携带更合理。

---

#### 2. Top-N 问题建议操作生成缺乏可实现的规则定义

| 字段 | 内容 |
|------|------|
| 严重程度 | **MUST FIX** |
| 位置 | spec.md: FR-2 (`generate_actionable_issues`) |
| 状态 | open |

**问题描述**：
FR-2 要求 Top-N 可操作问题列表包含"建议操作"，并给出了示例（如"优化 whitespace-fixer skill 触发条件"）。但 spec 只给出了输出格式示例，**没有定义从统计数据自动推导建议操作的规则或算法**。

不同的实现者可能产出质量悬殊的结果（有人输出通用建议，有人输出具体数据支撑的建议），导致这项需求不可控。

**影响**：建议操作的质量无法保证，可能变成无意义的占位文本。

**修改方向**：
方案 A：在 FR-2 中补充建议操作的自动推导规则，例如：
  - 如果某 skill 的错误率 > 30%，建议操作 = "审查 {skill_name} 的触发条件"
  - 如果某 token 消耗在单 session 中占全量 > 40%，建议操作 = "检查有无 token 浪费模式"
  - fallback 规则 = 不生成建议操作（让该字段为空）

方案 B：将"建议操作"降级为可选字段，允许为空，但不建议——因为 FR-2 明确要求包含它。

---

### LOW

#### 3. CLI 错误处理行为未定义

| 字段 | 内容 |
|------|------|
| 严重程度 | **LOW** |
| 位置 | spec.md: AC-1 |
| 状态 | open |

**问题描述**：
AC-1 只覆盖了 CLI 的成功路径（4 条验证点），未定义失败场景的行为：
- 无效参数格式（如 `--since invalid-date`）→ 预期 exit code 和错误消息
- JSONL 目录不存在 → 预期行为（空报告？报错退出？）
- JSONL 文件损坏 → 跳过还是中断？

这些缺失不影响核心功能交付，但对工具的健壮性有影响。argparse 部分覆盖了参数格式错误场景，但目录不存在等场景需要显式处理。

**修改方向**：在 AC-1 中增加 2-3 条失败场景的 AC，或在 Constraints 中增加"健壮性要求"。

---

#### 4. `--sample` 参数超出 session 总数时的行为未定义

| 字段 | 内容 |
|------|------|
| 严重程度 | **LOW** |
| 位置 | spec.md: FR-4 |
| 状态 | open |

**问题描述**：
FR-4 指定使用 `random.sample()` 实现抽样，但当 `--sample N` 中的 N 大于实际解析出的 session 总数时，`random.sample()` 会抛出 `ValueError: sample larger than population`。spec 未定义此场景的处理策略（报错？降级为全量？）。

**修改方向**：补充定义：当 N > 可用 session 数时，行为为 `min(N, len(sessions))` 并给出提示，或直接报错退出。

---

#### 5. FR-5 和 FR-6 属于运维/部署操作，不宜混在功能需求中

| 字段 | 内容 |
|------|------|
| 严重程度 | **LOW** |
| 位置 | spec.md: FR-5, FR-6 |
| 状态 | open |

**问题描述**：
- FR-5 "回顾性分析" 是完成脚本后的一次性执行操作，不是新功能
- FR-6 "周报自动化" 是 cron 配置，不是代码功能

这两项放在 FR 中会混淆"需要开发什么"和"开发完成后需要做什么"之间的界限。尤其是 FR-5 要求在 spec 阶段就产生回顾性报告（依赖全量数据），这更像是验证步骤。

**修改方向**：将 FR-5 移至 Acceptance Criteria 或新的 "Post-Implementation Tasks" 章节，FR-6 可保留但标注为部署操作。

---

### INFO

#### 6. 性能测试条件未指定测试机器规格

| 字段 | 内容 |
|------|------|
| 严重程度 | **INFO** |
| 位置 | spec.md: AC-5 |
| 状态 | open |

**问题描述**：
AC-5 要求 "670 个 JSONL 文件（~683MB）的全量分析时间 < 120 秒"，但没有说明测试机器的硬件规格（CPU 核心数、磁盘类型、内存等）。不同硬件上的结果不可比。

但这本质是测试环境问题而非 spec 缺陷。开发者可以在当前开发机器上验证，cron 运行环境也可能不同。建议在备注中注明测试机器规格供参考。

---

## 未发现问题项

以下要素检查无问题：

| 要素 | 状态 | 说明 |
|------|------|------|
| 目标明确性 | ✅ | Background 一段话说清楚了要做什么 |
| 范围合理性 | ✅ | 只新增 3 个模块，不重写已有，边界清晰 |
| 验收标准可量化 | ✅ | 所有 AC 都有明确的观测证据（文件存在、命令输出、时间限制） |
| 待决议项 | ✅ | 无 `[待决议]` 项 |
| 架构合规性 | ✅ | 纯 Python 脚本不与 CLAUDE.md 的 Pi 扩展约束冲突 |
| 性能要求 | ✅ | AC-5 的 120s 限时合理且可测试 |
| 已有代码保护 | ✅ | Constraints 明确不重写已有代码 |
| 依赖控制 | ✅ | 明确只用 Python 标准库 |

---

## 功能需求可测试性逐条检查

| FR | 可测试性 | 说明 |
|----|---------|------|
| FR-1 CLI 入口 | ✅ | 6 个参数定义清晰，可通过 `--help` 和参数组合验证 |
| FR-2 模式聚合 | ⚠️ | 建议操作生成规则缺失（见 MUST FIX #2） |
| FR-3 报告生成 | ⚠️ | Sampling 标识缺失（见 MUST FIX #1）；格式章节定义清晰 |
| FR-4 抽样验证 | ✅ | `random.sample()` 行为明确 |
| FR-5 回顾性分析 | ✅ | 文件产出可验证，但属于运维操作 |
| FR-6 周报自动化 | ✅ | `crontab -l` 可验证 |

---

## 结论

**verdict: fail** — 存在 2 条 MUST FIX 问题，修复后方可通过。

核心问题摘要：
1. **MUST FIX #1**：reporter 无法获取抽样/全量区分信息，无法满足 FR-4 的"抽样报告"标记要求
2. **MUST FIX #2**：Top-N 问题的建议操作生成缺乏可行规则，产出质量不可控

两条 MUST FIX 都集中在 **数据流断点**（采样信息丢失）和 **可验证性不足**（建议操作缺乏算法定义），属于影响功能完备性的关键问题。

---

## Summary

Spec 评审完成，第1轮，2条MUST FIX，需修改后重审。

整体而言，spec 质量较高：六要素基本完整，AC 可测试性强，约束声明充分。需要补充的主要是 reporter 的 Sampling 数据传递机制和 Top-N 建议操作生成规则。
