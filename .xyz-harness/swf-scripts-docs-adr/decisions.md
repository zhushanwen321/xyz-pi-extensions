---
topic: swf-scripts-docs-adr
created_at: 2026-07-10
---

# 决策账本 — swf-scripts-docs-adr

> 本 topic 的 append-only 决策账本。mid 全程沿用 full 的机制（见 loop-skeleton.md Step 1.2 schema）。

## 跨 topic 总纲引用

本 topic 是「subagent + workflow 合并 → pi-subagents-workflow」三 topic 拆分的 T3（预制脚本 + 文档/ADR）。
跨 topic 决策（已由 T1/T2 确认，不可推翻）：

- **合并为一包** `@zhushanwen/pi-subagents-workflow`（D-000 已确认）
- **旧两包原样保留**，T3 负责 deprecated 标记 + CHANGELOG 迁移指引（D-004 已确认）
- **executeAndAwait 已在 T1 实现**，workflow() 函数已在 T1 实现（D-007/D-008 已确认）
- **sync 模式已删除**，并发池已改为分层配额 maxConcurrent=6（T2 已确认）
- **通知机制已统一**为 pending:unregister EventBus 事件（T2 已确认）
- **ADR-026/029 标 superseded**（由 T3 负责写 ADR-030）

## 决策账本（append-only，一行一条决策）

| id | decision | rationale | classification | confirmed_by | stage | source | status | superseded_by |
|----|----------|-----------|----------------|--------------|-------|--------|--------|---------------|
| D-030 | 维持 mid 工作流（T3 评分 11 分 L1 边界） | 保持三主题一致性；ADR-030 需 L2 级架构审视；review-fix-loop 保证文档质量 | `D-不可逆` | `ask_user` | `clarity` | `[from: 范围守门]` | `confirmed` | |
| D-031 | 预制脚本为纯参考模板（用户复制修改） | workflow 脚本是 JS 代码，参数化会让模板复杂化；用户复制后自由修改更灵活 | `D-不可逆` | `ask_user` | `clarity` | `[from: M-2]` | `confirmed` | |
| D-032 | scatter-gather 和 map-reduce 分开为 4 个模板 | 语义不同：scatter-gather 强调数据分片，map-reduce 强调变换+聚合；分开更清晰 | `D-不可逆` | `ask_user` | `clarity` | `[from: M-2]` | `confirmed` | |
| D-033 | ~~ADR-029 完全 superseded by ADR-030~~ | ~~原决策：整个 ADR-029 标记 superseded~~ | `D-不可逆` | `ask_user` | `clarity` | `[from: M-3]` | `superseded` | D-033R |
| D-033R | [REVISIT of D-033] ADR-029 部分 superseded by ADR-030：仅 worktree编排(决策2)被取代；per-call cwd(决策1)显式标注仍有效；决策3-6(cw调用/plan.json schema/test状态机/SQLite WAL)与合并正交仍有效 | 架构 review 代码实证：ADR-029 决策1（per-call cwd）在 types.ts:417/subagent-service.ts:302/pi-runner.ts:89 等处已实现且仍活跃。完全 superseded 会丢失可追溯性。部分 superseded 保完整归属链 | `D-不可逆` | `ask_user` | `clarity` | `[from: 架构 review MF-2]` | `confirmed` | |
