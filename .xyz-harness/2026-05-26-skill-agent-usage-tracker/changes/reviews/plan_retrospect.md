---
phase: plan
verdict: pass
---

# Phase 2 (Plan) Retrospect

## 1. Phase Execution Review

### Summary

完成了 L1 复杂度的实现计划，涵盖 3 个 Task、3 个 Execution Group（BG1 Extension 核心、BG2 分析 Skill、BG3 安装验证）。产出了 5 个交付物（plan.md、e2e-test-plan.md、test_cases_template.json、use-cases.md、non-functional-design.md），经过 2 轮 review 修复 1 条 MUST FIX（skillMap 空值 guard 日志缺失）。

### Problems Encountered

1. **MUST FIX：防御性 guard 不完整**：plan 中写了 `!initialized` 检查，但漏掉了 `initialized=true` 但 `skillMap.size === 0` 的场景（比如 session 中没有任何 skill）。review subagent 正确指出。修复方式是在 read 分支中增加 size === 0 的显式检查和日志输出。

2. **e2e-test-plan 覆盖不足（LOW）**：TS-2 只测试了 single-mode subagent，AC-2 明确要求覆盖 parallel/chain 模式。已补充完整步骤。

3. **edit 工具匹配失败**：尝试修复 e2e-test-plan.md 时，oldText 包含全角 `≥` 字符导致匹配失败（终端渲染差异）。通过 grep 定位行号后用更精确的文本段重试成功。

### What Would You Do Differently

- 在编写 plan 的伪代码时，应该直接从 spec FR-3 的完整文本（包含"映射表为空时跳过并输出 console.error"）逐条翻译，而不是凭记忆写 guard 逻辑。这会避免 MUST FIX。
- e2e-test-plan 应该在写 TS-2 时就对照 AC-2 中的枚举（single/parallel/chain）逐个覆盖，而不是等 review 指出。

### Key Risks for Later Phases

- **Task 1 的 subagent tool 输入类型**：`ToolCallEvent` 是联合类型，`subagent` 的 input 是 `Record<string, unknown>`（CustomToolCallEvent），不是类型安全的。实现时需要防御性解析（optional chaining + Array.isArray 检查）。plan 中已提到但未详细展开类型守卫代码。
- **Skill 文件路径解析**：`path.resolve()` 的行为依赖于当前工作目录。如果 Pi 的 cwd 与 skill filePath 的基准不一致，可能导致匹配失败。实现时需要确认 Pi 传入的 `filePath` 是绝对路径还是相对路径。
- **BG1 和 BG2 可以并行但 BG3 依赖两者**：Wave 编排需要严格串行化 BG3 在 BG1/BG2 之后。

## 2. Harness Usability Review

### Flow Friction

整体流畅。L1 复杂度的 plan 不需要拆分子文档，单一 plan.md 就够了。Execution Groups 的分组对这么简单的项目来说有点过重（3 个 group、3 个 task），但格式要求如此，不算真正的摩擦。

### Gate Quality

Phase 2 gate 有 9 个检查项，比 Phase 1 的 3 个更全面。特别是 `test_cases_template.json` 的 JSON 有效性验证和 `complexity: L1` 检查都很有价值。

### Prompt Clarity

writing-plans skill 的指导很详细。但 "No Placeholders" 规则与 L1 简单 plan 的伪代码风格有张力——plan 中的 Step 3 用的是伪代码结构描述（不是可执行的代码），这算不算"placeholder"？实际操作中我把它当作接口契约级别的描述（签名 + 控制流），不包含方法体，应该没问题。

### Automation Gaps

无明显的自动化缺口。Gate check、review dispatch、文件验证都顺利。

### Time Sinks

- 读取 Pi API 类型定义花了较多 token（`types.d.ts` 1173 行、`skills.d.ts`、`system-prompt.d.ts`、`read.d.ts`）。对于 L1 项目，这些信息的 ROI 偏低——我只用了其中 5-6 个类型定义。可以考虑在 Quick Overview 中只 grep 关键类型名，不全文读取。
