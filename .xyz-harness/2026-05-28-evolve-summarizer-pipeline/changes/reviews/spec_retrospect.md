---
phase: spec
verdict: pass
---

# Phase 1 Retrospect: Evolve Summarizer Pipeline

## 1. Phase Execution Review

### Summary

完成了 evolution engine 的 spec 设计。核心决策：在 Python analyzer 和 LLM Judge 之间插入 TypeScript summarizer 层，将 745KB 原始报告压缩为 ~5KB 信号摘要。同时引入 metrics-history 趋势追踪和 effect-tracker 效果闭环。

spec 经过两轮独立审查，3 条 MUST FIX 全部修复后通过。

### Problems Encountered

1. **spec_review v1 的 YAML frontmatter 嵌套问题**：subagent 生成的 review 把 `verdict` 和 `must_fix` 放在嵌套对象（`review:` / `statistics:`）中，而 gate 脚本的 `_flatten_review_fields` 优先读顶层字段。v2 的 frontmatter 同样如此。手动修复为顶层 `verdict: pass` + `must_fix: 0`，gate 才通过。
   - **根因**：review 输出格式规范不够明确，subagent 按"结构化"直觉嵌套了 YAML，而 gate 脚本期望扁平 frontmatter。
   - **影响**：浪费 1 轮 gate check + 手动修复。

2. **WIP 文件混入 git add**：`git add -A` 把 evolution-engine/ 下的未提交修改（index.ts、judge.ts 等，属于之前调试的残留）也带进了 commit。用 `git stash` 拆分后才干净提交。
   - **改进**：以后 commit 前先 `git status --short` 检查，避免带入无关文件。

3. **第一轮 spec 有 3 条 MUST FIX**：Task Breakdown 缺失、约束与 FR 矛盾、top-N 参数未定义。说明初版 spec 写得比较粗糙，缺少"写给实现者看"的视角。
   - **改进**：写 spec 时应该同时问自己"实现者拿到这个能直接开工吗？"——参数、矛盾、边界都要提前想清楚。

### What Would You Do Differently

- spec 初版就应该包含 Task Breakdown 和具体参数值，不需要等 review 指出才补
- review frontmatter 格式应该在 spec 写完时就按 gate 要求的扁平格式生成，而不是嵌套结构

### Key Risks for Later Phases

1. **Summarizer 压缩效果验证**：spec 说 745KB → 10KB，但实际压缩比取决于数据分布。plan 阶段需要用真实数据验证。
2. **LLM Judge 对新格式的响应质量**：从原始 JSON 换成信号摘要后，Judge 是否还能产出高质量建议，需要实测。
3. **Effect Tracker 的快照关联**：history.jsonl 中增加 `metricsSnapshotDate` 字段，需要确保 apply 时 metrics-history 已有数据。

## 2. Harness Usability Review

### Flow Friction

- **脑暴跳步**：由于前面已经做了充分的调研和讨论（rethink + 搜索调研），进入 Phase 1 时需求已非常明确。brainstorming skill 的 Step 1-4（Quick Overview → Clarifying Questions → Propose Approaches → Present Design）几乎被跳过，直接写 spec。这合理（避免重复讨论），但说明 skill 对"已有设计共识"的场景缺少 fast-path。
- **Gate 检查需要单独跑**：gate 脚本需要在特定目录结构下运行，路径参数较长，容易打错。

### Gate Quality

- **Gate 检查有效**：untracked files 检查发现了 evolution-engine/ 的 WIP 文件混入，must_fix 检查正确识别了 v1 的 3 条问题。
- **False positive**：v2 review 的 `must_fix: 3`（在 statistics 嵌套下）被 gate 读为 must_fix=3（未通过），实际这是"总共 raised 3 条"而非"未解决 3 条"。gate 脚本对嵌套 YAML 的 must_fix 语义解析不够精确——它应该读 `must_fix_unresolved` 而非 `must_fix`。

### Prompt Clarity

- **brainstorming skill 过重**：对于已有设计共识的场景，skill 要求走完 Quick Overview → Questions → Approaches → Design → Write → Review 全流程，步骤冗余。但作为通用 skill 可以理解。
- **review subagent 的 frontmatter 格式要求**在 skill 描述中是清晰的（给出了模板），但 subagent 没有严格遵循扁平格式。

### Automation Gaps

- **GC 检查无自动化**：gate 脚本不检查 reports/signals 目录的 GC 逻辑是否被实现。这些是 spec 的 AC-6 要求，但 gate 无法验证。
- **review frontmatter 格式校验**：gate 只检查 `verdict` 和 `must_fix` 字段的存在性和值，不检查是否在正确的嵌套层级。可能导致通过/失败判断错误。

### Time Sinks

- **搜索调研耗时较长**：tavily 搜索 3 轮 + anysearch 搜索 1 轮 + arxiv 内容提取，总共约 5 次 API 调用。但这是必要的——调研产出的结论直接决定了架构设计方向。
- **Review frontmatter 修复**：手动修 YAML 嵌套问题，约 5 分钟。如果 review 输出格式规范更明确，可以避免。
