---
phase: spec
verdict: pass
---

# Phase 1 (Spec) Retrospect — goal-staleness-reminder-auto-clear

## 1. Phase Execution Review

### Summary

为 Goal 扩展新增 4 项功能：终态自动清理（2 轮后）、task/subtask 停滞提醒（10 turn 阈值）、subTodo→subtask 命名统一、`/goal history` 历史查看。Spec 经过 2 轮审查通过。

关键决策：
- 计数基准选 `turn_end` 粒度（与 skill-state 一致），放弃统一三个扩展的计数器（语义不同，强行统一增加复杂度）
- 提醒时机选 `before_agent_start`（与 todo/skill-state 模式一致），注入方式用 return message（不额外消耗 turn）
- 命名迁移视为破坏性变更但可接受——AI 的 prompt 由 promptGuidelines 自动覆盖

### Problems Encountered

1. **Spec v1 被打回 3 条 MUST FIX**：提醒范围 FR-2 正文与 AC-2 矛盾、auto-clear 与 history 数据生命周期冲突、终态 widget 行为歧义。三个问题都是真实的设计遗漏，review 质量高。
2. **跨扩展通信的误解**：用户最初提到"todo 提醒更新 goal"，我误读为跨扩展功能。用户纠正后聚焦到 goal 内部的停滞提醒，简化了设计。

### What Would You Do Differently

- **FR-2 的提醒范围应该在第一版就写明确**。"只提醒最小编号"和"列出所有"之间的犹豫不应该残留在 spec 里。
- **快照机制应该在 FR-4 初稿中就定义完整**，而不是只提"保留快照"让实现者猜测。

### Key Risks for Later Phases

1. **命名迁移影响面大**：state.ts + index.ts + templates.ts + commands.ts + widget.ts 中约 30+ 处 `subTodo` 引用需要机械替换，且 `deserializeState` 必须兼容旧字段名。plan 阶段需要列出所有文件的所有变更点。
2. **`_render` 协议破坏**：xyz-agent GUI 依赖 `_render.data` 中的字段名，命名迁移后 GUI 侧需配套更新。这不是本项目的职责，但需要明确标记为外部依赖。
3. **goal-history entry 的 GC**：spec 说"最多保留 20 条"但实现时需要在 reconstructState 中做清理逻辑，容易遗漏。

## 2. Harness Usability Review

### Flow Friction

Phase 1 流程顺畅。用户在 brainstorming 阶段已经充分讨论了需求和设计决策（计数器选型、注入时机、命名统一），进入 spec 编写时假设已经清晰。

### Gate Quality

Review subagent 发现的 3 条 MUST FIX 都是真问题，没有误报。特别是"auto-clear 与 history 数据冲突"这条——如果没有 review，实现时才会发现 clearGoalSession 和 history 读数据的时序矛盾。v2 修复后一次通过，说明 review 的反馈足够精确。

### Prompt Clarity

brainstorming skill 的流程引导有效——特别是"计数器能否统一"的讨论，虽然最终结论是"不统一"，但这个讨论避免了实现时才发现语义冲突。

### Automation Gaps

无显著自动化缺失。spec review 的 dispatch → fix → re-dispatch 循环已自动化。

### Time Sinks

计数器统一的分析占了较多讨论时间（三个扩展的计数语义对比、粒度分析、统一方案评估），最终结论是"不统一"。如果一开始就能判断"语义不同的计数器不应统一"，可以省掉这部分。但这属于必要的探索——不分析就无法得出结论。
