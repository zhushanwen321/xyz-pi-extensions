---
verdict: pass
---

# Context-Engineering v2 — 业务用例

## 用例列表

| UC | 名称 | 追溯 AC |
|----|------|---------|
| UC-1 | Microcompact Time-Based 清理 | AC-1 |
| UC-2 | Tool Result Budget 预算控制 | AC-2 |
| UC-3 | Frozen/Fresh 状态保持 | AC-3, AC-6 |
| UC-4 | Compact Boundary 感知 | AC-4 |
| UC-5 | L1 Protected Turn 保护 | AC-5 |
| UC-6 | 配置启停 | AC-8 |

## Actor

**Primary Actor**: Pi AI Agent（通过 `context` 事件自动触发）

**Secondary Actor**: 开发者（通过 `/context-engineering` 命令配置）

---

## UC-1: Microcompact Time-Based 清理

**目标**: 当上下文长时间未活跃时，清理旧的 compactable toolResult 以减少 token 消耗。

### Preconditions

1. Context-engineering v2 插件已加载且 `mc.enabled = true`
2. 当前处于主循环（非 subagent session）
3. 消息列表中存在 compactable toolResult（来自 `COMPACTABLE_TOOLS` 列表中的工具）

### Main Flow

1. Pi 在发起 LLM 调用前触发 `context` 事件，传入当前消息列表
2. 扩展从消息列表中查找最后一条 assistant 消息的时间戳
3. 扩展计算 `now - lastAssistantTimestamp`，与 `mc.gapThresholdMinutes`（默认 60）比较
4. 若未超过阈值，跳过 Microcompact，进入下一层级处理
5. 若超过阈值，从消息列表中收集所有 compactable toolResult
6. 按消息顺序从后往前保留最近 `keepRecent`（默认 5）个 compactable toolResult
7. 将剩余的 compactable toolResult 内容替换为 `'[Old tool result content cleared]'`
8. 返回修改后的消息列表

### Alternative Paths

- **A1: 无 assistant 消息**: 消息列表中没有 assistant 消息时，视为首次交互，跳过 Microcompact
- **A2: compactable toolResult 少于 keepRecent**: 如果清理范围内的 toolResult 总数 ≤ `keepRecent`，不执行任何清理

### Exception Paths

- **E1: 时间戳缺失**: assistant 消息缺少时间戳字段时，跳过 Microcompact，不中断流程

### Postconditions

- 被清理的 toolResult 不分配压缩 ID，不可通过 `recall_context` 恢复
- 最近 N 个 compactable toolResult 保持原样
- 其余消息不受影响

---

## UC-2: Tool Result Budget 预算控制

**目标**: 对单个 user 消息内的 toolResult 总大小进行预算控制，超预算时持久化最大的 toolResult。

### Preconditions

1. Context-engineering v2 插件已加载且 `budget.enabled = true`
2. 消息列表中至少有一个 user 消息包含 toolResult

### Main Flow

1. Pi 触发 `context` 事件，传入消息列表
2. 扩展遍历消息列表，按 user 消息粒度分组
3. 对每个 user 消息，计算其内部所有 toolResult 的字符总数
4. 将字符总数与 `budget.maxToolResultCharsPerMessage`（默认 200,000）比较
5. 若未超预算，对该消息内的 toolResult 标记为 `frozen`（记录到 `seenIds`），不执行替换
6. 若超预算，从 `fresh` 状态的 toolResult 中找出字符数最大的一个
7. 生成压缩 ID，将原始内容存入内存（`recall_store`）
8. 将该 toolResult 替换为 `<persisted-output>` 格式：包含工具名、前 2000 字节预览、压缩 ID
9. 将该 toolResult 标记为 `frozen`（记录到 `seenIds` 和 `replacements`）
10. 重新计算该 user 消息的 toolResult 总大小，若仍超预算，重复步骤 6-9
11. 返回修改后的消息列表

### Alternative Paths

- **A1: 所有 toolResult 均 frozen**: 当 user 消息内所有 toolResult 都已处于 `frozen` 状态时，跳过预算评估（历史决策不变）
- **A2: 多个 toolResult 大小相同**: 多个 toolResult 字符数相同时，选择消息列表中最早出现的那个

### Exception Paths

- **E1: 预算阈值为 0 或负数**: 视为禁用，跳过 Budget 处理
- **E2: toolResult 内容为空**: 跳过空 toolResult，不计入预算

### Postconditions

- 被替换的 toolResult 可通过 `recall_context(id)` 恢复完整内容
- `seenIds` 包含所有已处理的 tool_use_id
- `replacements` 包含所有替换后的内容映射

---

## UC-3: Frozen/Fresh 状态保持

**目标**: 确保已决定的 toolResult 处理方式在后续 turn 中保持不变，维持 prompt cache 稳定性。

### Preconditions

1. Context-engineering v2 插件已加载
2. 前序 turn 已执行过 Tool Result Budget 处理，`seenIds` 和 `replacements` 已有数据
3. 当前 turn 的消息列表包含前序 turn 已处理的 toolResult

### Main Flow

1. Pi 触发 `context` 事件，传入当前消息列表
2. 扩展遍历消息列表中的所有 toolResult
3. 对每个 toolResult，检查其 `tool_use_id` 是否在 `seenIds` 中
4. 若在 `seenIds` 中（`frozen`）：从 `replacements` 获取之前决定的替换内容，直接应用
5. 若不在 `seenIds` 中（`fresh`）：标记为 `fresh`，交由 Microcompact / Budget / L0 / L1 评估
6. 返回消息列表（frozen 部分 wire prefix 与前序 turn 完全一致）

### Alternative Paths

- **A1: session 重启**: `session_start` 事件触发时，`seenIds` 和 `replacements` 重建为空。所有 toolResult 变为 `fresh` 状态，重新评估

### Exception Paths

- **E1: replacements 中缺失已知 ID**: `seenIds` 中有 ID 但 `replacements` 中无对应内容时，视为状态损坏，将该 ID 从 `seenIds` 移除，降级为 `fresh` 处理

### Postconditions

- 前序 turn 已决定的 toolResult 处理方式不变
- 消息前缀（frozen 部分）与前序 turn 的 wire 表示完全一致，保证 prompt cache 命中
- 新 toolResult 作为 `fresh` 正常参与评估

---

## UC-4: Compact Boundary 感知

**目标**: 识别原生 compact 产生的 `compactionSummary` 消息，跳过其之前的所有消息的压缩处理。

### Preconditions

1. Context-engineering v2 插件已加载
2. 消息列表中可能包含 `compactionSummary` 类型的消息（由 Pi 原生 compact 产生）

### Main Flow

1. Pi 触发 `context` 事件，传入消息列表
2. 扩展遍历消息列表，查找 `compactionSummary` 类型的消息
3. 若未找到，正常执行全量压缩处理
4. 若找到，记录最后一个 `compactionSummary` 的索引位置 `boundaryIdx`
5. 将消息列表分为两个区域：
   - **Pre-boundary**（索引 < `boundaryIdx`）：不参与任何压缩处理（Microcompact / Budget / L0 / L1 / L2）
   - **Post-boundary**（索引 ≥ `boundaryIdx`）：正常参与压缩处理
6. `compactionSummary` 消息本身不被修改
7. 返回消息列表

### Alternative Paths

- **A1: 多个 compactionSummary**: 消息列表中有多个 `compactionSummary` 时，以最后一个为准（最旧的 compact 边界之前的内容已被摘要覆盖）

### Exception Paths

- **E1: 消息格式异常**: `compactionSummary` 消息缺少预期字段时，仍以消息类型为准进行边界划分，不中断流程

### Postconditions

- `compactionSummary` 之前的消息不被任何压缩逻辑修改
- `compactionSummary` 之后的消息按正常流程处理
- 原生 compact 的摘要成果被保留，不被二次压缩

---

## UC-5: L1 Protected Turn 保护

**目标**: 防止最近轮次内刚读取的大文件内容被 L1 规则化摘要压缩，避免 agent 反复读取同一文件。

### Preconditions

1. Context-engineering v2 插件已加载且 `l1.enabled = true`
2. 消息列表中存在 large toolResult（大小超过 `l1.summaryThresholdChars`）
3. `l1.protectRecentTurns` 已配置（默认 2）

### Main Flow

1. Pi 触发 `context` 事件，传入消息列表
2. L1 压缩逻辑识别出所有大小超过阈值的 toolResult 候选
3. 对每个候选 toolResult，计算其所在 turn 距当前 turn 的距离
4. 若距离 ≤ `l1.protectRecentTurns`，调用 `isInProtectedTurn` 返回 `true`，跳过该 toolResult
5. 若距离 > `l1.protectRecentTurns`，执行 L1 规则化摘要压缩
6. 摘要格式：`[Condensed (ID: ctx-xxx): {规则提取的摘要}]`
7. 返回消息列表

### Alternative Paths

- **A1: turn 边界不明确**: 消息列表中 turn 边界难以确定时（如连续多个 assistant/user 消息），按 assistant-user 消息对的数量计算 turn 数量

### Exception Paths

- **E1: protectRecentTurns 为 0**: 视为禁用保护，所有超阈值 toolResult 均参与 L1 压缩

### Postconditions

- 最近 N 轮内的 toolResult 保持原样，不被 condense
- 超过保护范围的 large toolResult 被摘要替换，且可 recall
- Agent 不会因 L1 压缩而反复读取同一文件

---

## UC-6: 配置启停

**目标**: 允许开发者通过命令动态控制各压缩层级的启用/禁用状态。

### Preconditions

1. Context-engineering v2 插件已加载
2. 用户在 Pi session 中通过命令行与 agent 交互

### Main Flow

1. 用户输入 `/context-engineering` 命令
2. 扩展解析命令参数
3. 若无参数，输出当前所有层级的配置和统计数据
4. 若参数为 `global on|off`，设置全局启用/禁用标志
5. 若参数为层级名称（`mc|budget|l0|l1|l2`）+ `on|off`，设置对应层级的启用/禁用标志
6. 输出更新后的配置状态
7. 后续 `context` 事件按最新配置执行

### Alternative Paths

- **A1: 无效层级名称**: 用户输入未知层级名称时，输出可用的层级列表和当前状态，不修改任何配置
- **A2: 全局关闭**: `global off` 时，所有层级均不执行，`context` 事件直接返回原始消息列表

### Exception Paths

- **E1: 配置持久化失败**: 配置写入 session entry 失败时，内存中的配置仍生效，但 session 重载后回退到默认值

### Postconditions

- 被禁用的层级在后续 `context` 事件中不执行任何处理
- 其他层级不受影响，继续正常工作
- 配置变更立即生效，无需重启 session

---

## 覆盖映射表

| UC | AC | 覆盖说明 |
|----|----|---------|
| UC-1 | AC-1 | 验证 time-based 触发、keepRecent 保护、不可 recall 三个核心行为 |
| UC-2 | AC-2 | 验证 per-message 预算评估、最大 toolResult 优先替换、recall 可恢复 |
| UC-3 | AC-3 | 验证 frozen 状态在后续 turn 中不变、fresh 状态被正常评估 |
| UC-3 | AC-6 | 验证 frozen 状态保证 wire prefix 一致性，从而命中 prompt cache |
| UC-4 | AC-4 | 验证 compactionSummary 边界识别、pre/post 分区处理、不修改 summary 本身 |
| UC-5 | AC-5 | 验证 protected turn 内的 toolResult 不被 L1 condense |
| UC-6 | AC-8 | 验证单层级启停不影响其他层级 |

**未单独建 UC 但被隐式覆盖的 AC**：

| AC | 覆盖方式 |
|----|---------|
| AC-7 | UC-4 的 postcondition 保证不干扰原生 compact；C-1 约束明确禁止取消 compact |
