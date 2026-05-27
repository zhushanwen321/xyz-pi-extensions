---
phase: spec
verdict: pass
---

# Spec Phase Retrospect — self-evolution-phase3

## 1. Phase Execution Review

### Summary

完成了 evolution-engine Extension 的 spec 设计，合并了原规划 Phase 3 + 4 + 5.5 为一个 spec。产出物包括：
- `spec.md`：8 个 FR、7 个 AC、3 个 UC、完整的 Constraints 和 Out of Scope
- `CONTEXT.md`：新增 EvolutionEngine 术语节（7 个术语）
- `docs/adr/006-llm-judge-subprocess.md`：LLM Judge 子进程架构决策
- `CLAUDE.md`：更新 child_process 例外声明
- `spec_review_v1.md`（fail）→ 修复 7 个问题 → `spec_review_v2.md`（pass）

关键决策：
1. 合并 Phase 3/4/5.5 为一步到位交付，避免了中间产物（独立 evolution_report tool）的浪费
2. LLM Judge 运行在独立 Pi 子进程中，保证模型质量一致性（glm-5.1 硬编码）
3. 自动触发规则选择保守型：3 条硬编码、仅提示不执行、session_start 时检查
4. Phase 2 报告不存在时自动执行 analyze.py，减少用户手动步骤

### Problems Encountered

**P1: child_process.spawn 架构约束冲突（MUST FIX）**

第一轮 spec review 发现 spec 声明"直接使用 child_process.spawn"与 CLAUDE.md "subagent 是已知例外"冲突。evolution-engine 不是 subagent extension，不能借用已有例外。

修复方式：将 evolution-engine 声明为第二个 child_process 例外，在 CLAUDE.md 中更新约束文本。这与 subagent 的例外理由一致——两者都是通过 spawn 启动独立 Pi 进程做 LLM 推理。

根因：在设计讨论中，用户和 AI 都默认 extension 可以 spawn 子进程（因为 subagent 已经这样做了），但忽视了 CLAUDE.md 的约束文本只提到了 subagent。这反映了"代码已经做了但文档没跟上"的常见问题。

**P2: 除零风险和边界条件遗漏**

第一轮 review 指出 FR-7 自动触发规则在无历史数据时存在除零问题、AC-1 的"至少 1 条建议"在数据不足时无法通过、临时文件路径未指定。这些是 spec 编写时的盲点——过于关注 happy path 而忽略了冷启动和空数据场景。

### What Would You Do Differently

1. **先检查约束再写 spec**：在写 Constraints 章节时就应该 grep CLAUDE.md 中的 child_process 相关约束，而不是在 review 阶段才被发现。这能节省一轮 review 轮次。
2. **冷启动场景应作为 checklist 项**：每次写 FR 涉及数值比较时，自动检查"分母为 0 怎么办"、"数据不存在怎么办"。

### Key Risks for Later Phases

1. **LLM Judge prompt 质量**：spec 定义了 schema 但没有定义具体的 prompt 内容。Phase 2 (plan) 需要决定 prompt 模板是写在 spec 里还是留给 dev 阶段迭代。建议在 plan 中明确 prompt 模板是可迭代的，不需要在第一版就追求完美。
2. **TUI 审批交互**：spec 只描述了"逐条展示，y/n/e 决策"，没有定义具体的 TUI 组件和布局。Pi 的 TUI 能力有限，Phase 3 (dev) 可能发现某些交互模式无法实现。
3. **信号数据量**：Phase 2 的回顾性分析 JSON 约 60KB。LLM Judge 子进程需要读取这个 JSON 并分析。如果数据量过大，可能需要在 plan 阶段设计数据裁剪策略。

## 2. Harness Usability Review

### Flow Friction

**用户需求重构**：原始需求是"看看 phase3 要做什么"，但经过一轮讨论后用户决定重新评估 Phase 3/4/5 并合并。这导致 brainstorming 阶段的流程发生了偏移——从"理解已有规划"变成"重新设计架构"。Harness 的 brainstorming skill 没有覆盖这种"需求在讨论中被重构"的场景，但实际执行中处理得还算自然。

**多轮用户确认**：brainstorming skill 要求"one question at a time"，但这个 spec 的决策点较多（scope、auto-trigger 程度、架构选择），导致需要 5-6 轮问答才能收敛到可写 spec 的状态。这是正常的，但感觉可以更紧凑——比如把 scope 和 auto-trigger 合并为一轮多选。

### Gate Quality

Gate 在第一轮 review 中正确识别了 MUST FIX 问题（child_process 约束冲突）。review subagent 还发现了 4 个 LOW 和 2 个 INFO 问题，质量较高。所有 7 个问题的修复方向都清晰可操作。

没有 false positive。review 花了约 2.4k output token，性价比合理。

### Prompt Clarity

Brainstorming skill 的步骤指引清晰：overview → 提问 → 方案 → 设计 → 写 spec → review → terminology/ADR。唯一的不明确点是"什么时候停止提问开始写 spec"——skill 说"If you can describe the full solution back to the user without guessing"，这个判断标准依赖 AI 的自觉性。

### Automation Gaps

1. **CONTEXT.md 更新需要手动**：术语更新应该可以在 spec 写完后自动提取候选术语。
2. **ADR 评估需要人工判断**：三个条件（难以逆转/会惊讶/真实权衡）需要 AI 判断，无法自动化。但这次只创建了 1 个 ADR，判断过程不耗时。
3. **CLAUDE.md 约束检查**：spec review 发现的 child_process 冲突本可以在写 spec 时自动检测（grep CLAUDE.md for "child_process"）。

### Time Sinks

1. **架构讨论**（5 轮问答）：用户要求画整体架构图，这是最耗时的部分。但产出价值高——架构图直接澄清了"Pi 是入口不是容器"的核心认知。
2. **spec review 修复**（1 轮 fail → 1 轮 pass）：7 个问题的修复本身不耗时，但 dispatch subagent + 等待结果增加了 2 个 turn。
