# Retrospect — prompt-quality-batch3

## 概述

第三批 prompt 质量改进，5 项改动覆盖：scout bash 黑名单、oracle/reviewer 职责 defer、context-builder/planner 输出载体互斥、workflow-script 工具描述增强。

## 做对了什么

1. **设计先行**：在进入 CW 流程前完成了完整的 5 项决策设计，包括用户拍板 scout bash 权限方向（保留 bash + 黑名单 vs 移除 bash）。plan 阶段零迭代通过。

2. **subagent 并行**：W1（5 个 .md）和 W2（1 个 .ts）无依赖，用 2 个 subagent 并行实现，主 agent 收集 commitHash 统一提交。总耗时约 3 分钟。

3. **对抗性 review 发现真实问题**：
   - should_fix: W2 anti-pattern 用 `sequential` 但工具实际叫 `chain` — 术语分裂会导致 agent 按措辞找不到内置 workflow
   - nit: scout 黑名单遗漏 `git switch`/`git clean`/`npm ci`/`curl`/`wget`
   - nit: `cp (overwrite)` 限定词暗示非覆盖 cp 可跑
   - 全部在 review 阶段修复，没流到 test 阶段才暴露

4. **TDD 红绿循环**：测试先写，跑确认 1 个 fail（scout 保留了旧措辞），修后再跑全绿。20 个新测试覆盖全部 5 个 testCase。

## 教训

### scout.md 措辞重复（测试捕获）

W1 subagent 替换白名单时保留了 L11 的 "Your bash access is for exploration only" 作为引导句，与 L13 黑名单标题语义重复。测试 `not.toContain("Your bash access is for exploration only")` 捕获了这个问题。

**根因**：subagent 做文本替换时倾向于"最小改动"（只替换明确指出的段落），不会主动清理语义重复的残留。

**防范**：prompt 类改动的测试应该同时断言"新内容存在"和"旧内容不存在"，而不是只断言前者。

### deprecated 包的副本不处理（有意决策）

`extensions/subagents/agents/` 存在内容相近的副本（旧 deprecated 包）。有意不改，避免双副本同步负担。AGENTS.md 已标注 ADR-030 deprecated。如果未来有人误用旧包，prompt 质量差异是可接受的降级。

## 延迟项

无。本批 5 项全部完成。先前批次 1/2 的延迟项（subagent-service.ts 拆分、xyz-agent 侧流式传输）仍在独立轨道。

## 量化

- commits: 4（W1 + W2 + review fix + test）
- 文件改动: 7（5 agent .md + 1 .ts + 1 test）
- 测试: 954 passed（含 20 新增）
- 环路时间: ~15 分钟（create → closeout）
