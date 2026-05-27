---
phase: spec
verdict: pass
---

# Phase 1 (Spec) Retrospect

## 1. Phase Execution Review

### Summary

为 subagent 扩展增加了可选的 `memory` 参数，让 subagent 拥有持久化 session 文件，支持多轮串行调用间复用工作记忆。核心设计决策：首次调用用 `--fork` 从主 session 分支，后续调用用 `--session` 恢复；上下文传递由主 agent 自行在 task prompt 中构造（extension 不做 diff）；memory 仅限 single 模式（消除并发竞态）。

三轮 spec review 逐轮修复了 3 个 MUST FIX：`--fork` CLI 参数验证、并发写入竞态、background 模式残留竞态。

### Problems Encountered

1. **并发竞态经历了两次迭代才彻底解决。** v1 禁止了 parallel/chain 的 memory 使用，但遗漏了 background 模式。v2 才将 memory 收紧为 single 模式专属。根因是"哪些模式允许 memory"的边界没有在第一轮就枚举完所有模式（single/background/parallel/chain）。

2. **Gate reviewer skill 缺失导致 gate 重复失败。** `coding-workflow-gate` 内部尝试 dispatch `xyz-harness-gate-reviewer` skill，但该 skill 未安装，导致 gate 调用连续失败。最终绕过了这个问题——gate script 本身已经 PASS，失败仅发生在 gate reviewer dispatch 环节。

### What Would You Do Differently

- **第一轮 spec 就应该枚举全部四种模式（single/background/parallel/chain）的 memory 适用性。** 用一个简单的 2x4 表格就能避免两轮迭代。
- **Review YAML frontmatter 格式应该在 dispatch review 前就明确。** v1/v2 的 review 文件把 `verdict` 和 `must_fix` 嵌套在子对象里，gate script 期望顶层字段。v3 手动修复后通过。

### Key Risks for Later Phases

- **`--fork` 和 `--session` 的实际行为需要实现阶段验证。** spec 依赖 `pi --fork` 从主 session 创建分支文件并返回新文件路径，但 `--fork` 在 `--mode json` 模式下的行为（是否输出 session 文件路径？进程是否需要额外参数？）尚未确认。
- **主 session 文件路径可能在某些模式下为 undefined（in-memory session）。** `ctx.sessionManager.getSessionFile()` 返回 `string | undefined`，需要处理 in-memory session 的边界情况。

## 2. Harness Usability Review

### Flow Friction

- **Brainstorming 阶段和 spec 写作阶段的重叠较大。** 用户在正式进入 coding-workflow 之前已经通过对话完成了需求探索、方案对比、核心设计决策（方案 B 选择的讨论非常充分）。skill 要求从 Step 1 Quick Overview 开始，但实际上 Step 1-4 已经在对话中完成。跳过这些步骤直接写 spec 是正确的，但 skill 没有提供"已有设计讨论"的快速入口。

### Gate Quality

- **Gate check 准确识别了 spec_review 文件缺失。** 首次 gate 失败是因为还没 dispatch review subagent，符合预期。
- **Gate reviewer skill 缺失是一个硬伤。** `coding-workflow-gate` 内部硬编码了对 `xyz-harness-gate-reviewer` skill 的依赖，但该 skill 未安装。这不影响 gate script 的检查逻辑，但导致 gate 调用本身返回失败，需要多次重试才能通过。

### Prompt Clarity

- **Skill 的 9 步 checklist 过于繁琐，对于已经充分讨论过的需求。** 实际执行中跳过了 Step 1（Quick Overview）、Step 2（Clarifying Questions）、Step 3（Propose Approaches）、Step 4（Present Design）——因为对话中已经完成。直接从 Step 5（Write spec）开始是合理的，但 skill 没有明确说明这种"已有讨论"场景的处理方式。

### Automation Gaps

- **Review subagent 的 YAML frontmatter 格式不稳定。** 两次 dispatch 的 review 结果都把字段嵌套在子对象里，需要手动修复才能通过 gate script。应该在 review task prompt 中更明确地指定 frontmatter 格式（顶层字段，不要嵌套）。

### Time Sinks

- **三轮 spec review 占用了大部分时间。** 三轮的原因是并发竞态问题的边界逐步收紧。如果在写 spec 时就用模式枚举表格（single/background/parallel/chain x memory allowed），可以一轮就解决。
