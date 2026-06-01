# pi-context-prune 模块级源码详解

> 每个模块包含：完整函数签名、核心算法伪代码、边界条件与错误处理、调用关系图。

---

## 模块依赖关系总图

```
index.ts (主入口)
├── config.ts          loadConfig / saveConfig
├── batch-capture.ts   captureBatch / captureUnindexedBatchesFromSession / serializeBatchForSummarizer
├── summarizer.ts      summarizeBatch / summarizeBatches / resolveModel
├── indexer.ts         ToolCallIndexer
├── pruner.ts          pruneMessages
├── reminder.ts        countUnprunedToolCalls / annotateWithUnprunedCount
├── summary-refs.ts    buildShortToolCallRefs / formatSummaryToolCallRefs / makeSummaryDetails
├── frontier.ts        PruneFrontierTracker
├── stats.ts           StatsAccumulator
├── context-prune-tool.ts  registerContextPruneTool
├── query-tool.ts      registerQueryTool
├── commands.ts        registerCommands
│   ├── tree-browser.ts    buildPruneTree / TreeBrowser
│   ├── progress-text.ts   pruneProgressText
│   └── stats.ts           formatTokens / formatCost / formatCharProgress
└── multi-batch-loader.ts  MultiBatchLoaderOverlay
    └── progress-text.ts   pruneProgressText
```

---

## 1. src/config.ts（49 行）

### 函数签名

```typescript
export const SETTINGS_PATH: string
  // = join(homedir(), ".pi/agent/context-prune/settings.json")

export async function loadConfig(): Promise<ContextPruneConfig>
export async function saveConfig(config: ContextPruneConfig): Promise<void>
```

### 核心算法

```
loadConfig():
  try:
    raw = readFile(SETTINGS_PATH)
    existing = JSON.parse(raw)
    merged = { ...DEFAULT_CONFIG, ...existing }
    // 逐字段类型校验，无效值回退到默认
    return {
      enabled: typeof merged.enabled === "boolean" ? merged.enabled : DEFAULT
      showPruneStatusLine: typeof ... === "boolean" ? ... : DEFAULT
      pruneOn: isPruneOn(merged.pruneOn) ? merged.pruneOn : DEFAULT
      summarizerThinking: isSummarizerThinking(...) ? ... : DEFAULT
      remindUnprunedCount: typeof ... === "boolean" ? ... : DEFAULT
      summarizerModel: merged.summarizerModel ?? DEFAULT  // 无校验，任意 string
      batchingMode: merged.batchingMode ?? DEFAULT
    }
  catch:
    return { ...DEFAULT_CONFIG }

saveConfig(config):
  mkdir(dirname(SETTINGS_PATH), { recursive: true })
  writeFile(SETTINGS_PATH, JSON.stringify(config, null, 2))
```

### 边界条件

- 文件不存在 → catch → 返回默认配置
- JSON 解析失败 → catch → 返回默认配置
- 字段类型错误（如 `enabled: "yes"`）→ 逐字段校验回退
- `summarizerModel` 无校验，接受任意 string（包括无效的 provider/model-id）

### 调用关系

- 被调用：`index.ts` 的 `session_start` 事件、`commands.ts` 每次配置修改后
- 调用：无外部依赖，仅 `node:fs/promises` 和 `node:path`

---

## 2. src/batch-capture.ts（235 行）

### 函数签名

```typescript
export function captureBatch(
  message: any,       // AssistantMessage from turn_end event
  toolResults: any[], // ToolResultMessage[] from turn_end event
  turnIndex: number,
  timestamp: number
): CapturedBatch

export function captureUnindexedBatchesFromSession(
  branch: any[],      // ctx.sessionManager.getBranch()
  indexer: { isSummarized(id: string): boolean },
  excludeToolNames: string[]  // 默认 [CONTEXT_PRUNE_TOOL_NAME]
): CapturedBatch[]

export function serializeBatchForSummarizer(batch: CapturedBatch): string
export function serializeBatchesForSummarizer(batches: CapturedBatch[]): string
export function groupBatchesByMode(batches: CapturedBatch[], mode: BatchingMode): CapturedBatch[]
```

### 核心算法

#### captureBatch()

```
captureBatch(message, toolResults, turnIndex, timestamp):
  content = message.content (Array)
  
  // 1. 提取助手文本
  assistantText = content.filter(type === "text").map(.text).join("\n").trim()
  
  // 2. 匹配工具调用与结果
  toolCalls = content.filter(type === "toolCall").map(block => {
    match = toolResults.find(r => r.toolCallId === block.id)
    resultText = match.content.filter(type === "text").map(.text).join("\n")
    return { toolCallId: block.id, toolName: block.name, args: block.input,
             resultText, isError: match.isError }
  })
  
  return { turnIndex, timestamp, assistantText, toolCalls }
```

#### captureUnindexedBatchesFromSession()

```
captureUnindexedBatchesFromSession(branch, indexer, excludeToolNames):
  // 预构建 toolCallId → ToolResultMessage 映射
  resultMap = Map<branch entries where role === "toolResult">
  
  batches = []
  turnCounter = 0   // 每个 assistant 消息递增（无论是否有工具调用）
  userTurnGroup = 0 // 每个 user 消息递增
  
  for entry in branch:
    if entry.type !== "message": continue
    msg = entry.message
    
    if msg.role === "user":
      userTurnGroup++
      continue
    
    if msg.role !== "assistant": continue
    
    currentTurnIndex = turnCounter++
    toolCallBlocks = msg.content.filter(type === "toolCall")
    
    // 过滤：已有结果 AND 未被摘要 AND 不在排除列表
    readyToPrune = toolCallBlocks.filter(tc =>
      tc.id &&
      !indexer.isSummarized(tc.id) &&
      !excludeToolNames.includes(tc.name) &&
      resultMap.has(tc.id)
    )
    
    if readyToPrune.length > 0:
      batch = captureBatch(msg, matchedResults, currentTurnIndex, timestamp)
      batches.push({ ...batch, toolCalls: filtered_to_readyIds, userTurnGroup })
  
  return batches
```

#### serializeBatchForSummarizer()

```
serializeBatchForSummarizer(batch):
  parts = []
  if batch.assistantText:
    parts.push("Assistant said: " + batch.assistantText)
  
  toolParts = batch.toolCalls.map(tc => {
    status = tc.isError ? "ERROR" : "OK"
    resultText = tc.resultText
    if resultText.length > 2000:   // ← 摘要 prompt 内截断，非最终输出
      resultText = resultText.slice(0, 2000) + " ...[N chars truncated]"
    return `Tool: ${tc.toolName}(${JSON.stringify(tc.args)})\nResult (${status}): ${resultText}`
  })
  
  parts.push(toolParts.join("\n---\n"))
  return parts.join("\n")
```

#### groupBatchesByMode()

```
groupBatchesByMode(batches, mode):
  if mode !== "agent-message": return batches  // "turn" 模式不变
  
  out = []
  current = null  // 当前合并中的 batch
  
  for batch in batches:
    if batch.userTurnGroup === undefined:
      current = null  // 无分组的 batch 打断合并
      out.push(batch)
      continue
    
    if current && current.userTurnGroup === batch.userTurnGroup:
      // 同组合并
      current.assistantText = [current.assistantText, batch.assistantText].filter(Boolean).join("\n\n")
      current.toolCalls = current.toolCalls.concat(batch.toolCalls)
      current.turnIndex = batch.turnIndex
      current.timestamp = batch.timestamp
    else:
      current = { ...batch }  // 新组开始
      out.push(current)
  
  return out
```

### 边界条件

- `captureBatch`: toolResults 中找不到匹配的 toolCallId → resultText = "(no result)", isError = false
- `captureUnindexedBatchesFromSession`: turnCounter 只计 assistant 消息，不受 ToolResultMessage 被剪枝影响（AssistantMessage 不被删除）
- `serializeBatchForSummarizer`: 单个工具结果截断到 2000 chars — 这是 prompt 内的截断，不丢失最终数据
- `groupBatchesByMode`: 无 `userTurnGroup` 的 batch（来自实时 turn_end）不参与合并

### 调用关系

- 被调用：`index.ts` turn_end 事件（captureBatch）、flushPending（captureUnindexedBatchesFromSession）、summarizer.ts（serializeBatchForSummarizer）
- 调用：无外部模块依赖

---

## 3. src/summarizer.ts（216 行）

### 函数签名

```typescript
export function summarizerThinkingOptions(config: ContextPruneConfig): Record<string, unknown>
export function resolveModel(config: ContextPruneConfig, ctx: ExtensionContext): any
export async function summarizeBatch(
  batch: CapturedBatch,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options?: SummarizeBatchOptions
): Promise<SummarizeResult | null>
export async function summarizeBatches(
  batches: CapturedBatch[],
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options?: SummarizeBatchesOptions
): Promise<Array<SummarizeResult | null>>
```

### 核心算法

#### summarizeBatch()

```
summarizeBatch(batch, config, ctx, options):
  if options.signal?.aborted: throw "aborted before start"
  
  try:
    // 1. 解析模型
    model = resolveModel(config, ctx)
    // "default" → ctx.model
    // "provider/model-id" → ctx.modelRegistry.find(provider, modelId)
    // 找不到 → fallback ctx.model + warning
    
    // 2. 获取认证
    auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
    if !auth.ok: notify error, return null
    
    // 3. 构造 prompt
    serialized = serializeBatchForSummarizer(batch)
    userMessage = SYSTEM_PROMPT + "\n\n<tool-call-batch>\n" + serialized + "\n</tool-call-batch>"
    
    // 4. 流式调用 LLM
    responseStream = stream(model, {
      messages: [{ role: "user", content: [{ type: "text", text: userMessage }] }],
    }, { apiKey, headers, signal, ...thinkingOptions })
    
    // 5. 消费 stream
    for event in responseStream:
      if signal.aborted: break
      if event is text_start/text_delta/text_end:
        report progress (received chars)
    
    // 6. 中断检查
    if signal.aborted: throw "aborted during stream"
    
    response = await responseStream.result()
    if response.stopReason === "aborted": throw
    if response.stopReason === "error": throw errorMessage
    
    // 7. 提取文本
    llmText = response.content.filter(type === "text").map(.text).join("\n")
    
    return { summaryText: llmText, usage: response.usage }
  
  catch err:
    if signal.aborted: throw err  // 向上传播 abort
    notify error
    return null  // 单 batch 失败不影响其他 batch
```

#### summarizeBatches()

```
summarizeBatches(batches, config, ctx, options):
  if batches.length === 0: return []
  if batches.length === 1:
    return [summarizeBatch(batches[0], ...)]  // 单 batch 无额外开销
  
  // 多 batch 并行
  return Promise.all(
    batches.map((batch, index) =>
      summarizeBatch(batch, config, ctx, { signal, onTextProgress })
    )
  )
```

### LLM Prompt 模板

```
System (硬编码):
  "You are summarizing a batch of tool calls made by an AI coding assistant.
   For each tool call provide:
   - Tool name and a one-sentence description of what it did
   - Key outcome: success/failure and the most important data returned
   - Any findings the future conversation needs to remember
   Keep each tool call to 1-3 bullet points. Be concise."

User (动态):
  "<tool-call-batch>
   Tool: read({"file": "src/index.ts"})
   Result (OK): ... (截断到 2000 chars)
   ---
   Tool: grep({"pattern": "TODO"})
   Result (OK): ...
   ---
   </tool-call-batch>"
```

### 边界条件与错误处理

- **模型解析失败**：invalid format 或找不到 → fallback 默认模型 + UI warning
- **认证失败**：`auth.ok === false` → notify error + return null
- **Abort 处理**：三重检查 — 启动前、stream 中、stream 后
- **Provider 错误**：`stopReason === "error"` → throw errorMessage
- **单 batch 失败**：return null，不 throw（`summarizeBatches` 中其他 batch 继续执行）

### 调用关系

- 被调用：`index.ts` 的 `flushPending()`
- 调用：`batch-capture.ts` 的 `serializeBatchForSummarizer()`、`@mariozechner/pi-ai` 的 `stream()`

---

## 4. src/indexer.ts（139 行）

### 类接口

```typescript
class ToolCallIndexer {
  private index: Map<string, ToolCallRecord>           // toolCallId → 完整记录
  private aliasToToolCallId: Map<string, string>       // 短 ID → 真实 ID
  private nextShortAliasNumber: number                 // 下一个短 ID 编号
  
  reconstructFromSession(ctx: ExtensionContext): void
  isSummarized(toolCallId: string): boolean
  getIndex(): Map<string, ToolCallRecord>
  registerSummaryRefs(refs: SummaryToolCallRef[]): void
  allocateSummaryRefs(batch: CapturedBatch): SummaryToolCallRef[]
  resolveToolCallId(toolCallIdOrAlias: string): string | undefined
  getRecord(toolCallIdOrAlias: string): ToolCallRecord | undefined
  lookupToolCalls(toolCallIds: string[]): ToolCallRecord[]
  addBatch(batch: CapturedBatch, pi: ExtensionAPI): void
}
```

### 核心算法

#### reconstructFromSession()

```
reconstructFromSession(ctx):
  index.clear()
  aliasToToolCallId.clear()
  nextShortAliasNumber = 1
  
  branch = ctx.sessionManager.getBranch()
  for entry in branch:
    if entry is custom && customType === "context-prune-index":
      for toolCall in entry.data.toolCalls:
        index.set(toolCall.toolCallId, toolCall)
    
    if entry is custom_message && customType === "context-prune-summary":
      refs = normalizeSummaryToolCallRefs(entry.details)
      registerSummaryRefs(refs)  // 重建 alias 映射 + 更新 nextShortAliasNumber
```

#### allocateSummaryRefs()

```
allocateSummaryRefs(batch):
  toolCallIds = batch.toolCalls.map(tc => tc.toolCallId)
  refs = toolCallIds.map((id, offset) => ({
    shortId: `t${nextShortAliasNumber + offset}`,
    toolCallId: id
  }))
  nextShortAliasNumber += refs.length
  return refs
```

#### addBatch()

```
addBatch(batch, pi):
  records = batch.toolCalls.map(tc => ({
    toolCallId, toolName, args, resultText, isError,
    turnIndex: batch.turnIndex, timestamp: batch.timestamp
  }))
  for record in records:
    index.set(record.toolCallId, record)
  pi.appendEntry("context-prune-index", { toolCalls: records })
```

#### resolveToolCallId() / getRecord()

```
resolveToolCallId(idOrAlias):
  if index.has(idOrAlias): return idOrAlias        // 已经是真实 ID
  return aliasToToolCallId.get(idOrAlias)          // 短 ID 查找

getRecord(idOrAlias):
  resolved = resolveToolCallId(idOrAlias)
  if !resolved: return undefined
  return index.get(resolved)
```

### 边界条件

- `reconstructFromSession`: 数据格式错误（缺少字段）→ 静默跳过
- `registerSummaryRefs`: `shortId === toolCallId` 时不注册 alias（避免无意义映射）
- `getRecord`: 短 ID 和真实 ID 都尝试解析

### 调用关系

- 被调用：`index.ts`（session_start/session_tree 重建）、`pruner.ts`（pruneMessages）、`query-tool.ts`（getRecord/lookupToolCalls）、`reminder.ts`（isSummarized）
- 调用：`summary-refs.ts`（buildShortToolCallRefs, normalizeSummaryToolCallRefs）

---

## 5. src/frontier.ts（62 行）

### 类接口

```typescript
class PruneFrontierTracker {
  private frontier: PruneFrontier | null
  
  reset(): void
  get(): PruneFrontier | null
  fromJSON(data: PruneFrontier): void
  reconstructFromSession(ctx: ExtensionContext): void
  advance(frontier: PruneFrontier): void
  persist(pi: ExtensionAPI): void
}
```

### 核心算法

```
PruneFrontier 数据结构:
  lastAttemptedToolCallId: string    // 最后尝试的工具调用 ID
  lastAttemptedToolName: string     // 最后尝试的工具名称
  lastAttemptedTurnIndex: number    // 最后尝试的 turn 索引
  lastAttemptedTimestamp: number    // 时间戳
  attemptedBatchCount: number       // 包含的 batch 数
  attemptedToolCallCount: number    // 包含的工具调用数
  rawCharCount: number             // 原始字符数
  summaryCharCount: number         // 摘要字符数
  outcome: "summarized" | "skipped-oversized"  // 结果

reconstructFromSession(ctx):
  reset()
  branch = ctx.sessionManager.getBranch()
  // 扫描所有 frontier entries，取最后一个（最新覆盖旧值）
  for entry in branch:
    if entry is custom && customType === "context-prune-frontier":
      fromJSON(entry.data)

advance(frontier):
  this.frontier = { ...frontier }  // 浅拷贝

persist(pi):
  if !this.frontier: return
  pi.appendEntry("context-prune-frontier", this.frontier)
```

### 设计要点

- **frontier 在 summarized 和 skipped-oversized 时都前进**，只在 operational failure 时不前进
- **用途**：`trimBatchToPendingRange()` 使用 frontier 跳过已处理的 batch，避免重复摘要
- **持久化方式**：每次 flush 后 appendEntry，reconstruct 取最后一个 entry

### 调用关系

- 被调用：`index.ts`（session_start/session_tree 重建、flushPending 后 advance/persist、trimBatchToPendingRange 读取）
- 调用：无

---

## 6. src/reminder.ts（87 行）

### 函数签名

```typescript
export function countUnprunedToolCalls(messages: any[], indexer: ToolCallIndexer): number
export function buildReminderText(count: number): string
export function annotateWithUnprunedCount(messages: any[], count: number): any[]
```

### 核心算法

#### countUnprunedToolCalls()

```
countUnprunedToolCalls(messages, indexer):
  count = 0
  for msg in messages:
    if msg.role !== "assistant": continue
    if !Array.isArray(msg.content): continue
    for block in msg.content:
      if block.type !== "toolCall": continue
      id = block.toolCallId ?? block.id
      if id && !indexer.isSummarized(id): count++
  return count
```

#### annotateWithUnprunedCount()

```
annotateWithUnprunedCount(messages, count):
  if count <= 0 || messages.length === 0: return messages
  
  last = messages[messages.length - 1]
  if last.role !== "toolResult" || !Array.isArray(last.content): return messages
  
  // 追加 <pruner-note> 到最后一个 toolResult 的 content
  reminder = { type: "text", text: buildReminderText(count) }
  clonedLast = { ...last, content: [...last.content, reminder] }
  
  out = messages.slice()
  out[messages.length - 1] = clonedLast
  return out
```

**reminder 文本格式**：
```
<pruner-note>8 unpruned tool call result(s) currently in context. Consider calling context_prune after a logical batch of 8–12 related tool calls.</pruner-note>
```

### 设计要点

- **为什么修改最后一个 toolResult 而非注入新消息**：
  1. 保持 user/assistant/toolResult 角色交替，部分 provider 拒绝不合规的消息序列
  2. 保护 prompt cache prefix — 只改变最后一个消息的文本，前面的 prefix 不变
  3. LLM 自然地阅读最近的 toolResult，reminder 出现在决策的最佳时机
- **浅拷贝**：只 clone 最后一个消息和其 content 数组，不深拷贝全部消息

### 调用关系

- 被调用：`index.ts` 的 `context` 事件处理器
- 调用：`indexer.ts` 的 `isSummarized()`

---

## 7. src/pruner.ts（16 行）

### 函数签名

```typescript
export function pruneMessages(messages: any[], indexer: ToolCallIndexer): any[]
```

### 核心算法

```
pruneMessages(messages, indexer):
  return messages.filter(msg =>
    // 只移除已被摘要的 toolResult
    if msg.role === "toolResult" && indexer.isSummarized(msg.toolCallId):
      return false  // 过滤掉
    return true     // 保留其他所有消息
  )
```

### 设计要点

**只删除 ToolResultMessage，保留 AssistantMessage 的 toolCall blocks**。

原因：AssistantMessage 中的 toolCall blocks 携带 toolCallId，是 LLM 引用 `context_tree_query(t1)` 的入口。如果也删除 toolCall blocks，LLM 不知道存在哪些已被摘要的工具调用。

### 调用关系

- 被调用：`index.ts` 的 `context` 事件处理器
- 调用：`indexer.ts` 的 `isSummarized()`

---

## 8. src/summary-refs.ts（61 行）

### 函数签名

```typescript
export function buildShortToolCallRefs(
  toolCallIds: string[],
  startIndex: number
): { refs: SummaryToolCallRef[]; nextIndex: number }

export function normalizeSummaryToolCallRefs(details: unknown): SummaryToolCallRef[]
export function formatSummaryToolCallRefs(refs: SummaryToolCallRef[]): string
export function makeSummaryDetails(batch: CapturedBatch, refs: SummaryToolCallRef[]): SummaryMessageDetails
```

### 核心算法

#### buildShortToolCallRefs()

```
buildShortToolCallRefs(toolCallIds, startIndex):
  refs = toolCallIds.map((id, offset) => ({
    shortId: `t${startIndex + offset}`,   // t1, t2, t3, ...
    toolCallId: id
  }))
  return { refs, nextIndex: startIndex + refs.length }
```

#### normalizeSummaryToolCallRefs()

```
normalizeSummaryToolCallRefs(details):
  if !details || typeof !== "object": return []
  
  // 优先从 toolCallRefs 字段解析
  if Array.isArray(details.toolCallRefs):
    return details.toolCallRefs
      .filter(ref => typeof ref.shortId === "string" && typeof ref.toolCallId === "string")
      .map(ref => ({ shortId: ref.shortId, toolCallId: ref.toolCallId }))
  
  // 兼容旧格式：toolCallIds（无短 ID，直接用 toolCallId 作为 shortId）
  if Array.isArray(details.toolCallIds):
    return details.toolCallIds.map(id => ({ shortId: id, toolCallId: id }))
  
  return []
```

#### formatSummaryToolCallRefs()

```
formatSummaryToolCallRefs(refs):
  refList = refs.map(ref => `\`${ref.shortId}\``).join(", ")
  return (
    "\n\n---\n" +
    "**Summarized tool refs**: " + refList + "\n" +
    "Use `context_tree_query` with these refs to retrieve the original full outputs."
  )
```

### 调用关系

- 被调用：`indexer.ts`（normalizeSummaryToolCallRefs 在重建时）、`index.ts`（allocateSummaryRefs 后 formatSummaryToolCallRefs 拼接到摘要文本末尾）
- 调用：无外部依赖

---

## 9. src/stats.ts（139 行）

### 类接口

```typescript
class StatsAccumulator {
  private stats: SummarizerStats
  add(usage: Usage): void
  getStats(): SummarizerStats
  reset(): void
  reconstructFromSession(ctx: ExtensionContext): void
  persist(pi: ExtensionAPI): void
}

// 格式化工具函数
export function formatCompactCount(n: number): string   // 1.2k, 340, 1.5M
export function formatTokens(n: number): string         // 同上
export function formatCharProgress(received: number, raw?: number): string
export function formatCost(n: number): string           // $0.003, <$0.001
export function statsSuffix(stats: SummarizerStats): string
```

### 核心算法

```
// SummarizerStats:
{
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number        // USD
  callCount: number
}

add(usage):
  stats.totalInputTokens += usage.input ?? 0
  stats.totalOutputTokens += usage.output ?? 0
  stats.totalCost += usage.cost?.total ?? 0
  stats.callCount += 1

reconstructFromSession(ctx):
  reset()
  branch = ctx.sessionManager.getBranch()
  // 扫描所有 stats entries，每个是完整快照，取最后一个
  for entry in branch:
    if entry is custom && customType === "context-prune-stats":
      fromJSON(entry.data)
```

### 调用关系

- 被调用：`index.ts`（session_start 重建、flushPending 后 persist）、`commands.ts`（getStats 显示）
- 调用：无

---

## 10. src/context-prune-tool.ts（125 行）

### 函数签名

```typescript
export function registerContextPruneTool(
  pi: ExtensionAPI,
  flushFn: (ctx: ExtensionContext, options?: FlushOptions) => Promise<FlushResult>
): void
```

### 核心算法

注册 `context_prune` 工具（无参数），execute 内部：

```
execute():
  sendToolProgress("Context prune running… (press Esc to cancel)")
  
  result = flushFn(ctx, {
    signal,  // 传递 abort signal
    onBatchTextProgress: (index, total, batch, receivedChars) => {
      // 实时更新进度文本
      sendToolProgress(pruneProgressText(batch, index, total, receivedChars, "running"))
    }
  })
  
  if !result.ok:
    if reason === "aborted":
      return "Context prune was cancelled (Esc pressed). No batches were summarized..."
    return "Context prune did not run: {reason}"
  
  if reason === "skipped-oversized":
    return "Context prune skipped N tool calls: summary was X chars vs Y raw chars..."
  
  return "Context prune completed. Summarized N tool calls from M batches..."
```

### 设计要点

- **工具始终注册但默认不激活**。只有 `pruneOn === "agentic-auto"` 时通过 `pi.setActiveTools()` 激活
- **Abort 支持**：工具接收 `signal` 参数，Esc 键触发 abort，整个 flush 流程可中断

### 调用关系

- 被调用：Pi LLM 在 agentic-auto 模式下调用
- 调用：`index.ts` 的 `flushPending()`、`progress-text.ts` 的 `pruneProgressText()`

---

## 11. src/query-tool.ts（67 行）

### 函数签名

```typescript
export function registerQueryTool(pi: ExtensionAPI, indexer: ToolCallIndexer): void
```

### 核心算法

注册 `context_tree_query` 工具，参数：`{ toolCallIds: string[] }`

```
execute(params):
  for id in params.toolCallIds:
    record = indexer.getRecord(id)
    if !record:
      blocks.push("## toolRef: {id}\n(not found in index)")
      continue
    
    header = "## toolRef: {id}\nTool: {record.toolName}\nArgs: {JSON}\nStatus: {status}\nTurn: {turnIndex}"
    body = truncateHead(record.resultText, { maxLines, maxBytes })
    if truncated: body += "[Output truncated: ...]"
    blocks.push(header + "\n" + body)
  
  return blocks.join("\n\n---\n\n")
```

### 设计要点

- **支持短 ID 和真实 ID**：通过 `indexer.getRecord()` 自动解析
- **truncateHead**：使用 Pi 内置的 `truncateHead`，保留文件尾部（错误和结果通常在尾部）
- **批量查询**：一次调用可查多个 ID

### 调用关系

- 被调用：LLM 主动调用
- 调用：`indexer.ts` 的 `getRecord()`、Pi 内置的 `truncateHead()`

---

## 12. src/reminder.ts（87 行）— 已在上方第 6 节详解

---

## 13. index.ts 主入口（572 行）

### 函数签名

```typescript
export default function(pi: ExtensionAPI): void
```

### 闭包状态

```typescript
// 模块级共享可变状态（闭包内，每次 session_start 重建）
currentConfig: { value: ContextPruneConfig }
indexer: ToolCallIndexer
statsAccum: StatsAccumulator
frontier: PruneFrontierTracker
pendingBatches: CapturedBatch[]
isFlushing: boolean
```

### 核心函数

#### flushPending()（第 159-369 行，核心函数）

```typescript
async function flushPending(
  ctx: any,
  options?: FlushOptions
): Promise<FlushResult>
```

```
flushPending(ctx, options):
  if isFlushing: return { ok: false, reason: "already-flushing" }
  
  batches = options.previewedBatches ?? capturePendingBatches(ctx)
  if batches.length === 0: return { ok: false, reason: "empty" }
  if options.signal?.aborted: return { ok: false, reason: "aborted" }
  
  // 排空队列（防止并发 double-summarize）
  pendingBatches.length = 0
  isFlushing = true
  
  try:
    // 摘要 batches
    if options.onProgress:
      // 串行模式（/pruner now 逐行显示进度）
      for each batch:
        onProgress(i, ..., "start")
        result = summarizeBatch(batch, ...)
        onProgress(i, ..., result ? "done" : "skipped")
    else:
      // 并行模式（后台快速处理）
      results = summarizeBatches(batches, ...)
    
    // 处理结果
    for each (batch, result):
      if !result: break  // 首次失败，后续 batch 退回 pending
      
      // Oversized 检查
      if summaryText.length > batchRawCharCount:
        oversizedBatches.push(batch)
        continue  // 不持久化，但 frontier 会前进
      
      // 持久化
      if delivery === "runtime":
        pi.sendMessage({customType: summary, content, details}, {deliverAs: "steer"})
        indexer.registerSummaryRefs(refs)
        indexer.addBatch(batch, pi)
      else:  // "session"
        appendSummaryMessage(content, details)
        persistBatchIndex(batch, appendEntry)
    
    // Advance frontier + persist stats
    frontier.advance(lastBatchSnapshot)
    frontier.persist(pi)
    statsAccum.persist(pi)
    
    return { ok: true, reason, batchCount, toolCallCount, rawCharCount, summaryCharCount }
  
  catch err:
    restoreBatches(batches)  // 退回全部 batches
    if signal.aborted: return { ok: false, reason: "aborted" }
    return { ok: false, reason: "failed/stale-context" }
  finally:
    isFlushing = false
```

### 事件处理器

#### session_start

```
session_start:
  currentConfig.value = await loadConfig()
  indexer.reconstructFromSession(ctx)
  statsAccum.reconstructFromSession(ctx)
  frontier.reconstructFromSession(ctx)
  pendingBatches.length = 0
  setPruneStatusWidget(ctx, ...)
  syncToolActivation()  // agentic-auto 模式激活 context_prune 工具
```

#### session_tree

```
session_tree:  // branch 切换后重建
  同上，但不重新加载 config
```

#### turn_end

```
turn_end:
  if !config.enabled: return
  if !event.toolResults?.length: return  // 纯文本 turn 跳过
  
  capturedBatch = captureBatch(event.message, event.toolResults, event.turnIndex, Date.now())
  batch = trimBatchToPendingRange(capturedBatch without context_prune tool calls)
  if !batch: return
  
  pendingBatches.push(batch)
  
  if config.pruneOn === "every-turn":
    await flushPending(ctx, { delivery: "session" })
  else:
    // 通知用户有 batch 排队中
    notify("N turn(s) queued — will summarize on {trigger}")
```

#### tool_execution_end（on-context-tag 模式）

```
tool_execution_end:
  if event.toolName !== "context_tag": return
  if !config.enabled || config.pruneOn !== "on-context-tag": return
  await flushPending(ctx, { delivery: "runtime" })
```

#### message_end（agent-message 模式）

```
message_end:
  if !config.enabled || config.pruneOn !== "agent-message": return
  if !isFinalAssistantMessage(event.message): return  // 非最终文本回复跳过
  await flushPending(ctx, { delivery: "session" })
```

#### context

```
context:
  if !config.enabled: return undefined
  
  messages = event.messages
  changed = false
  
  // 1. 剪枝已摘要的 toolResult
  if !indexEmpty:
    pruned = pruneMessages(messages, indexer)
    if pruned.length !== messages.length: changed = true
  
  // 2. agentic-auto reminder
  if config.pruneOn === "agentic-auto" && config.remindUnprunedCount:
    count = countUnprunedToolCalls(messages, indexer)
    if count > 0:
      annotated = annotateWithUnprunedCount(messages, count)
      if annotated !== messages: changed = true
  
  if !changed: return undefined
  return { messages }
```

#### before_agent_start

```
before_agent_start:
  if !config.enabled || config.pruneOn !== "agentic-auto": return undefined
  // 追加 agentic-auto system prompt
  return { systemPrompt: event.systemPrompt + "\n\n" + AGENTIC_AUTO_SYSTEM_PROMPT }
```

### 辅助函数

```
trimBatchToPendingRange(batch):
  // 1. 过滤已被摘要的 toolCall
  toolCalls = batch.toolCalls.filter(tc => !indexer.isSummarized(tc.toolCallId))
  if toolCalls.length === 0: return null
  
  // 2. frontier 过滤：跳过已处理的 turn
  if !currentFrontier: return { ...batch, toolCalls }
  if batch.turnIndex < currentFrontier.lastAttemptedTurnIndex: return null
  if batch.turnIndex > currentFrontier.lastAttemptedTurnIndex: return { ...batch, toolCalls }
  // 同一 turn：只保留 frontier 之后的 toolCall
  remaining = toolCalls.slice(after frontier.lastAttemptedToolCallId)
  if remaining.length === 0: return null
  return { ...batch, toolCalls: remaining }

syncToolActivation():
  shouldActivate = config.enabled && config.pruneOn === "agentic-auto"
  activeTools = pi.getActiveTools()
  // 添加或移除 context_prune 工具
```

### Delivery 模式

| 模式 | 场景 | 持久化方式 |
|------|------|-----------|
| `runtime` | agentic-auto、on-context-tag | `pi.sendMessage({deliverAs: "steer"})` + `pi.appendEntry()` |
| `session` | every-turn、agent-message | `sessionManager.appendCustomMessageEntry()` + `appendCustomEntry()` |

`runtime` 模式在 agent/tool 循环活跃时使用，Pi 能在协议安全边界放置 steer 消息。
`session` 模式在最终消息后使用，此时 print-mode Pi 可能已使 `pi.*` 方法失效，直接写 session 文件。

---

## 14. src/commands.ts（796 行）

### 函数签名

```typescript
export function registerCommands(
  pi: ExtensionAPI,
  currentConfig: { value: ContextPruneConfig },
  flushPending: (...) => Promise<FlushResult>,
  capturePendingBatches: (ctx) => CapturedBatch[],
  syncToolActivation: () => void,
  getStats: () => SummarizerStats,
  indexer: ToolCallIndexer
): void

export function pruneStatusText(config: ContextPruneConfig, stats?: SummarizerStats): string
export function setPruneStatusWidget(ctx, config, value?): void
```

### 注册的命令

| 子命令 | 功能 |
|--------|------|
| `/pruner` (无参数) | 交互式子命令选择器 |
| `/pruner settings` | Pi TUI SettingsList overlay，可交互修改所有配置 |
| `/pruner on` / `off` | 启用/禁用 |
| `/pruner status` | 显示当前配置和统计 |
| `/pruner model [id]` | 查看/设置摘要模型 |
| `/pruner thinking [level]` | 查看/设置 thinking level |
| `/pruner prune-on [mode]` | 查看/设置触发模式 |
| `/pruner batching [mode]` | 查看/设置批量模式 |
| `/pruner stats` | 显示累积 token/成本统计 |
| `/pruner tree` | 折叠树浏览器，浏览所有已剪枝的工具调用 |
| `/pruner now` | 立即 flush，带多行进度动画 |
| `/pruner help` | 帮助文本 |

### `/pruner now` 的进度系统

```
startPrunerWidget(ctx, batches):
  rows = batches.map((b, i) => ({
    label: "Batch {i+1}/{total}",
    toolCallCount, rawChars,
    status: "pending", receivedChars: 0
  }))
  
  // 注册 TUI widget (placement: aboveEditor)
  ctx.ui.setWidget(PROGRESS_WIDGET_ID, (tui) => {
    requestRender = tui.requestRender
    
    // 动画循环：有 running 行时启动 setInterval 推进 spinner
    ensureAnimationLoop()
    
    return { render(width): string[] }  // 每行一个 spinner/状态
  })
  
  return {
    updateRow(index, status, chars): 更新行状态 + 同步动画
    clearWidget(): 停止动画 + 移除 widget
  }
```

**Spinner 动画**：`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`，120ms 间隔，只在有 running 行时启动 `setInterval`。

### Message Renderer

注册 `context-prune-summary` 类型的消息渲染器：

```
registerMessageRenderer("context-prune-summary", (message, { expanded }, theme) => {
  header = theme.fg("accent", "[pruner] Turn {turnIndex} summary ({toolCount} tools)")
  if expanded:
    return Text(header + "\n" + message.content)  // 展开显示完整摘要
  return Text(header)  // 折叠只显示标题
})
```

### 调用关系

- 被调用：`index.ts` 传入所有依赖后注册
- 调用：`config.ts`（saveConfig）、`stats.ts`（格式化函数）、`tree-browser.ts`（buildPruneTree, TreeBrowser）、`summary-refs.ts`（normalizeSummaryToolCallRefs）、`progress-text.ts`（pruneProgressText）

---

## 15. src/tree-browser.ts（380 行）

### 函数签名

```typescript
export function buildPruneTree(ctx: ExtensionCommandContext, indexer: ToolCallIndexer): TreeNode[]
class TreeBrowser implements Component {
  constructor(roots: TreeNode[], theme: Theme, onDone: () => void)
  handleInput(data: string): void
  render(width: number): string[]
}
```

### 核心算法

#### buildPruneTree()

```
buildPruneTree(ctx, indexer):
  branch = ctx.sessionManager.getBranch()
  roots = []
  
  for entry in branch:
    if entry is custom_message && customType === "context-prune-summary":
      refs = normalizeSummaryToolCallRefs(details)
      children = refs.map(ref => toolCallNode(indexer.getRecord(ref.toolCallId)))
      roots.push({
        id, label: "[pruner] Turn {turnIndex} summary ({N} tools · {chars} chars)",
        children, expanded: false, depth: 0,
        detail: summaryText, charCount: summaryChars
      })
  
  return roots
```

### 交互

| 按键 | 动作 |
|------|------|
| ↑/↓ | 移动选中行 |
| Enter/Space | 展开/折叠非叶节点 |
| Ctrl-O | 打开选中摘要的 overlay（Markdown 渲染，可滚动） |
| Esc/q | 关闭 |

### 调用关系

- 被调用：`commands.ts` 的 `/pruner tree` 子命令
- 调用：`summary-refs.ts`、`indexer.ts`

---

## 附录：完整数据流图

```
                    ┌─────────────────────────────────────────────────┐
                    │               turn_end event                    │
                    │  event.message (AssistantMessage)               │
                    │  event.toolResults (ToolResultMessage[])         │
                    └───────────────────┬─────────────────────────────┘
                                        │
                        ┌───────────────▼───────────────┐
                        │   captureBatch()                │
                        │   → CapturedBatch               │
                        └───────────────┬───────────────┘
                                        │
                        ┌───────────────▼───────────────┐
                        │   pendingBatches.push(batch)    │
                        └───────────────┬───────────────┘
                                        │
                    (触发条件满足: every-turn / agent-message / ...)
                                        │
                        ┌───────────────▼───────────────┐
                        │   flushPending()                │
                        │                                 │
                        │  1. capturePendingBatches()      │
                        │  2. trimBatchToPendingRange()    │
                        │  3. groupBatchesByMode()         │
                        │  4. summarizeBatch() × N         │ ←── LLM 调用
                        │  5. oversized 检查               │
                        │  6. pi.sendMessage(steer)        │ ←── 注入摘要
                        │  7. indexer.addBatch()           │ ←── 持久化原文
                        │  8. frontier.advance()           │
                        │  9. statsAccum.persist()         │
                        └───────────────┬───────────────┘
                                        │
          ┌─────────────────────────────┼─────────────────────────────┐
          │                             │                             │
  ┌───────▼────────┐     ┌─────────────▼──────────────┐    ┌────────▼────────┐
  │ context event   │     │  pi.appendEntry() 持久化     │    │  pi.sendMessage │
  │                 │     │  - context-prune-index      │    │  (deliverAs:    │
  │ pruneMessages() │     │  - context-prune-frontier   │    │   "steer")      │
  │ 过滤已摘要的     │     │  - context-prune-stats      │    │  摘要注入 LLM   │
  │ ToolResult      │     └────────────────────────────┘    │  上下文          │
  │                 │                                       └─────────────────┘
  │ + reminder      │
  │ (agentic-auto)  │
  └────────────────┘
                                        │
                    ┌───────────────────▼─────────────────────────────┐
                    │         context_tree_query 工具                   │
                    │  按 short ID (t1, t2) 查找 indexer               │
                    │  → 返回完整原始工具输出                            │
                    └─────────────────────────────────────────────────┘
```
