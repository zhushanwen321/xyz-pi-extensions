---
phase: spec
verdict: pass
---

# Phase 1 Retrospect — Evolve Daily Report

## 1. Phase Execution Review

### Summary

将用户"evolve 每天自动执行，产出报告"的需求转化为 spec。产出物：

- **spec.md**: 5 个 FR（自动触发+并发保护、报告生成、查看命令、pending 增量合并、GC 扩展），11 个 AC，6 个 task
- **spec_review_v1.md**: 4 个 MUST_FIX（均在 spec 更新中解决）+ 8 个 LOW

关键设计决策：fire-and-forget 异步执行、lock 文件防并发、title 精确匹配去重、`.last-run-status` 诊断静默失败、与 monitor.ts 共存。

### Problems Encountered

**1. Compact 连续 3 次失败**

gate 已通过、retrospect 已写入、代码已推送，但 compact 连续 3 次失败导致 phase advancement 反复回滚。每次回滚后需要在新 session 中重新提交 gate。交付物没有任何变更，纯浪费的 round-trip。

**2. Gate review 格式试错（首次 session 中 4 次失败）**

gate 对 review 文件的 YAML frontmatter 格式要求没有文档：severity 枚举值（MUST_FIX/LOW 而非 CRITICAL/MINOR）、`must_fix` 统计语义（"未解决数"而非"总 raised 数"）、文件必须放在 `changes/reviews/` 下。全部通过试错发现。

**3. 未提交 diff 的理解成本**

9 个文件 292+/184- 的 diff（instruction-based 重构），需要逐文件阅读。好在 diff 内聚性高。

### What Would I Do Differently

1. **先读已通过的 review 文件当模板**，一次通过而非四次试错
2. **Compact 问题不在 spec phase 能控制范围内**，但 harness 应对 compact 失败有更好的恢复机制（检测已有交付物，跳过重做）

### Key Risks for Later Phases

1. 并发安全 lock 机制的边界条件（stale PID、OS PID 复用）
2. fire-and-forget 的错误可观测性（异步执行，只能靠日志和 `.last-run-status`）
3. pending.json 增量合并与手动 `/evolve` 的 pending 覆盖冲突

## 2. Harness Usability Review

### Flow Friction

**Compact 失败循环是最大问题**。3 次 compact 失败 → 3 次 phase 回滚 → 3 次重新提交 gate。每次 gate 本身通过，但 phase 状态被重置。这不在 spec phase 控制范围内，但严重影响了体验。

**Review 文件格式试错**是第二大摩擦。4 次 gate 失败全是格式问题，不是内容问题。

### Gate Quality

- spec.md 的 verdict/untracked 检查准确有用
- review 文件格式检查正确但过于严格且缺乏文档
- gate 行为一致：每次提交都返回相同结果，无状态残留

### Prompt Clarity

Phase 1 skill 指引清晰，spec 模板六要素结构完整。没有歧义。

### Automation Gaps

1. **Review 格式模板注入**：phase-start 时自动注入 review 文件模板，避免格式猜测
2. **Compact 失败恢复**：harness 应检测已有交付物（spec.md + review + retrospect 都在且已推送），跳过重做
3. **Gate 幂等性标记**：gate 通过后写一个 `.gate-passed` 标记文件，compact 失败后直接跳到下一阶段

### Time Sinks

1. **Compact 失败循环**：3 次额外 session 启动 + gate 提交，占整个 spec phase 总 turn 数的 ~50%
2. **Gate 格式试错**：占首次 session ~40% turn 数
