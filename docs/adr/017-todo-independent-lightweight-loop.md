# ADR 017: Todo 使用独立轻量循环而非复用 Goal 的 Loop

## Status
Accepted

## Context

`@zhushanwen/pi-todo` v4 需要添加 `agent_end` 和 `before_agent_start` 事件处理来实现自动闭合、停滞检测和验证提醒。与此同时 `@zhushanwen/pi-goal` 已有完整的 agent loop 实现（状态机、budget 管理、continuation prompt、stall 检测）。

两者都涉及"agent loop → 检查 task 状态 → 注入 context"的模式。一个合理的选项是让 todo 复用 goal 的 loop 机制。

## Decision

Todo 实现自己独立的轻量版 agent loop，不与 goal 共享代码。

具体差异：

| 维度 | Goal Loop | Todo Loop |
|------|-----------|-----------|
| 状态机 | 7 态（active/paused/blocked/complete/budget_limited/time_limited/cancelled） | 无状态机，仅检查 todos[] |
| Budget | token + time budget | 无 budget |
| Continuation | 每轮发送 followUp | 仅在停滞时注入 context |
| Stall 检测 | stallCount → maxStallTurns → blocked | stall → inject context |
| Prompt | XML 模板模板化 | 简单拼接字符串 |
| 用户触发 | 必须 `/goal` | AI 自发创建 |

## Rationale

1. **本质区别**：todo 是 AI 自发的轻量追踪（无启动门槛），goal 是用户驱动的正式目标循环。共享机制会迫使 todo 理解 goal 的状态机和 budget——但 todo 不需要这些。

2. **隔离性**：todo 和 goal 是独立 npm 包（`@zhushanwen/pi-todo` vs `@zhushanwen/pi-goal`），用户可能只装其中一个。让 todo 依赖 goal 会破坏独立性。

3. **复杂度不匹配**：todo 的 loop 只需要约 50 行代码（检查状态 → 注入 context），复用 goal 的 loop 需要引入至少 200 行的状态机 + budget 逻辑，反而更重。

4. **后续演化自由**：todo 和 goal 可能朝不同方向演化（如 todo 加强验证机制、goal 支持多目标并行），共享代码会限制各自的变化范围。

## Consequences

- Positive：todo 保持独立发布、零依赖 goal
- Positive：todo 的 loop 代码简单，约 50 行，容易理解和修改
- Negative：两处类似的循环逻辑不共享，修改时需同步（如 context 注入格式变化需要在两个扩展中各自更新）
- Negative：如果未来 todo 的功能膨胀到需要 budget/stall state machine，需要重构——但届时 todo 可能已经不再是"轻量"工具
