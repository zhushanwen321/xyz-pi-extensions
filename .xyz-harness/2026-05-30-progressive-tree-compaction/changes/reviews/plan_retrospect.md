---
phase: plan
verdict: pass
---

# Phase 2 Retrospect — Progressive Tree Compaction

## 1. Phase Execution Review

### Summary

完成了完整的实施规划。产出物包括 plan.md（5 个 Task、接口契约、Spec Coverage Matrix、Execution Groups）、e2e-test-plan.md（9 个 Scenario）、test_cases_template.json（16 个 TC）、use-cases.md、non-functional-design.md。经过 2 轮评审（第 1 轮 FAIL 5 MUST FIX → 第 2 轮 PASS 0 MUST FIX）。

### Problems Encountered

**1. 自检不足导致第 1 轮评审 FAIL（核心问题）**
5 条 MUST FIX 中有 3 条（compressedSegIds 持久化、runCompression append 未修改、增量提示词与追加模式冲突）是计划内的遗漏——设计过程中想到了但没写进 plan 的最终版本。根源是写完 plan.md 后只做了粗略的 placeholder scan，没有逐 Task 检查实现完整性和一致性的覆盖。

**2. Task 4 过滤设计"思考流写入 plan"**
Task 4 的 initial plan 中包含了大段的自我对话（"Simplest approach... Better alternative... Actually... Wait..."），把设计过程中的犹豫和修正直接写进了交付物。这导致 reviewer 认为设计不自洽。正确的做法是先理清决策再写 plan，或者在 plan 中只呈现最终选择。

**3. computeCompressionScope 公式与 spec 脱节**
plan 中的公式用了两个不同的 per-segment 常量（63 + 12 = 75 tokens/段），而 spec 写的是 63。并且分母缺少系统提示词。这是典型的 spec→plan 传递断裂——写 plan 时没有逐字对照 spec 的公式。

### What Would You Do Differently

- 在 dispatch review 前做一个**更严格的自检**：对照 spec 逐条检查 FR/AC 的 plan 覆盖（而不是只检查 placeholder）
- 写 plan 时**先理清所有设计决策再动笔**，而不是边想边写
- Task 之间的依赖一致性应该用**类型检查**级别的严格度验证（方法签名、参数名、返回值跨 Task 是否一致）

### Key Risks for Later Phases

- **tree-compactor.ts 行数**：当前 958 行，加上 5 个 change 后可能超过 1000 行限制。如果实现时超限，需要将 helper 函数拆分到独立文件
- **computeCompressionScope 的实际精度未知**：63 tokens/段只是理论估计，实现后需要通过实际压缩测试校准
- **compressedSegIds 的 message 过滤**：基于 userMsgCount 从头部切割是近似的（可能有少量 system prompt 在压缩段之前），但现有的 budget truncation 会在后续步骤中修正

## 2. Harness Usability Review

### Flow Friction

**1. writing-plans skill 的 L1/L2 选择合理但文档复杂**
对于这个纯后端、单模块的改动，L1 判断正确。但 skill 文档中 L2 子文档相关的大段描述（~40% 的内容）需要阅读跳过才能找到 L1 的相关指引。可以考虑在开头标注"如果你是 L1（简单）场景，仅阅读以下部分即可"。

**2. "禁止实现代码"规则的歧义**
Skill 要求"plan 中不要包含实现代码"，但 interface contracts 是例外（明确注明豁免）。这个例外在快速阅读时容易被忽略。

### Gate Quality

Gate 第 1 次 PASS（虽然内部 review 第 1 轮 FAIL）。这说明 coding-workflow 的 gate 入口检查（YAML frontmatter、文件存在性）是正确的，但深度检查（plan 质量）依赖 review subagent。两阶段检查（gate → review → fix → gate）的配合有效——review 捕获了 plan 的深层问题。

### Prompt Clarity

writing-plans skill 的 Execution Groups 格式很明确，但 Wave 编排部分对于单 group 场景略显冗余。不过冗余比遗漏好——对于多 group 场景，Wave 编排必不可少。

### Automation Gaps

**1. spec→plan 一致性检查可以自动化**
第 1 轮 review 发现的公式不一致问题（perSegmentTokens 用了两个值）可以通过一个简单的脚本检测：分析 plan.md 中引用 COMPRESSION_CONFIG 常量的代码块，提取其值，与 spec.md 中的对应值对比。如果 Phase 3 有更多扩展，可以考虑增加这个检查。

**2. 多次 review 的递进验证**
第 2 轮 review 没有自己验证第 1 轮的所有修复，而是依赖 subagent 重新完整审查。这工作得好但也消耗 token。理论上可以做一个"diff-based re-check"——只检查第 1 轮指出的问题区域。但当前的全量重审方法更安全，对于这个规模的项目可以接受。

### Time Sinks

- **修复 5 条 MUST FIX**：约 40% 的 Phase 2 时间。如果 self-review 更严格，可以压缩到 10%
- **尝试理解写作-plans skill 的 L2 章节**：约 10% 的时间。对于 L1 场景，这部分内容应该被更明确地 skip
