---
phase: spec
verdict: pass
---

# Phase 1 (Spec) Retrospect — skill-state-tracker

## 1. Phase Execution Review

### Summary

完成了 skill-state-tracker 扩展的 spec 设计。核心产出：4 状态状态机（loaded/error/completed/recorded）+ 3 个事件 hook（tool_call、turn_end、before_agent_start）+ 1 个 skill_state 工具。关键决策：Hook 自动检测 skill 加载（不依赖 AI 元认知）、混合注入策略（before_agent_start 首次 + turn_end 提醒）、依赖 subagent 工具而非 programmatic spawn。

### Problems Encountered

1. **Review v1 三条 MUST_FIX**：状态机转换矩阵缺失、FR-4/FR-5 因果顺序矛盾、"上下文摘要"不可实现。三条都是真实的设计缺陷，review 质量高。修复后在 v2 通过。
2. **before_agent_start 的 timing 限制**：最初设计只考虑 before_agent_start 做提醒，分析后发现它只在 agent loop 入口触发一次，无法在 loop 内 10 turn 时注入。改为混合策略后才解决。

### What Would You Do Differently

- 状态机转换矩阵应该在 FR-2 初版就写完整，而不是依赖 review 发现。2×3 矩阵加一个合法性表是低成本高价值的信息。
- 因果顺序（steering 注入 → AI 调 subagent → AI 调 skill_state(recorded)）应该在设计讨论时就明确，而不是在两个 FR 中隐含相反的顺序。

### Key Risks for Later Phases

- **提示词有效性**：让 AI 正确流转状态依赖提示词质量，这是最大的不确定性。plan 阶段需要为提示词模板设计验证方案。
- **10 turn 提醒的时机**：turn_end + sendMessage(steer) 的组合在 Pi 运行时中的实际行为需要在 dev 阶段实测验证。
- **subagent 任务 prompt 的质量**：FR-4 要求 AI 自行构造 subagent prompt，这个 prompt 的质量直接影响问题记录的有用性。

## 2. Harness Usability Review

### Flow Friction

- Gate 因 untracked files 失败一次，需要手动 `git add -A && git commit`。这是已知流程，不意外但总是多一步。
- Brainstorming skill 的 10 步 checklist 对本需求偏重。需求已经有完整的设计调研文档（skill-state-tracker-design.md），提问空间有限。大部分 step 是"确认设计"而非"探索需求"。

### Gate Quality

- Gate 正确识别了 untracked files 问题，无 false positive。
- Review subagent 的三条 MUST_FIX 都是真实问题，质量高。特别是因果顺序矛盾这种跨 FR 一致性问题，人工容易遗漏。

### Prompt Clarity

- Brainstorming skill 的 "Ask clarifying questions" 步骤与"需求已有设计文档"的场景匹配度低。skill 假设从零开始探索，但本需求已有详尽的 ADR 级别设计文档。实际执行中跳过了 Step 2-4 的大部分提问，直接进入设计确认。
- 建议增加 "design-refinement" 快速路径：当需求附有设计文档时，直接进入 assumption audit + spec writing。

### Automation Gaps

- Context.md / ADR 检查是手动执行的。对于本需求（无新术语、无新 ADR），检查结果是空的，但仍然需要走一遍流程。

### Time Sinks

- API 扫描 subagent 耗时较长（扫描了 4 个扩展的代码 + types 目录），但产出了高质量的 API 参考，直接支撑了 spec 写入和 assumption audit。值得。
