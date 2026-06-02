---
phase: plan
verdict: pass
absorbed: false
topic: "2026-06-02-evolve-expand-tracking-dimensions"
harness_issues:
  - "plan_review subagent 发现的 4 个 MUST_FIX 都是 plan 编写时的粗心错误，应该在 self-review 阶段就发现"
  - "sed 命令批量替换 task 编号时产生连锁错误（所有编号被替换为同一个值），需要更谨慎的替换策略"
---

# Phase 2 Retrospect: Plan

## 1. Phase Execution Review

### Summary

本 phase 的目标是从 approved spec 产出完整的 implementation plan。实际工作：

1. **评估复杂度**：判定为 L1（无前端、无新 API、纯后端变更），使用单一 plan.md
2. **编写 plan.md**：16 个 Task，分 3 个 Execution Group（BG1 TypeScript、BG2 Python、BG3 Skill 更新）
3. **编写辅助文档**：e2e-test-plan.md、test_cases_template.json、use-cases.md、non-functional-design.md
4. **Plan Review**：subagent 发现 4 个 MUST_FIX，修复后通过

### Problems Encountered

**问题 1：文件路径全部错误**

plan.md 中所有文件路径使用 `packages/evolve/` 前缀，但实际包名是 `packages/evolve-daily/`。这是 27 个文件路径的系统性错误。

**根因**：编写 plan 时没有验证实际包名，凭记忆使用了 `evolve` 而非 `evolve-daily`。

**解决**：`sed -i '' 's|packages/evolve/|packages/evolve-daily/|g'` 全局替换。

**问题 2：TypeScript detector 缺运行时注册**

创建了 4 个 detector 工厂函数（compact/subagent/param-error/goal-quality），但没有 Task 将它们注册到 Pi 的 `pi.on("tool_execution_end")` 事件系统。detector 被创建但永远不会被执行。

**根因**：只考虑了"定义 detector"，没有考虑"detector 如何被调用"。

**解决**：新增 Task 6: Detector Registration to Pi Event System。

**问题 3：self_correction_rate 硬编码占位值**

`tool_errors.py` 中 `self_correction_rate = 0.65` 是占位值，导致 miner rule `low-self-correction`（阈值 ≤ 0.50）永远不会触发。

**根因**：认为"自行修正率需要复杂的 turn 级分析"就简化为常量，但 spec 已定义了计算方式。

**解决**：实现真正的计算逻辑——遍历消息序列，检查每个错误后是否有同工具的成功调用。

**问题 4：estimate_tokens 传入假字符串**

`context.py` 中 `estimate_tokens("x" * cumulative_chars)` 构造了纯 ASCII 字符串，完全失去了中英文混合估算能力。

**根因**：函数设计时只考虑了"接收文本"的接口，没有考虑"只有字符数"的场景。

**解决**：重命名为 `estimate_tokens_from_chars(char_count, text_sample="")`，直接接收字符数。

**问题 5：sed 批量替换 task 编号连锁错误**

用 sed 批量替换 task 编号时，`sed 's/Task 7/Task 8/'` 后再 `sed 's/Task 8/Task 9/'`，导致刚替换的 Task 8 也被改成 Task 9。最终所有 task 编号变成同一个值。

**根因**：sed 命令是顺序执行的，后面的替换会影响前面的结果。

**解决**：手动修复，或使用更精确的替换策略（如只替换特定行号范围）。

### What Would You Do Differently

1. **验证包名**：在写 plan 之前先 `ls packages/` 确认实际目录名
2. **思考运行时集成**：定义 detector 时同步思考"detector 如何被调用"
3. **禁止占位值**：plan 中的代码示例必须是可执行的逻辑，不能用常量占位
4. **谨慎使用 sed**：批量替换时使用更精确的匹配模式，或手动替换

### Key Risks for Later Phases

1. **16 个 Task 的执行顺序**：BG1 和 BG2 实际上可以并行（Python extractor 不引用 TypeScript 代码），但 plan 声明了串行依赖。dev 阶段可以优化。
2. **14 条 miner rules 只有 1 条完整代码**：plan 中 Task 14 只给出了 1 条规则的完整示例，其余 13 条说"类似"。dev 阶段需要为每条规则提供精确规格。
3. **workflow extractor 的 gate_count >= 5 判定**：review 指出这个逻辑脆弱，但未修改。dev 阶段需要改进。

## 2. Harness Usability Review

### Flow Friction

Phase 2 的流程比 Phase 1 顺畅。gate check 一次通过（Phase 1 花了 4 轮）。主要原因是 Phase 1 的 retrospect 记录了 gate check 的前置条件（文件路径、frontmatter 字段），Phase 2 直接遵循。

但 plan_review subagent 发现的 4 个 MUST_FIX 本应在 self-review 阶段就发现。skill 中的 Self-Review 章节有 3 个检查维度（spec 覆盖、placeholder 扫描、类型一致性），但没有"验证包名"和"验证运行时集成"的检查项。

### Gate Quality

Gate check 正确识别了 plan_review_v1 的 must_fix=4，没有误报。但 gate check 只检查最新 review 文件的 verdict 和 must_fix，不检查修复内容的真实性。如果我在 plan_review_v2.md 中写 must_fix=0 但实际没修复，gate 也会通过。

### Prompt clarity

Phase 2 的 skill 指令（xyz-harness-writing-plans）非常详细，涵盖了 L1/L2 分级、Execution Groups、Interface Contracts、Spec Coverage Matrix 等。但有一个遗漏：没有明确要求"验证包名"和"验证运行时集成"。

### Automation gaps

1. **task 编号管理**：手动管理 16 个 task 的编号容易出错（如 sed 连锁替换问题）。应该有自动化工具管理编号。
2. **review 修复追踪**：plan_review_v1 发现 4 个 MUST_FIX 后，我手动修复了 plan.md，但 review 文件本身没有记录修复内容。应该有自动化工具将修复内容同步到 review 文件。

### Time Sinks

1. **sed 连锁替换**：修复 task 编号时 sed 命令产生连锁错误，花了额外时间手动修复
2. **plan_review_v2 的 must_fix 字段**：gate check 从 statistics.must_fix 提取值，我最初写成 must_fix=4（原始问题数），需要改成 must_fix=0（当前未解决数）
