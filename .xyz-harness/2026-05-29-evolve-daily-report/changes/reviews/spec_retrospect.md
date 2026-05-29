---
phase: spec
verdict: pass
---

# Phase 1 Retrospect — Evolve Daily Report

## 1. Phase Execution Review

### Summary

将用户"evolve 每天自动执行，产出报告"的需求转化为 spec。核心产出：

- **spec.md**: 6 个 FR（自动触发、并发保护、报告生成、查看命令、pending 增量合并、GC 扩展），11 个 AC，6 个 task
- **spec_review_v1.md**: 4 个 MUST_FIX（均已在 spec 中解决）+ 8 个 LOW

关键设计决策：
1. fire-and-forget 异步执行而非阻塞 session_start
2. lock 文件 + temp-file-rename 防并发
3. title 精确匹配去重，30 条容量上限
4. `.last-run-status` 解决静默失败不可诊断问题
5. 与 monitor.ts 共存（实时警报 vs 每日深度体检）

### Problems Encountered

1. **未提交改动的理解成本**：9 个文件的 diff 量大（292+/184-），需要逐文件阅读才能理解 instruction-based 重构的全貌。好在 diff 内聚性高（统一将 diff→instruction），理解成本可控。

2. **Gate 反复失败 4 次**：
   - 第 1 次：untracked files + verdict=pending + 缺少 spec_review
   - 第 2 次：spec_review 仍找不到（文件放在了错误位置——根目录而非 `changes/reviews/`）
   - 第 3 次：review 文件含反引号导致 YAML 解析错误
   - 第 4 次：severity 用了 CRITICAL/MINOR 而非 gate 期望的 MUST_FIX/LOW；must_fix 统计数应为 0（全 resolved）

   累计 4 次 gate 重试，消耗了不必要的 turn。

3. **Review 格式猜测成本**：没有 gate 对 review 文件格式的明确文档，需要通过查看相邻项目的 review 文件来推断格式要求（YAML frontmatter + 必需字段如 `must_fix`、`status`、`raised_in_round`）。

### What Would I Do Differently

1. **先把 review 模板读出来再写**：在写 review 之前就读一个已通过的 review 文件作为格式参考，而不是先写 Markdown 自由格式再反复修格式。一次通过 vs 四次重试。

2. **Gate 失败模式预先了解**：如果提前知道 gate 对 review 文件的检查项（frontmatter 格式、verdict 值、severity 枚举值、must_fix 统计），就不需要反复试错。

### Key Risks for Later Phases

1. **并发安全实现复杂度**：lock 文件 + PID 检查 + stale lock 清理在 plan/dev 阶段需要注意边界条件
2. **fire-and-forget 的错误可观测性**：异步执行意味着错误只能通过日志和 `.last-run-status` 追踪，测试覆盖需要特别关注
3. **pending.json 增量合并的边界情况**：title 去重、容量淘汰、与手动 `/evolve` 的 pending 覆盖冲突

## 2. Harness Usability Review

### Flow Friction

**Gate 的 review 文件格式要求是最大的摩擦点**。4 次 gate 失败中有 3 次是 review 文件格式问题（位置、YAML 语法、字段枚举值），而非 spec 内容问题。这拉长了 spec phase 但没有提升 spec 质量。

### Gate Quality

- spec.md 的 `verdict: pending → pass` 检查是合理的
- untracked files 检查有用（提醒 git add）
- 但 review 文件的格式检查过于严格且缺乏文档说明——AI 需要通过试错来发现正确的 severity 枚举值（CRITICAL→MUST_FIX, MINOR→LOW）和统计字段语义（`must_fix: 0` 表示"没有未解决的 MUST_FIX"，而不是"没有 MUST_FIX 被 raised"）

### Prompt Clarity

Phase 1 的 prompt 和 skill 指引是清晰的。`/evolve` 命令的使用和现有架构的分析没有歧义。

### Automation Gaps

1. **Review 文件格式验证可以自动化**：一个 `validate-review-format.sh` 脚本可以在写完 review 后立即检查格式，而不是等到 gate 才发现错误
2. **Review 模板注入**：gate 检查或 phase-start 可以自动注入一个 review 文件模板到工作目录，避免格式猜测

### Time Sinks

1. **Gate 格式试错**：占用了 spec phase 约 40% 的 turn 数（4 次 gate 调用 + 格式修复）
2. **未提交 diff 的理解**：虽然必要，但 9 个文件的 diff 阅读花了较多时间。好在 CLAUDE.md 的约束"写之前先读"让这是必须的投入
