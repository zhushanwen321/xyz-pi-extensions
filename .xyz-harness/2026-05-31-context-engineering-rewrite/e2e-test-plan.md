---
verdict: pass
---

# E2E Test Plan — context-engineering-rewrite

## Test Scenarios

### Scenario 1: Microcompact Time-Based 清理（AC-1）

**目标：** 验证 60 分钟后旧的 compactable toolResult 被清理，最近 5 个保留。

**前置条件：**
- context-engineering 扩展启用，mc.enabled=true，mc.gapThresholdMinutes=60，mc.keepRecent=5
- 消息列表中有 8 个 compactable toolResult，最后一个 assistant 消息距今 65 分钟

**步骤：**
1. 触发 context 事件
2. 检查前 3 个 compactable toolResult 被替换为 `'[Old tool result content cleared]'`
3. 检查最近 5 个 compactable toolResult 保留原内容
4. 检查被清理的 toolResult 不在 recall store 中（无压缩 ID）

**预期结果：** mcCleared=3，被清理的不可 recall

### Scenario 2: Tool Result Budget（AC-2）

**目标：** 验证单 user 消息内 toolResult 超预算时，最大的被持久化。

**前置条件：**
- budget.enabled=true，budget.maxToolResultCharsPerMessage=200000
- 一个 user 消息内有 5 个 toolResult，总计 250K chars

**步骤：**
1. 触发 context 事件
2. 找到最大的 fresh toolResult
3. 检查其被替换为 `<persisted-output>` 格式
4. 通过 recall_context 获取原始内容

**预期结果：** budgetPersisted=1，recall 可获取原始内容

### Scenario 3: Frozen/Fresh 跨 Turn 稳定性（AC-3, AC-6）

**目标：** 验证 frozen toolResult 在后续 turn 中保持不变。

**前置条件：**
- Turn 1 中 toolResult A（100K chars）被 Budget 持久化
- FrozenFreshState 记录 A 为 frozen

**步骤：**
1. Turn 2 触发 context 事件
2. 检查 toolResult A 仍使用之前的 replacement
3. 检查新出现的 toolResult B 是 fresh 状态
4. 验证两次 turn 的 A 内容完全相同

**预期结果：** A 的 replacement 在 Turn 1 和 Turn 2 中完全一致

### Scenario 4: Compact Boundary 感知（AC-4, AC-7）

**目标：** 验证 compactionSummary 之前的消息不被压缩。

**前置条件：**
- 消息列表索引 5 处有 compactionSummary 消息
- 索引 2 处有超 30 分钟的 toolResult（正常应被 L0 过期）

**步骤：**
1. 触发 context 事件
2. 检查索引 2 的 toolResult 未被过期（因为在 compact boundary 之前）
3. 检查索引 8 的 toolResult 正常参与压缩

**预期结果：** compact boundary 之前的消息不被处理

### Scenario 5: L1 Protected Turn（AC-5）

**目标：** 验证 L1 不 condense 最近 2 轮内的 toolResult。

**前置条件：**
- 一个 12K chars 的 toolResult 在最近 2 轮内
- l1.protectRecentTurns=2

**步骤：**
1. 触发 context 事件
2. 检查该 toolResult 未被 condense
3. 检查超出保护范围的 12K toolResult 被正常 condense

**预期结果：** 受保护的保留原文，不受保护的被 condense

### Scenario 6: 配置启停（AC-8）

**目标：** 验证 mc 和 budget 可独立启停。

**前置条件：**
- 默认配置加载

**步骤：**
1. 执行 `/context-engineering mc off`
2. 触发 context 事件，验证 Microcompact 不触发
3. 执行 `/context-engineering budget off`
4. 触发 context 事件，验证 Budget 不触发
5. 执行 `/context-engineering mc on`
6. 触发 context 事件，验证 Microcompact 正常触发

**预期结果：** mc off 时不清理，budget off 时不持久化，on 后恢复正常

## Test Environment

- **运行环境：** vitest（`npx vitest run`），从 vitest 导入 describe/it/expect/vi
- **数据构造：** 通过 test helper 函数构造 AgentMessage 数组（复用现有 helper）
- **状态管理：** FrozenFreshState 用 createFrozenFreshState() 创建实例
- **不使用 node:test，不使用 tsx --test**
