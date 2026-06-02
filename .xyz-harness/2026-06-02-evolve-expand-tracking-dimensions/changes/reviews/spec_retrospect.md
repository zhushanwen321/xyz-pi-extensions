---
phase: spec
verdict: pass
absorbed: false
topic: "2026-06-02-evolve-expand-tracking-dimensions"
harness_issues:
  - "gate-check 要求的 skill 依赖（xyz-harness-gate-reviewer, harness-retrospect）未自动安装，需要手动 symlink"
  - "spec_review 文件的 must_fix 字段未在 spec phase 的 gate 提示中说明，导致首次提交失败"
  - "review 文件默认放在 topicDir 根目录，但 gate-check 期望在 changes/reviews/ 下，路径约定不够显式"
---

# Phase 1 Retrospect: Spec

## 1. Phase Execution Review

### Summary

本 phase 的目标是为 evolve 系统定义 6 个新追踪维度的 spec。实际工作分为三个阶段：

1. **全景分析**（前半段）：扫描了 evolve-daily 扩展、Python 分析器（8 个 extractor + miner）、skill-state 扩展、以及 evolution-data 目录下的所有数据文件。识别出生产者不明、功能分散、扩展性差三个核心问题。

2. **架构设计**（中段）：基于分析结果写了 4-layer 架构文档（003-evolve-redesign-4-layer.md），定义了 Problem Registry → Tracking Engine → Analysis Pipeline → Report & Suggestion 的分层结构。

3. **Spec 细化**（后半段）：用户提出 3 个澄清问题后，重写了 spec，将每个维度从抽象的"追踪目标"细化为具体的信号源、可追踪数据、不能追踪的数据、产出数据结构和 Miner 规则。

### Problems Encountered

**问题 1：初版 spec 过于抽象**

初版 spec 用 ProblemRegistry 的 `MatchCondition` 声明式定义检测器，但实际上下文利用率需要计算 token 累积量、重复操作需要维护 turn 内调用计数器——这些都是带状态的逻辑，无法用声明式匹配描述。

**解决**：用户指出后，明确了 Problem Registry 只做索引 + 阈值 + 模板，不驱动 L2/L3 实际逻辑。

**问题 2：对信号源的可行性假设错误**

初版假设 session JSONL 中有 tool call 的开始时间和 token 使用量，但实际上 session JSONL 只记录 message（user/assistant/toolResult），不记录 Pi 内部事件（tool_call、turn_end）。Compact 的精确 token 数也不可得。

**解决**：在 spec 中明确标注了"不能追踪"的数据，避免不可实现的设计。

**问题 3：Gate check 反复失败**

- 首次：spec.md 缺少 `verdict` 字段 → 补上
- 二次：spec_review 文件放在 topicDir 根目录 → 移到 changes/reviews/
- 三次：spec_review 缺少 `must_fix` 字段 → 补上
- 四次：gate-reviewer 和 harness-retrospect skill 未安装 → 手动 symlink

**解决**：逐项修复，但耗费了 4 轮 gate check。

### What Would You Do Differently

1. 在写 spec 之前先读 gate-check.py 源码，了解它的确切期望（文件路径、frontmatter 字段）
2. 先检查所有依赖 skill 是否已安装
3. 在第一版 spec 中就做"能追踪 vs 不能追踪"的分析，而不是等到用户追问

### Key Risks for Later Phases

1. **上下文利用率精度有限**：字符数/token 换算因语言和模型差异很大，只能作为趋势观察指标
2. **Subagent 耗时不可追踪**：session JSONL 不记录 tool call 开始时间，需要从 result 内容中解析
3. **workflow 数据依赖 .xyz-harness/ 目录**：无 workflow 项目时该维度数据为空

## 2. Harness Usability Review

### Flow Friction

Spec phase 的流程本身是顺畅的——写 spec → 提交 gate → 通过。但 gate check 的前置条件检查不够显式：必须手动发现文件路径约定（changes/reviews/）和 frontmatter 字段要求（verdict + must_fix）。

### Gate Quality

Gate check 正确识别了缺失的文件和字段，没有误报。但错误消息可以更具体——比如"spec_review_v1 must_fix: 'must_fix' field missing"只说了缺什么，没说应该填什么值。

### Prompt Clarity

Phase 1 的 skill 指令（xyz-harness-brainstorming）在本次流程中没有被显式加载——用户直接给了需求，我跳过了 brainstorming 流程直接写 spec。这在需求已经明确时是合理的，但 harness 流程没有提供"跳过 brainstorming"的选项。

### Automation Gaps

1. **Skill 依赖检查**：gate check 应该在执行前检查所有依赖 skill 是否已安装，而不是执行到一半才发现缺失
2. **Frontmatter 模板**：spec.md 和 review 文件的 frontmatter 应该有模板，而不是靠 AI 猜测

### Time Sinks

1. **Gate check 重试**：4 轮 gate check，每轮修复一个问题，耗费了约 30% 的 phase 时间
2. **探索性分析**：扫描 evolution-data 目录和 Python 分析器代码耗费了大量读取操作，但这是必要的——不理解现状就无法设计新维度
