# Context Engineering 扩展 — 模块级源码详解

> 源码版本：`context-engineering/` 当前 main 分支
> 分析日期：2026-06-01

---

## 目录

1. [架构总览](#架构总览)
2. [compressor.ts — 5 层压缩引擎](#compressorts)
3. [config.ts — 配置加载与解析](#configts)
4. [recall-store.ts — 内容回溯存储](#recall-storets)
5. [frozen-fresh.ts — Budget 冻结状态](#frozen-freshts)
6. [commands.ts — 命令处理](#commandsts)
7. [index.ts — 扩展入口](#indexts)

---

## 架构总览

```
Pi 进程
  │
  ├── session_start ──→ 重建 config / store / stats / ffState
  │
  ├── context 事件 ──→ compressContext(messages, config, store, usage, ffState)
  │                      │
  │                      ▼ 5 层管道（顺序执行）
  │                      ┌─────────────────────────────────┐
  │                      │ 1. MC   (Microcompact)          │
  │                      │ 2. Budget (Tool result budget)  │
  │                      │ 3. L0   (Zero-cost cleanup)     │
  │                      │ 4. L1   (Rule-based condense)   │
  │                      │ 5. L2   (Emergency compression) │
  │                      └────────────────┬────────────────┘
  │                                       │
  │                      validateToolPairing() ──→ 失败则回滚原始 messages
  │                                       │
  │                      返回 { messages, stats }
  │
  ├── recall_context 工具 ──→ store.recall(id) ──→ 返回原始内容
  │
  └── /context-engineering 命令 ──→ 查看/开关各层
      /context-stats 命令     ──→ 查看累计统计
```

**核心设计原则**：
- 每一层返回新的 messages 数组（不可变风格），不修改输入
- 每层独立开关，可运行时通过命令控制
- 配对校验失败时回滚到原始消息，保证安全性
- 所有被压缩的内容通过 `recall_context` 工具可回溯

---

## compressor.ts

**798 行，整个扩展的核心引擎。**

### 导出类型

```typescript
// 消息类型 — Pi 消息的结构子集
interface TextContent { type: "text"; text: string }
interface ThinkingContent { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean }
interface ImageContent { type: "image"; data: string; mimeType: string }
interface ToolCall { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }

type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | BashExecutionMessage | CompactionSummaryMessage

// Turn boundary
interface TurnBoundary { startIndex: number; endIndex: number; timestamp: number }

// 统计
interface L0Stats { expired: number; truncated: number; thinkingCleared: number }
interface CompressionStats {
  l0Expired: number; l0Truncated: number; l0ThinkingCleared: number;
  l1Condensed: number; l2Triggered: boolean; validationFailed: boolean;
  mcTriggered: boolean; mcCleared: number; budgetPersisted: number;
}
```

### 常量

| 常量 | 值 | 用途 |
|------|-----|------|
| `CHARS_PER_TOKEN` | 4 | chars→tokens 估算因子 |
| `DEFAULT_CONTEXT_WINDOW` | 200,000 | fallback 上下文窗口 |
| `COMPACTABLE_TOOLS` | Set{read, bash, bash_background, grep, glob, web_search, web_fetch, edit, write} | MC 可清理的工具集 |
| `MS_PER_MINUTE` | 60,000 | 毫秒/分钟转换 |
| `IMPORT_EXPORT_RE` | `/^(import\|export)\s/` | L1 中间行保留规则 |
| `DEFINITION_RE` | `/(function\|class\|interface\|type\|const\|let\|var)\s+\w+/` | L1 中间行保留规则 |
| `FALLBACK_KEEP_RATIO` | 0.4 | L1 fallback 截断保留 40% |
| `MAX_CONDENSE_RATIO` | 0.4 | L1 condense 不够时 fallback 阈值 |

---

### 函数详解

#### `findTurnBoundaries(messages: AgentMessage[]): TurnBoundary[]`

**功能**：将消息序列切分为 turn。一个 turn 是从一个触发点开始到下一个触发点之前的所有消息。

**算法**：
```
boundaries = []
turnStart = 0
for i in 1..messages.length-1:
  if messages[i].role in {"user", "bashExecution"}:
    boundaries.push({startIndex: turnStart, endIndex: i, timestamp: messages[turnStart].timestamp})
    turnStart = i
// 最后一个 turn：turnStart → messages.length
boundaries.push({startIndex: turnStart, endIndex: messages.length, timestamp: messages[turnStart].timestamp})
return boundaries
```

**边界条件**：
- 空数组返回 `[]`
- 单条消息返回 1 个 boundary
- `bashExecution` 被视为 turn 分界（因为它是用户触发的命令执行）

---

#### `isInProtectedTurn(msgIndex: number, boundaries: TurnBoundary[], protectCount: number): boolean`

**功能**：判断消息索引是否在最近 `protectCount` 个 turn 内。

**算法**：
```
if protectCount <= 0 || boundaries.length === 0: return false
protectedStart = max(0, boundaries.length - protectCount)
for i in protectedStart..boundaries.length-1:
  if msgIndex >= boundaries[i].startIndex && msgIndex < boundaries[i].endIndex:
    return true
return false
```

**用途**：L0/L1/L2 都使用此函数保护最近的 turn，避免压缩当前正在进行的对话。

---

#### `getMessageTimestamp(msg: AgentMessage): number`

**签名**：`(msg: AgentMessage) => number`

直接返回 `msg.timestamp`。所有消息类型都有此字段。

---

#### `getToolResultText(msg: ToolResultMessage): string`

**签名**：`(msg: ToolResultMessage) => string`

**算法**：过滤 `content` 中所有 `TextContent` 类型，拼接 `.text`。忽略 ImageContent。

---

#### `expireToolResult(_originalText: string, id: string): string`

**签名**：`(text: string, id: string) => string`

**输出格式**：`[Tool result expired. ID: ctx-xxxxxxxxxxxx. Use recall_context(ctx-xxxxxxxxxxxx) to retrieve the original content.]`

注意：`_originalText` 未使用（前缀 `_` 标记），只生成替换文本。

---

#### `truncateBashOutput(output: string, maxChars: number, id: string): string`

**签名**：`(output: string, maxChars: number, id: string) => string`

**算法**：
```
if output.length <= maxChars: return output
tailChars = maxChars
return "... [truncated. ID: {id}. Use recall_context({id}) to retrieve full output. Total: {output.length} chars]\n\n" + output.slice(-tailChars)
```

**设计决策**：保留尾部——bash 输出是"尾重"的（错误信息、最终结果在末尾）。与 Pi 核心的 `truncateTail` 一致。

---

#### `expireThinking(): string`

**签名**：`() => string`

固定返回 `"[thinking expired]"`。

---

#### `fallbackTruncate(content: string): string`

**签名**：`(content: string) => string`（内部函数）

**算法**：保留头部 40%（`FALLBACK_KEEP_RATIO`），尾部附 `"\n[... truncated for space]"`。

**设计决策**：非代码内容（JSON、YAML、日志）头部通常包含结构/头部信息，保留头部。

---

#### `condenseToolResult(content: string, keepHeadLines: number, keepTailLines: number): string`

**签名**：`(content: string, keepHeadLines: number, keepTailLines: number) => string`

**L1 的核心算法，结构化摘要**：

```
lines = content.split("\n")

// 行数不足以分 head/middle/tail → fallback
if lines.length <= keepHeadLines + keepTailLines:
  return fallbackTruncate(content)

head = lines[0..keepHeadLines-1]
tail = lines[-keepTailLines..]
middle = lines[keepHeadLines..-(keepTailLines+1)]

// 对 middle 做选择性保留
keptMiddle = []
omitCount = 0
for line in middle:
  if line 匹配 IMPORT_EXPORT_RE 或 DEFINITION_RE:
    if omitCount > 0: keptMiddle.push("[... {omitCount} lines omitted]")
    omitCount = 0
    keptMiddle.push(line)
  else:
    omitCount++
if omitCount > 0: keptMiddle.push("[... {omitCount} lines omitted]")

result = [...head, ...keptMiddle, ...tail].join("\n")

// 压缩不够 → fallback 截断
if result.length > content.length * 0.4:
  return fallbackTruncate(content)

return result
```

**关键细节**：
- 中间行只保留 `import/export` 语句和定义语句（function/class/interface/type/const/let/var）
- 如果压缩后仍超过原内容的 40%，放弃结构化摘要，直接 fallback 截断
- 默认 keepHeadLines=10, keepTailLines=5

---

#### `validateToolPairing(messages: AgentMessage[]): boolean`

**签名**：`(messages: AgentMessage[]) => boolean`

**算法**：
```
pendingToolCalls = Set<string>
for msg in messages:
  if msg.role === "assistant":
    for block in msg.content:
      if block.type === "toolCall": pendingToolCalls.add(block.id)
  elif msg.role === "toolResult":
    if msg.toolCallId NOT in pendingToolCalls: return false  // 孤儿结果
    pendingToolCalls.delete(msg.toolCallId)
return pendingToolCalls.size === 0  // 无悬空调用
```

**用途**：在 5 层管道执行完后验证，如果压缩破坏了 toolCall↔toolResult 配对关系，则回滚到原始消息。这是安全网。

---

#### `findCompactBoundary(messages: AgentMessage[]): number | null`

**签名**：`(messages: AgentMessage[]) => number | null`

**算法**：遍历所有消息，返回最后一个 `compactionSummary` 类型消息的索引。无则返回 `null`。

**用途**：Pi 的 compaction 机制产生的摘要消息是压缩边界。边界之前的消息不处理（它们已经是摘要了）。

---

### 5 层管道详解

#### 第 1 层：MC (Microcompact) — `processMicrocompact`

```typescript
function processMicrocompact(
  messages: AgentMessage[],
  config: McConfig,
  store: RecallStore,
  now: number,
  compactBoundaryIdx: number | null,
): { messages: AgentMessage[]; stats: McStats }
```

**触发条件**（全部满足）：
1. `config.enabled === true`
2. 存在至少一个 assistant 消息
3. `now - 最后一个 assistant 消息的时间戳 > gapThresholdMinutes * 60000`（默认 60 分钟）
4. compactable toolResult 数量 > `keepRecent`（默认 5）

**处理逻辑**：
1. 遍历所有消息，收集满足以下条件的 toolResult 索引：
   - `toolName` 在 `COMPACTABLE_TOOLS` 集合中
   - 文本不以 `"[Tool result expired"` 开头（不重复处理已过期内容）
   - 索引在 `compactBoundaryIdx` 之后
2. 保留最近 `keepRecent` 个，前面的全部过期
3. 过期处理：将原始文本存入 RecallStore，替换为过期提示

**输出格式**：`[Old tool result expired. ID: ctx-xxxx. Use recall_context(ctx-xxxx) to retrieve the original content.]`

**统计**：`{ triggered: boolean, cleared: number }`。`triggered` 表示间隔满足条件，`cleared` 是实际清理数量。

---

#### 第 2 层：Budget (Tool result budget) — `processBudget`

```typescript
function processBudget(
  messages: AgentMessage[],
  config: BudgetConfig,
  store: RecallStore,
  ffState: FrozenFreshState,
  compactBoundaryIdx: number | null,
): { messages: AgentMessage[]; stats: BudgetStats }
```

**核心思想**：按 user 消息分段，每段内控制 toolResult 的总字符数不超过预算。最大 toolResult 优先持久化（persist）。

**算法**：
```
result = [...messages]
persisted = 0

按 user 消息将 messages 分段 [groupStart, i):
  freshEntries = []  // 未冻结的 toolResult
  totalFreshChars = 0

  for j in [groupStart, i):
    if 不是 toolResult: skip
    if j < compactBoundaryIdx: skip
    if ffState.isFrozen(msg.toolCallId):
      用 ffState.getReplacement() 替换内容
    else:
      记录 {idx, toolCallId, chars}
      totalFreshChars += chars

  while totalFreshChars > maxToolResultCharsPerMessage AND freshEntries 非空:
    找 freshEntries 中 chars 最大的
    将原始文本存入 store.store(text, "budget-persisted")
    replacement = "[Persisted output (ID: {id}). Preview: {前 previewSize 字符}... Total: {len} chars]"
    ffState.markFrozen(toolCallId, replacement)  // 冻结！后续 turn 不再重新评估
    替换 result[idx] 的内容
    更新 totalFreshChars
    // 防护：如果 replacement 比原文还长，停止
    if replacement.length >= maxEntry.chars: break
```

**FrozenFreshState 使用方式**：
- `ffState` 由调用方（index.ts）持有，跨 context 事件持久化
- 一个 toolResult 被 budget 持久化后，标记为 `frozen`
- 后续 turn 再次处理时，frozen 的 toolResult 直接使用之前生成的 replacement，不重新评估
- 这避免了：同一个大 toolResult 在每个 turn 被反复持久化

**关键防护**：
- replacement 长度 >= 原文长度时 break，避免无限循环
- compactBoundaryIdx 之前的消息不处理

**输出格式**：`[Persisted output (ID: ctx-xxxx). Preview: {前 2000 字符}... Total: {len} chars]`

---

#### 第 3 层：L0 (Zero-cost cleanup) — `processL0`

```typescript
function processL0(
  messages: AgentMessage[],
  config: L0Config,
  store: RecallStore,
  now: number,
  turnBoundaries: TurnBoundary[],
): { messages: AgentMessage[]; stats: L0Stats }
```

**"零成本"含义**：不消耗 LLM token，纯规则驱动的清理。处理三种场景：

**场景 1：toolResult 过期**
```
条件：
  - msg.role === "toolResult"
  - (now - msg.timestamp) > expireMinutes * 60000  (默认 30 分钟)
  - NOT isInProtectedTurn(i, boundaries, protectRecentTurns)  (默认保护 2 turn)
  - NOT keepRecentProtected  (默认保护最近 5 个 toolResult)
  - NOT isAlreadyProcessed (不重复处理)

处理：store.store(original, "l0-expired") → 替换为 expireToolResult()
```

**场景 2：bashExecution 截断**
```
条件：
  - msg.role === "bashExecution"
  - msg.output.length > bashTruncateChars  (默认 4000 字符)

处理：store.store(output, "l0-truncated") → truncateBashOutput(output, bashTruncateChars, id)
注意：无条件截断，不受 turn 保护
```

**场景 3：thinking 清理**
```
条件：
  - msg.role === "assistant"
  - (now - msg.timestamp) > thinkingExpireMinutes * 60000  (默认 5 分钟)
  - NOT hasUserAfter[i]  (后面没有 user 消息，即这是最后一个 assistant 消息)

处理：将 thinking 内容替换为 "[thinking expired]"
```

**`hasUserAfter` 预计算**：
```
从后往前扫描，标记每个位置之后是否还有 user 消息。
用途：thinking 只清理"后面没有 user 消息"的 assistant 消息。
理由：如果后面还有 user 消息，说明这是对话中间的 thinking，可能还有用。
```

**`keepRecent` 保护**：
```
收集所有 toolResult 的索引，最后 keepRecent 个加入 keepRecentProtected 集合。
这些位置的 toolResult 即使已过期也不会被清理。
```

---

#### 第 4 层：L1 (Rule-based compression) — `processL1`

```typescript
function processL1(
  messages: AgentMessage[],
  config: L1Config,
  store: RecallStore,
  turnBoundaries: TurnBoundary[],
  compactBoundaryIdx: number | null,
): { messages: AgentMessage[]; stats: { condensed: number } }
```

**触发条件**（全部满足）：
1. `config.enabled === true`
2. `msg.role === "toolResult"`
3. `NOT isToolResultExpired(msg)` — 不是已过期的
4. `NOT isAlreadyProcessed(msg)` — 不是已处理过的（expired/condensed/persisted）
5. 索引在 `compactBoundaryIdx` 之后
6. `NOT isInProtectedTurn(i, boundaries, protectRecentTurns)` (默认保护 2 turn)
7. `text.length > summaryThresholdChars` (默认 8000 字符)

**处理逻辑**：
1. 调用 `condenseToolResult(text, keepHeadLines, keepTailLines)` 生成摘要
2. 原始内容存入 `store.store(text, "l1-condensed")`
3. 替换为：`[Condensed (ID: {id}): {summary}]`

**`isAlreadyProcessed` 判断**：文本以以下任一前缀开头视为已处理：
- `"[Tool result expired"`
- `"[Old tool result"`
- `"[Condensed"`
- `"[Persisted output"`

---

#### 第 5 层：L2 (Emergency compression) — `processL2`

```typescript
function processL2(
  messages: AgentMessage[],
  config: L2Config,
  store: RecallStore,
  contextUsage: ContextUsage | undefined,
  turnBoundaries: TurnBoundary[],
  compactBoundaryIdx: number | null,
): { messages: AgentMessage[]; stats: { triggered: boolean } }
```

**使用率计算**：
```
if contextUsage.percent != null:
  usagePercent = contextUsage.percent  // 来自 Pi API
else:
  totalChars = sum(estimateMessageChars(msg) for msg in messages)
  usagePercent = (totalChars / CHARS_PER_TOKEN) / DEFAULT_CONTEXT_WINDOW  // chars→tokens 估算
```

**触发条件**：
- `usagePercent >= emergencyThreshold` (默认 0.9，即 90%)

**处理逻辑**：强制过期所有未过期、未处理、未受 turn 保护的 toolResult：
```
for each msg:
  if compactBoundaryIdx 之前: skip
  if msg is toolResult AND NOT expired AND NOT processed AND NOT protected:
    store.store(original, "l2-emergency")
    expireToolResult(original, id)
    anyForceExpired = true
```

**`triggered` 语义**：表示"至少有一个 toolResult 被强制过期"，不是"使用率超过阈值"。区分"L2 激活但无东西可过期"和"L2 未激活"。

---

### 主入口：`compressContext`

```typescript
function compressContext(
  messages: AgentMessage[],
  config: ContextEngineeringConfig,
  store: RecallStore,
  contextUsage: ContextUsage | undefined,
  ffState: FrozenFreshState,
): { messages: AgentMessage[]; stats: CompressionStats }
```

**管道执行流程**：
```
1. if !config.enabled → 返回原始 messages + zeroStats
2. now = Date.now()
3. boundaries = findTurnBoundaries(messages)
4. compactBoundaryIdx = findCompactBoundary(messages)
5. current = messages

6. MC:   if config.mc.enabled → processMicrocompact(current, ...)
7. Budget: if config.budget.enabled → processBudget(current, ..., ffState)
8. L0:   if config.l0.enabled → processL0(current, ...)
9. L1:   if config.l1.enabled → processL1(current, ...)
10. L2:  if config.l2.enabled → processL2(current, ...)

11. validateToolPairing(current)
    if 失败 → 返回 { messages: 原始 messages, stats: { ...stats, validationFailed: true } }
    if 成功 → 返回 { messages: current, stats }
```

**重要设计**：
- 管道是串行的，后一层的输入是前一层的输出
- 配对校验失败时回滚到**原始** messages，不是上一层
- stats 即使回滚也会记录（validationFailed=true），用于调试

---

### 内部辅助函数

#### `estimateMessageChars(msg: AgentMessage): number`

**签名**：`(msg: AgentMessage) => number`

按角色估算字符数：
- `user`: string content 或 TextContent 文本长度之和
- `assistant`: text + thinking + toolCall(name + JSON.stringify(arguments)) 长度之和
- `toolResult`: text + image data 长度之和
- `bashExecution`: output 长度
- 其他: 0

**注意**：是粗略估算，用于 L2 的 fallback 使用率计算。

#### `isToolResultExpired(msg: ToolResultMessage): boolean`

用 `includes("[Tool result expired")` 判断。注意是 `includes` 不是 `startsWith`——因为 L2 产出的过期格式与此不完全一致。

#### `isAlreadyProcessed(msg: ToolResultMessage): boolean`

检查四种前缀：expired / Old tool result / Condensed / Persisted output。

---

## config.ts

**172 行，配置定义 + 加载 + 命令参数解析。**

### 导出类型

```typescript
interface L0Config {
  enabled: boolean;
  expireMinutes: number;         // toolResult 过期时间（默认 30 分钟）
  bashTruncateChars: number;     // bash 输出截断阈值（默认 4000 字符）
  thinkingExpireMinutes: number; // thinking 过期时间（默认 5 分钟）
  protectRecentTurns: number;    // 保护最近 N 个 turn（默认 2）
  keepRecent: number;            // 保护最近 N 个 toolResult（默认 5）
}

interface L1Config {
  enabled: boolean;
  summaryThresholdChars: number; // 触发 condense 的字符阈值（默认 8000）
  keepHeadLines: number;         // 保留头部行数（默认 10）
  keepTailLines: number;         // 保留尾部行数（默认 5）
  protectRecentTurns: number;    // 保护最近 N 个 turn（默认 2）
}

interface L2Config {
  enabled: boolean;
  emergencyThreshold: number;    // 紧急阈值（默认 0.9 = 90%）
  protectRecentTurns: number;    // 保护最近 N 个 turn（默认 3）
}

interface McConfig {
  enabled: boolean;
  gapThresholdMinutes: number;   // 间隔阈值（默认 60 分钟）
  keepRecent: number;            // 保留最近 N 个（默认 5）
}

interface BudgetConfig {
  enabled: boolean;
  maxToolResultCharsPerMessage: number; // 每段预算（默认 200,000 字符）
  previewSize: number;                   // 持久化预览长度（默认 2000 字符）
}

interface ContextEngineeringConfig {
  enabled: boolean;
  l0: L0Config;
  l1: L1Config;
  l2: L2Config;
  mc: McConfig;
  budget: BudgetConfig;
}
```

### 导出常量

#### `DEFAULT_CONFIG: ContextEngineeringConfig`

硬编码的默认配置。各字段的默认值见上方注释。

### 导出函数

#### `deepMerge<T>(base: T, override: Record<string, unknown>): T`

**签名**：`<T>(base: T, override: Record<string, unknown>) => T`

**算法**：递归深合并。
- 基础对象浅拷贝
- 遍历 override 的每个 key
- 如果两边都是非数组对象，递归合并
- 否则 override 覆盖 base

**边界条件**：
- `null`/`undefined` 值不触发递归（`baseVal != null && overVal != null`）
- 数组不递归，直接覆盖

#### `loadConfig(settingsPath?: string): ContextEngineeringConfig`

**签名**：`(settingsPath?: string) => ContextEngineeringConfig`

**算法**：
```
filePath = settingsPath ?? "~/.pi/agent/settings.json"
try: raw = readFileSync(filePath, "utf-8")
catch: return { ...DEFAULT_CONFIG }  // 文件不存在

try: parsed = JSON.parse(raw)
catch: return { ...DEFAULT_CONFIG }  // JSON 解析失败

override = parsed["context-engineering"]
if override is null/undefined/non-object: return { ...DEFAULT_CONFIG }

return deepMerge(DEFAULT_CONFIG, override)
```

**文件路径**：默认读取 `~/.pi/agent/settings.json` 中的 `"context-engineering"` 字段。

**错误处理**：文件不存在、JSON 解析失败、字段缺失——全部静默回退到默认配置。

#### `parseLevelArgs(args: string): { target; action } | null`

**签名**：`(args: string) => { target: "global"|"l0"|"l1"|"l2"|"mc"|"budget"; action: "on"|"off" } | null`

**算法**：
```
tokens = args.trim().split(/\s+/)
if tokens.length < 2: return null
[rawTarget, rawAction] = tokens
if rawTarget not in validTargets OR rawAction not in validActions: return null
return { target: rawTarget, action: rawAction }
```

---

## recall-store.ts

**63 行，被压缩内容的回溯存储。**

### 导出类型

```typescript
interface StoredContent {
  id: string;       // "ctx-{12位hex}"
  original: string; // 原始内容
  compressedAt: number; // 时间戳
  level: "l0-expired" | "l0-truncated" | "l1-condensed" | "l2-emergency" | "mc-cleared" | "budget-persisted";
}

interface RecallStore {
  store: (content: string, level: StoredContent["level"]) => string;
  recall: (id: string) => StoredContent | undefined;
  clear: () => void;
  size: () => number;
}
```

### 常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `ID_CHARS` | 12 | UUID 前 12 字符 = 48 bit 熵，碰撞阈值约 16M 条 |
| `MAX_ENTRIES` | 500 | 内存保护上限，超过时 LRU 淘汰 |

### 导出函数

#### `createRecallStore(): RecallStore`

**签名**：`() => RecallStore`

**工厂函数**，返回闭包对象。内部用 `Map<string, StoredContent>` 存储。

**`store(content, level)` 算法**：
```
if entries.size >= MAX_ENTRIES:
  oldest = entries.keys().next().value  // Map 保持插入顺序
  entries.delete(oldest)               // LRU 淘汰最早的

idSuffix = randomUUID().replace(/-/g, '').slice(0, 12)  // 48 bit
id = "ctx-{idSuffix}"
entries.set(id, { id, original: content, compressedAt: Date.now(), level })
return id
```

**`recall(id)`**：直接 `entries.get(id)`。

**`clear()`**：`entries.clear()`。

**`size()`**：`entries.size`。

**调用方**：
- 写入：compressor.ts 的 MC/Budget/L0/L1/L2 各层
- 读取：index.ts 的 `recall_context` 工具

---

## frozen-fresh.ts

**36 行，Budget 层的冻结/新鲜状态跟踪。**

### 导出类型

```typescript
interface FrozenFreshState {
  isFrozen(toolUseId: string): boolean;
  markFrozen(toolUseId: string, replacement: string): void;
  getReplacement(toolUseId: string): string | undefined;
  getAllFrozenIds(): Set<string>;
  reset(): void;
}
```

### 导出函数

#### `createFrozenFreshState(): FrozenFreshState`

**签名**：`() => FrozenFreshState`

**工厂函数**，内部用 `Map<string, string>` 存储（toolCallId → replacement text）。

**方法说明**：
- `isFrozen(id)` → `frozen.has(id)`
- `markFrozen(id, replacement)` → `frozen.set(id, replacement)`
- `getReplacement(id)` → `frozen.get(id)`
- `getAllFrozenIds()` → `new Set(frozen.keys())`
- `reset()` → `frozen.clear()`

**生命周期**：
- 在 `session_start` 时 `reset()`
- 在 `processBudget` 中被读写
- **跨 context 事件持久化**：由 index.ts 的 `frozenFreshState` 闭包变量持有，不在每次 context 事件中重建

**解决的问题**：Budget 层按 user 消息分段计算，一个大 toolResult 被持久化后，后续 context 事件中同一个 toolResult 不应重新评估（它已经被替换了）。`markFrozen` 确保后续直接使用之前的 replacement。

---

## commands.ts

**154 行，命令处理逻辑。**

### 内部函数

#### `formatConfigSummary(config: ContextEngineeringConfig): string`

**签名**：`(config: ContextEngineeringConfig) => string`

将配置格式化为人类可读的文本，包含每层的参数。每层独立显示 enabled/disabled 状态。

#### `formatStats(stats: CompressionStats): string`

**签名**：`(stats: CompressionStats) => string`

将统计数据格式化为一行一指标。

### 导出函数

#### `handleContextEngineeringCommand(args: string | undefined, config: ContextEngineeringConfig, stats: CompressionStats): string`

**签名**：`(args: string | undefined, config: ContextEngineeringConfig, stats: CompressionStats) => string`

**逻辑**：
```
if !args || args.trim().length === 0:
  return formatConfigSummary(config) + "\n\n" + formatStats(stats)  // 显示当前状态

parsed = parseLevelArgs(args)
if !parsed: return USAGE_HELP  // 显示帮助

switch (parsed.target):
  "global" → config.enabled = onOff
  "mc"     → config.mc.enabled = onOff
  "budget" → config.budget.enabled = onOff
  "l0"     → config.l0.enabled = onOff
  "l1"     → config.l1.enabled = onOff
  "l2"     → config.l2.enabled = onOff

return "{层名} {action}led."
```

**注意**：直接修改传入的 `config` 对象（mutation），因为 index.ts 中 `config` 是闭包变量。

#### `handleContextStatsCommand(stats: CompressionStats): string`

**签名**：`(stats: CompressionStats) => string`

返回标题 + `formatStats(stats)`。

---

## index.ts

**105 行，扩展入口。**

### 内部函数

#### `zeroStats(): CompressionStats`

返回全零/全 false 的统计对象。

#### `addStats(target: CompressionStats, delta: CompressionStats): void`

累加统计。布尔字段用 `||` 语义（任一为 true 则 true）。

#### `recallResult(id: string, store: RecallStore): { content; details }`

**签名**：`(id: string, store: RecallStore) => { content: [...], details: {...} }`

调用 `store.recall(id)`：
- 未找到 → 返回错误消息 + `{ found: false, id }`
- 找到 → 返回 `[Recalled content ({level}, {ISO timestamp})]\n\n{original content}` + `{ found: true, id, level }`

### 导出函数

#### `contextEngineeringExtension(pi: ExtensionAPI): void`

**签名**：`(pi: ExtensionAPI) => void`

**工厂函数**，注册扩展到 Pi。闭包持有 4 个可变状态：

| 变量 | 类型 | 生命周期 |
|------|------|----------|
| `config` | `ContextEngineeringConfig` | session_start 时从 settings.json 重新加载 |
| `store` | `RecallStore` | session_start 时重建（清空） |
| `cumulativeStats` | `CompressionStats` | session_start 时清零 |
| `frozenFreshState` | `FrozenFreshState` | session_start 时 reset |

**注册的事件/工具/命令**：

1. **`session_start`**：重建所有闭包状态
2. **`context`**：调用 `compressContext` → 累加统计 → 返回压缩后的消息
   - 类型转换：`as unknown as CompressorMessage[]`（Pi API 类型和内部类型结构一致但 TS 无法验证）
   - 异常保护：catch 后静默降级（仅在 `DEBUG_CONTEXT_ENGINEERING` 环境变量设置时打日志）
3. **`recall_context` 工具**：参数 `{ id: string }`，调用 `recallResult`
4. **`/context-engineering` 命令**：查看/修改配置
5. **`/context-stats` 命令**：查看统计

---

## 调用关系总图

```
index.ts
  ├── session_start
  │     ├── config.ts::loadConfig()
  │     ├── recall-store.ts::createRecallStore()
  │     ├── frozen-fresh.ts::createFrozenFreshState()
  │     └── zeroStats()
  │
  ├── context event
  │     └── compressor.ts::compressContext()
  │           ├── findTurnBoundaries()
  │           ├── findCompactBoundary()
  │           ├── processMicrocompact() ──→ store.store("mc-cleared")
  │           ├── processBudget() ───────→ store.store("budget-persisted")
  │           │     └── frozen-fresh.ts::isFrozen/markFrozen/getReplacement
  │           ├── processL0() ───────────→ store.store("l0-expired"/"l0-truncated")
  │           │     ├── isInProtectedTurn()
  │           │     ├── expireToolResult()
  │           │     ├── truncateBashOutput()
  │           │     └── expireThinking()
  │           ├── processL1() ───────────→ store.store("l1-condensed")
  │           │     ├── condenseToolResult()
  │           │     │     └── fallbackTruncate()
  │           │     └── isInProtectedTurn()
  │           ├── processL2() ───────────→ store.store("l2-emergency")
  │           │     ├── estimateMessageChars()
  │           │     └── isInProtectedTurn()
  │           └── validateToolPairing()
  │
  ├── recall_context tool
  │     └── recallResult() ──→ store.recall()
  │
  ├── /context-engineering command
  │     └── commands.ts::handleContextEngineeringCommand()
  │           └── config.ts::parseLevelArgs()
  │
  └── /context-stats command
        └── commands.ts::handleContextStatsCommand()
```

---

## 关键设计模式总结

### 1. 闭包状态管理

`index.ts` 用 `let` 闭包变量持有 `config`/`store`/`stats`/`ffState`。`session_start` 时重建，所有注册的 handler 共享同一引用。已知违反 session 隔离原则（多 session 时共享状态），但当前单 session 使用无问题。

### 2. 安全网设计

`validateToolPairing` 在所有压缩后执行，如果配对被破坏，整个压缩结果被丢弃（回滚到原始 messages）。这保证了即使压缩逻辑有 bug，也不会破坏 Pi 的 tool call 协议。

### 3. 冻结-新鲜二分法（Frozen-Fresh Pattern）

Budget 层引入 `FrozenFreshState` 解决的核心问题：大 toolResult 一旦被持久化，在后续 context 事件中需要保持替换状态，而不是重新评估。这避免了"同一大结果反复被选中持久化"的循环。

### 4. Turn 保护的一致性

L0/L1/L2 都有 `protectRecentTurns` 参数，共享 `isInProtectedTurn()` 实现。MC 用 `keepRecent` 参数保护最近的 N 个 compactable toolResult。L0 额外用 `keepRecent` 保护最近 N 个任意 toolResult。

### 5. 分层压缩的增量设计

MC → Budget → L0 → L1 → L2 的顺序不是随意的：
- **MC** 先清掉长时间不用的工具结果（时间间隔 > 60 分钟）
- **Budget** 按预算控制每段 toolResult 总量（防止单段过大）
- **L0** 做零成本清理（过期、截断、thinking）
- **L1** 对剩余的大结果做结构化摘要
- **L2** 是最后防线，当上下文使用率 > 90% 时强制过期

每一层的输出是下一层的输入，逐层收紧。
