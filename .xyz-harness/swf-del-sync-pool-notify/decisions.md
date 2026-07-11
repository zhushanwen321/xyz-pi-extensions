---
topic: swf-del-sync-pool-notify
created_at: 2026-07-10
---

# 决策账本 — swf-del-sync-pool-notify

> 本 topic 的 append-only 决策账本。mid 全程沿用 full 的机制（见 loop-skeleton.md Step 1.2 schema）。

## 跨 topic 总纲引用

本 topic 是「subagent + workflow 合并 → pi-subagents-workflow」三 topic 拆分的 T2（删sync + 并发池分层 + 通知合并）。跨 topic 决策（已由 T1 确认，不可推翻）：

- **合并为一包** `@zhushanwen/pi-subagents-workflow`（D-000 已确认）
- **旧两包原样保留、不标记 deprecated；deprecated 标记与清理由 T3 负责**（D-004 已确认）
- **executeAndAwait 已在 T1 实现**（D-007/D-008 已确认）
- **双重记账一致性由本 topic (T2) 处理**（D-009 已确认）

## 决策账本（append-only，一行一条决策）

| id | decision | rationale | classification | confirmed_by | stage | source | status | superseded_by |
|----|----------|-----------|----------------|--------------|-------|--------|--------|---------------|
