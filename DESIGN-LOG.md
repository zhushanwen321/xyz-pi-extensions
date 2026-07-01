# 设计历史索引

> **跨主题导航**。每主题一行，coding-closeout 收尾时更新状态。
> 新人 / AI 先读本表，再决定深入哪个 topic 或 ADR。

## 主题台账

> 初始录入自 git index 已确认的 topic 目录。实际归档状态待 coding-closeout 核对更新。

| Topic | 主题 | 开始 | 归档 | 沉淀去向 | 状态 |
|-------|------|------|------|---------|------|
| 2026-05-22-batch-operations | 批量操作 | 05-22 | — | — | in-progress |
| 2026-05-24-subagent-memory-session | subagent memory session | 05-24 | — | — | in-progress |

## 状态语义

- `in-progress` — 设计 / 实施中，topic 目录可读写
- `archived` — coding-closeout 已收尾，topic 目录只读，沉淀已进长期文档
- `abandoned` — 放弃，标理由（沉淀仍可能有价值，归档前提取）

## 活跃 ADR 索引

> 当前 `status: accepted` 的 ADR 速查（被推翻的 `superseded` 不列，查 `docs/adr/` 全量）。

| ADR | 标题 | 状态 |
|-----|------|------|
| ADR-001 | Subagent 进程隔离架构 | accepted |
| ADR-002 | Goal 7 态状态机 | accepted |
| ADR-003 | Goal 强制任务分解 + evidence | accepted |

> 完整 ADR 清单见 [docs/adr/](./docs/adr/)。
