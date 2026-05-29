# Claude Code 上下文管理分析报告

> 分析基于 Claude Code v2.1.88 源码 (2026-03-31)
> 项目: __/Users/zhushanwen/GitApp/claude-code-source-code__

---

## 1. 项目概览

Claude Code 是一个基于 Anthropic API 的终端 AI coding agent。上下文管理是其核心模块，位于 `src/services/compact/` 目录。

**核心文件结构：**

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/services/compact/compact.ts` | 1706 | 核心压缩引擎：全量/部分压缩 |
| `src/services/compact/autoCompact.ts` | ~300 | 自动压缩触发判断 + 调度 |
| `src/services/compact/microCompact.ts` | ~560 | 微压缩：每次 API 调用前运行 |
| `src/services/compact/cachedMicrocompact.ts` | (动态导入) | 基于 cache_edits API 的微压缩 |
| `src/services/compact/sessionMemoryCompact.ts` | ~500 | 基于 session memory 的实验性压缩 |
| `src/services/compact/prompt.ts` | ~250 | 压缩摘要生成的 prompt 模板 |
| `src/services/compact/grouping.ts` | 78 | 按 API round-trip 分组消息 |
| `src/services/compact/postCompactCleanup.ts` | ~100 | 压缩后缓存清理 |
| `src/services/compact/timeBasedMCConfig.ts` | ~45 | 时间触发微压缩配置 |
| `src/services/compact/apiMicrocompact.ts` | ~170 | 服务端 context management 策略 |
| `src/utils/messages.ts` | 5513 | 消息创建、操作工具函数 |
| `src/utils/tokens.ts` | ~300 | Token 估算和用量追踪 |
| `src/utils/context.ts` | ~250 | Context window 配置 |
| `src/utils/contextAnalysis.ts` | ~250 | Context 组成分析 |
| `src/utils/agentContext.ts` | ~150 | Subagent 上下文隔离 |
| `src/services/SessionMemory/` | - | Session memory 提取和存储 |

---

## 2. 上下文管理架构

Claude Code 采用 **三层递进式** 上下文管理模型：

```
每次 API 调用前
    │
    ├── Tier 1: 微压缩 (Microcompact)
    │   ├── 时间触发: 空闲 >60min 时清除旧工具结果
    │   ├── 缓存编辑: 通过 cache_edits API 删除工具结果
    │   └── API 策略: 服务端 clear_tool_uses_20250919
    │
    ├── Tier 2: 自动压缩检查 (Auto Compact)
    │   ├── 检查: 每轮查询前调用 shouldAutoCompact()
    │   ├── 阈值: effectiveContextWindow - 13_000 tokens
    │   ├── 路径: Session Memory → Legacy Compact
    │   └── 断路器: 连续失败 3 次后放弃
    │
    ├── Tier 3 (被动): 响应式压缩 (Reactive Compact)
    │   ├── 触发: API 返回 prompt_too_long 错误时
    │   ├── 策略: 从尾部丢弃最早的分组
    │   └── 重试: 最多 3 次 PTL retry
    │
    └── 手动: /compact 命令
        ├── 先尝试 session memory → reactive → legacy
        └── 支持 partial compact (保留最近/保留最早)
```

### 2.1 触发阈值体系

```
modelContextWindow = 200_000 (默认值, 取决于模型)
    ↓
getEffectiveContextWindowSize(model) = modelContextWindow - maxOutputTokens
    = ~200_000 - 20_000 = ~180_000
    ↓
getAutoCompactThreshold(model) = effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS(13_000)
    = ~167_000 tokens
```

各级警告阈值：
- **警告线** (WARNING_THRESHOLD): threshold - 20_000 tokens
- **错误线** (ERROR_THRESHOLD): threshold - 20_000 tokens  
- **自动压缩线** (AUTOCOMPACT): >= threshold (即 >= ~167K)
- **阻塞线** (BLOCKING): effectiveWindow - 3_000 tokens

### 2.2 消息模型数据结构

消息类型系统 (`src/types/message.ts` 中定义)：

```
Message = UserMessage | AssistantMessage | SystemMessage 
        | AttachmentMessage | ProgressMessage | TombstoneMessage

SystemMessage 的 subtypes:
  compact_boundary       // 压缩边界标记
  microcompact_boundary  // 微压缩边界标记
  api_error              // API 错误
  away_summary           // 离开模式摘要
  inform_message         // 通知消息
  stop_hook_summary      // Stop hook 摘要
  ...
```

**SystemCompactBoundaryMessage** 详细结构：
```typescript
type CompactMetadata = {
  trigger: 'manual' | 'auto'          // 触发方式
  preTokens: number                    // 压缩前的 token 数
  userContext?: string                 // 用户自定义指令
  messagesSummarized?: number          // 本次压缩的消息数
  preservedSegment?: {                 // 保留的消息段 (用于 partial compact)
    headUuid: UUID
    anchorUuid: UUID
    tailUuid: UUID
  }
  preCompactDiscoveredTools?: string[] // 压缩前已发现的工具
}
```

---

## 3. 压缩策略详解

### 3.1 Tier 1: 微压缩 (Microcompact)

**位置**: `microCompact()`, 在 `queryModelWithStreaming()` 之前调用。

**两种模式**:

#### a) 时间触发模式 (Time-based MC)

```typescript
// timeBasedMCConfig.ts
type TimeBasedMCConfig = {
  enabled: boolean        // GrowthBook: tengu_slate_heron
  gapThresholdMinutes: number  // 默认 60 分钟
  keepRecent: number      // 保留最近 N 个工具结果
}
```

- 当距离上次 assistant 消息超过 60 分钟，服务器缓存已经过期
- 清除所有旧的工具结果，用 `[Old tool result content cleared]` 标记替换
- 保留最近 N 个工具结果（默认 5）
- 仅对 `COMPACTABLE_TOOLS` 生效：Read, Bash, Grep, Glob, WebSearch, WebFetch, Edit, Write

#### b) 缓存编辑模式 (Cached MC)

```typescript
// microCompact.ts (cachedMicrocompactPath)
// 使用 API cache_edits 机制删除工具结果
// 不修改本地消息内容
toolsToDelete = getToolResultsToDelete(state)  // 基于计数阈值
cacheEdits = createCacheEditsBlock(state, toolsToDelete)
```

- 利用 Anthropic API 的 `cache_edits` 能力
- 不修改本地消息数组，只在 API 请求中添加 `cache_reference` 和 `cache_edits`
- 缓存前缀保持不变，只删除过时的工具结果
- 仅对主线程有效（forked agents 不参与）

#### c) API 策略模式

```typescript
// apiMicrocompact.ts: 发送到服务端的 ContextEditStrategy
strategy = {
  type: 'clear_tool_uses_20250919',
  trigger: { type: 'input_tokens', value: 180000 },
  clear_at_least: { type: 'input_tokens', value: 140000 },
  clear_tool_inputs: [SHELL_TOOL_NAMES, GLOB, GREP, FILE_READ, WEB_FETCH, WEB_SEARCH],
}
```

### 3.2 Tier 2: 自动压缩 (Auto Compact)

**入口**: `autoCompactIfNeeded()` 在每轮查询循环开始时调用。

```typescript
async function shouldAutoCompact(messages, model, querySource): boolean {
  // 递归守卫
  if (querySource === 'session_memory' || querySource === 'compact') return false
  
  // 环境变量禁用检查
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) return false
  if (!userConfig.autoCompactEnabled) return false

  // Reactive-only 模式压制
  if (feature('REACTIVE_COMPACT') && tengu_cobalt_raccoon) return false
  
  // Context collapse 模式压制
  if (feature('CONTEXT_COLLAPSE') && isContextCollapseEnabled()) return false
  
  // 阈值触发
  const tokenCount = tokenCountWithEstimation(messages)
  const threshold = getAutoCompactThreshold(model)
  return tokenCount >= threshold
}
```

**执行路径**:
1. 尝试 `trySessionMemoryCompaction()` — 如果有 session memory，优先使用
2. 失败则调用 `compactConversation()` — 发送给 API 生成摘要
3. 成功后: `runPostCompactCleanup()` 清理缓存

**断路器**:
- 连续 3 次自动压缩失败后放弃（防止无限重试）
- `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`

### 3.3 Tier 3: 全量压缩 (Full Compact)

**核心函数**: `compactConversation()` (compact.ts:186)

执行流程：
```
1. 预处理阶段:
   - hooks_start: PreCompact hooks 执行
   - 合并 hook 指令 + 用户自定义指令

2. 压缩摘要生成:
   - stripImagesFromMessages(): 替换图片为 [image] 标记
   - stripReinjectedAttachments(): 移除 skill_discovery 附件
   - 构建压缩 prompt (9 个 section 的结构化摘要)
   - 通过 forked agent 或 streaming API 生成摘要
   - PTL retry: 最多 3 次，丢弃最旧的分组

3. 后处理阶段:
   - 清除 readFileState 和 memory path 缓存
   - 恢复最近读取的文件 (最多 5 个，50K token 预算)
   - 恢复 Plan 附件、Skill 附件、Plan Mode 附件
   - 重新注入 deferred tools/agent listing/MCP 指令
   - 执行 SessionStart 和 PostCompact hooks

4. 构建返回:
   - boundaryMarker (SystemCompactBoundaryMessage)
   - summaryMessages (UserMessage, isCompactSummary: true)
   - attachments (文件、plan、skill)
   - hookResults (来自 SessionStart hooks)
```

### 3.4 部分压缩 (Partial Compact)

```typescript
async function partialCompactConversation(
  allMessages, pivotIndex, context, cacheSafeParams,
  userFeedback?, direction: 'from' | 'up_to'
)
```

- **direction = 'from'** (默认): 从 pivot 位置开始向后压缩，保留前面的消息
- **direction = 'up_to'**: 从开头到 pivot 位置压缩，保留后面的消息
- 保持工具调用/结果配对完整性
- 保留的段通过 `preservedSegment` 元数据标记

### 3.5 Session Memory 压缩 (实验性)

```typescript
// sessionMemoryCompact.ts
// 取代全量压缩，使用已提取的 session memory 作为摘要
// 仅保留 lastSummarizedMessageId 之后的消息
```

配置:
```typescript
type SessionMemoryCompactConfig = {
  minTokens: 10_000        // 最少保留 10K tokens
  minTextBlockMessages: 5  // 最少 5 条含文本的消息
  maxTokens: 40_000        // 最多保留 40K tokens
}
```

**优势**: 不需要额外 API 调用就可生成摘要（session memory 在后台持续提取）
**降级逻辑**: 如果 session memory 不可用或为空，回退到 legacy compact

### 3.6 摘要 Prompt 体系

```typescript
// prompt.ts
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools...`

const BASE_COMPACT_PROMPT = `您的任务是...9 个 section:
1. Primary Request and Intent
2. Key Technical Concepts  
3. Files and Code Sections (含完整代码片段)
4. Errors and fixes
5. Problem Solving
6. All user messages (非 tool result 的用户消息)
7. Pending Tasks
8. Current Work (最近工作的精确描述)
9. Optional Next Step (直接引用最近对话)
`

// 格式化: 
// 1. 剥离 <analysis> 分析草稿块  
// 2. 替换 <summary> 标签为可读标题
// 3. 添加 transcript 路径提示
// 4. suppressFollowUpQuestions 模式下：
//    "Continue the conversation from where it left off without asking..."
```

---

## 4. 关键代码片段

### 4.1 压缩边界标记的创建

```typescript
// utils/messages.ts:4536
export function createCompactBoundaryMessage(
  trigger: 'manual' | 'auto',
  preTokens: number,
  lastPreCompactMessageUuid?: UUID,
  userContext?: string,
  messagesSummarized?: number,
): SystemCompactBoundaryMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: `Conversation compacted`,
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    level: 'info',
    compactMetadata: {
      trigger, preTokens, userContext, messagesSummarized,
    },
    ...(lastPreCompactMessageUuid && { logicalParentUuid: lastPreCompactMessageUuid }),
  }
}
```

### 4.2 从边界获取消息

```typescript
// utils/messages.ts:4610
export function getMessagesAfterCompactBoundary<T extends Message>(
  messages: T[], options?: { includeSnipped?: boolean }
): T[] {
  const boundaryIndex = findLastCompactBoundaryIndex(messages)
  const sliced = boundaryIndex === -1 
    ? messages 
    : messages.slice(boundaryIndex)
  // 同时过滤 snipped 消息 (UI 保留但模型不可见)
  if (!options?.includeSnipped && feature('HISTORY_SNIP')) {
    return projectSnippedView(sliced)
  }
  return sliced
}
```

### 4.3 Token 估算

```typescript
// utils/tokens.ts:226
export function tokenCountWithEstimation(messages: readonly Message[]): number {
  // 找到最后的 API 响应，获取其 usage
  // 后续消息用 roughTokenCountEstimationForMessages 估算
  // 组合 = 最后 API 响应的 total_usage + 后续消息估算
}
```

### 4.4 Subagent 上下文隔离

```typescript
// utils/agentContext.ts
const agentContextStorage = new AsyncLocalStorage<AgentContext>()

// 在 subagent 执行时注入上下文
export function runWithAgentContext<T>(context: AgentContext, fn: () => T): T {
  return agentContextStorage.run(context, fn)
}

// 其他部分通过 getAgentContext() 获取当前 agent 身份
export function getAgentContext(): AgentContext | undefined {
  return agentContextStorage.getStore()
}
```

### 4.5 微压缩核心逻辑

```typescript
// services/compact/microCompact.ts
// 时间触发检查：
export function evaluateTimeBasedTrigger(messages, querySource): { gapMinutes, config } | null {
  const config = getTimeBasedMCConfig()
  if (!config.enabled || !querySource || !isMainThreadSource(querySource)) return null
  const lastAssistant = messages.findLast(m => m.type === 'assistant')
  // 计算 gap = (now - lastAssistant.timestamp) / 60_000
  // 如果 gap < gapThresholdMinutes 则返回 null
}
```

### 4.6 后压缩消息组装

```typescript
// services/compact/compact.ts:330
export function buildPostCompactMessages(result: CompactionResult): Message[] {
  return [
    result.boundaryMarker,           // 边界标记
    ...result.summaryMessages,       // 摘要 (UserMessage, isCompactSummary: true)
    ...(result.messagesToKeep ?? []), // 保留的最近消息
    ...result.attachments,           // 文件、plan、skill 附件
    ...result.hookResults,           // Hook 执行结果
  ]
}
```

---

## 5. 对 Pi 无限上下文方案的启示

### 5.1 三层递进架构的可借鉴性

Claude Code 的 **Tier 1 (微压缩) → Tier 2 (自动压缩) → Tier 3 (全量压缩)** 模型非常适合 Pi 的无限上下文方案：

| 层级 | 触发条件 | 成本 | 适用场景 |
|------|---------|------|---------|
| 消息剪枝 (Snip) | 每次渲染前 | 零 (纯客户端) | 旧消息从模型可见剪除，但保留在 UI 滚动缓存 |
| 微压缩 | 每轮 API 调用前 | 零 | 清除过时的工具结果，不改变消息结构 |
| 全量摘要压缩 | Token 接近阈值 | 一次 API 调用 | 精确保留关键上下文 |

### 5.2 关键设计决策

**a) 压缩边界标记 (Compact Boundary)**:
- Claude Code 使用 `SystemCompactBoundaryMessage` 在消息流中标记压缩点
- 后续操作通过 `getMessagesAfterCompactBoundary()` 拿到有效片段
- Pi 可以借鉴：用类似边界标记机制实现"断点续聊"，用户可回溯到任意压缩点

**b) 摘要注入 vs 消息替换**:
- Claude Code 用注入的 `UserMessage` (带 `isCompactSummary: true` 标记) 表示摘要
- 压缩后的上下文 = 边界 + 摘要 + 保留的最近消息 + 附件 + hook结果
- Pi 可以保留此模型，让 LLM 看到统一的、带摘要的消息序列

**c) 附件恢复机制 (Post-Compact Restoration)**:
- 压缩后自动恢复最近读取的文件（最多 5 个，50K token）
- 恢复 Plan、Skill 文件内容
- 恢复 Plan Mode 指令
- 重新注入工具变化 delta
- **这对于 Pi 至关重要**：压缩后必须重建模型的工作上下文

**d) 缓存共享 (Cache Sharing)**:
- 压缩用 forked agent + cache sharing 技术，直接复用主线程的 prompt cache
- 减少压缩本身的 API 成本
- Pi 如果支持 prompt caching，可以借鉴此模式

### 5.3 Subagent 上下文隔离

Claude Code 使用 `AsyncLocalStorage` 实现 agent 身份追踪：
- 每个 subagent 获得独立 `SubagentContext`
- 压缩循环会检查 `querySource` 防止死锁（subagent 不触发主线程的自动压缩）
- 缓存清理时区分主线程和 subagent（`runPostCompactCleanup` 的 `isMainThreadCompact` 检查）
- **Pi 的无限上下文必须同样隔离不同 agent 的上下文边界**

### 5.4 实验性特性的取舍

| 特性 | 状态 | 评估 |
|------|------|------|
| Session Memory 压缩 | 实验性 (GrowthBook 开关) | 值得借鉴：后台持续提取知识，压缩时零成本 |
| Context Collapse | 实验性 (CONTEXT_COLLAPSE) | 更激进的上下文管理，与 autocompact 互斥 |
| Reactive Compact | 实验性 | 响应式压缩，只在 API 拒绝时触发 |
| 时间触发微压缩 | 可配置 (GB) | 适合长期会话的缓存维护 |

### 5.5 实现建议

1. **分层策略**: 从轻量级开始（Snip → Microcompact），根据需要升级到全量压缩
2. **压缩频率**: 自动压缩阈值应为 `contextWindow - maxOutputTokens - buffer`，buffer 建议 10-15K
3. **消息模型**: 明确定义压缩边界标记、摘要消息、保留消息的层级关系
4. **恢复机制**: 压缩后必须重建文件缓存、工具注册、指令等模型工作上下文
5. **防死锁**: Subagent 或后台进程不应触发主线程的自动压缩
6. **断路器**: 压缩连续失败时应停止重试（建议 3 次）
7. **成本控制**: 全量压缩一次约 20K output tokens + 全部 context 的 input tokens，需合理控制频率
8. **用户透明度**: 提供可视化上下文使用率（类似 Claude Code 的 `/context` 命令）

### 5.6 技术债务关注点

从源码可以观察到 Cladue Code 积累的技术债务：
- 多处 TODO 注释（如 `shouldExcludeFromPostCompactRestore` 需要重构为 `isMemoryFilePath`）
- 特性开关爆炸（`feature('REACTIVE_COMPACT')`, `feature('CACHED_MICROCOMPACT')`, `feature('CONTEXT_COLLAPSE')` 等）
- 循环依赖问题（`grouping.ts` 为了解决 `compact.ts ↔ compactMessages.ts` 的循环依赖被独立出来）
- 手动 type assertion 较多（`as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`）
- **Pi 应在一开始就设计清晰的消息模型和压缩策略接口，避免后期大量引入条件开关**

---

## 6. 总结

Claude Code 的上下文管理是一个成熟的分层系统：
- **微观层面**: 每次 API 调用前清理无用工具结果，利用 cache_edits 保持缓存命中
- **中观层面**: Token 达到阈值时自动触发摘要压缩，优先使用 session memory 减少成本
- **宏观层面**: 手动 `/compact` 支持全量和部分压缩，用户可以控制保留哪一段历史

核心设计哲学是 **"渐进式压缩"**：从最轻量的操作开始，只在必要时升级到更重的操作，同时通过多级缓存（客户端缓存、API prompt cache、session memory）减少压缩本身的成本。
