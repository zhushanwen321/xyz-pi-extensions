---
verdict: pass
---

# Non-Functional Design — goal-staleness-reminder-auto-clear

## 1. 稳定性

改动集中在单个扩展内部（`goal/src/`），不影响 Pi 核心进程或其他扩展。最不稳定的是 `deserializeState` 的向后兼容——新增 3 个可选字段 + 1 个字段重命名，默认值策略明确（currentTurnIndex→0, lastUpdatedTurn→0, completedAtTurnIndex→undefined, subTodos→subtasks 映射），旧 session 加载不会崩溃。重命名的 61 处引用全部是机械替换，无逻辑变更，编译器能捕获所有遗漏。

## 2. 数据一致性

`goal-history` entry 与 `goal-state` entry 使用不同的 customType，数据生命周期完全隔离。`clearGoalSession` 只清除 session.state（内存），不影响已写入的 entries。`reconstructGoalState` 的 GC 只清理 `goal-state` 类型的 entry，`goal-history` entries 由独立的 GC 逻辑管理（保留最近 20 条）。终态快照写入时机在 `transitionStatus` 之后、`clearGoalSession` 之前，确保快照数据完整。

## 3. 性能

`before_agent_start` 中新增的停滞检查是 O(tasks) 遍历，task 数量通常 ≤ 20，性能可忽略。`turn_end` 中仅递增一个计数器，无额外开销。`/goal history` 从 entries 列表中过滤 `goal-history` 类型，entries 总量通常 < 100，线性扫描足够。无性能风险。

## 4. 业务安全

无安全影响。staleness reminder 是注入到 agent 上下文的提示文本，不改变 agent 行为的强制约束。agent 可以忽略提醒继续工作。提醒内容不包含用户敏感信息，只包含 task ID、描述和停滞计数。

## 5. 数据安全

不适用。无文件 I/O，无网络请求，所有数据存储在 Pi 的 session entry 系统内。goal-history 快照包含 objective 文本和 task 统计，不含敏感信息。
