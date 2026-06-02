# magic-context 源码架构分析（下）— Historian / Compressor / Dreamer / Strip / Cache / Partial-Recomp

> 分析对象：magic-context（⭐764）五个核心子系统
> 分析日期：2025-06-01
> 分析深度：源码级（compartment-runner-historian 585 行、compartment-runner-compressor 798 行、dreamer/runner 1381 行、strip-content 657 行、system-prompt-hash 512 行、compartment-runner-partial-recomp 498 行已完整阅读）

---

## 1. Historian 深度分析

Historian 是 magic-context 三层架构的"第一层"——负责将原始对话历史压缩为结构化的 Compartment（分区摘要）。它通过创建 Pi 子 session 来运行 LLM，生成 XML 格式的 compartment 输出。

### 1.1 两阶段验证流程

Historian 的核心是 `runValidatedHistorianPass()`，实现了一个**三重降级**的验证流程：

```
runValidatedHistorianPass()
    │
    ├─ 1. runHistorianPrompt(initial prompt)
    │      └→ validateHistorianOutput()
    │           ├─ ok → (twoPass ? runEditorPassOrFallback : 直接返回)
    │           └─ fail → 进入修复流程
    │
    ├─ 2. buildHistorianRepairPrompt(原 prompt + 失败输出 + 错误信息)
    │      └→ runHistorianPrompt(repair prompt)
    │           └→ validateHistorianOutput()
    │                ├─ ok → 返回
    │                └─ fail → 进入降级流程
    │
    └─ 3. runFallbackHistorianPass(用主 session 模型重试)
           └→ runHistorianPrompt(modelOverride = 主 session 模型)
                └→ validateHistorianOutput()
                     ├─ ok → 返回
                     └─ fail → 最终失败 {ok: false}
```

**设计理由**：

- **第一次尝试**：用配置的 historian 模型（通常是便宜/快速模型）生成 compartment
- **修复重试**：如果输出格式不合法（缺少覆盖、结构错误等），不是重跑同一个 prompt，而是把错误信息告诉 LLM，让它修复
- **最终降级**：如果专用模型彻底失败，用主 session 的模型作为最后手段。这保证了即使 historian 模型不可用（配额、认证问题），系统仍然能工作

### 1.2 子 Session 管理与生命周期

`runHistorianPrompt()` 的子 session 管理极其精细：

```
1. client.session.create({parentID, title: "magic-context-compartment"})
   → 获取 agentSessionId

2. for retryIndex 0..MAX_HISTORIAN_RETRIES(2):
   try:
     promptSyncWithModelSuggestionRetry(client, {
       path: {id: agentSessionId},
       body: {
         agent: HISTORIAN_AGENT,        // 使用 historian agent 的 system prompt
         model: modelOverride?,          // 可选模型覆盖
         parts: [{type: "text", text: prompt, synthetic: true}]  // synthetic=true 隐藏于 TUI
       }
     })
     break  // 成功则跳出重试循环
   catch:
     if !isTransientError → throw       // 非瞬时错误直接抛出
     sleep(backoffMs)                    // 瞬时错误退避后重试

3. client.session.messages({id: agentSessionId, limit: 50})
   → 提取最新 assistant text

4. finally:
   client.session.delete({id: agentSessionId})  // 无论成功失败都清理子 session
```

**关键设计**：

- `synthetic: true` 标记：让这个大 prompt 不出现在 TUI 的 subagent 面板中（issue #50），但仍然传递给 LLM
- 子 session 是临时的：无论成功、失败、异常，`finally` 块都会清理。避免泄漏
- `parentID` 关联：子 session 通过 `parentID` 绑定到主 session，便于追踪

### 1.3 重试与降级策略

**瞬态错误检测** (`isTransientHistorianPromptError`)：

```typescript
// 非瞬态（不重试）：400 Bad Request、401 Unauthorized、403 Forbidden
// 瞬态（重试）：429 Rate Limit、502/503/500、ECONNRESET、ETIMEDOUT、overloaded
```

**退避策略**：
- 第 1 次重试：2000ms + random(0, 1000) ≈ 2-3s
- 第 2 次重试：6000ms + random(0, 2000) ≈ 6-8s

**Fallback chain**：`fallbackModels` 数组（resolved historian fallback chain），每个依次尝试。注意 Editor Pass 故意不接收 fallback chain——如果 editor 模型失败，直接返回已验证的 draft，不浪费额外 LLM 调用。

### 1.4 Editor Pass（可选第二遍）

`runEditorPassOrFallback()` 是 Historian 的可选精炼步骤：

- **触发条件**：`twoPass: true` 配置
- **Agent**：使用 `HISTORIAN_EDITOR_AGENT`（不同于 historian 的 system prompt）
- **输入**：historian 的已验证 draft XML
- **目的**：清理低信号内容、删除跨 compartment 重复
- **降级策略**：editor 失败 → 返回 draft（不会比没有更差）
- **不使用 fallback chain**：避免在"精炼"步骤上浪费成本

这是一个优雅的设计——两阶段（draft → polish），第二阶段是纯增益，失败不影响第一阶段的成果。

**Dump 机制**：每次 historian 运行都 dump 原始输出到 `<project>/.opencode/magic-context/historian/`，成功后清理，失败后保留供调试。这解决了"LLM 输出格式错误但错误信息不够"的调试难题。

---

## 2. Compressor（压缩机）

Compressor 是 Historian 的"后续压缩器"——当 compartment 总量超过 history budget 时，选择旧 compartment 进行再压缩（合并多个旧 compartment 为更少的 compartment）。

### 2.1 深度优先选择算法

`selectCompressionBand()` 是 Compressor 最核心的算法，解决"下一次压缩谁"的问题。

**旧算法的问题**：最老优先 → seq 0-14 先被压缩到 depth 1 → 下一次还是 seq 0-14（它们仍然最老）→ 同一区间被反复压缩到 depth 5 → 早期历史变成空壳。

**新算法（深度优先）**：

```
1. eligible = [0, scored.length - graceCompartments)  // 保护最新 N 个
2. 过滤掉 depth >= maxMergeDepth(5) 的 compartment
3. 收集所有 distinct depth tier，升序排列
4. 对每个 tier（从最低开始）：
   a. 从最老的 compartment 开始，找连续同 depth 区间
   b. 区间长度 >= 2 → 返回
   c. 单个 → 跳过，找下一个同 tier 的 anchor
5. 所有 tier 都找不到 → 返回空
```

**效果**：产生平滑的深度梯度——旧历史更深（更压缩），新历史更浅（保留更多细节）。类似人类记忆的衰减曲线。

**保护机制**：
- `graceCompartments`（默认 10）：最新的 compartment 永远不被压缩
- `floorHeadroom`：不能压缩到低于 `ceil(lastEndMessage / minCompartmentRatio)` 个 compartment
- `hardMaxPick`：单次最多选 `maxCompartmentsPerPass`（默认 15）个

### 2.2 LLM 压缩流程

`runCompressorPass()` 与 Historian 类似，创建子 session 调用 LLM：

```
1. buildCompressorPrompt(compartments, currentTokens, targetTokens, outputDepth, outputCount)
2. 创建子 session
3. promptSyncWithModelSuggestionRetry(agent: "historian", prompt: compressorPrompt)
4. extractLatestAssistantText → parseCompartmentOutput
5. snapLLMOutputToInputBoundaries（吸附 LLM 偏移的 ordinal）
6. 返回吸附后的结果
```

**targetTokens 计算**：`max(200, floor(selectedTokens / mergeRatio))`
- mergeRatio 按 depth 递增：depth 1 = 1.33x, 2 = 2.0x, 3 = 2.5x, 4 = 3.0x
- 深度越深，目标 token 越少 → 压缩越狠

### 2.3 Ordinal 吸附（snapLLMOutputToInputBoundaries）

这是解决"LLM 精度不够"的工程杰作：

```
问题：LLM 输出 start=8161，但实际 compartment 边界是 8160
      精确匹配会拒绝这个结果 → 整个压缩 pass 失败

解决：对每个 LLM 输出的 ordinal，用二分查找找到包含它的 input compartment
      用该 compartment 的边界替代 LLM 输出
      如果 ordinal 不在任何 input compartment 内 → 幻觉，整个结果作废
```

**实现**：
- `containing(ord)`: 二分查找 `sorted[mid].startMessage <= ord <= sorted[mid].endMessage`
- 对每个 LLM 输出的 start/end 分别吸附
- 记录 `snapCount` 供日志追踪

### 2.4 Depth 5 短路与 Caveman 后处理

**Depth 5 短路**：

```typescript
if (outputDepth === 5) {
    // 直接 collapse 为 title-only，content = ""
    // 不需要 LLM 调用
    return finalizeCompression({...compressed: selectedCompartments.map(c => ({...c, content: ""}))});
}
```

这是关键优化——depth 5 的 compartment 只保留标题，内容完全丢弃。既然内容为空，不需要 LLM 来"压缩"。

**Caveman 后处理**（depth 1-4）：

LLM 压缩后，对每个 compartment 的 content 应用 caveman 压缩：
- depth 1: 无 caveman（LLM 输出直接使用）
- depth 2: lite（轻量压缩）
- depth 3: full
- depth 4: ultra

Caveman 压缩器（来自 `caveman.ts`，未在此次分析范围内）是基于规则的去噪：删除代码注释、空行、冗余描述等。

### 2.5 最终化与持久化

`finalizeCompression()` 负责将压缩结果写回 SQLite：

```
1. 验证范围一致性：compressedStart == originalStart && compressedEnd == originalEnd
2. 验证内部连续性：相邻 compartment 无 overlap、无 gap
3. 构建新 compartment 序列：leading（不变）+ compressed（新）+ trailing（不变）
4. 写入 SQLite：
   - 有 lease holder: replaceAllCompartmentStateAndBumpDepth（CAS 保护）
   - 无 lease: replaceAllCompartmentState + incrementCompressionDepth
5. 不清理 injection cache（后台 compressor 不能 bust cache）
```

**关键设计**：后台 compressor 不 bust cache。下一个 cache-busting pass 会从 DB 读取新状态。这避免了后台操作干扰正在进行的 context event 处理。

---

## 3. Dreamer 深度分析

Dreamer 是 magic-context 的"第二层"——后台规划器，负责分析项目状态、识别关键文件、管理 smart notes、更新 user memory。

### 3.1 任务队列与调度

Dreamer 使用一个 SQLite 持久化的任务队列：

```typescript
// 入队
dequeueNext(db) → DreamEntry | null

// 状态管理
resetDreamEntry(db, entryId)   // 重置为待执行
removeDreamEntry(db, entryId)  // 删除已完成

// 失败处理
getEntryRetryCount(db, entryId) → number
clearStaleEntries(db)          // 清理过期条目
```

**调度模式**：Dreamer 不是定时 cron（虽然配置中提到了 cron），而是通过事件驱动的 "dream scheduler" 触发。每次触发时从队列中取任务执行。

**Lease 保护**：通过 `acquireLease/renewLease/releaseLease` 防止多个 Dreamer 实例同时运行。

### 3.2 Key Files 识别

Dreamer 集成了 `key-files` 模块，自动识别项目的关键文件：

```typescript
getKeyFileCandidates() → FileCandidate[]
heuristicKeyFileSelection(candidates) → selected[]
runKeyFilesTask() → KeyFileResult[]
```

**数据源**：直接读取 OpenCode 的 SQLite DB（readonly 模式），获取项目 session 列表，分析哪些文件被频繁访问。

**输出**：生成一个 key-files 列表，注入到 system prompt 的 `<key-files>` 块中，帮助 LLM 快速了解项目结构。

### 3.3 Smart Notes 管理

Smart Notes 是 Dreamer 的一个子功能：

```typescript
getPendingSmartNotes(db) → SmartNote[]
markNoteChecked(db, noteId)
markNoteReady(db, noteId)
```

Smart Notes 是 Dreamer 发现的"值得注意的信息"（如配置变更、依赖更新、模式变化）。它们会被标记为 checked/ready 状态，在合适的时机注入到对话中。

### 3.4 User Memory Review

Dreamer 集成了 user memory 的自动审查：

```typescript
getActiveUserMemories(db) → UserMemory[]
reviewUserMemories(memories) → ReviewResult[]
getMemoryCountsByStatus(db) → {active, draft, archived}
```

Dreamer 定期审查 user memory，标记过时的记忆、更新过期的偏好。

### 3.5 Circuit Breaker

```typescript
const CIRCUIT_BREAKER_THRESHOLD = 3;

// 连续失败 3 次后，跳过后续 dream 任务
// 直到有成功执行重置计数器

// 错误签名：取 error.name 或错误消息第一行
// 跳过条件：AbortError 或 lease 相关错误不触发 circuit breaker
```

**设计理由**：Dreamer 在后台运行，连续失败不应阻塞正常 agent 工作。Circuit breaker 防止了"不断重试一个注定失败的 dream"导致的资源浪费。

**Session 管理**：Dreamer 直接查询 OpenCode 的 session DB（`opencode.db`），而不是通过 SDK。这是因为 SDK 的 `session.list` 按 directory 过滤，可能漏掉不同 workspace 下的同项目 session。

---

## 4. Strip 系统深度分析

Strip 系统是 Forge 管道中的"清洁工"——在 context event 中清理消息中的冗余内容。它包含 7 种独立的 strip 策略。

### 4.1 七种 Strip 策略详解

#### ① stripSystemInjectedMessages

**目标**：清理系统注入消息（通知、提醒、内部标记）

**识别模式**（6 种正则）：
```
/<!-- OMO_INTERNAL_INITIATOR -->/
/<system-reminder>[\s\S]*<\/system-reminder>/
/^\[SYSTEM DIRECTIVE:/
/^\[Category\+Skill Reminder\]/
/^\[EDIT ERROR - IMMEDIATE ACTION REQUIRED\]/
/^\[EMERGENCY CONTEXT WINDOW WARNING\]/
```

**保护**：`protectedTailStart` 之前才清理——最近的消息可能包含有用信息（如后台任务 ID）。

**特殊处理**：先去掉 `§N§` tag 前缀再匹配，因为 tagger 已经在文本前面加了 tag。

#### ② stripDroppedPlaceholderMessages

**目标**：清理全是 `[dropped §N§]` 占位符的消息

**逻辑**：将消息文本按 `(?=\[dropped §)` 分段，检查每个非空段是否匹配 `/^\[dropped §\d+§\]$/`。全部匹配才 strip。

**为什么需要这个**：`ctx_reduce` 工具把消息内容替换为 `[dropped §N§]`，但消息结构还在。如果不清理，这些空壳消息白白占 token。

#### ③ clearOldReasoning + replayClearedReasoning

**目标**：基于 tag 年龄清除 reasoning/thinking 部分

```typescript
// 计算 age cutoff
const ageCutoff = maxTag - clearReasoningAge;
// 对 tag <= ageCutoff 的消息，将 reasoning 的 thinking/text 设为 "[cleared]"
```

**`replayClearedReasoning`**：在每次 context event（包括 defer pass）中重放已持久化的清除决策。因为 OpenCode 每次 turn 都从 DB 重建消息，之前在内存中的修改会丢失，需要重新应用。

#### ④ stripClearedReasoning

**目标**：清理已标记为 `[cleared]` 的 reasoning 部分

```typescript
// 判断条件：thinking === "[cleared]" || thinking === undefined
//           AND text === "[cleared]" || text === undefined
```

**防御性检查**：如果一个 reasoning part 既没有 `thinking` 也没有 `text` 字段，不清理。这保护了未来可能的新字段结构。

#### ⑤ stripInlineThinking

**目标**：清理旧消息中的 `<thinking>...</thinking>` 标签

```typescript
const INLINE_THINKING_PATTERN = /<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>\s*/g;
```

只处理 `tag <= ageCutoff` 的 assistant 消息。同样有 `replayStrippedInlineThinking` 版本用于重放。

#### ⑥ truncateErroredTools

**目标**：截断过长的工具错误信息

```typescript
// 只处理 tag <= watermark 的消息
// 错误信息 > 100 chars → 截断为 100 chars + "... [truncated]"
```

#### ⑦ stripProcessedImages

**目标**：清理已处理的 base64 图片

```typescript
// 只处理 user 消息中 tag <= watermark 的 file parts
// mime.startsWith("image/") && url.startsWith("data:") && url.length > 200
```

**方向**：从尾部向前遍历，只清理已有 assistant 回复的 user 消息中的图片（说明图片已被"看过"）。

### 4.2 Sentinel 替换与 Cache 安全

**核心原则**：所有 strip 操作都用 **sentinel 替换**，而不是从数组中删除消息。

```typescript
// 替换消息的所有 parts 为一个空 sentinel
msg.parts.length = 0;
msg.parts.push(makeWholeMessageSentinel(providerID));

// 或替换单个 part
message.parts[i] = makeSentinel(part);
```

**为什么不能删除**：

1. **Prompt Cache 稳定性**：Anthropic 的 prompt cache 基于消息数组的前缀 hash。删除消息会改变数组结构，导致 cache prefix 失效，整个历史需要重新发送
2. **Anthropic/Bedrock 的优化**：OpenCode 的 provider transform 层会自动丢弃空文本 parts，所以 sentinel 在 wire 上是不可见的——效果等同于删除，但不破坏 cache
3. **Proxy provider**：某些代理 provider 基于消息数组结构做 hash，数组长度变化会导致 hash 不匹配

### 4.3 Anthropic 专用 Reasoning Strip

`stripReasoningFromMergedAssistants()` 解决了一个非常具体的上游 bug：

**问题**：`@ai-sdk/anthropic` 的 `groupIntoBlocks` 会合并连续的 assistant 消息为一个 Anthropic assistant block。每个 source assistant 的 signed reasoning 变成独立的 thinking block——合并后出现 thinking 与 text/tool_use 交错。

**Opus 4.7 的限制**：`thinking or redacted_thinking blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.`

**唯一合法布局**：`[thinking at index 0 (optional)] + [text/tool_use only]`——即每个连续 assistant run 最多一个 thinking block，且必须是第一个非 metadata part。

**规则**：
- 对每个连续 assistant run，只保留**第一个** assistant 的**第一个** reasoning part
- 该 reasoning part 必须是第一个非 metadata、非 sentinel 的 part
- 其他所有 reasoning/thinking/redacted_thinking 都被 sentinel 替换

**Provider 限制**：只对 `providerID === "anthropic"` 执行。OpenAI 兼容 provider（如 Moonshot/Kimi）有相反的要求——每个 tool-call assistant 必须有非空的 `reasoning_content`，执行这个 strip 会导致 400 错误。

---

## 5. System Prompt Cache 保护

### 5.1 Hash 变化检测

`createSystemPromptHashHandler()` 使用 SHA256 hash 检测 system prompt 的变化：

```
每次 before_agent_start（或类似事件）：
  1. 计算当前 system prompt 的 SHA256 hash
  2. 与上次保存的 hash 比较
  3. 如果变化了：
     a. Anthropic prompt cache prefix 已失效
     b. 触发 historyRefreshSessions → 下游消费者立即 flush 队列操作
     c. 更新保存的 hash
```

**设计理由**：Anthropic 的 prompt cache 是基于 system prompt 前缀的。如果 system prompt 变了（如 agent 切换、配置更新），之前缓存的前缀全部失效。这个检测让系统能立即响应变化，而不是等到下次 injection 才发现 cache 已失效。

### 5.2 注入控制策略

System prompt handler 控制四种注入：

| Marker | 内容 | 来源 |
|--------|------|------|
| `## Magic Context` | Magic Context 使用指南 | 硬编码 prompt |
| `<project-docs>` | ARCHITECTURE.md + STRUCTURE.md | 项目根目录文件 |
| `<user-profile>` | 用户偏好记忆 | SQLite user memory |
| `<key-files>` | 项目关键文件列表 | Dreamer key-files 任务 |

**注入逻辑**：
1. 检查 system prompt 中是否已有 marker（如已被 oh-my-opencode 预注入）→ 跳过
2. 只注入新内容到 system prompt 尾部
3. 通过 `systemPromptRefreshSessions` Set 控制何时重新读取磁盘上的文件（如 ARCHITECTURE.md 变更后）

### 5.3 内部 Agent 跳过

```typescript
function isInternalOpenCodeAgent(systemPromptContent: string): boolean {
    return (
        content.includes("You are a title generator...") ||
        content.includes("Summarize what was done in this conversation...") ||
        content.includes("You are an anchored context summarization assistant...")
    );
}
```

OpenCode 有三个内部 agent（title generator、summary writer、compaction summarizer），它们用便宜/小模型执行单次任务。对这些 agent 注入 magic-context 的 guidance 纯属浪费 token。检测方式是用精确子串匹配（不是模糊匹配），这样上游 prompt 的小改动不会误触发跳过。

---

## 6. Partial Recomp（部分重压缩）

Partial Recomp 允许用户指定消息范围重新压缩 compartment，不需要全量重建。

### 6.1 范围吸附算法

`snapRangeToCompartments()` 将用户指定的 ordinal 范围映射到 compartment 边界：

```
输入：range = {start: 50, end: 200}，compartments = [0-100, 101-200, 201-300, ...]

1. 找第一个 endMessage >= start 的 compartment → [0-100]
2. 找最后一个 startMessage <= end 的 compartment → [101-200]
3. 三段划分：
   - priorCompartments: [201-300, ...]（start 之前的，不变）
   - rangeCompartments: [0-100, 101-200]（需要重压缩）
   - tailCompartments: []（end 之后的，不变）

输出：{snapStart: 0, snapEnd: 200, priorCompartments, rangeCompartments, tailCompartments}
```

**错误处理**：
- range 完全在所有 compartment 之前 → error
- range 不与任何 compartment 重叠 → error
- start < 1 → error
- end < start → error

### 6.2 三段划分策略

Partial recomp 的执行流程：

```
1. snapRangeToCompartments() → 确定三段
2. 对 rangeCompartments 执行 historian pass（生成新 compartment）
3. 合并：prior + 新 compartment + tail
4. 写回 SQLite（replaceAllCompartmentState）
5. 清理 injection cache
```

**使用场景**：用户发现某个历史区间的 compartment 内容不准确（如 historian 摘要遗漏了关键信息），可以用 `/ctx-recomp 50-200` 只重压缩那个区间，而不需要重做整个 session 的历史。

---

## 7. 模块间调用关系图

```
                        hook.ts (事件注册)
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
    event-handler.ts    transform.ts    system-prompt-hash.ts
         │                  │                    │
         │                  ▼                    ▼
         │         tagger.ts               readProjectDocs()
         │         strip-content.ts        getUserProfile()
         │         inject-compartments
         │                  │
         ▼                  ▼
    ┌────────────────────────────────┐
    │        Storage Layer (SQLite)  │
    │  compartments | tags | memory  │
    │  session_meta | embeddings     │
    └───────────────┬────────────────┘
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
  Historian    Compressor    Dreamer
  (subagent)   (subagent)   (subagent)
        │           │           │
        ▼           ▼           ▼
  runValidated  runCompres-  dreamer/
  Historian     sionPass     runner.ts
  Pass()        IfNeeded()     │
                                ▼
                          key-files/
                          smart-notes/
                          user-memory/
                          partial-recomp/
```

**调用关系**：
- `transform.ts`（Forge）在每次 context event 中调用 tagger → strip → inject
- `event-handler.ts` 触发 Historian（context usage > 65%）和 Dreamer（定时）
- Historian 产出 compartment → 写入 SQLite → 下次 transform 注入
- Compressor 检查 compartment 总量 → 超过 budget → 选择旧 compartment 再压缩
- Dreamer 在后台运行，更新 memory、key-files、smart notes
- `system-prompt-hash.ts` 在每次 agent start 时检测 hash 变化，触发 flush
- Partial Recomp 是用户手动触发的（`/ctx-recomp N-M`）

---

## 8. 关键设计决策总结

| 决策 | 选择 | 理由 |
|------|------|------|
| **子 session** | 创建临时 Pi session 运行 LLM | 隔离性：historian/compressor 的 LLM 调用不影响主 session 的上下文 |
| **两阶段验证** | draft → validate → repair → validate → fallback | 三重降级保证鲁棒性：大多数情况一次成功，格式错误时修复，模型不可用时降级 |
| **深度优先选择** | 选最低深度层最老区间 | 产生平滑梯度（旧=深，新=浅），避免旧算法的"同一区间被压缩到空壳" |
| **Sentinel 替换** | 用空 sentinel 替换而非删除 | 保护 Anthropic prompt cache prefix 稳定性 |
| **Ordinal 吸附** | 二分查找最近 compartment 边界 | LLM 的 ordinal 输出精度 ±1-2，精确匹配太严格会频繁失败 |
| **Depth 5 短路** | title-only，不调 LLM | 内容为空不需要 LLM 压缩，节省成本 |
| **Editor Pass 不用 fallback** | editor 失败直接返回 draft | 纯精炼步骤，不值得额外 LLM 成本 |
| **Circuit Breaker** | 连续 3 次失败后跳过 | 后台任务不应因持续失败而消耗资源 |
| **Internal Agent 跳过** | 精确子串匹配 title/summary/compaction | 避免对 cheap model 的单次任务注入冗余 prompt |
| **直接读 OpenCode DB** | readonly 打开 opencode.db | SDK 的 session.list 按 directory 过滤，会漏 session |
| **后台 compressor 不 bust cache** | 写 DB 但不清理 injection cache | 避免干扰正在进行的 context event 处理 |

---

## 9. 精华提炼（最值得借鉴的 5 个设计）

### ① Sentinel 替换模式

**问题**：需要从消息中移除内容，但不能改变消息数组结构（会破坏 prompt cache）。

**解决方案**：用空文本 sentinel 替换，而非删除。Anthropic/Bedrock 的 provider 层会自动丢弃空文本，效果等同于删除。

**可借鉴度**：★★★★★ — 任何做 context event transform 的扩展都需要这个。

### ② 深度优先的压缩选择

**问题**：如何选择"下一次压缩谁"才能避免同一区间被反复压缩。

**解决方案**：按深度分层，选最低层最老区间。产生类似"记忆衰减"的梯度。

**可借鉴度**：★★★★☆ — 如果 context-engineering 加入 LLM 摘要层并需要多轮压缩，这个策略直接适用。

### ③ LLM Ordinal 吸附

**问题**：LLM 输出的行号/消息序号有 ±1-2 的偏差，精确匹配导致频繁失败。

**解决方案**：用二分查找将 LLM 输出吸附到最近的已知边界。超出范围才算幻觉。

**可借鉴度**：★★★☆☆ — 如果让 LLM 处理行号相关任务（如选择要压缩的消息范围），这个思路通用。

### ④ 三重降级验证

**问题**：LLM 生成的结构化输出可能格式不合法。

**解决方案**：draft → repair（带错误信息的重试）→ fallback（用不同模型）。每一层都有独立价值。

**可借鉴度**：★★★★☆ — 任何依赖 LLM 生成结构化输出的场景都适用。比简单的"重试"更智能。

### ⑤ Prompt Cache 变化检测

**问题**：system prompt 变化导致 Anthropic 的 prompt cache 失效，需要立即响应。

**解决方案**：每次 agent start 时 hash 检测 system prompt 变化，变化时触发下游刷新。

**可借鉴度**：★★★★★ — 如果 context-engineering 需要注入 system prompt block，这个检测是必需的。

---

## 10. 复杂度评估与风险

### 代码量评估

| 模块 | 行数 | 依赖复杂度 |
|------|------|-----------|
| Historian | 585 | 中（子 session 管理、验证、重试） |
| Compressor | 798 | 高（深度选择、ordinal 吸附、caveman） |
| Dreamer | 1381 | 极高（任务队列、key-files、smart-notes、user-memory、circuit breaker） |
| Strip | 657 | 中（7 种策略，但每种相对独立） |
| System Prompt Hash | 512 | 中（hash 检测、注入控制） |
| Partial Recomp | 498 | 低（范围吸附 + 三段划分） |

### 主要风险

1. **维护成本**：Historian + Compressor + Dreamer 的 LLM 交互依赖 Pi/OpenCode 的子 session API。API 变更可能导致大面积回归
2. **LLM 成本**：每次 historian pass 至少一次 LLM 调用，compressor 也是。长 session 可能多次触发
3. **调试困难**：子 session 是临时的，虽然 dump 机制保留了 historian 输出，但 compressor 的中间状态难以追踪
4. **Anthropic 绑定**：多个 strip 策略（特别是 reasoning strip）是 Anthropic 专用 workaround。@ai-sdk 的修复会让这些代码变成死代码
5. **SQLite 锁竞争**：多个后台操作（historian、compressor、dreamer）同时写 SQLite，需要 lease 保护。`PRAGMA busy_timeout` 缓解但不能消除

### 总体评估

magic-context 是一个**工程杰作**，但也是一个**过度工程**的典型案例。它的 50K+ 行代码解决了一个真实问题（上下文管理），但复杂度已经超过了大多数用户能理解和配置的能力。

**最值得学习的不是具体实现**（50K 行谁也不想维护），而是**设计思想**：
- Sentinel 替换保护 cache
- 深度优先选择避免重复压缩
- 三重降级验证提高鲁棒性
- Prompt hash 检测触发响应式刷新
- Circuit breaker 保护后台任务

这些思想可以用 1/10 的代码量在 context-engineering 中实现。
