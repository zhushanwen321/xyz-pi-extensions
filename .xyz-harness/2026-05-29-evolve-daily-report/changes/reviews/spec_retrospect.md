---
phase: spec
verdict: pass
---

# Phase 1 Retrospect — Evolve Daily Report

## 1. Phase Execution Review

### Summary

将用户"evolve 每天自动执行，产出报告"的需求转化为 spec。核心产出：

- **spec.md**: 5 个 FR（自动触发+并发保护、报告生成、查看命令、pending 增量合并、GC 扩展），11 个 AC，6 个 task
- **spec_review_v1.md**: 4 个 MUST_FIX（均已在 spec 更新中解决）+ 8 个 LOW

关键设计决策：
1. fire-and-forget 异步执行，不阻塞 session_start
2. lock 文件 + temp-file-rename 防并发
3. title 精确匹配去重 + 30 条容量上限
4. `.last-run-status` 解决静默失败不可诊断
5. 与 monitor.ts 共存（实时警报 vs 每日深度体检）

### Problems Encountered

**1. Gate 格式试错（4 次失败）**

gate 对 review 文件的格式要求缺乏文档，通过试错发现：
- review 文件必须放在 `changes/reviews/` 下（不是 topic 根目录）
- YAML frontmatter 中 severity 枚举必须是 `MUST_FIX`/`LOW`（不是 `CRITICAL`/`MINOR`）
- `must_fix` 统计语义是"未解决的 MUST_FIX 数量"，全 resolved 时应为 0
- review 内容不能含反引号（YAML 解析器限制）

4 次 gate 重试消耗约 40% 的 spec phase turn 数。全部是格式问题，非内容问题。

**2. Compact 失败导致跨 session 重试**

第一次 gate 通过后，compact 失败，phase advancement 回滚。第二次 session 中重新提交 gate（交付物仍在磁盘上），一次通过。这暴露了 harness 对 compact 失败的容错问题——交付物已经写入并 git add 了，但 phase 状态被回滚。

**3. 未提交 diff 的理解成本**

9 个文件 292+/184- 的 diff，需要逐文件阅读理解 instruction-based 重构。好在 diff 内聚性高（统一将 diff→instruction），理解成本可控。

### What Would I Do Differently

1. **先读一个已通过的 review 文件当模板**：在写 review 之前就读相邻项目的 review 文件，一次通过 vs 四次重试。
2. **Gate 失败模式应预置**：如果 harness 文档中列出 review 文件格式要求（YAML frontmatter 字段、severity 枚举值、统计字段语义），就不需要试错。

### Key Risks for Later Phases

1. **并发安全实现复杂度**：lock 文件 + PID 检查 + stale lock 清理，plan/dev 阶段需注意边界条件
2. **fire-and-forget 的错误可观测性**：异步执行的错误只能通过日志和 `.last-run-status` 追踪，测试覆盖需特别关注
3. **pending.json 增量合并边界**：title 去重、容量淘汰、与手动 `/evolve` 的 pending 覆盖冲突

## 2. Harness Usability Review

### Flow Friction

**Gate review 格式是最大摩擦点**。4 次 gate 失败中 3 次是 review 文件格式问题。没有格式文档，只能通过试错和查看相邻项目推断。

**Compact 失败导致的 phase 回滚是第二个摩擦点**。交付物已完成并写入磁盘，但因为 compact 失败被要求重新执行 gate。好在第二次直接通过了（无需重做工作），但过程让人困惑。

### Gate Quality

- spec.md 的 `verdict: pending → pass` 检查合理
- untracked files 检查有用（提醒 git add）
- review 文件格式检查过于严格且缺乏文档——AI 需要通过试错发现正确的 severity 枚举值和统计字段语义
- gate 第二次执行时（compact 失败后重试）行为一致，没有状态残留问题

### Prompt Clarity

Phase 1 的 skill 指引清晰。brainstorming skill 的步骤明确，spec 模板的六要素结构完整。

### Automation Gaps

1. **Review 文件格式验证可以前置**：phase-start 时注入一个 review 文件模板到工作目录，或 gate 检查失败时给出期望格式的示例
2. **Compact 失败恢复**：compact 失败后 phase 回滚，但交付物仍在磁盘。harness 应检测到已有交付物并跳过重做

### Time Sinks

1. **Gate 格式试错**：占 spec phase 约 40% turn 数
2. **Compact 失败后的重新提交**：额外的 session 启动 + gate 重调，虽然不需要重做工作但消耗时间和 token
