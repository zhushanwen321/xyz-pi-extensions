---
phase: plan
verdict: pass
absorbed: false
topic: "2026-06-02-peekhour-model-switch"
harness_issues:
  - "gate check 对 untracked files 报错但没在 pre-check 阶段提醒，导致需要额外 commit+push+retry 循环"
  - "plan review subagent 返回结果后触发 needs_attention 信号，即使 subagent 已正常完成。误报噪音"
---

# Phase 2 Retrospect: Plan

## 1. Phase Execution Review

### Summary

基于 Phase 1 的 spec（已确认方案 B：数据+规则注入），编写了完整的 L1 实现计划。6 个 Task 覆盖 6 个文件的改动，线性依赖链（types → config → advisor → prompt → index → setup），单 Execution Group（BG1）。同步产出了 e2e-test-plan、test_cases_template、use-cases、non-functional-design 四个附加交付物。

关键设计决策：
- 全部 L1 复杂度——无前后端分离、无新存储、无跨服务通信
- 删除推荐引擎（3 个核心函数 + 5 个辅助函数）是净减代码操作，替换为 3 个纯数据提取函数
- 粘性信息从 advisor 内部类型提升为导出接口（StickinessInfo 增加 justCompacted）

### Problems Encountered

1. **Gate untracked file 报错**：plan review subagent 写入了 `plan_review_v1.md`，gate 检测到 untracked file 报 FAIL。需要额外 commit + push + retry。问题在于 review 文件是 subagent 产出的，主 agent 在 gate 前没有 stage 它。

2. **Subagent needs_attention 误报**：plan review subagent 正常返回结果后，系统仍然发送了 `needs_attention` 信号。查看 status 已完成，无需操作。这是噪音。

### What Would I Do Differently

- 在 dispatch review subagent 之前，先 `mkdir -p` 确保 reviews 目录存在（虽然 write 工具会自动创建）
- 在 gate 前统一 `git add -A` 检查 untracked files，而不是等 gate 报错再修

### Key Risks for Later Phases

- **Task 3（advisor.ts 重写）是最高风险 Task**：删除量大（~200 行），需要确保保留的函数（computeQuotaSnapshot、computeStickiness、parseZaiResetTime）在新类型定义下正确工作
- **Task 4（prompt.ts 重写）需要精确的 token 预算控制**：注入文本过长会浪费上下文窗口
- **无自动化测试**：E2E test plan 全部是 integration test（需要 Pi 运行时），Phase 3 无法用 vitest 验证。只能通过手动启动 Pi 验证

## 2. Harness Usability Review

### Flow Friction

- **Gate untracked file 问题是重复出现的摩擦**。Phase 1 gate 也遇到了类似问题（reviewer skill 路径）。Phase 2 是 subagent 产出文件未被 stage。建议 gate 在报错时自动 `git add` 相关文件，或 pre-commit hook 自动 stage `.xyz-harness/` 下的文件。
- **6 个交付物并行写入很顺畅**——没有依赖冲突，每个文件职责清晰。

### Gate Quality

- Gate 检查项全面：文件存在、YAML frontmatter、JSON 有效性、verdict 值、untracked files。
- untracked file 检查是好功能，但报错后需要手动 commit+push+retry 的流程可以优化（自动 stage+commit？）。
- Plan review subagent 质量高：验证了源码级别的细节（cache 字段路径、函数名匹配）。

### Prompt Clarity

- writing-plans skill 的结构化模板很有用（File Structure → Task List → Execution Groups → Coverage Matrix）。
- 对于 L1 级别的项目，很多 L2 专用的章节（interface_chain.json、sub-documents）可以跳过，但 skill 没有明确的 L1 快速路径。部分时间花在了确认"这个真的不需要"上。

### Automation Gaps

- Subagent 产出的文件需要主 agent 手动 stage+commit。如果 coding-workflow 扩展能在 subagent 完成后自动 stage，可以省掉一个 commit cycle。
- Plan review 的"源码交叉验证"步骤（grep 函数名、检查 cache 字段）可以脚本化，不需要 LLM 做这种机械检查。

### Time Sinks

- **Gate retry 循环**（untracked file → commit → push → retry）占用了约 2 轮交互。
- **ADR 评估**是 MUST+Nullable，但本 phase 没有新的架构决策，评估结果是空的。这个步骤的 ROI 很低——对于"不创建 ADR"的情况，一句声明即可，不需要完整的三条件评估流程。
