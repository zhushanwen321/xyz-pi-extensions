# ADR-020: GoalRuntimeState Mixed-Frequency Tech Debt

**Status**: Accepted (tech debt record)

## Context

`GoalRuntimeState` 在 `extensions/goal/src/state.ts` 中将不同变更频率的字段混在一个 flat interface 里：

| 变更频率 | 字段 |
|---------|------|
| 配置（创建后不变） | `goalId`, `objective`, `budget`, `timeStartedAt`, `objectiveUpdatedAt` |
| 每 turn 更新 | `currentTurnIndex`, `tokensUsed`, `timeUsedSeconds`, `stallCount`, `lastProgressTurn`, `lastTurnTokensUsed` |
| 事件驱动 | `tasks`, `status`, `lastBlockerReason` |
| UI 状态 | `budgetWarning70Sent`, `budgetWarning90Sent`, `budgetLimitSteeringSent` |
| 终态标记 | `completedAtTurnIndex` |

## Problem

1. **序列化全量 dump**：`persistGoalState` 每次 `appendEntry` 写完整 state，但通常只有 2-3 个字段变了
2. **Debug 困难**：面对 20+ 字段的 diff，难以快速定位"什么变了"
3. **职责模糊**：UI flag（`budgetWarning70Sent`）和领域数据（`tasks`）混在一起

## Decision

**暂不重构**，记录为已知技术债。理由：

- 当前 flat interface 功能正确且已稳定
- 分层 state（`config` / `progress` / `tasks` / `uiFlags`）改动面极大——所有文件都引用 `state.xxx`，要改成 `state.config.xxx` 等
- `deserializeState` 的向后兼容逻辑会显著复杂化
- 没有实际性能问题（session entries 大小对 Pi 运行时不是瓶颈）

**已清理**：死字段 `turnCount`（写入但从未被读取做决策）已在本次迭代中移除。

## Consequences

- 短期：保持现状，代码可维护性足够
- 长期：如果 session entries 过大影响性能，或 state 字段继续膨胀，考虑分层重构
- 分层时优先按 `config` / `runtime` 两层分离（而非四层），减少改动面
