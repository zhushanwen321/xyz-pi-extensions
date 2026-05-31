---
verdict: pass
---

# Context-Engineering v2：复刻 Claude Code 三层架构

## Background

Pi 的 context-engineering 扩展 v1 在实际使用中暴露出多个设计缺陷：

1. **L1 没有 protected turn 检查**：刚读取的大文件（>8K chars）在下一轮就被 condense，导致 agent 反复读取同一个文件
2. **没有 compact boundary 感知**：compact 保留的 toolResult 会被 L0/L1/L2 再次压缩，绕过了 compact 的保留策略
3. **没有 cache 意识**：每次独立决策，没有 frozen/fresh 状态，可能导致 prompt cache miss
4. **L0/L1/L2 按严重度分层，不是按时机分层**：所有压缩都在同一个 context 事件中执行，没有根据上下文状态选择不同策略

本需求的目标是**完全复刻 Claude Code 的三层上下文管理架构**，解决上述所有问题。

### 前置调研

- `docs/evolution/002-pi-context-engineering-redesign.md` — Claude Code 三层架构分析、Pi 差距分析、方案对比
- `main/docs/research/coding-agents-context-research.md` — Claude Code/Aider/Qwen Code 对比调研
- `main/docs/adr/006-progressive-context-compression.md` — 原始设计决策

### Claude Code 三层架构核心设计

#### 第一层：Microcompact（每次 API 调用前，零 LLM 成本）

**两条子路径**：

**A. Time-Based Microcompact**
- 触发：距最后一次 assistant 消息超过 60 分钟
- 保护：保留最近 N 个 compactable toolResult（`keepRecent: 5`）
- 替换：`'[Old tool result content cleared]'` — 直接清除，**不可恢复**
- 逻辑：cache 已冷（Anthropic 1h TTL），清理旧 toolResult 无额外代价

**B. Cached Microcompact（cache_edits API）**
- 触发：累计 toolResult 数量超过阈值
- 保护：保留最近 N 个 toolResult
- 替换：API 层面删除，客户端消息不变
- 优势：不破坏 prompt cache
- **Pi 当前不支持此路径**

**Microcompact 只处理特定工具**（`COMPACTABLE_TOOLS`）：
```
read, bash, bash_background, grep, glob, web_search, web_fetch, edit, write
```

#### 第二层：Tool Result Budget（每次 API 调用前）

- 每个 user message 内的 toolResult 有预算上限（`MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200,000`）
- **按消息独立评估** — 不同 turn 的 toolResult 各自独立计算
- 超预算时，优先持久化**最大的** toolResult 到磁盘
- 替换为：`<persisted-output>` 标签 + 预览（前 2000 字节）+ 文件路径
- **可恢复**：通过 `recall_context` 获取完整内容

**关键设计 — Frozen vs Fresh**：
- `frozen`：之前已经决定如何处理的 toolResult，**后续 turn 不再改变**
- `fresh`：新出现的 toolResult，可以被替换
- 这保证 prompt cache 稳定：相同的消息 → 相同的 wire prefix → cache hit

#### 第三层：Autocompact（token 超阈值时，LLM 摘要）

- 用 LLM 生成**完整对话摘要**
- 摘要替代所有旧消息，保留最近的消息
- 生成 `compact_boundary` 消息作为分界线
- **物理截断**：`getMessagesAfterCompactBoundary` 确保 compact 前的消息不会被后续 microcompact 处理

## Functional Requirements

### FR-1: Microcompact — Time-Based 清理（新）

在 `context` 事件中，检查距最后一条 assistant 消息是否超过可配置阈值（默认 60 分钟）。如果超过，清理所有旧的 compactable toolResult，但保留最近 N 个（`keepRecent`，默认 5）。

- 触发条件：`now - lastAssistantTimestamp > gapThresholdMinutes`
- 保护条件：保留最近 `keepRecent` 个 compactable toolResult（按消息顺序，从后往前数）
- 替换格式：`'[Old tool result content cleared]'`
- **不可恢复**：不分配压缩 ID，不存储原始内容
- 适用范围：仅主循环（main thread），subagent 不适用（通过 `ctx.sessionManager` 判断）

**与 v1 L0 的区别**：
- v1 L0：30 分钟过期，分配压缩 ID，可 recall
- v2 Microcompact：60 分钟清理，**不可 recall**（cache 已冷，recall 无意义）

### FR-2: Tool Result Budget — Per-Message 预算控制（新）

在 `context` 事件中，对每个 user 消息内的 toolResult 进行预算评估。超过预算时，将最大的 toolResult 持久化（替换为预览 + 压缩 ID）。

- 预算阈值可配置（`maxToolResultCharsPerMessage`，默认 200,000）
- 评估粒度：**按 user 消息独立评估**，不同 turn 各自独立
- 替换策略：优先替换**最大的** fresh toolResult
- 替换格式：`<persisted-output>\n<path>{toolName}</path>\n<preview>{前 2000 字节}</preview>\n</persisted-output>`
- **可恢复**：分配压缩 ID，可通过 `recall_context` 获取完整内容

**Frozen/Fresh 状态管理**：
- 每个 toolResult 有一个 `state`：`frozen` 或 `fresh`
- `frozen`：之前已经决定如何处理的 toolResult（在 `seenIds` 中），后续 turn 保持不变
- `fresh`：新出现的 toolResult（不在 `seenIds` 中），需要评估是否需要替换
- 状态存储：扩展闭包变量（`session_start` 时重建）

### FR-3: Microcompact — Compact Boundary 感知（新）

在 `context` 事件中，检测消息列表中是否存在 `compactionSummary` 类型的消息。如果存在，跳过该消息之前的所有消息的压缩处理。

- 检测方式：遍历消息列表，找到最后一个 `compactionSummary` 消息的索引
- 保护范围：`compactionSummary` 消息及其之后的消息
- 跳过方式：`compactionSummary` 之前的消息不参与 L0/L1/L2 处理
- **不修改 `compactionSummary` 消息本身**

**与 Claude Code 的差异**：
- Claude Code：`getMessagesAfterCompactBoundary` 物理截断，compact 前的消息完全消失
- Pi v2：逻辑跳过，compact 前的消息仍在列表中，但不被压缩处理

### FR-4: Tool Result 过期清理（保留，优化）

保留 v1 的 L0 过期清理，但增加 `keepRecent` 保护。

- 过期时间可配置（`expireMinutes`，默认 30）
- 替换格式：`[Tool result expired. ID: ctx-xxx. Call recall_context(ctx-xxx) to retrieve]`
- **新增**：`keepRecent` 保护（默认 5），保留最近 N 个 compactable toolResult
- **新增**：`isInProtectedTurn` 检查，保护最近 `protectRecentTurns` 轮内的消息

### FR-5: Bash Execution 输出截断（保留）

保留 v1 的 bash 输出截断。

- 截断阈值可配置（`bashTruncateChars`，默认 4000）
- 截断格式：`... [{N} chars truncated, ID: ctx-xxx] ...\n\n{尾部}`

### FR-6: Thinking 块空闲清理（保留）

保留 v1 的 thinking 块清理。

- 空闲时间可配置（`thinkingExpireMinutes`，默认 5）
- 清空格式：`[thinking expired]`

### FR-7: Tool Result 规则化摘要压缩（保留，优化）

保留 v1 的 L1 规则化摘要，但增加 `isInProtectedTurn` 检查。

- 大小阈值可配置（`summaryThresholdChars`，默认 8000）
- **新增**：`isInProtectedTurn` 检查，保护最近 `protectRecentTurns` 轮内的消息
- 摘要格式：`[Condensed (ID: ctx-xxx): {规则提取的摘要}]`

### FR-8: 原始内容 Recall（保留）

保留 v1 的 recall 机制，但扩展存储范围。

- 工具名：`recall_context`
- 参数：`id`（string，压缩 ID）
- 返回：原始消息的完整内容
- 存储位置：扩展内部维护的 `Map<string, StoredContent>`
- 生命周期：随 session 存活，`session_start` 时重建
- **新增**：Tool Result Budget 持久化的内容也可 recall

### FR-9: 紧急压缩（保留，优化）

保留 v1 的 L2 紧急压缩，但增加 compact boundary 感知。

- 触发阈值可配置（`emergencyThreshold`，默认 0.90）
- **新增**：跳过 `compactionSummary` 之前的消息

### FR-10: ToolCall/ToolResult 配对完整性（保留）

保留 v1 的配对完整性校验。

### FR-11: 压缩动作统计（保留，扩展）

扩展 v1 的统计，增加 Microcompact 和 Tool Result Budget 的统计。

- 统计内容：
  - Microcompact 触发次数、清理数量
  - Tool Result Budget 触发次数、持久化数量
  - L0 过期清理数量
  - L0 截断数量
  - L1 摘要数量
  - L2 紧急触发次数
  - Frozen/Fresh 状态统计

### FR-12: 配置与启停（保留，扩展）

扩展 v1 的配置，增加 Microcompact 和 Tool Result Budget 的配置。

- 命令：`/context-engineering` — 查看当前配置和统计
- 命令：`/context-engineering global on|off` — 全局启用/禁用
- 命令：`/context-engineering mc on|off` — 控制 Microcompact
- 命令：`/context-engineering budget on|off` — 控制 Tool Result Budget
- 命令：`/context-engineering l0 on|off` — 控制 L0
- 命令：`/context-engineering l1 on|off` — 控制 L1
- 命令：`/context-engineering l2 on|off` — 控制 L2

## Acceptance Criteria

### AC-1: Microcompact Time-Based 清理
- Given 距最后一条 assistant 消息已超过 60 分钟，消息列表中有 8 个 compactable toolResult
- When context 事件触发
- Then 最近 5 个 compactable toolResult 保留，前 3 个被清理为 `'[Old tool result content cleared]'`
- And 被清理的 toolResult **不可 recall**（无压缩 ID）

### AC-2: Tool Result Budget Per-Message 预算
- Given 一个 user 消息内有 5 个 toolResult，总计 250,000 chars（超过 200,000 预算）
- When context 事件触发
- Then 最大的 toolResult 被替换为 `<persisted-output>` + 预览
- And 其他 4 个 toolResult 保留原样
- And 被替换的 toolResult 可通过 `recall_context` 获取完整内容

### AC-3: Frozen/Fresh 状态保持
- Given Turn 1 中 toolResult A（100K chars）被 Tool Result Budget 持久化
- When Turn 2 的 context 事件触发
- Then toolResult A 仍然是 `frozen` 状态，使用之前的替换内容
- And 新出现的 toolResult B 是 `fresh` 状态，被评估是否需要替换

### AC-4: Compact Boundary 感知
- Given 消息列表中包含 `compactionSummary` 消息（索引 5），之后有新的 toolResult（索引 8）
- When context 事件触发
- Then 索引 5 之前的消息不参与压缩处理
- And 索引 5 及之后的消息正常参与压缩处理

### AC-5: L1 Protected Turn 检查
- Given 一个 12,000 chars 的 toolResult 在最近 2 轮内（`protectRecentTurns: 2`）
- When L1 压缩执行
- Then 该 toolResult **不被 condense**（在保护范围内）

### AC-6: Frozen/Fresh + Prompt Cache 稳定性
- Given Turn 1 和 Turn 2 的消息前缀相同（只有最后一条 user 消息不同）
- When 两次 API 调用
- Then 两次调用的 wire prefix 相同（prompt cache 命中）

### AC-7: 不干扰原生 Compact
- Given context-engineering v2 启用
- When Pi 原生 compact 触发
- Then 原生 compact 正常执行，不报错，不冲突
- And compact 后的 `compactionSummary` 消息被正确识别

### AC-8: 配置与启停
- Given 插件默认配置加载
- When 用户执行 `/context-engineering mc off`
- Then Microcompact 不再触发
- And 其他层级（Budget/L0/L1/L2）仍正常工作

## Constraints

### C-1: 不替代原生 Compact
本插件不尝试拦截、替代或取消 Pi 原生 compaction。`session_before_compact` 事件不返回 `{ cancel: true }`。

### C-2: 不修改 Session Entries
插件不在 session entry 层面做任何修改。压缩后的消息仅存在于 `context` 事件的返回值中。

### C-3: 原始内容不持久化
被压缩的原始内容只保存在进程内存中。session 重载后丢失。

### C-4: 不支持 Cache Edits API
Pi 当前不支持 Anthropic 的 `cache_edits` API，所以 Microcompact 只实现 time-based 路径，不实现 cached 路径。

### C-5: 性能约束
`context` 事件在每次 LLM 调用前触发，必须快速返回：
- Microcompact：< 5ms
- Tool Result Budget：< 10ms
- L0/L1/L2：< 15ms
- **不调用 LLM**

### C-6: Frozen/Fresh 状态存储
状态存储在扩展闭包变量中，通过 `pi.appendEntry` 持久化到 session manager。状态格式：

```typescript
interface FrozenFreshState {
  seenIds: Set<string>               // 已经见过的 tool_use_id（frozen）
  replacements: Map<string, string>  // tool_use_id → replacement content
}
```

### C-7: 配置格式

```json
{
  "context-engineering": {
    "enabled": true,
    "mc": {
      "enabled": true,
      "gapThresholdMinutes": 60,
      "keepRecent": 5
    },
    "budget": {
      "enabled": true,
      "maxToolResultCharsPerMessage": 200000,
      "previewSize": 2000
    },
    "l0": {
      "enabled": true,
      "expireMinutes": 30,
      "bashTruncateChars": 4000,
      "thinkingExpireMinutes": 5,
      "protectRecentTurns": 2,
      "keepRecent": 5
    },
    "l1": {
      "enabled": true,
      "summaryThresholdChars": 8000,
      "keepHeadLines": 10,
      "keepTailLines": 5,
      "protectRecentTurns": 2
    },
    "l2": {
      "enabled": true,
      "emergencyThreshold": 0.90,
      "protectRecentTurns": 3
    }
  }
}
```

## Complexity Assessment

| 维度 | 评估 | 说明 |
|------|------|------|
| 新增代码量 | ~500 行 | Microcompact + Tool Result Budget + Frozen/Fresh + Compact Boundary 感知 |
| 核心算法复杂度 | 中 | Frozen/Fresh 状态管理、per-message 预算评估 |
| 外部依赖 | 低 | 无新依赖 |
| 风险点 | 中 | Frozen/Fresh 状态可能在 session 重启后丢失；Compact Boundary 感知依赖 `compactionSummary` 消息类型 |
| 与现有功能的交互 | 低 | 只读 session entries，只在 context 事件中修改消息副本 |
