---
phase: plan
verdict: pass
---

# Phase 2 Retrospect: Evolve Summarizer Pipeline

## 1. Phase Execution Review

### Summary

Phase 2 产出完整：plan.md（L1 复杂度）、e2e-test-plan.md、test_cases_template.json（13 条用例）、use-cases.md（2 个 UC）、non-functional-design.md（5 维度）。经过两轮独立审查，1 条 MUST FIX（Spec Coverage Matrix 中 AC-3 引用错误 Task 编号）修复后通过。

Complexity 评估为 L1（纯后端 TypeScript，无跨域协调、无新存储引擎、无 API 端点），这是准确的判断——避免了 L2 的并行子文档开销。

### Problems Encountered

1. **Spec Coverage Matrix 的 Task 引用错误**：AC-3（metrics-history 滑动窗口）的实现在 Task 1 Step 2（state.ts），但 Coverage Matrix 写成了 Task 2。根因：写 plan 时 Task 编号是按"功能模块"分的（Task 1 = summarizer, Task 2 = effect-tracker），而 state.ts 的修改被归类到 Task 1 中，Coverage Matrix 写的时候没有回溯确认实际步骤位置。AC-6 同样有类似问题（写 Task 5，实际是 Task 3 + Task 5）。
   - **影响**：1 轮额外 review + 修复。
   - **改进**：写 Coverage Matrix 时应该从 Task 的 Steps 列表中查找具体实现位置，而非凭记忆填写。

2. **Review subagent 的 YAML frontmatter 格式问题再次出现**：Phase 1 已经遇到过嵌套 YAML 问题（verdict/must_fix 放在 review/statistics 对象下），Phase 2 的 plan_review_v1.md 仍然出现了同样的模式。在 dispatch review subagent 时虽然 task prompt 中加了格式提示，但 v1 仍然用了嵌套格式（不过 gate 脚本的 `_flatten_review_fields` 这次能正确解析）。
   - **影响**：无阻塞（gate 通过了），但说明 frontmatter 格式一致性是一个系统性问题。

3. **Spec Metrics Traceability 与 Coverage Matrix 的 AC-3 不一致**：v2 review 指出 Traceability 表中 AC-3 仍显示 Task 2（未修复），而 Coverage Matrix 已改为 Task 1。这是因为 Traceability 表在 plan.md 的另一个位置，修复 Coverage Matrix 时漏了同步。
   - **影响**：被标记为 LOW，不阻塞。
   - **改进**：修复 Coverage Matrix 时应该全局搜索所有引用该 AC 的位置。

### What Would You Do Differently

- Coverage Matrix 和 Traceability 表应该在所有 Task 细节写完之后再统一填写，避免中途引用错误。
- 对 review subagent 的 YAML 格式要求应该更强势——在 task prompt 中给出完整的 frontmatter 模板示例，而不只是文字描述。

### Key Risks for Later Phases

1. **summarizer.ts 可能超过 1000 行**：当前 plan 预估 ~200 行，但如果异常检测逻辑复杂度上升，可能需要拆分。dev 阶段应监控行数。
2. **Judge retry 的短 prompt 可能仍返回空**：重试机制只重试 1 次，如果模型本身无法理解信号格式，两次都会失败。dev 阶段需要用真实数据测试。
3. **buildEffectReview 的指标-建议匹配是启发式的**：plan 中说"match suggestion keywords to metric field names"，这是一个模糊的 heuristic，dev 阶段可能需要具体化为映射表。

## 2. Harness Usability Review

### Flow Friction

- **writing-plans skill 对 L1 项目偏重**：skill 要求产出 use-cases.md、non-functional-design.md、test_cases_template.json 等多个文件，对于这个"修改 7 个文件的内部重构"项目来说，文档量相对工作量大。但作为流程一致性要求可以理解。
- **Execution Groups 的 subagent 配置表对于单 group 无意义**：L1 只有 1 个 BG1 group，Execution Groups 章节的详细配置（Agent 链、注入上下文、Execution Flow）占了大量篇幅但对执行无额外指导价值。L1 简化版应该允许精简这部分。

### Gate Quality

- **Gate 检查全面**：10 项检查覆盖了所有交付物的存在性、YAML frontmatter 正确性、JSON 有效性。这次没有 false positive。
- **complexity 字段被正确检查**：gate 脚本检查 `complexity: L1` 并跳过了 L2 特有的 `plan_bl_review`，说明 conditional gate logic 工作正常。

### Prompt Clarity

- **Interface Contracts 模板清晰**：方法签名表的格式明确，产出质量高。
- **"禁止实现代码"规则的边界不够清晰**：plan 中包含了 TypeScript 类型定义（interface 定义），这属于"接口签名"还是"实现代码"？按 skill 说明"参数类型和返回类型的名称"是可以的，但完整的 interface 定义（20+ 字段）可能越界。实践中这是必要的——没有类型定义，实现者无法正确编码。

### Automation Gaps

- **Coverage Matrix 与 Traceability 的自动交叉验证**：两份表都追踪 AC→Task 映射，但可以手动不一致。gate 脚本不检查两者的一致性。这属于"人工 QA 范围"，但如果有自动化会更好。
- **文件数统计**：Execution Groups 要求"每组文件数 ≤ 10"，但没有自动化检查。BG1 实际 11 个文件，略超。

### Time Sinks

- **Plan 文档量**：plan.md 23KB 是最大的单文件交付物，写+审查+修复约占总时间 60%。对于 L1 项目，这个比例偏高。核心原因是 Interface Contracts 的完整类型定义占了大量篇幅。
- **Review 修复循环**：1 条 MUST FIX 导致完整的一轮 review dispatch + 等待 + 修复，修复本身只需改一个数字。如果 self-review 时更仔细地检查 Coverage Matrix，可以避免。
