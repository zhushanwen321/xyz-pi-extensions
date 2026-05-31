# 002 - Pi Context-Engineering 重设计：复刻 Claude Code 三层架构

## 背景

Pi 的 context-engineering 扩展在实际使用中暴露出多个设计缺陷：

- L1 没有 protected turn 检查，导致刚读取的大文件被立即 condense
- 没有 compact boundary 感知，compact 保留的 toolResult 会被再次压缩
- 没有 cache 意识，每次独立决策可能导致 cache miss

Claude Code 的上下文管理是一个成熟的三层递进体系，每层的触发条件、粒度、成本、可逆性完全不同。本文档分析在 Pi 中复刻这套架构的可行方案。

***

## Claude Code 三层架构核心设计

### 第一层：Microcompact（客户端预处理，零 LLM 成本）

**触发时机**：每次 API 调用前。

**两条子路径**：

#### A. Time-Based Microcompact

- **触发条件**：距最后一次 assistant 消息超过 60 分钟（`gapThresholdMinutes: 60`）
- **设计思想**：cache 已冷（Anthropic 1h TTL），重写前清理旧 toolResult 无额外代价
- **保护机制**：保留最近 N 个 compactable toolResult（`keepRecent: 5`）
- **替换方式**：`'[Old tool result content cleared]'`——直接清除，**不可恢复**
- **适用范围**：仅主循环（main thread），subagent 不适用

#### B. Cached Microcompact（cache\_edits API）

- **触发条件**：累计 toolResult 数量超过阈值（`triggerThreshold`）
- **设计思想**：利用 Anthropic 的 `cache_edits` API，**不修改本地消息内容**
- **保护机制**：保留最近 N 个 toolResult（`keepRecent`）
- **替换方式**：API 层面删除，客户端消息不变
- **优势**：**不破坏 prompt cache**
- **限制**：仅 Anthropic API，Pi 当前不支持

**Microcompact 只处理特定工具**（`COMPACTABLE_TOOLS`）：

```
Bash, Glob, Grep, FileRead, FileEdit, FileWrite, WebFetch, WebSearch, NotebookEdit
```

### 第二层：Tool Result Budget（单消息级预算控制）

**触发时机**：每次 API 调用前（在 microcompact 之前执行）。

**核心机制**：

- 每个 user message 内的 toolResult 有预算上限（`MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200,000`）
- **按消息独立评估**——不同 turn 的 toolResult 各自独立计算
- 超预算时，优先持久化**最大的** toolResult 到磁盘
- 替换为：`<persisted-output>` 标签 + 预览（前 2000 字节）+ 文件路径

**关键设计——Frozen vs Fresh**：

```typescript
type ToolResultCandidate = {
  content: string
  size: number
  toolUseId: string
  state: 'frozen' | 'fresh'  // 关键状态
}
```

- `frozen`：之前已经决定如何处理的 toolResult，**后续 turn 不再改变**
- `fresh`：新出现的 toolResult，可以被替换
- 这保证 prompt cache 稳定：相同的消息 → 相同的 wire prefix → cache hit

### 第三层：Autocompact（LLM 摘要）

**触发时机**：token 使用量超过 auto-compact 阈值（约 80% 上下文窗口减去 13K buffer）。

**核心机制**：

- 用 LLM（`streamCompactSummary`）生成**完整对话摘要**
- 摘要替代所有旧消息，保留最近的消息
- 生成 `compact_boundary` 消息作为分界线

**Compact Boundary 的作用**：

```typescript
// 每次 API 调用前，先截断到 boundary 之后
let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]
```

- 物理截断：compact 前的消息从后续处理管道中完全消失
- 隔离保护：microcompact 和 tool result budget 只处理 compact 后的消息
- 无重复压缩：compact summary 不会被再次压缩

**Post-Compact 恢复**：

- 重新注入最近访问的文件内容（`POST_COMPACT_MAX_FILES_TO_RESTORE = 5`，每个文件最多 5K token）
- 调用 `processSessionStartHooks('compact')` 重新执行 session start hooks

***

## Pi 当前架构与 Claude Code 的差距

### 差距 1：没有 Microcompact 层

Pi 的 L0/L1/L2 是按严重度分层，不是按时机分层：

- L0：时间过期（30 分钟）——类似 time-based microcompact，但没有 keepRecent 保护
- L1：大 toolResult condense（8K chars）——没有 protected turn 检查
- L2：紧急 force-expire（90% 上下文）——类似 autocompact 的紧急触发

**缺失**：

- 没有 keepRecent 保护（L0/L1/L2 都没有）
- L1 没有 protected turn 检查（已确认的 bug）
- 没有 frozen/fresh 状态管理
- 没有 per-message 预算控制

### 差距 2：没有 Compact Boundary 感知

Pi 的 compact 产生 `compactionSummary` 消息，但：

- context-engineering 不认识 `compactionSummary` 类型
- compact 前保留的 toolResult 仍会被 L0/L1/L2 处理
- 没有物理截断机制

### 差距 3：没有 Cache 意识

- 没有 frozen/fresh 状态，每次独立决策
- 没有 cache\_edits API 支持
- compact 后的消息结构变化可能导致 cache miss

### 差距 4：没有磁盘持久化

- 被压缩的 toolResult 只在内存中（recall\_context）
- session 重启后丢失

***

## 复刻方案对比

### 方案 A：完全重写 context-engineering 扩展

**思路**：在扩展内完整复刻 Claude Code 的三层架构。

**实现要点**：

1. **Microcompact 层**：
   - time-based：检查消息时间戳，超过 60 分钟触发
   - 保护：保留最近 N 个 compactable toolResult
   - 替换：直接清除内容
2. **Tool Result Budget 层**：
   - per-message 独立预算评估
   - frozen/fresh 状态管理（需要跨 turn 记忆）
   - 持久化到磁盘（通过 pi.appendEntry 或自定义存储）
3. **Autocompact 层**：
   - 监听 `session_compact` 事件感知 compact 状态
   - 维护 compact boundary 信息
   - 在 context handler 中跳过 compact 前的消息

**优势**：

- 与 Pi 核心解耦，独立开发测试
- 完整复刻 Claude Code 架构
- 可以渐进式实现

**劣势**：

- 扩展无法访问 Pi 的完整消息历史（只看到 context 事件传入的消息）
- 无法实现 `getMessagesAfterCompactBoundary` 的物理截断（需要修改 Pi 核心）
- frozen/fresh 状态需要跨 turn 持久化（扩展的 session 生命周期管理复杂）
- cache\_edits API 需要 Pi 核心支持

**可行性**：中等。大部分逻辑可以在扩展内实现，但 compact boundary 感知需要 Pi 核心配合。

### 方案 B：集成到 Pi 核心层

**思路**：将上下文管理逻辑集成到 Pi 的 agent-loop 或 agent-session 中。

**实现要点**：

1. **在 agent-loop 中添加 Microcompact 层**：
   - 在 `streamAssistantResponse` 中，`transformContext` 之前执行
   - 直接访问 `context.messages`，可以物理截断
2. **在 agent-loop 中添加 Tool Result Budget 层**：
   - 在 microcompact 之后执行
   - per-message 预算控制
3. **修改 compact 逻辑**：
   - compact 后生成 boundary 消息
   - `getMessagesAfterCompactBoundary` 在消息传给扩展前执行

**优势**：

- 直接访问完整消息历史
- 可以物理截断（compact boundary）
- 可以集成 cache\_edits API（如果 Pi 未来支持）
- 与 autocompact 逻辑紧密集成

**劣势**：

- 需要修改 Pi 核心代码（侵入性大）
- 与 Pi 核心强耦合
- 难以独立测试和更新

**可行性**：低。除非 Pi 核心团队愿意接受这个改动，否则不现实。

### 方案 C：混合方案（扩展 + 核心配合）

**思路**：扩展处理 Microcompact 和 Tool Result Budget，核心层处理 Autocompact 和 compact boundary。

**实现要点**：

**Pi 核心层改动**（最小化）：

1. compact 后生成 `compact_boundary` 消息（类似 Claude Code）
2. 在 `emitContext` 之前，先执行 `getMessagesAfterCompactBoundary`
3. 暴露 compact 状态信息给扩展（通过 session manager 或 context 事件）

**扩展层实现**：

1. **Microcompact**：
   - time-based：检查消息时间戳
   - 保护：保留最近 N 个 compactable toolResult
   - 替换：直接清除内容
2. **Tool Result Budget**：
   - per-message 独立预算评估
   - frozen/fresh 状态管理（利用 pi.appendEntry 持久化）
   - 持久化到磁盘（通过 session manager）

**优势**：

- 核心改动最小化（只添加 boundary 消息和截断逻辑）
- 扩展独立开发测试
- 完整复刻 Claude Code 架构
- 保留扩展的灵活性

**劣势**：

- 仍然需要修改 Pi 核心
- 扩展需要处理 compact 状态同步

**可行性**：高。这是最平衡的方案。

### 方案 D：渐进式改进（不完全复刻）

**思路**：分阶段修复 context-engineering 的缺陷，不追求完全复刻。

**阶段 1：修复已知缺陷**：

- L1 添加 protected turn 检查
- L0/L1/L2 添加 keepRecent 保护

**阶段 2：添加状态管理**：

- frozen/fresh 状态管理
- 跨 turn 记忆（利用 pi.appendEntry）

**阶段 3：Compact Boundary 感知**：

- 监听 `session_compact` 事件
- 维护 compact boundary 信息
- 跳过 compact 前的消息

**阶段 4：Cache 意识**（如果 Pi 支持 cache\_edits）：

- 集成 cache\_edits API
- frozen/fresh 状态与 cache 稳定性

**优势**：

- 每阶段独立可测试
- 风险低
- 不需要修改 Pi 核心

**劣势**：

- 无法完全复刻 Claude Code 架构
- 某些深层改进（如 cache\_edits）仍然受阻
- compact boundary 感知仍然不完整（无法物理截断）

**可行性**：高。这是最现实的方案。

***

## 方案对比总结

| 维度                   | 方案 A：完全重写扩展 | 方案 B：集成到核心 | 方案 C：混合方案 | 方案 D：渐进式改进 |
| -------------------- | ----------- | ---------- | --------- | ---------- |
| **复刻完整度**            | 90%         | 100%       | 95%       | 70%        |
| **核心改动**             | 无           | 大          | 小         | 无          |
| **开发复杂度**            | 高           | 中          | 中         | 低          |
| **测试复杂度**            | 中           | 高          | 中         | 低          |
| **Cache 意识**         | 部分          | 完整         | 部分        | 无          |
| **Compact Boundary** | 部分          | 完整         | 完整        | 部分         |
| **磁盘持久化**            | 可以          | 可以         | 可以        | 可以         |
| **独立更新**             | 是           | 否          | 部分        | 是          |

***

## 推荐方案

**推荐方案 C（混合方案）+ 方案 D 的渐进式策略**：

1. **阶段 1**（立即）：修复 L1 的 protected turn 检查，添加 keepRecent 保护
2. **阶段 2**（短期）：实现 frozen/fresh 状态管理
3. **阶段 3**（中期）：请求 Pi 核心添加 compact boundary 消息和截断逻辑
4. **阶段 4**（长期）：如果 Pi 支持 cache\_edits，集成 cache 意识

这样可以在不修改 Pi 核心的情况下先修复已知缺陷，同时为后续的完整复刻做好准备。

***

## 开放问题

1. **Pi 核心是否愿意添加 compact boundary 支持？**
   - 如果愿意，方案 C 是最佳选择
   - 如果不愿意，只能用方案 D
2. **Pi 是否计划支持 cache\_edits API？**
   - 如果支持，可以集成 cache 意识
   - 如果不支持，只能用 time-based microcompact
3. **扩展的 session 生命周期管理是否足够？**
   - frozen/fresh 状态需要跨 turn 持久化
   - pi.appendEntry 是否足够？
4. **磁盘持久化的存储位置？**
   - 扩展自己的存储 vs Pi 的 session manager
   - 清理策略？

***

## 附录：关键技术细节

### Claude Code 的 COMPACTABLE\_TOOLS

```typescript
const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,   // read
  ...SHELL_TOOL_NAMES,   // bash, bash_background
  GREP_TOOL_NAME,        // grep
  GLOB_TOOL_NAME,        // glob
  WEB_SEARCH_TOOL_NAME,  // web_search
  WEB_FETCH_TOOL_NAME,   // web_fetch
  FILE_EDIT_TOOL_NAME,   // edit
  FILE_WRITE_TOOL_NAME,  // write
])
```

Pi 的 context-engineering 应该定义类似的集合，只对这些工具的 toolResult 进行压缩。

### Claude Code 的 Time-Based Microcompact 配置

```typescript
const TIME_BASED_MC_CONFIG_DEFAULTS: TimeBasedMCConfig = {
  enabled: false,           // 默认关闭，通过 GrowthBook 灰度
  gapThresholdMinutes: 60,  // 60 分钟阈值（对应 Anthropic cache TTL）
  keepRecent: 5,            // 保留最近 5 个 compactable toolResult
}
```

Pi 可以使用类似的配置，但阈值可能需要调整（Pi 的 cache TTL 未知）。

### Claude Code 的 Tool Result Budget 配置

```typescript
const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000  // 每个 user 消息的 toolResult 总预算
const PREVIEW_SIZE = 2_000                          // 预览大小（前 2000 字节）
const PERSISTENCE_THRESHOLD = 50_000                // 持久化阈值（超过 50K 的 toolResult）
```

Pi 可以使用更保守的预算（如 100K），因为 Pi 的上下文窗口通常比 Claude 小。

### Claude Code 的 Autocompact 阈值

```typescript
// 自动 compact 阈值：上下文窗口的 80% 减去 13K buffer
const autoCompactThreshold = Math.floor(contextWindow * 0.8) - 13_000
```

Pi 的 autocompact 已经有自己的阈值设置（通过 `CompactionSettings`），可以复用。

### Claude Code 的 Post-Compact 恢复

```typescript
const POST_COMPACT_MAX_FILES_TO_RESTORE = 5      // 最多恢复 5 个文件
const POST_COMPACT_MAX_FILE_SIZE = 5_000          // 每个文件最多 5K token
```

compact 后会重新注入最近访问的文件内容，确保 LLM 仍有关键上下文。Pi 可以实现类似的机制。

### Claude Code 的 Session Memory Compact 配置

```typescript
// session memory compact 配置（用于 autocompact 后的消息保留）
const config = {
  minTokens: 20_000,           // 最少保留 20K token
  minTextBlockMessages: 3,     // 最少保留 3 个有文本块的消息
  maxTokens: 100_000,          // 最多保留 100K token
}
```

Pi 的 compact 已经有自己的 `keepRecentTokens` 设置，可以复用。

### Frozen/Fresh 状态管理的关键设计

```typescript
// Claude Code 的 frozen/fresh 状态管理
interface ContentReplacementState {
  // key: tool_use_id, value: replacement content
  replacements: Map<string, string>
  // 已经见过的 tool_use_id（frozen）
  seenIds: Set<string>
}

// 每次 API 调用时：
// 1. 遍历所有 toolResult
// 2. 如果 tool_use_id 在 seenIds 中（frozen），使用缓存的 replacement
// 3. 如果 tool_use_id 不在 seenIds 中（fresh），评估是否需要替换
// 4. 替换后，将 tool_use_id 加入 seenIds，replacement 加入 replacements
```

Pi 可以使用类似的机制，但需要跨 turn 持久化状态（通过 pi.appendEntry 或自定义存储）。

### Pi 的 context 事件处理流程

```
agent-loop.ts:
1. toolResult 被加入 messages[]
2. 回到 while 循环顶部
3. streamAssistantResponse() 被调用
4. → transformContext(messages) → emitContext(messages) → context-engineering 的 context handler
5. → 返回压缩后的 messages
6. → convertToLlm(messages) → 发送给 LLM
```

context-engineering 在步骤 4 中处理消息，但无法控制步骤 1-3 的流程。如果要在步骤 1 之前执行 microcompact，需要修改 Pi 核心。

### Pi 的 compact 事件处理流程

```
agent-session.ts:
1. shouldCompact() 检查是否需要 compact
2. prepareCompaction() 准备 compact
3. emit({ type: 'session_before_compact' })  // 扩展可以拦截
4. compact() 执行 compact
5. appendCompaction() 保存 compact 结果
6. emit({ type: 'session_compact' })  // 扩展可以感知
7. buildSessionContext() 重建消息列表
8. agent.state.messages = sessionContext.messages
```

context-engineering 可以在步骤 6 中感知 compact，但无法控制步骤 7-8 的消息重建。
