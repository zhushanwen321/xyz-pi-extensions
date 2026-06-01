# 上下文管理三扩展 — 完整源码架构对比

> 分析对象：pi-context-prune（⭐175）、magic-context（⭐764）、context-engineering（自有）
> 分析日期：2025-06-01
> 分析深度：源码级（所有核心文件已完整阅读）

---

## 1. 整体架构对比

### 1.1 架构图

#### context-engineering（你的）

```
context event
     │
     ▼
┌─────────────────────────────────────────────────┐
│           compressContext(messages, config)       │
│                                                    │
│  ┌─── MC ───┐  ┌── Budget ──┐  ┌── L0 ──┐       │
│  │ 时间间隔   │  │ 按 user    │  │ 过期    │       │
│  │ >60min   │→ │ 消息分段   │→ │ 截断   │       │
│  │ 清理旧输出 │  │ 总量预算   │  │ thinking│       │
│  └───────────┘  └───────────┘  └────┬───┘       │
│                                      │             │
│              ┌── L1 ──┐  ┌── L2 ──┐  │           │
│              │ 大输出   │  │ 紧急    │  │           │
│              │ 结构化摘要│→ │ 强制过期│  │           │
│              └─────────┘  └────┬───┘  │           │
│                               │      │             │
│                     ┌── 配对校验 ──┐   │           │
│                     │ validateTool │←─┘           │
│                     │ Pairing()   │               │
│                     └──────┬──────┘               │
│                            │                       │
│              recall_store (内存 Map, UUID ID)       │
│              frozen_fresh_state (跨 turn 持久化)    │
└────────────────────────────────────────────────────┘
```

**特点**：同步管道，零 LLM 调用，纯规则驱动。

#### pi-context-prune

```
turn_end event
     │
     ▼ captureBatch()
┌──────────────────┐
│ pendingBatches[]  │ ← 累积
└────────┬─────────┘
         │ (触发条件: every-turn / agent-message / agentic-auto ...)
         ▼ flushPending()
┌──────────────────────────────────────────────────────────┐
│  summarizeBatches() ← LLM 调用 (stream, 并行/串行)        │
│       │                                                   │
│       ├→ SummarizeResult[] (摘要文本 + usage)              │
│       │                                                   │
│       ├→ oversized 检查: summary.length > raw.length → skip│
│       │                                                   │
│       ├→ pi.sendMessage({deliverAs: "steer"}) 注入摘要      │
│       │                                                   │
│       └→ indexer.addBatch() → pi.appendEntry 持久化原文     │
│                                                           │
│  frontier.advance() — 追踪剪枝边界                          │
│  statsAccum.add() — 累积 token 成本                        │
└──────────────────────────────────────────────────────────┘

context event
     │
     ▼ pruneMessages()
┌──────────────────────────────────────────────────────────┐
│  过滤: role === "toolResult" && indexer.isSummarized(id)  │
│  保留: AssistantMessage (toolCall blocks) 不删除            │
│                                                           │
│  + agentic-auto 模式: annotateWithUnprunedCount()         │
│    在最后一个 toolResult 追加 <pruner-note> 提醒            │
└──────────────────────────────────────────────────────────┘
```

**特点**：异步 LLM 摘要，5 种触发模式，短 ID 召回系统，oversized 保护。

#### magic-context

```
message_end / 定时
     │
     ▼
┌───────────────────────────────────────────────────────────┐
│  Historian (subagent 进程)                                 │
│    触发: context usage > 65%                                │
│    执行: 独立 Pi 进程压缩历史 → compartment (分区摘要)        │
│    存储: SQLite compartments 表 + tags                      │
├───────────────────────────────────────────────────────────┤
│  Dreamer (subagent 进程)                                   │
│    触发: 定时 cron 或手动                                    │
│    执行: 分析项目状态 → 更新 memory + 策略建议                │
├───────────────────────────────────────────────────────────┤
│  Forge (context event 内)                                   │
│    触发: 每次 context event                                  │
│    管道:                                                     │
│      1. Tagger → §N§/§S§/§D§ 前缀标记消息                    │
│      2. Heuristic Cleaner → 规则清理 (年龄、去重)            │
│      3. Caveman Compressor → 基于年龄的文本压缩              │
│      4. Injection → compartment + memory 注入 system prompt │
│      5. Nudge → 高使用率时提示 agent 调用 ctx_reduce          │
├───────────────────────────────────────────────────────────┤
│  工具: ctx_search, ctx_memory, ctx_note, ctx_expand,        │
│        ctx_reduce                                           │
│  存储: SQLite (~/.local/share/cortexkit/magic-context/)     │
│  搜索: FTS5 全文 + embedding 语义搜索                       │
└───────────────────────────────────────────────────────────┘
```

**特点**：三层架构（Historian + Dreamer + Forge），SQLite 持久化，跨 session 记忆，50K+ 行代码。

### 1.2 规模对比

| 维度 | context-engineering | pi-context-prune | magic-context |
|------|-------------------|-----------------|---------------|
| 总行数（不含测试） | **~800** | **~3,476** | **~50,365** |
| 源文件数 | 6 | 17 | 100+ |
| 事件监听 | 1 (`context`) | 7 | 10+ |
| 工具注册 | 1 (`recall_context`) | 2 (`context_tree_query`, `context_prune`) | 5+ |
| 命令注册 | 2 | 1 (`/pruner`) | 6+ |
| 外部依赖 | 无 | 无（仅 Pi SDK） | SQLite, embedding |
| 额外 LLM 调用 | **0** | **1+/batch** | **多次/subagent** |

---

## 2. 核心数据结构对比

### 2.1 context-engineering

```typescript
// 回忆存储 — 纯内存 Map，session 结束即丢失
interface StoredContent {
  id: string;           // "ctx-" + UUID[0:12]
  original: string;     // 完整原始内容
  compressedAt: number; // 时间戳
  level: "l0-expired" | "l0-truncated" | "l1-condensed" | "l2-emergency" | "mc-cleared" | "budget-persisted";
}
// 上限 500 条，LRU 淘汰

// Turn 边界 — 按 user/bashExecution 消息分段
interface TurnBoundary {
  startIndex: number;
  endIndex: number;   // 不含
  timestamp: number;
}

// 冻结状态 — Budget 层标记已持久化的 toolCallId
// 跨 turn 保持，确保同一 toolCallId 后续 turn 用相同 replacement
interface FrozenFreshState {
  isFrozen(toolUseId: string): boolean;
  markFrozen(toolUseId: string, replacement: string): void;
  getReplacement(toolUseId: string): string | undefined;
}

// 压缩统计 — 累积，用于 /context-stats 命令
interface CompressionStats {
  l0Expired: number; l0Truncated: number; l0ThinkingCleared: number;
  l1Condensed: number; l2Triggered: boolean; validationFailed: boolean;
  mcTriggered: boolean; mcCleared: number; budgetPersisted: number;
}
```

### 2.2 pi-context-prune

```typescript
// 捕获的工具调用
interface CapturedToolCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  resultText: string;   // 完整原文
  isError: boolean;
}

// 一轮 batch — 从 turn_end 捕获
interface CapturedBatch {
  turnIndex: number;
  timestamp: number;
  assistantText: string;  // 非工具调用的助手文本
  toolCalls: CapturedToolCall[];
  userTurnGroup?: number; // 用于 agent-message 批量模式合并
}

// 索引记录 — 通过 pi.appendEntry 持久化
interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  resultText: string;  // 完整原文，可跨 session 恢复
  isError: boolean;
  turnIndex: number;
  timestamp: number;
}

// 短 ID 引用 — t1, t2, ... → 真实 toolCallId
interface SummaryToolCallRef {
  shortId: string;    // "t1", "t2", ...
  toolCallId: string; // 真实 ID
}

// 剪枝边界 — 追踪最后一次成功的剪枝尝试
interface PruneFrontier {
  lastAttemptedToolCallId: string;
  lastAttemptedToolName: string;
  lastAttemptedTurnIndex: number;
  lastAttemptedTimestamp: number;
  attemptedBatchCount: number;
  attemptedToolCallCount: number;
  rawCharCount: number;
  summaryCharCount: number;
  outcome: "summarized" | "skipped-oversized";
}

// LLM 摘要结果
interface SummarizeResult {
  summaryText: string;
  usage: { input, output, cacheRead, cacheWrite, totalTokens, cost };
}
```

### 2.3 magic-context

```
SQLite 数据库，核心表：
- compartments: 分区摘要（带 tags，可按 tag 搜索/注入）
- memories: 跨 session 记忆（项目知识、用户偏好）
- tags: §N§/§S§/§D§ 标记的消息状态
- embeddings: 语义搜索向量（可选，需要 embedding 服务）
- sessions: session 元数据
- migrations: Schema 版本管理

核心数据流：
消息 → Tagger 打标 → 按标签过滤 → Caveman 压缩 → compartment 注入
```

---

## 3. 压缩算法深度对比

### 3.1 context-engineering: 5 层同步管道

| 层 | 触发条件 | 算法 | 效果 |
|---|---------|------|------|
| **MC** | 最后 assistant 时间戳距今 > 60 分钟 | 过期旧工具输出，保留最近 5 个 | 处理"午休回来"场景 |
| **Budget** | 按 user 消息分段，工具输出总量 > 200K chars | 循环持久化最大的工具输出，替换为 preview | 防止单段过载 |
| **L0** | 工具输出年龄 > 30 分钟 | 替换为 `[expired. ID: xxx]` + thinking 清理 | 基础过期 |
| **L1** | 工具输出 > 8000 chars | head/tail 保留 + import/definition 行保留，中间省略 | 结构化摘要 |
| **L2** | context usage > 90% | 强制过期所有非保护 turn 的工具输出 | 紧急逃生 |

**关键设计**：
- `findTurnBoundaries()`：按 user/bashExecution 消息分段，每个 turn 独立判断是否保护
- `isInProtectedTurn()`：保留最近 N 个 turn，防止压缩当前工作中的内容
- `validateToolPairing()`：压缩后校验 assistant toolCall 和 toolResult 的配对完整性，配对失败则回滚到原始消息
- `FrozenFreshState`：Budget 层标记已持久化的 toolCallId，后续 turn 用相同 replacement 文本，保证一致性

### 3.2 pi-context-prune: LLM 驱动的流式摘要

**核心算法流程**：

```
1. turn_end → captureBatch()
   - 从 event.message 提取 toolCall blocks
   - 从 event.toolResults 匹配结果
   - 过滤掉 context_prune 自己的调用
   - 加入 pendingBatches[]

2. 触发条件检查
   - every-turn: 每次 turn_end 直接 flush
   - agent-message: 累积到助手发送最终文本回复时 flush
   - agentic-auto: LLM 自己调用 context_prune 工具触发 flush
   - on-demand: 用户手动 /pruner now
   - on-context-tag: LLM 调用 context_tag 时 flush

3. flushPending()
   a. capturePendingBatches() — 从 session branch 扫描未摘要的 batch
   b. trimBatchToPendingRange() — 用 frontier 和 indexer 过滤已处理的
   c. groupBatchesByMode() — agent-message 模式合并同组 batch
   d. summarizeBatches() — 每个独立 LLM 调用，并行或串行
      - serializeBatchForSummarizer(): 格式化每个工具调用为文本
        - 每个结果截断到 2000 chars（用于 prompt，非最终输出）
      - stream() 调用 LLM，支持 abort signal
   e. oversized 检查: summaryText.length > rawCharCount → skip
   f. pi.sendMessage({deliverAs: "steer"}) 注入摘要到 LLM 上下文
   g. indexer.addBatch() → pi.appendEntry 持久化原文到 session

4. context event → pruneMessages()
   - 过滤 role === "toolResult" && indexer.isSummarized(id)
   - 保留 AssistantMessage 的 toolCall blocks（让 LLM 能引用）
   - agentic-auto 模式追加 <pruner-note> 到最后一个 toolResult
```

**LLM 摘要 Prompt**：

```
System: You are summarizing a batch of tool calls made by an AI coding assistant.
For each tool call provide:
- Tool name and a one-sentence description of what it did
- Key outcome: success/failure and the most important data returned
- Any findings the future conversation needs to remember
Keep each tool call to 1-3 bullet points. Be concise.

User: <tool-call-batch>
Tool: read({file: "src/index.ts"})
Result (OK): ... (truncated to 2000 chars)
---
Tool: grep({pattern: "TODO"})
Result (OK): ...
---
</tool-call-batch>
```

### 3.3 magic-context: 三层架构

**Historian（历史压缩器）**：
- 触发：context usage > 65%
- 执行：启动 Pi subagent（独立进程）
- 过程：将对话历史发送给 LLM，生成 tagged compartment（分区摘要）
- 存储：SQLite compartments 表，带 tag 系统

**Dreamer（规划器）**：
- 触发：定时 cron 或手动 `/ctx-dream`
- 执行：Pi subagent 分析项目状态
- 输出：memory 更新 + 策略建议

**Forge（实时管道，在 context event 内）**：
```
Tagger → 给每条消息打 §N§/§S§/§D§ 标签
  ↓
Heuristic Cleaner → 规则清理（基于年龄、去重、结构删除）
  ↓
Caveman Compressor → 越旧的内容压缩越狠
  ↓
Injection → compartment + memory 注入 system prompt（通过 hash 检测保护 cache）
  ↓
Nudge → 高使用率时提示 agent 调用 ctx_reduce
```

---

## 4. 持久化与恢复对比

### 4.1 context-engineering

| 机制 | 实现 | 生命周期 |
|------|------|---------|
| RecallStore | 内存 `Map<string, StoredContent>` | **session 内**，session_start 重建为空 |
| FrozenFreshState | 内存 `Map<string, string>` | **session 内**，跨 turn 持久 |
| CompressionStats | 闭包变量 | **session 内** |
| 配置 | `~/.pi/agent/settings.json` | 跨 session |

**无跨 session 持久化**。一旦 session 结束，所有被压缩的原始内容丢失。

### 4.2 pi-context-prune

| 机制 | 实现 | 生命周期 |
|------|------|---------|
| ToolCallIndexer.index | `Map<string, ToolCallRecord>` | session_start 从 entries 重建 |
| ToolCallIndexer.aliasToToolCallId | `Map<string, string>` (短 ID → 真实 ID) | session_start 从 summary entries 重建 |
| PruneFrontierTracker | 内存对象 | session_start 从 `context-prune-frontier` entry 重建 |
| StatsAccumulator | 内存对象 | session_start 从 `context-prune-stats` entry 重建 |
| 原始工具输出 | `pi.appendEntry("context-prune-index", {toolCalls})` | **跨 session 持久** |
| 摘要消息 | `pi.sendMessage({customType: "context-prune-summary"})` | 在 LLM 上下文中 |
| 配置 | `~/.pi/agent/context-prune/settings.json` | 跨 session |

**恢复流程** (`session_start` / `session_tree`)：
```
1. loadConfig() — 读取 settings.json
2. indexer.reconstructFromSession(ctx) — 扫描 branch 中所有 custom entries:
   - "context-prune-index" → 重建 toolCallId → ToolCallRecord 映射
   - "context-prune-summary" → 重建 shortId → toolCallId 映射 + nextShortAliasNumber
3. statsAccum.reconstructFromSession(ctx) — 扫描最后一个 "context-prune-stats" entry
4. frontier.reconstructFromSession(ctx) — 扫描最后一个 "context-prune-frontier" entry
5. pendingBatches.length = 0 — 丢弃旧 batch
```

### 4.3 magic-context

| 机制 | 实现 | 生命周期 |
|------|------|---------|
| Compartments | SQLite compartments 表 | **永久，跨 session** |
| Memories | SQLite memories 表 | **永久，跨 session** |
| Embeddings | SQLite + embedding 向量 | **永久，跨 session** |
| Session 元数据 | SQLite sessions 表 | **永久** |
| Tags | 消息前缀 `§N§`/`§S§`/`§D§` | context event 内 |
| Schema 版本 | SQLite migrations 表 | 自动管理 |

**最强的持久化能力**。所有数据通过 SQLite 跨 session 保留，支持全文搜索和语义搜索。

---

## 5. Pi Extension API 使用对比

### 5.1 context-engineering

| API | 用法 |
|-----|------|
| `pi.on("session_start")` | 重建 store/stats/ffState |
| `pi.on("context")` | 压缩管道主入口 |
| `pi.registerTool("recall_context")` | 按 ID 召回原始内容 |
| `pi.registerCommand("context-engineering")` | 查看配置 |
| `pi.registerCommand("context-stats")` | 查看统计 |
| `ctx.getContextUsage()` | L2 层获取使用率 |

### 5.2 pi-context-prune

| API | 用法 |
|-----|------|
| `pi.on("session_start")` | 重建 config/index/stats/frontier |
| `pi.on("session_tree")` | branch 切换后重建所有状态 |
| `pi.on("turn_end")` | 捕获 batch，every-turn 模式 flush |
| `pi.on("tool_execution_end")` | on-context-tag 模式触发 |
| `pi.on("message_end")` | agent-message 模式触发 |
| `pi.on("agent_end")` | 最后状态更新 |
| `pi.on("context")` | 过滤已摘要的 toolResult + 注入 reminder |
| `pi.on("before_agent_start")` | agentic-auto 模式注入 system prompt |
| `pi.registerTool("context_tree_query")` | 按短 ID 召回原文 |
| `pi.registerTool("context_prune")` | LLM 自主触发剪枝 |
| `pi.registerCommand("/pruner")` | 配置/手动触发/状态 |
| `pi.sendMessage({deliverAs: "steer"})` | 注入摘要到 LLM 上下文 |
| `pi.appendEntry()` | 持久化 index/stats/frontier |
| `pi.getActiveTools()` / `pi.setActiveTools()` | 动态激活/停用 context_prune 工具 |
| `ctx.sessionManager.getBranch()` | 遍历 session 历史扫描 batch |
| `ctx.modelRegistry.find()` | 查找指定摘要模型 |
| `ctx.modelRegistry.getApiKeyAndHeaders()` | 获取模型认证 |
| `stream()` from `pi-ai` | 流式 LLM 调用 |

### 5.3 magic-context

| API | 用法 |
|-----|------|
| 几乎所有 Pi 事件 API | Historian/Dreamer/Forge 各监听不同事件 |
| `pi.registerTool()` × 5+ | ctx_search, ctx_memory, ctx_note, ctx_expand, ctx_reduce |
| `pi.registerCommand()` × 6+ | /ctx-status, /ctx-flush, /ctx-recomp, /ctx-dream, /ctx-aug |
| Subagent API | Historian 和 Dreamer 作为独立 Pi 进程运行 |
| `pi.sendMessage()` | 注入 compartment + memory |
| SQLite 外部依赖 | 所有数据持久化 |
| Embedding 服务 | 语义搜索 |

---

## 6. 精华提炼：最值得借鉴的具体设计

### 从 pi-context-prune 借鉴

#### ① LLM 摘要层 — context-engineering 缺失的核心能力

context-engineering 的 L1 是基于规则的 head/tail + import/definition 保留。对于代码输出效果还行，但对于 bash 日志、grep 搜索结果等非结构化输出，会丢失关键信息。

**建议**：在 L1 和 L2 之间增加可选的 **L1.5 LLM 摘要层**。当 L1 规则摘要后压缩比不够（如 `result.length > content.length * 0.4`），且工具输出大于某阈值（如 4000 chars），触发 LLM 摘要。默认关闭，用户可开启。

```typescript
// 伪代码
if (config.l1_5.enabled && text.length > config.l1_5.thresholdChars) {
  const ruleResult = condenseToolResult(text, ...);
  if (ruleResult.length > text.length * 0.4) {
    // 规则压缩不够，使用 LLM
    const llmSummary = await summarizeWithLLM(text, ctx);
    if (llmSummary && llmSummary.length < text.length) {
      return llmSummary;  // oversized 保护
    }
  }
}
```

#### ② 短 ID 系统 — 让 LLM 更容易引用

context-engineering 的 recall ID 是 `ctx-a1b2c3d4e5f6`，12 位 UUID 前缀。LLM 难以记忆和引用。

pi-context-prune 用 `t1`, `t2`, `t3` 等短 ID，LLM 可以轻松记住并使用 `context_tree_query(t1)` 召回。

**建议**：RecallStore 改为递增短 ID：

```typescript
// 当前: `ctx-${randomUUID().slice(0, 12)}`
// 改为: `c${++nextId}`  (c1, c2, c3, ...)
```

#### ③ Oversized 保护

pi-context-prune 在摘要后检查 `summaryText.length > rawCharCount`，如果摘要比原文还长就跳过。

context-engineering 的 `condenseToolResult` 有类似的 `result.length > content.length * MAX_CONDENSE_RATIO` 检查，但 L0 的 `expireToolResult` 生成的新文本（`[Tool result expired. ID: ctx-xxx...]`）总是比原文短，所以天然有保护。不过如果引入 LLM 摘要层，oversized 保护就变得必要。

#### ④ Prompt Cache 保护

pi-context-prune 的 reminder 机制通过修改最后一个 toolResult（而非注入新消息）来避免破坏消息角色交替（user/assistant/toolResult）和 prompt cache 前缀。

context-engineering 不注入额外消息（只替换 toolResult 内容），所以天然不破坏 cache。但如果未来需要注入提示，应参考 pi-context-prune 的做法。

#### ⑤ PruneFrontier — 精确的边界追踪

pi-context-prune 的 frontier 追踪最后一次成功剪枝的位置（turnIndex + toolCallId），防止重复剪枝或遗漏。即使剪枝被 skip（oversized），frontier 也会前进。

context-engineering 没有显式的 frontier 概念——它依赖时间戳和 `isAlreadyProcessed()` 检查来判断。这是够用的（因为是幂等的），但在"部分压缩"场景（如 LLM 摘要只处理了一部分 batch）下不如 frontier 精确。

### 从 magic-context 借鉴

#### ⑥ 跨 session 召回

context-engineering 的 RecallStore 是纯内存，session 结束即丢失。magic-context 通过 SQLite 实现跨 session 记忆。

**建议**：不需要引入 SQLite，但可以将 RecallStore 的内容序列化到文件（`~/.pi/agent/context-engineering/recall-store.json`），下次 session_start 恢复。或者利用 Pi 的 `pi.appendEntry()` 持久化，类似 pi-context-prune 的 indexer。

#### ⑦ Context Pressure 精细化

magic-context 不仅看使用率百分比，还考虑 prompt cache hit rate、消息增长率等。

context-engineering 的 L2 只看 `ctx.getContextUsage().percent`。可以引入更精细的压力计算：

```typescript
interface ContextPressure {
  usagePercent: number;
  messageCount: number;
  growthRate: number;        // 最近 N turn 的消息增长速度
  toolResultBytes: number;   // 工具输出总字节数
}
```

---

## 7. 关键设计决策对比

| 决策点 | context-engineering | pi-context-prune | magic-context |
|--------|-------------------|-----------------|---------------|
| **压缩方式** | 纯规则 | LLM 摘要 | 规则 + LLM + subagent |
| **何时压缩** | 每次 context event | turn_end / 手动 / LLM 自主 | context event + 后台 |
| **保留什么** | 替换为 placeholder | 保留摘要文本 | 替换为 compartment |
| **如何召回** | 按 UUID ID | 按短 ID (t1, t2) | 全文/语义搜索 |
| **持久化** | 无 | pi.appendEntry | SQLite |
| **一致性保证** | validateToolPairing 回滚 | frontier 追踪 + oversized 保护 | tag 系统标记 |
| **成本** | 零 | 有（LLM 调用） | 高（多次 LLM + embedding） |
| **延迟** | 零（同步） | 中（streaming） | 高（subagent 进程） |

---

## 8. 代码质量评估

### context-engineering

| 维度 | 评分 | 说明 |
|------|------|------|
| 可读性 | ★★★★☆ | 清晰的分层结构，每个函数职责单一 |
| 健壮性 | ★★★★☆ | try-catch + 配对校验回滚，但缺少持久化恢复 |
| 可测试性 | ★★★★★ | 纯函数管道，已有完整测试 |
| 可维护性 | ★★★★☆ | ~800 行，易于理解和修改 |
| 类型安全 | ★★★☆☆ | 消息类型有 `as unknown as` 转型（Pi API 类型不兼容） |

### pi-context-prune

| 维度 | 评分 | 说明 |
|------|------|------|
| 可读性 | ★★★☆☆ | index.ts 572 行偏长，但模块拆分合理 |
| 健壮性 | ★★★★★ | stale context 处理、abort 支持、oversized 保护、frontier 追踪 |
| 可测试性 | ★★★☆☆ | LLM 依赖难 mock，但核心逻辑是纯函数 |
| 可维护性 | ★★★★☆ | 模块边界清晰，但 commands.ts 796 行太长 |
| 类型安全 | ★★★★☆ | 大量 `any`（Pi event 类型），但核心数据结构有完整类型 |

### magic-context

| 维度 | 评分 | 说明 |
|------|------|------|
| 可读性 | ★★☆☆☆ | 50K+ 行，理解成本极高 |
| 健壮性 | ★★★★☆ | SQLite 事务、migration 系统、完整错误处理 |
| 可测试性 | ★★★☆☆ | 有 40+ 测试文件，但 mock 层复杂 |
| 可维护性 | ★★☆☆☆ | 复杂度爆炸，每次 Pi API 变更都有回归风险 |
| 类型安全 | ★★★★☆ | 有完整的 TypeScript 类型 |

---

## 9. 未来挑战与演进方向

### 共同挑战

1. **上下文窗口增长**：200K → 1M → 10M tokens，压缩需求会减弱但不消失（工具输出也在增长）
2. **Pi 原生压缩**：Pi 未来可能内置上下文压缩，扩展的价值会下降
3. **模型价格下降**：LLM 摘要的边际成本趋近于零，规则压缩的成本优势减弱

### context-engineering 的演进路径

| 阶段 | 增强 | 来源 | 工作量 |
|------|------|------|--------|
| **Phase 1** | 短 ID 系统 | pi-context-prune | 0.5 天 |
| **Phase 1** | RecallStore 持久化到文件 | magic-context 思路 | 1 天 |
| **Phase 2** | 可选 LLM 摘要层 (L1.5) | pi-context-prune 核心 | 2-3 天 |
| **Phase 2** | Oversized 保护（L1.5 场景） | pi-context-prune | 0.5 天 |
| **Phase 3** | Context pressure 精细化 | magic-context | 2 天 |
| **Phase 3** | 基于相关性的选择性压缩 | pi-context-prune 思路 | 3 天 |

### 不应该做的

1. **不引入 SQLite** — 保持零外部依赖
2. **不实现跨 session 记忆** — 这是 magic-context 的定位，不是 context-engineering 的
3. **不实现 5 种触发模式** — context event 已经每 turn 触发
4. **不把 LLM 摘要作为默认** — 保持零成本基础，LLM 作为可选增强

---

## 10. 整体洞察

### 三者的关系是「分层互补」而非「竞争」

```
层级 0: 规则过期（时间戳 + 大小）         → context-engineering MC + L0 ✅
层级 1: 规则摘要（head/tail + 结构保留）   → context-engineering L1 ✅
层级 1.5: LLM 摘要（可选增强）            → 【缺失，可从 context-prune 借鉴】
层级 2: 紧急逃生（强制过期）              → context-engineering L2 ✅
层级 3: 跨 session 记忆 + 搜索           → magic-context ✅
层级 4: 预测性上下文注入                 → magic-context ✅
```

context-engineering 覆盖了层级 0-2（零成本基础层），pi-context-prune 提供了层级 1.5（LLM 增强），magic-context 覆盖了层级 3-4（跨 session 记忆）。

### 核心判断

1. **context-engineering 的「零 LLM 调用」定位是正确的**。这是最基础的一层，不应该有额外成本。
2. **缺少 LLM 摘要层是真正的短板**。规则摘要不理解语义，对于非代码输出（日志、搜索结果、对话历史）效果差。
3. **短 ID 系统是最容易借鉴且收益最高的改进**。工作量半天，但显著提升 LLM 的召回能力。
4. **RecallStore 持久化是第二优先级**。不需要 SQLite，文件级持久化即可。
5. **magic-context 的复杂度不值得引入**。50K 行代码的维护成本远超收益。
