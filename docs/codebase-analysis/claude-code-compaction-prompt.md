# Claude Code 上下文压缩（Compaction）机制深度分析

> 基于 Claude Code 源码 `src/services/compact/` 目录，分析其上下文压缩的完整架构、提示词设计和执行流程。

---

## 目录

1. [系统架构概览](#1-系统架构概览)
2. [压缩提示词完整分析](#2-压缩提示词完整分析)
3. [压缩触发条件与策略](#3-压缩触发条件与策略)
4. [压缩输入格式](#4-压缩输入格式)
5. [压缩输出格式与校验](#5-压缩输出格式与校验)
6. [消息分组逻辑](#6-消息分组逻辑)
7. [微压缩（MicroCompact）机制](#7-微压缩microcompact机制)
8. [Session Memory 压缩](#8-session-memory-压缩)
9. [API 微压缩](#9-api-微压缩)
10. [基于时间的微压缩配置](#10-基于时间的微压缩配置)
11. [关键设计决策与约束](#11-关键设计决策与约束)
12. [压缩后恢复机制](#12-压缩后恢复机制)

---

## 1. 系统架构概览

Claude Code 的上下文压缩系统由以下模块组成，形成多层次的上下文管理策略：

```
┌─────────────────────────────────────────────────────────────────────┐
│                      上下文压缩系统架构                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  第一层：微压缩 (MicroCompact) — 请求前自动执行                       │
│  ├── 时间微压缩 (timeBasedMC) — 缓存过期时清除旧 tool_result          │
│  ├── 缓存微压缩 (cachedMC) — 使用 cache_edits API 不破坏缓存          │
│  └── API 微压缩 (apiMicrocompact) — 服务端 context management         │
│                                                                     │
│  第二层：Session Memory 压缩 — 优先尝试的 LLM-free 压缩               │
│  └── 基于 session memory 文件 + 保留最近消息，无需 LLM 调用            │
│                                                                     │
│  第三层：大压缩 (Full Compact) — LLM 摘要压缩                         │
│  ├── 自动压缩 (autoCompact) — token 超阈值时自动触发                  │
│  ├── 手动压缩 (manual /compact) — 用户主动触发                        │
│  └── 部分压缩 (partialCompact) — 用户选择消息范围                      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**文件职责分工：**

| 文件 | 职责 |
|------|------|
| `prompt.ts` | 压缩提示词模板、格式化、摘要消息构造 |
| `compact.ts` | 大压缩主逻辑（全量压缩 + 部分压缩） |
| `microCompact.ts` | 微压缩入口（时间微压缩 + 缓存微压缩） |
| `autoCompact.ts` | 自动压缩触发判断和执行编排 |
| `sessionMemoryCompact.ts` | Session Memory 压缩（LLM-free 路径） |
| `grouping.ts` | 消息按 API round 分组 |
| `apiMicrocompact.ts` | 服务端 context management 策略配置 |
| `timeBasedMCConfig.ts` | 基于时间的微压缩配置（GrowthBook 远程配置） |

---

## 2. 压缩提示词完整分析

### 2.1 工具调用禁止前导指令（NO_TOOLS_PREAMBLE）

这是放在所有压缩提示词最前面的关键指令：

```
CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.
```

**设计意图：** 压缩使用 `maxTurns: 1` 的 forked agent 执行，如果模型尝试调用工具被拒绝后，就不再有输出机会。在 Sonnet 4.6+ adaptive-thinking 模型上，这个前导指令将工具调用率从 2.79% 降至 0.01%。

### 2.2 分析阶段指令（Analysis Instruction）

压缩提示词要求模型先在 `<analysis>` 标签中进行「草稿思考」，这是一个 **思考草稿本（drafting scratchpad）**，最终会被 `formatCompactSummary()` 移除。

**分析指令要求：**
1. 按时间顺序分析每条消息/每个部分
2. 对每个部分识别：
   - 用户的显式请求和意图
   - 处理用户请求的方法
   - 关键决策、技术概念和代码模式
   - 具体细节（文件名、完整代码片段、函数签名、文件编辑）
   - 遇到的错误及修复方式
   - **特别关注用户的反馈**，尤其是用户要求以不同方式做某事的情况
3. 仔细检查技术准确性和完整性

### 2.3 三种压缩提示词变体

#### 变体 A：BASE_COMPACT_PROMPT（全量压缩）

**使用场景：** 对整个对话历史进行压缩摘要。

**输出结构（9 个必填部分）：**

```
1. Primary Request and Intent — 用户的所有显式请求和意图
2. Key Technical Concepts — 所有重要技术概念、技术和框架
3. Files and Code Sections — 具体文件和代码段，包括完整代码片段
4. Errors and fixes — 所有遇到的错误及修复方式
5. Problem Solving — 已解决的问题和正在进行的排障
6. All user messages — 所有非工具结果的用户消息（关键！）
7. Pending Tasks — 所有明确的待处理任务
8. Current Work — 压缩请求前正在进行的精确工作
9. Optional Next Step — 与最近工作直接相关的下一步
```

**关键约束：**
- 第 9 部分（Optional Next Step）要求：**必须与用户最近的显式请求直接一致**，必须包含最近对话的原文引用
- 如果最后一个任务已完成，不要开始新的任务，除非用户明确要求

#### 变体 B：PARTIAL_COMPACT_PROMPT（部分压缩 'from' 方向）

**使用场景：** 只压缩选中消息之后的部分，之前的消息保持完整。

与 BASE 的区别：
- 开头强调 "the RECENT portion of the conversation"
- 分析指令改为 "Analyze the recent messages chronologically"
- 上下文范围限定为 "recent messages only"

#### 变体 C：PARTIAL_COMPACT_UP_TO_PROMPT（部分压缩 'up_to' 方向）

**使用场景：** 压缩选中消息之前的部分，摘要会被放置在继续会话的开头，后面跟新的消息。

**独特之处：**
- 第 8 部分从 "Current Work" 改为 "Work Completed"
- 第 9 部分从 "Optional Next Step" 改为 "Context for Continuing Work"
- 说明：*"This summary will be placed at the start of a continuing session; newer messages that build on this context will follow after your summary"*

### 2.4 尾部指令（NO_TOOLS_TRAILER）

```
REMINDER: Do NOT call any tools. Respond with plain text only — 
an <analysis> block followed by a <summary> block. 
Tool calls will be rejected and you will fail the task.
```

首尾双重提醒，确保模型不尝试工具调用。

### 2.5 自定义指令注入

用户和 Hook 可以提供额外的压缩指令，例如：

```markdown
## Compact Instructions
When summarizing the conversation focus on typescript code changes and also 
remember the mistakes you made and how you fixed them.
```

```markdown
# Summary instructions
When you are using compact - please focus on test output and code changes. 
Include file reads verbatim.
```

自定义指令通过 `Additional Instructions:` 前缀插入到提示词模板和尾部指令之间。

### 2.6 提示词组装流程

```typescript
function getCompactPrompt(customInstructions?: string): string {
  let prompt = NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT
  if (customInstructions?.trim()) {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`
  }
  prompt += NO_TOOLS_TRAILER
  return prompt
}
```

---

## 3. 压缩触发条件与策略

### 3.1 自动压缩触发（AutoCompact）

**触发阈值计算：**

```
autoCompactThreshold = effectiveContextWindow - 13,000 (AUTOCOMPACT_BUFFER_TOKENS)
effectiveContextWindow = contextWindowSize - maxOutputTokens (最大 20,000)
```

例如，对于 200K 上下文窗口的模型：
- `effectiveContextWindow = 200,000 - 20,000 = 180,000`
- `autoCompactThreshold = 180,000 - 13,000 = 167,000`
- 即上下文使用量达到 **~93%** 时触发

**触发判断流程：**

```
shouldAutoCompact()
  ├── 排除 session_memory / compact / marble_origami 查询源
  ├── 检查用户是否禁用自动压缩 (DISABLE_COMPACT / DISABLE_AUTO_COMPACT)
  ├── 检查 reactive-only 模式 (tengu_cobalt_raccoon)
  ├── 检查 context collapse 模式是否激活
  ├── 计算当前 token 数量 - snipTokensFreed
  └── 比较 tokenUsage >= autoCompactThreshold
```

**多重阈值体系：**

| 阈值类型 | 缓冲量 | 用途 |
|---------|--------|------|
| autoCompact | -13,000 | 自动压缩触发 |
| warning | -20,000 | 警告用户 |
| error | -20,000 | 错误提示 |
| blocking | -3,000 | 阻止继续对话 |

### 3.2 自动压缩执行流程

```typescript
autoCompactIfNeeded()
  ├── 断路器检查：连续失败 >= 3 次则跳过
  ├── shouldAutoCompact() 判断
  ├── 构造 RecompactionInfo（追踪链内重压缩）
  ├── trySessionMemoryCompaction()  ← 优先尝试 SM 压缩
  │   ├── 检查 feature flag (tengu_session_memory + tengu_sm_compact)
  │   ├── 等待 session memory 提取完成
  │   ├── 检查 session memory 是否为空
  │   ├── 计算保留消息的起始索引
  │   ├── 生成 CompactionResult
  │   └── 检查压缩后是否仍然超过阈值
  └── compactConversation()  ← 回退到 LLM 压缩
```

### 3.3 压缩优先级链

```
微压缩（每次 API 请求前）
  ↓ 如果 token 使用量超过自动压缩阈值
Session Memory 压缩（LLM-free，优先）
  ↓ 如果 SM 不可用或压缩后仍超阈值
大压缩（LLM 摘要，兜底）
```

---

## 4. 压缩输入格式

### 4.1 消息预处理

在发送给压缩 LLM 之前，消息经过以下预处理：

1. **移除图片和文档：** `stripImagesFromMessages()` 将所有 `image` 和 `document` block 替换为 `[image]` / `[document]` 文本标记
2. **移除重新注入的附件：** `stripReinjectedAttachments()` 过滤掉 `skill_discovery` / `skill_listing` 类型的附件（压缩后会重新注入）
3. **跳过压缩边界之前的内容：** `getMessagesAfterCompactBoundary()` 只取最后一个压缩边界之后的消息
4. **标准化消息格式：** `normalizeMessagesForAPI()` 处理 tool_use/tool_result 配对

### 4.2 系统提示词

压缩使用的系统提示词非常简单：

```typescript
systemPrompt: 'You are a helpful AI assistant tasked with summarizing conversations.'
```

这比正常对话的系统提示词轻量得多，有助于减少 token 消耗。

### 4.3 缓存共享机制

**Prompt Cache Sharing** 是压缩的核心优化（默认启用）：

- 使用 `runForkedAgent()` 创建一个 fork，复用主对话的缓存前缀（system prompt + tools + context messages）
- 不设置 `maxOutputTokens`（避免造成 thinking config 不匹配导致缓存失效）
- 缓存命中率通过 `cacheHitRate` 指标追踪

### 4.4 两条执行路径

```
streamCompactSummary()
  ├── 路径 1: Forked Agent（缓存共享，优先）
  │   └── runForkedAgent() 复用主线程 prompt cache
  │       ├── 成功 → 返回 assistant message
  │       └── 失败 → 降级到路径 2
  └── 路径 2: 常规流式（fallback）
      └── queryModelWithStreaming() 独立请求
          ├── 思考禁用：thinkingConfig: { type: 'disabled' }
          ├── 输出限制：maxOutputTokensOverride = min(20K, modelMax)
          └── 可重试：最多 2 次（streaming retry）
```

### 4.5 Prompt-Too-Long 重试机制

如果压缩请求本身超出长度限制（CC-1180），系统会：

1. 调用 `truncateHeadForPTLRetry()` 丢弃最旧的 API round 分组
2. 最多重试 `MAX_PTL_RETRIES = 3` 次
3. 如果丢弃的 token 量可解析，按精确 gap 裁剪；否则丢弃 20% 的分组
4. 如果裁剪后第一组是 assistant 开头，插入合成 user message `[earlier conversation truncated for compaction retry]`

---

## 5. 压缩输出格式与校验

### 5.1 原始输出格式

模型输出包含两个 XML 块：

```xml
<analysis>
[思考草稿，按时间顺序分析每条消息]
</analysis>

<summary>
1. Primary Request and Intent:
   [详细描述]
   
2. Key Technical Concepts:
   - [概念 1]
   - [概念 2]
   
3. Files and Code Sections:
   - [文件名]
      - [重要性说明]
      - [完整代码片段]
      
4. Errors and fixes:
   - [错误描述]
     - [修复方式]
     
5. Problem Solving:
   [描述]
   
6. All user messages:
   - [消息内容]
   
7. Pending Tasks:
   - [任务]
   
8. Current Work:
   [精确描述]
   
9. Optional Next Step:
   [下一步 + 原文引用]
</summary>
```

### 5.2 格式化处理

`formatCompactSummary()` 对原始输出进行两步处理：

1. **移除 `<analysis>` 块** — 这是起草用的草稿本，提高摘要质量但不保留
2. **转换 `<summary>` 标签** — 替换为 `Summary:` 标题头

```typescript
function formatCompactSummary(summary: string): string {
  // 移除 analysis 草稿
  formattedSummary = formattedSummary.replace(/<analysis>[\s\S]*?<\/analysis>/, '')
  
  // 提取并格式化 summary 部分
  const summaryMatch = formattedSummary.match(/<summary>([\s\S]*?)<\/summary>/)
  if (summaryMatch) {
    formattedSummary = formattedSummary.replace(
      /<summary>[\s\S]*?<\/summary>/,
      `Summary:\n${content.trim()}`
    )
  }
  
  // 清理多余空行
  formattedSummary = formattedSummary.replace(/\n\n+/g, '\n\n')
  return formattedSummary.trim()
}
```

### 5.3 摘要注入消息

`getCompactUserSummaryMessage()` 构造注入到新对话中的摘要消息：

```
This session is being continued from a previous conversation that ran out of context. 
The summary below covers the earlier portion of the conversation.

[格式化后的摘要]

If you need specific details from before compaction (like exact code snippets, 
error messages, or content you generated), read the full transcript at: [transcriptPath]

Recent messages are preserved verbatim.

Continue the conversation from where it left off without asking the user any further 
questions. Resume directly — do not acknowledge the summary, do not recap what was 
happening, do not preface with "I'll continue" or similar. Pick up the last task as 
if the break never happened.
```

**关键约束：**
- `suppressFollowUpQuestions = true`（自动压缩时）→ 要求模型直接继续，不问问题
- Proactive 模式额外指令：*"You are running in autonomous/proactive mode. Continue your work loop."*
- 提供 transcript 路径，让模型可以回查具体细节

### 5.4 输出校验

压缩输出经过以下校验：

1. **空输出检查：** `summary` 为空 → 抛出 "Failed to generate conversation summary"
2. **API 错误前缀检查：** `startsWithApiErrorPrefix(summary)` → 抛出 API 错误
3. **Prompt-Too-Long 检查：** `summary.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE)` → 触发 PTL 重试
4. **Abort 检查：** `assistantMsg.isApiErrorMessage` → 不当作成功处理

---

## 6. 消息分组逻辑

`grouping.ts` 中的 `groupMessagesByApiRound()` 是压缩系统中消息裁剪的基础。

### 6.1 分组规则

**核心思想：** 按 API round-trip 边界分组，而非按人类消息轮次分组。

**分组逻辑：**
- 每个 API 请求-响应构成一个 group
- 边界触发条件：遇到一个 **新的** assistant 消息（`message.id` 与前一个 assistant 不同）
- 同一个 API 响应的流式分块（thinking、tool_use 等）共享相同的 `message.id`，保持在同一 group

```
Group 1: [user_A] → [assistant_1 (thinking)] → [assistant_1 (tool_use)] → [tool_result]
Group 2: [assistant_2 (text)] → [user_B]
Group 3: [assistant_3 (tool_use)] → [tool_result] → [assistant_3 (text)]
```

### 6.2 设计理由

- ** finer-grained**：相比人类轮次分组，API round 分组更细粒度
- **SDK/CCR/eval 兼容**：这些场景中整个工作负载可能只有一个人类轮次
- **API 安全的分割点**：API 契约保证每个 tool_use 在下一个 assistant turn 前被 resolve
- **容错处理**：对于畸形对话（如 resume 后的悬挂 tool_use），fork 的 `ensureToolResultPairing` 会在 API 时修复

---

## 7. 微压缩（MicroCompact）机制

微压缩是在每次 API 请求前自动执行的轻量级上下文管理。

### 7.1 三种微压缩路径

```
microcompactMessages()
  ├── 路径 1: 时间微压缩 (maybeTimeBasedMicrocompact)
  │   ├── 条件：距上次 assistant 消息超过 gapThresholdMinutes (默认 60 分钟)
  │   ├── 动作：直接清除旧 tool_result 内容 → 替换为 "[Old tool result content cleared]"
  │   ├── 原理：服务器缓存已过期，无论如何都会重写，提前清除减少重写量
  │   └── 保留：最近 keepRecent 个 (默认 5) tool result 不清除
  │
  ├── 路径 2: 缓存微压缩 (cachedMicrocompactPath)
  │   ├── 条件：feature('CACHED_MICROCOMPACT') + 模型支持 + 主线程
  │   ├── 动作：通过 cache_edits API 删除 tool_result，不破坏缓存前缀
  │   ├── 不修改本地消息内容，在 API 层添加 cache_reference/cache_edits
  │   └── 阈值和保留数量由 GrowthBook 配置
  │
  └── 路径 3: 无操作
      └── 旧版内容清除路径已移除，回退到大压缩处理
```

### 7.2 可压缩的工具类型

微压缩只处理以下工具的 tool_result：

```typescript
const COMPACTABLE_TOOLS = new Set([
  'Read',           // FileReadTool
  'Bash',           // Shell tools
  'Grep',           // GrepTool
  'Glob',           // GlobTool
  'WebSearch',      // WebSearchTool
  'WebFetch',       // WebFetchTool
  'Edit',           // FileEditTool
  'Write',          // FileWriteTool
])
```

### 7.3 时间微压缩触发条件

```typescript
evaluateTimeBasedTrigger():
  ├── config.enabled === false → 不触发
  ├── querySource 为空或非主线程 → 不触发
  ├── 无 assistant 消息 → 不触发
  ├── gapMinutes < config.gapThresholdMinutes → 不触发
  └── 触发 → 返回 { gapMinutes, config }
```

### 7.4 缓存微压缩状态管理

```typescript
// 全局状态（仅主线程）
cachedMCState: {
  registeredTools: Set<string>     // 已注册的 tool_use_id
  toolOrder: string[]              // 工具注册顺序
  deletedRefs: Set<string>         // 已删除的引用
  pinnedEdits: PinnedCacheEdits[]  // 已固定的 cache_edits
}

// 流程：
// 1. collectCompactableToolIds() → 收集所有可压缩的 tool_use ID
// 2. registerToolResult() → 注册到状态
// 3. registerToolMessage() → 按 user message 分组注册
// 4. getToolResultsToDelete() → 计算需要删除的列表
// 5. createCacheEditsBlock() → 创建 cache_edits 块
// 6. consumePendingCacheEdits() → API 层消费
```

---

## 8. Session Memory 压缩

Session Memory 压缩是一种 **不调用 LLM** 的压缩方式，利用后台维护的 session memory 文件作为摘要。

### 8.1 启用条件

需要两个 feature flag 同时开启：
- `tengu_session_memory` — session memory 功能总开关
- `tengu_sm_compact` — SM 压缩开关

### 8.2 配置参数

```typescript
DEFAULT_SM_COMPACT_CONFIG = {
  minTokens: 10_000,           // 保留最少 token 数
  minTextBlockMessages: 5,     // 保留最少含文本的消息数
  maxTokens: 40_000,           // 保留最多 token 数
}
```

### 8.3 执行流程

```
trySessionMemoryCompaction()
  ├── 检查 feature flags
  ├── 等待 session memory 提取完成
  ├── 获取 session memory 内容
  ├── 检查 SM 是否为空模板 → 空则回退
  ├── 
  ├── 场景 1：有 lastSummarizedMessageId
  │   └── 找到该 ID 对应的消息索引作为起点
  ├── 
  ├── 场景 2：恢复的会话（无 lastSummarizedMessageId）
  │   └── 从最后一条消息开始，初始保留 0 条
  ├── 
  ├── calculateMessagesToKeepIndex()
  │   ├── 从起点向后计算已有 token 和文本消息数
  │   ├── 如果已满足 minTokens + minTextBlockMessages → 停止
  │   ├── 否则向前扩展直到满足条件或达到 maxTokens
  │   ├── 不越过上一个 compact boundary
  │   └── adjustIndexToPreserveAPIInvariants()
  │       ├── 保证 tool_use/tool_result 不被拆分
  │       └── 保证共享 message.id 的 thinking block 不被拆分
  ├──
  ├── 过滤掉旧的 compact boundary 消息
  ├── 运行 session_start hooks
  ├── 创建 CompactionResult
  │   ├── boundary marker
  │   ├── session memory 内容作为 summary
  │   ├── messagesToKeep
  │   └── hookResults
  └── 检查压缩后 token 是否仍超阈值 → 超则回退
```

### 8.4 与大压缩的对比

| 特征 | Session Memory 压缩 | 大压缩 (LLM) |
|------|-------------------|-------------|
| LLM 调用 | ❌ 不需要 | ✅ 需要 |
| 摘要来源 | 后台维护的 SM 文件 | LLM 实时生成 |
| 保留消息 | ✅ 保留最近消息 | ❌ 全部替换 |
| 延迟 | 极低 | 5-10+ 秒 |
| Token 成本 | 无 API 成本 | 需要消耗 input + output tokens |
| 适用条件 | SM 功能启用 + SM 非空 | 始终可用 |

### 8.5 API 不变性保护

`adjustIndexToPreserveAPIInvariants()` 处理两个关键场景：

**场景 1：tool_use/tool_result 配对**
- 如果保留的消息中包含 `tool_result`，确保对应的 `tool_use` 也被包含
- 防止 API 报错 "orphan tool_result references non-existent tool_use"

**场景 2：流式分块的 message.id 合并**
- 流式输出会为每个 content block（thinking、tool_use）生成独立的 message，但共享相同的 `message.id`
- `normalizeMessagesForAPI` 会按 `message.id` 合并这些消息
- 如果分割导致 thinking block 与其同 id 的 tool_use 被拆开，合并会丢失 thinking

---

## 9. API 微压缩

API 微压缩利用 Anthropic API 原生的 **Context Management** 功能，在服务端进行上下文裁剪。

### 9.1 两种策略

#### 策略 1: `clear_tool_uses_20250919` — 清除工具结果

```typescript
{
  type: 'clear_tool_uses_20250919',
  trigger: { type: 'input_tokens', value: 180_000 },      // 触发阈值
  clear_at_least: { type: 'input_tokens', value: 140_000 }, // 至少清除量
  clear_tool_inputs: ['Bash', 'Glob', 'Grep', 'Read', ...], // 可清除输入的工具
  // 或
  exclude_tools: ['Edit', 'Write', 'NotebookEdit'],        // 排除的工具
}
```

**设计：**
- 触发：当 `input_tokens` 达到 180K 时
- 目标：保留最近 40K token 的上下文
- 两种子模式：清除工具结果（`clear_tool_inputs`）或清除工具调用（`exclude_tools`）

#### 策略 2: `clear_thinking_20251015` — 清除思考块

```typescript
{
  type: 'clear_thinking_20251015',
  keep: 'all'                                              // 保留所有
  // 或
  keep: { type: 'thinking_turns', value: 1 }               // 只保留最近 1 轮
}
```

**条件：**
- 需要 `hasThinking = true`
- 不在 redact-thinking 模式下
- `clearAllThinking` 时只保留最近 1 轮（用于 >1h 空闲后的缓存 miss 场景）

### 9.2 启用条件

- 需要设置环境变量 `USE_API_CLEAR_TOOL_RESULTS` 或 `USE_API_CLEAR_TOOL_USES`
- 思考清除策略对非 ant 用户也生效
- 工具清除策略仅对 ant 用户生效

---

## 10. 基于时间的微压缩配置

### 10.1 配置参数

```typescript
TimeBasedMCConfig = {
  enabled: false,              // 总开关（默认关闭）
  gapThresholdMinutes: 60,     // 空闲超过 60 分钟触发（匹配服务器 1h cache TTL）
  keepRecent: 5,               // 保留最近 5 个 tool result
}
```

### 10.2 配置来源

通过 GrowthBook feature flag `tengu_slate_heron` 远程配置，支持运行时调整。

### 10.3 设计原理

> 60 分钟是安全选择：服务器的 1h cache TTL 保证已过期，所以清除不会导致原本可以命中的缓存 miss。

时间微压缩在 API 调用之前执行（在 `microcompactMessages` 中），这样缩小的 prompt 直接发送，减少 rewrite 量。

---

## 11. 关键设计决策与约束

### 11.1 缓存保护

- **Forked Agent 路径**：复用主线程的 prompt cache，不设置 maxOutputTokens 避免缓存失效
- **缓存微压缩**：使用 cache_edits API 而非修改消息内容，保护缓存前缀
- **时间微压缩**：在确认缓存已过期时才清除内容，避免强制 miss
- **压缩后通知**：`notifyCompaction()` 重置缓存读取基线，避免误报缓存 break

### 11.2 断路器（Circuit Breaker）

- 自动压缩连续失败 **3 次** 后停止尝试
- 避免在上下文不可恢复地超出限制时浪费 API 调用
- 数据支撑：1,279 个会话曾出现 50+ 连续失败，浪费 ~250K API 调用/天

### 11.3 消息完整性保护

- `adjustIndexToPreserveAPIInvariants()` 确保 tool_use/tool_result 不被拆分
- 同 `message.id` 的流式分块保持在一起
- 不越过 compact boundary 作为分割底线

### 11.4 Hook 系统

压缩过程涉及 4 个 Hook 触发点：

```
PreCompact Hooks → 压缩开始前
  ↓
SessionStart Hooks → 压缩成功后（恢复 CLAUDE.md 等上下文）
  ↓
PostCompact Hooks → 压缩完成后
  ↓
（此外还有 compact progress 通知给 UI）
```

Hook 可以：
- 修改自定义指令（`newCustomInstructions`）
- 提供用户显示消息（`userDisplayMessage`）

### 11.5 图片处理

压缩前将所有图片/文档替换为文本标记 `[image]` / `[document]`：
- 避免压缩请求本身超出长度限制
- 在 CCD 会话中用户经常附加图片，这个问题尤其突出
- 同时处理嵌套在 `tool_result` 中的图片

---

## 12. 压缩后恢复机制

### 12.1 文件内容恢复

压缩会重新读取最近访问的文件（最多 5 个），作为附件注入：

```typescript
POST_COMPACT_MAX_FILES_TO_RESTORE = 5
POST_COMPACT_TOKEN_BUDGET = 50_000
POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000
```

- 按时间戳排序，优先恢复最近访问的文件
- 排除 CLAUDE.md 和 plan 文件（这些有专门的恢复机制）
- 跳过在保留消息中已可见的 Read 结果

### 12.2 Skill 内容恢复

```typescript
POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000
POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000
```

- 按最近使用时间排序
- 每个 skill 截断到 5K token，保留文件头部（通常包含设置和使用说明）
- 不重新注入完整 skill_listing（~4K token），因为模型仍可通过 SkillTool 访问

### 12.3 其他恢复

- **Plan 文件**：如果有 plan 文件，作为 `plan_file_reference` 附件恢复
- **Plan 模式**：如果当前在 plan 模式，注入 `plan_mode` 附件保持模式
- **Agent 列表**：重新公告 agent 列表 delta
- **MCP 指令**：重新公告 MCP 工具指令 delta
- **延迟工具**：重新公告 deferred tools delta
- **异步 Agent**：恢复正在运行的异步 agent 状态

### 12.4 Session Metadata 恢复

```typescript
reAppendSessionMetadata()  // 重新追加会话标题和标签
```

确保自定义会话标题在压缩后不会丢失（因为 `readLiteMetadata` 只读尾部 16KB 窗口）。

---

## 附录：关键常量速查表

| 常量 | 值 | 含义 |
|------|-----|------|
| `AUTOCOMPACT_BUFFER_TOKENS` | 13,000 | 自动压缩缓冲 |
| `WARNING_THRESHOLD_BUFFER_TOKENS` | 20,000 | 警告阈值缓冲 |
| `ERROR_THRESHOLD_BUFFER_TOKENS` | 20,000 | 错误阈值缓冲 |
| `MANUAL_COMPACT_BUFFER_TOKENS` | 3,000 | 手动压缩缓冲 |
| `MAX_OUTPUT_TOKENS_FOR_SUMMARY` | 20,000 | 摘要最大输出（p99.99 = 17,387） |
| `POST_COMPACT_MAX_FILES_TO_RESTORE` | 5 | 压缩后恢复文件数上限 |
| `POST_COMPACT_TOKEN_BUDGET` | 50,000 | 压缩后附件 token 预算 |
| `POST_COMPACT_MAX_TOKENS_PER_FILE` | 5,000 | 每文件 token 上限 |
| `POST_COMPACT_MAX_TOKENS_PER_SKILL` | 5,000 | 每 skill token 上限 |
| `POST_COMPACT_SKILLS_TOKEN_BUDGET` | 25,000 | Skill 总 token 预算 |
| `MAX_PTL_RETRIES` | 3 | Prompt-Too-Long 重试上限 |
| `MAX_COMPACT_STREAMING_RETRIES` | 2 | 流式压缩重试上限 |
| `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` | 3 | 断路器阈值 |
| `IMAGE_MAX_TOKEN_SIZE` | 2,000 | 图片 token 估算值 |
| `TIME_BASED_MC gapThresholdMinutes` | 60 | 时间微压缩空闲阈值（分钟） |
| `TIME_BASED_MC keepRecent` | 5 | 时间微压缩保留数量 |
| `SM_COMPACT minTokens` | 10,000 | SM 压缩最少保留 token |
| `SM_COMPACT minTextBlockMessages` | 5 | SM 压缩最少保留文本消息 |
| `SM_COMPACT maxTokens` | 40,000 | SM 压缩最多保留 token |
| `API DEFAULT_MAX_INPUT_TOKENS` | 180,000 | API 微压缩触发阈值 |
| `API DEFAULT_TARGET_INPUT_TOKENS` | 40,000 | API 微压缩目标保留量 |
