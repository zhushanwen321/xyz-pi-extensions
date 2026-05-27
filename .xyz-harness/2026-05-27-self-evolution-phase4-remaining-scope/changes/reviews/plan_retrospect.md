---
phase: plan
verdict: pass
---

# Phase 2 (Plan) Retrospect

## 1. Phase Execution Review

### Summary

产出了完整的 Phase 4 实施计划（5 个 Task，2 个 Execution Group，5 个 Wave），加上 6 个交付物文件（plan.md、e2e-test-plan.md、test_cases_template.json、use-cases.md、non-functional-design.md）。

关键工作内容：
- 重新阅读了 evolution-engine 的全部源码（commands.ts 506 行、judge.ts 317 行、applier.ts 258 行、monitor.ts 327 行）
- 验证了 Python analyzer 脚本的存在和 CLI 接口匹配（`--since`、`--format json`、`--output` 参数，`tool_stats`/`token_stats`/`skill_stats` 等输出键）
- 通过 Complexity Assessment 确定为 L1（简单），走单 plan 路径
- 写完 plan 后 dispatch 了独立 review subagent，发现 2 个 MUST FIX
- 修复后 dispatch 第二轮 review，通过

### Problems Encountered

1. **Plan v1 视角偏差** — 第一版 plan 从"代码要改什么"出发，产出了 3 个 Task（验证+修复、补充模板、质量评估），但遗漏了 spec 的核心要求"端到端跑通"。具体表现：Task 1 只做了单元级验证（修复硬编码路径、改进错误信息），没有包含"安装 extension → 运行 /evolve → apply → rollback"的完整闭环步骤。Review subagent 正确识别了这个 gap。

2. **Plan v1 修复 buffer 缺失** — Spec 明确将"修复实际发现的问题"标注为工作量"中"，预期 E2E 测试会发现 bug。但 v1 的 3 个 Task 结束后没有预留任何修复轮次。这是一个"计划过于乐观"的典型问题。

3. **Edit 工具匹配失败** — 在修复 plan.md 时，一次 edit 调用因为模板中的 markdown 代码块（三个反引号）导致 oldText 匹配失败。改用 read+offset 定位后再做精确替换解决。

### What Would You Do Differently

- **先画 AC 覆盖矩阵再写 Task**。本次先写了 Task 再补 Coverage Matrix，导致 Matrix 是事后验证而非事前驱动。如果先列"spec 要什么"再写"怎么实现"，v1 就不会遗漏 E2E 验证。
- **对"从未跑通过的代码"保持更多敬畏**。2291 行 TS 看起来完整，但从未在真实 pi 环境中运行过。第一版 plan 把"让它跑起来"当成 Task 1 的一个步骤，而非独立 Task。应该给它更高的优先级和更多的步骤空间。
- **merge-reviewer 模板内容不应该写在 plan 里**。Skill 说"禁止实现代码"，虽然模板是 prompt 而非代码，但完整内容写在 plan 中让文件过长（23KB）。应该只写接口签名和约束，内容留到 Task 4 执行时由 subagent 产出。

### Key Risks for Later Phases

- **E2E 验证可能暴露严重运行时不兼容**（import 路径、extension API 签名、pi --mode json 输出格式变化）。如果 Task 2 发现的问题超过 Task 3 的 2 轮修复上限，需要人工介入。
- **D3.3 门控依赖 LLM 输出质量**。glm-5.1 在结构化 JSON 输出上的可靠性未经充分验证。如果频繁生成非 JSON 输出，需要在 prompt 中增加更强的约束或换模型。

## 2. Harness Usability Review

### Flow Friction

Plan review 两轮机制运作良好，是本次 phase 最有价值的环节。v1 的 2 个 MUST FIX 都附带了具体的修改建议（如"增加 Task 1.5 专门做 E2E 验证"），不是模糊的"需要改进"。修复后 v2 一次性通过。

### Gate Quality

Gate 一次性通过。Phase 1 的 gate 经验教训（YAML frontmatter 的 `must_fix: 0` 格式）帮助这次全部文件一次性写对。

### Prompt Clarity

Writing-plans skill 对 L1/L2 分级、Execution Groups、Wave Schedule 的指导很详细。但对于"验证已有代码"而非"从零实现"的场景，TDD 模板（"写失败测试 → 实现 → 验证"）略显不适合。Task 2（E2E 闭环验证）和 Task 5（质量评估）本质上是验证/评估任务，不是编码任务，硬套 TDD 模板会有 gap。最终在 Task 2/5 中用了自定义步骤格式，没有被模板强制绑定。

### Automation Gaps

无特别的自动化缺口。但注意到 writing-plans skill 要求同时产出 6 个文件（plan.md + e2e-test-plan.md + test_cases_template.json + use-cases.md + non-functional-design.md + ADR 评估），对于 L1 简单需求来说，use-cases.md 和 non-functional-design.md 的价值密度较低——use-cases 的内容基本是 plan 中 Task 描述的另一种组织方式。

### Time Sinks

Plan review 的第一轮反馈 + plan 修复占了约 30% 的 plan 编写时间（1 个 subagent 调用做 review + 1 次 multi-edit 修复 + 1 个 subagent 调用做 re-review）。如果能在写 plan 时就执行 self-review checklist 中的"spec 覆盖"检查项（而非写完再 review），可以减少一轮迭代。
