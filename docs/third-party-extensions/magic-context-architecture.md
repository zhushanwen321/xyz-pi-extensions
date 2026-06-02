# magic-context 源码架构深度分析

> 分析对象：cortexkit/magic-context（⭐764）
> 分析日期：2025-06-01
> 分析深度：源码级（transform.ts 1421 行、event-handler.ts 689 行、hook.ts 685 行、tagger.ts 713 行、storage-db.ts 805 行 等 15 个核心文件完整阅读）

---

## 1. 整体架构

### 1.1 三层架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                        OpenCode / Pi Runtime                        │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    hook.ts (入口，685 行)                      │  │
│  │  createMagicContextHook(deps) → 返回 7 个事件处理器             │  │
│  │                                                               │  │
│  │  返回的事件处理器：                                              │  │
│  │  1. experimental.chat.messages.transform → transform.ts       │  │
│  │  2. experimental.chat.system.transform → system-prompt-hash   │  │
│  │  3. experimental.text.complete → text-complete                │  │
│  │  4. chat.message → chatMessageHook                            │  │
│  │  5. event → eventHandler + dreamQueue                         │  │
│  │  6. command.execute.before → commandHandler                   │  │
│  │  7. tool.execute.after → toolExecuteAfterHook                 │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────────┐  │
│  │  Forge 层     │  │  Historian   │  │  Dreamer                  │  │
│  │  (实时管道)   │  │  (后台压缩)  │  │  (定时规划)               │  │
│  │              │  │              │  │                           │  │
│  │ transform.ts │  │ compartment- │  │ dreamer/                  │  │
│  │  1421 行     │  │ runner-      │  │  runner.ts                │  │
│  │              │  │ historian.ts │  │  1381 行                  │  │
│  │ 每次 context │  │  585 行      │  │                           │  │
│  │ event 触发   │  │              │  │ 定时 cron 或手动          │  │
│  │              │  │ 使用率 > 65% │  │  /ctx-dream              │  │
│  │              │  │ 触发         │  │                           │  │
│  │              │  │              │  │ subagent 进程             │  │
│  │              │  │ subagent 进程│  │                           │  │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬───────────────┘  │
│         │                 │                       │                  │
│  ┌──────▼─────────────────▼───────────────────────▼───────────────┐  │
│  │                     SQLite (context.db)                         │  │
│  │  compartments | memories | tags | sessions | embeddings | ...  │  │
│  └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 数据流

```
每次 LLM 调用前:
  OpenCode 重建 messages 数组 → hook 返回 transform(messages)
     │
     ▼
  transform.ts 主管道 (每条消息走一遍):
     1. findSessionId() — 从消息中提取 sessionId
     2. getOrCreateSessionMeta() — 从 SQLite 读取 session 元数据
     3. 模型变更检测 — 检测 provider/model 切换，清除陈旧状态
     4. loadContextUsage() — 加载上下文使用率
     5. overflow 恢复检测 — 如果上次 overflow，bump 到 95%
     6. prepareCompartmentInjection() — 准备注入 compartment + memory
     7. tagMessages() — 给每条消息分配 §N§ 标签前缀
     8. applyFlushedStatuses() — 应用已持久化的 drop/truncate 操作
     9. stripStructuralNoise() — 剥离工具结构噪音
    10. replayClearedReasoning() — 回放已清除的 reasoning
    11. replayCavemanCompression() — 回放 caveman 文本压缩
    12. stripClearedReasoning() — 清除旧的 reasoning
    13. stripReasoningFromMergedAssistants() — Anthropic 合并消息处理
    14. runCompartmentPhase() — 启动/等待 Historian subagent
    15. runPostTransformPhase() — 后处理（启发式清理、nudge、caveman）
    16. 估算 token 统计
```

### 1.3 规模

| 维度 | 数据 |
|------|------|
| 核心源文件 | 100+ |
| 核心代码行（不含测试/脚本） | ~50,365 |
| 最大文件 | transform.ts (1421 行) |
| SQLite 表 | 15+ |
| Pi 事件监听 | 7 个 |
| 注册工具 | 5+ (ctx_search, ctx_memory, ctx_note, ctx_expand, ctx_reduce) |
| 注册命令 | 6+ (/ctx-status, /ctx-flush, /ctx-recomp, /ctx-dream, /ctx-aug 等) |

---

## 2. SQLite Schema

### 核心表结构

```sql
-- Session 元数据
CREATE TABLE session_meta (
    session_id TEXT PRIMARY KEY,
    is_subagent INTEGER DEFAULT 0,
    cache_ttl TEXT,
    last_context_percentage REAL DEFAULT 0,
    last_input_tokens INTEGER DEFAULT 0,
    observed_safe_input_tokens INTEGER DEFAULT 0,
    cache_alert_sent INTEGER DEFAULT 0,
    compartment_in_progress INTEGER DEFAULT 0,
    cleared_reasoning_through_tag INTEGER DEFAULT 0,
    conversation_tokens INTEGER DEFAULT 0,
    tool_call_tokens INTEGER DEFAULT 0
    -- ... 更多字段
);

-- 标签系统 — 给每条消息分配一个递增编号
CREATE TABLE tags (
    session_id TEXT NOT NULL,
    tag_number INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT DEFAULT 'active',  -- active | dropped | truncated | source_restored
    source_contents TEXT,          -- 原始内容备份
    caveman_depth INTEGER DEFAULT 0,
    drop_reason TEXT,
    created_at INTEGER,
    PRIMARY KEY (session_id, tag_number)
);
CREATE INDEX idx_tags_dropped_session_tag_number ON tags(session_id, tag_number) WHERE status != 'active';

-- Compartment（分区摘要）
CREATE TABLE compartments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    start_message TEXT,            -- 起始消息 ID
    end_message TEXT,              -- 结束消息 ID
    summary TEXT NOT NULL,         -- LLM 生成的摘要
    tags TEXT,                     -- 标签 JSON 数组
    token_count INTEGER,
    created_at INTEGER,
    ordinal INTEGER                -- 排序序号
);

-- 记忆（跨 session 知识）
CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL,
    content TEXT NOT NULL,
    memory_type TEXT DEFAULT 'fact',  -- fact | preference | pattern
    embedding BLOB,                   -- 语义向量
    source_session_id TEXT,
    created_at INTEGER,
    updated_at INTEGER
);

-- FTS5 全文搜索
CREATE VIRTUAL TABLE memories_fts USING fts5(content, memories, content=memories, tokenize='porter');

-- Embedding 向量（语义搜索）
CREATE TABLE embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id INTEGER REFERENCES memories(id),
    vector BLOB,
    model TEXT,
    created_at INTEGER
);

-- Session 索引（消息元数据）
CREATE TABLE indexed_messages (
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    ordinal INTEGER,
    role TEXT,
    created_at INTEGER,
    PRIMARY KEY (session_id, message_id)
);
```

---

## 3. Forge 层详解（context event 管道）

### 3.1 hook.ts — 主入口

**核心函数**: `createMagicContextHook(deps: MagicContextDeps)`

**初始化流程**:

```
1. openDatabase() → SQLite 连接
2. isDatabasePersisted() → 安全检查，非持久化存储直接禁用
3. resolveProjectIdentity() → 解析项目路径
4. registerDreamProjectDirectory() → 注册 Dreamer 项目
5. checkCompactionMarkerConsistency() → 启动时一致性检查
6. rehydrate pending markers → 崩溃恢复
7. 创建各子系统实例:
   - nudgerWithRecentReduce (nudge 管理)
   - transform (Forge 管道)
   - eventHandler (事件分发)
   - commandHandler (命令处理)
   - systemPromptHash (cache 保护)
   - eventHook (事件钩子)
8. 返回 7 个事件处理器
```

**状态管理（闭包变量）**:

```typescript
// 跨 session 的缓存集合 — 三组独立的 cache-busting 信号
historyRefreshSessions: Set<string>          // 触发 injection cache 重建
deferredHistoryRefreshSessions: Set<string>  // 延迟重建（historian 完成后）
systemPromptRefreshSessions: Set<string>     // system prompt adjunct 刷新
pendingMaterializationSessions: Set<string>  // 挂起的 materialization
deferredMaterializationSessions: Set<string> // 延迟 materialization

// Per-session 状态
contextUsageMap: Map<string, {usage, updatedAt}>    // 上下文使用率
liveModelBySession: Map<string, {providerID, modelID}> // 活跃模型
variantBySession: Map<string, string>               // 模型变体
agentBySession: Map<string, string>                 // agent 类型
recentReduceBySession: Map<string, number>          // 最近 ctx_reduce 时间
toolUsageSinceUserTurn: Map<string, number>         // 用户 turn 后工具使用次数
lastHeuristicsTurnId: Map<string, string>           // 最后启发式 turn ID
```

### 3.2 event-handler.ts — 事件分发

处理 5 种事件类型：

| 事件 | 处理逻辑 |
|------|---------|
| `session.created` | 记录 session 元数据（是否 subagent、cache TTL） |
| `session.error` | 检测 context overflow → 设置 `needs_emergency_recovery` 标记 → 触发 Historian |
| `message.updated` | 更新上下文使用率 → 检测 Historian 触发条件 → 检查 compartment trigger |
| `message.removed` | 清理 tag/nudge/reasoning/compaction marker → 重建索引 |
| `session.deleted` | 清理所有 session 状态 → 删除 SQLite 数据 |
| `session.compacted` | 清理 compaction marker → 清除 pending 状态 → 重置 token 缓存 |

**核心逻辑 — compartment trigger**（在 `message.updated` 中）：

```
当上下文使用率超过阈值（默认 65%）时:
  1. 检查 historian failure state（如果 historian 连续失败，不重试）
  2. 清除低使用率下的 failure state（< 90% 时重置）
  3. 调用 checkCompartmentTrigger() 检查触发条件:
     - 上下文使用率超过 execute_threshold
     - 尾部工具输出超过 trigger_budget
     - commit cluster 触发
  4. 如果 shouldFire → 设置 compartmentInProgress = true
     → 下次 transform 时 Historian 将被启动
```

### 3.3 transform.ts — Forge 核心管道（1421 行）

**入口函数**: `createTransform(deps: TransformDeps) → async transform function`

**完整管道（16 步）**:

#### 步骤 1-6: 初始化与状态加载

```
1. findSessionId(messages) — 从消息中提取 sessionId
2. getOrCreateSessionMeta(db, sessionId) — 读取 session 元数据
   - 确定 reducedMode (subagent) vs fullFeatureMode
3. 模型变更检测:
   - 比较上次已知模型 vs 消息中最新模型
   - 如果模型切换 → 清除所有陈旧状态（percentage, tokens, overflow 等）
4. isFirstTransformPassForSession — 首次 pass 重置陈旧 percentage
5. loadContextUsage() — 加载上下文使用率
6. overflow 恢复检测:
   - 如果 needs_emergency_recovery → bump percentage 到 95%
   - 如果 historian 连续失败 > 0 且 percentage >= 95%:
     → abort 当前 session
     → 发送紧急通知
     → startRecoveryRun() 启动恢复 Historian
```

#### 步骤 7-8: Compartment 注入准备

```
7. prepareCompartmentInjection(db, sessionId, messages, isCacheBusting, ...):
   - 从 SQLite 读取 compartments（分区摘要）
   - 从 SQLite 读取 memories（项目记忆）
   - 按 token 预算筛选和排序
   - 构建 <session-history> XML 块
   - 缓存结果（避免每次 pass 重建）
   - isCacheBusting=true 时强制重建

8. historyRefreshSessions.drain():
   - 一次性消费 historyRefresh 信号
   - 后续 defer pass 使用缓存的 injection 结果
   - 保护 Anthropic prompt cache 前缀
```

#### 步骤 9-13: 消息处理管道

```
9. tagMessages(sessionId, messages, tagger, db):
   - tagger.initFromDb() — 从 SQLite 加载已有标签
   - 为每条新消息分配 §N§ 标签前缀（递增编号）
   - skipPrefixInjection: subagent 或 ctx_reduce_enabled=false 时不注入前缀
   - 返回 targets Map（tag_number → TagTarget）、reasoningByMessage 等

10. applyFlushedStatuses(sessionId, db, targets, tags):
    - 读取已持久化的 drop/truncate 操作
    - 在消息上执行这些操作
    - 恢复 source_contents（原始内容备份）

11. stripStructuralNoise(messages):
    - 移除工具调用中的结构噪音（XML 标签、空行等）

12. replayClearedReasoning(messages, reasoningByMessage, watermark):
    - 根据 persisted reasoning watermark 回放 reasoning 清除
    - 每次都执行（包括 defer pass），因为 OpenCode 每次从 DB 重建消息

13. replayCavemanCompression(targets, tags):
    - 回放 caveman 文本压缩
    - 只在 ctx_reduce_enabled=false 且非 subagent 时执行
```

#### 步骤 14: Compartment Phase（Historian 调度）

```
14. runCompartmentPhase():
    - 检查是否有活跃的 Historian subagent
    - 如果有 → await 其完成
    - 如果触发条件满足 → startCompartmentAgent()
    - 处理 compartment 完成后的回调:
      → deferredHistoryRefreshSessions.add()
      → deferredMaterializationSessions.add()
```

#### 步骤 15: 后处理

```
15. runPostTransformPhase():
    - 启发式清理（heuristic cleanup）
    - Nudge 注入
    - Caveman 文本压缩（深度加深）
    - Auto-search 提示
    - Deferred drain
```

#### 步骤 16: Token 估算

```
16. 遍历所有消息，估算 token:
    - conversationTokens: text + reasoning + thinking + images
    - toolCallTokens: tool_use + tool_result + tool-invocation
    - 缓存到 messageTokensBySession（LRU 100 sessions）
    - 写入 session_meta
```

---

## 4. Historian 层详解（后台压缩）

### 4.1 compartment-runner-historian.ts（585 行）

**触发条件**:
- 上下文使用率 > 65%（默认 execute_threshold_percentage）
- 非首次 pass（loadedSessions.has）
- 非正在运行中（getActiveCompartmentRun === undefined）
- 有足够的未压缩历史

**核心流程**:

```
startCompartmentAgent(deps):
  1. 标记 activeRun: activeCompartmentRuns.set(sessionId, abortController)
  2. 计算 historian chunk tokens:
     - historian model 的 context window × 0.6
     - 每个 chunk 不超过这个大小
  3. 将历史消息分割为 chunks
  4. 对每个 chunk 启动 subagent（独立 Pi 进程）:
     - 构建 system prompt（Historian agent）
     - 注入 chunk 消息
     - LLM 生成结构化摘要
  5. 收集摘要 → 合并为 compartment
  6. 写入 SQLite compartments 表
  7. 清理已压缩的 tag（status → dropped）
  8. 触发回调:
     → deferredHistoryRefreshSessions.add()
     → deferredMaterializationSessions.add()
```

**Historian Agent Prompt 设计**:

```
System: You are a Historian agent. Your job is to summarize conversation
history into structured compartments.

For each compartment, produce:
- A concise summary of what happened
- Key decisions made
- Important code changes
- Any unresolved issues

Format your output as:
<compartment tags="tag1,tag2">
  <summary>...</summary>
  <decisions>...</decisions>
  <changes>...</changes>
  <issues>...</issues>
</compartment>
```

### 4.2 compartment-runner-compressor.ts（798 行）

**定位**: Historian 的后处理压缩器，在 Historian 生成 compartment 后运行。

**核心算法**:

```
1. 检查冷却期（cooldown_ms，默认 5 分钟）
2. 计算合并可行性:
   - min_compartment_ratio: 最小 compartment 比例
   - max_merge_depth: 最大合并深度（1-5）
3. 对相邻的 compartment 尝试合并:
   - 如果合并后的摘要 token < 原始两个的 80% → 合并
   - 使用 LLM 重新生成合并摘要
4. 更新 SQLite 中的 compartments
```

---

## 5. Dreamer 层详解（规划器）

### dreamer/runner.ts（1381 行）

**触发条件**:
- 定时 cron 调度（通过 `dreamer.schedule` 配置）
- 手动 `/ctx-dream` 命令
- 每小时检查一次 schedule

**核心流程**:

```
1. checkScheduleAndEnqueue():
   - 解析 cron 表达式
   - 如果到了调度时间 → 将任务加入队列

2. processDreamQueue():
   - 从队列取任务
   - 启动 subagent（Dreamer agent）
   - 构建项目上下文 prompt:
     - 项目目录结构
     - 最近 session 摘要
     - 已有 memories
     - git log（最近提交）
   - LLM 分析后输出:
     - 新 memories（写入 memories 表）
     - 策略建议
     - key-files 识别（高频读取的文件）

3. postProcess():
   - 写入新 memories 到 SQLite
   - 更新 project embedding
   - 记录执行历史
```

**Dreamer 任务类型**:
- `analyze_patterns`: 分析代码模式和使用习惯
- `update_memories`: 更新项目记忆
- `pin_key_files`: 识别并 pin 高频文件
- `user_memories`: 提取用户偏好

---

## 6. Tagger 系统（消息标记与过滤）

### tagger.ts（713 行）

**核心接口**:

```typescript
interface Tagger {
    initFromDb(sessionId: string, db: ContextDatabase): void;
    assignTag(sessionId: string, messageId: string, role: string): number;
    cleanup(sessionId: string): void;
}
```

**标签分配算法**:

```
assignTag(sessionId, messageId, role):
  1. 检查内存缓存是否已分配 → 直接返回
  2. 检查 SQLite 是否已有此 messageId 的标签 → 加载到缓存
  3. 分配新标签:
     - nextTagNumber[sessionId]++
     - 写入 SQLite tags 表
     - 更新内存缓存
  4. 返回 tag_number
```

**标签前缀注入**:

```
tagMessages(sessionId, messages, tagger, db):
  对每条消息:
    1. tagger.initFromDb() — 从 DB 加载已有标签
    2. 对新消息调用 tagger.assignTag()
    3. 如果 ctxReduceEnabled:
       - 在消息的第一个 text part 前插入 §N§ 前缀
       - 例如: "§1§User asks about authentication"
    4. 如果 !ctxReduceEnabled:
       - 只记录标签到 DB，不注入前缀
       - 但 heuristic cleanup 仍然工作
```

**标签生命周期**:

```
§N§ (Normal) → active
    ↓ heuristic cleanup 清除
§D§ (Dropped) → 消息被标记为 dropped
    ↓ applyFlushedStatuses 执行
source_contents 备份 → 消息被替换为 [dropped]
    ↓ 下次 pass
replayClearedReasoning → 保持 dropped 状态
```

---

## 7. 搜索系统（FTS5 + Embedding）

### search.ts（651 行）

**双引擎搜索**:

```
1. FTS5 全文搜索:
   - 使用 SQLite FTS5 虚拟表
   - Porter stemmer 分词
   - BM25 排名
   - 搜索 memories 表的 content 字段

2. Embedding 语义搜索:
   - 使用 embedding 向量（512 维 ONNX 模型）
   - 余弦相似度排序
   - 支持 local / openai-compatible / off 三种模式
   - 向量存储在 embeddings 表

3. 混合搜索:
   - 合并 FTS5 + Embedding 结果
   - 按分数加权排序
   - score_threshold 过滤低质量结果
```

---

## 8. 记忆系统（跨 session 知识）

### memory/storage-memory.ts（639 行）

**Memory 类型**:

```typescript
interface Memory {
    id: number;
    projectPath: string;
    content: string;
    memoryType: "fact" | "preference" | "pattern";
    embedding?: Blob;
    sourceSessionId?: string;
    createdAt: number;
    updatedAt: number;
}
```

**写入流程**:

```
1. Historian/Dreamer 生成 memory 候选
2. 去重检查（embedding 相似度 > 0.95 → 更新而非创建）
3. 生成 embedding 向量
4. 写入 memories + memories_fts + embeddings 表
5. 如果 auto_promote=true → 自动提升 session facts 为 project memories
```

**注入流程**（在 transform.ts 步骤 7）:

```
1. 读取项目 memories
2. 按 injection_budget_tokens 筛选（默认 2000 tokens）
3. 排序（最近优先 + 相关度优先）
4. 注入到 <session-history> 的 <facts> 块中
5. 注入到 system prompt 的 adjunct 块中
```

---

## 9. Strip/Compressor（文本压缩算法）

### strip-content.ts（657 行）

**stripClearedReasoning(messages)**:

```
对每条 assistant 消息:
  1. 检查 tag_number 是否 <= persistedReasoningWatermark
  2. 如果是 → 将 reasoning/thinking part 替换为空 sentinel
     (Anthropic: "" string, 其他: "[cleared]" string)
  3. 保留 reasoning 的 signature（Anthropic 需要）
```

**stripReasoningFromMergedAssistants(messages)**:

```
当两条 assistant 消息合并后:
  1. 检测 liveProviderID === "anthropic"
  2. 如果是 → 清除第二条消息的 reasoning
     (Anthropic 的 groupIntoBlocks 要求 thinking 在 index 0)
  3. 其他 provider 不清除
```

### Caveman 压缩（基于年龄的文本压缩）

```
核心思路：越旧的内容压缩越狠

caveman_depth = 0: 原始文本
caveman_depth = 1: 保留首尾段，中间省略
caveman_depth = 2: 只保留关键行（import/export/function signature）
caveman_depth = 3: 替换为 [compressed, N chars, depth 3]

每次 heuristic cleanup 可以将 depth +1
只对 age > auto_drop_tool_age (默认 100) 的标签执行
```

---

## 10. Prompt Cache 保护机制

### system-prompt-hash.ts（512 行）

**问题**: Anthropic 的 prompt cache 依赖 system prompt 前缀不变。如果每次 transform 都修改 system prompt（注入 compartment/memory），会破坏 cache，导致每次请求都重新计算 cache prefix，增加成本和延迟。

**解决方案**:

```
1. 计算 system prompt 的 SHA256 hash
2. 缓存注入结果（compartment + memory + key files）
3. 只有当 hash 变化时才重新注入
4. 使用三组独立的 cache-busting 信号:
   - historyRefreshSessions: 触发 injection cache 重建
   - systemPromptRefreshSessions: 触发 system prompt adjunct 刷新
   - pendingMaterializationSessions: 触发 pending 操作执行

5. Defer pass 策略:
   - 当没有 cache-busting 信号时 → 使用缓存的 injection
   - 当有信号时 → 重建 injection + drain 信号
   - 后续 pass 继续使用缓存 → 保护 prompt cache
```

---

## 11. 配置系统

### 核心配置项（magic-context.jsonc）

```typescript
interface MagicContextConfig {
    // 基础
    protected_tags: number;           // 保护的最近 N 个标签（默认 5）
    ctx_reduce_enabled?: boolean;     // 是否启用 agent 驱动的 ctx_reduce
    nudge_interval_tokens?: number;   // nudge 间隔 token 数
    auto_drop_tool_age?: number;      // 自动 drop 的工具年龄（默认 100）
    drop_tool_structure?: boolean;    // 是否 drop 工具结构
    clear_reasoning_age?: number;     // 清除 reasoning 的年龄（默认 50）
    execute_threshold_percentage?: number | { default: number; [modelKey: string]: number };
    cache_ttl: string | Record<string, string>;

    // Historian
    historian?: {
        model?: string;               // Historian 使用的模型
        fallback_models?: string[];   // fallback 模型链
        two_pass?: boolean;           // 是否启用二次编辑 pass
        disable?: boolean;            // 禁用 Historian
    };
    history_budget_percentage?: number;
    historian_timeout_ms?: number;

    // Memory
    memory?: {
        enabled: boolean;
        injection_budget_tokens: number;
        auto_promote?: boolean;       // 自动提升 session facts
    };

    // Embedding
    embedding?: {
        provider?: "local" | "openai-compatible" | "off";
    };

    // Dreamer
    dreamer?: {
        schedule?: string;            // cron 表达式
        tasks?: string[];             // 任务类型
        task_timeout_minutes?: number;
        max_runtime_minutes?: number;
        user_memories?: { enabled: boolean; promotion_threshold: number };
        pin_key_files?: { enabled: boolean; token_budget: number; min_reads: number };
        inject_docs?: boolean;
        fallback_models?: string[];
        disable?: boolean;
    };

    // Compressor
    compressor?: {
        enabled: boolean;
        min_compartment_ratio: number;
        max_merge_depth: number;
        cooldown_ms: number;
    };

    // Experimental
    experimental?: {
        temporal_awareness?: boolean;
        git_commit_indexing?: { enabled: boolean; since_days: number; max_commits: number };
        auto_search?: { enabled: boolean; score_threshold: number; min_prompt_chars: number };
        caveman_text_compression?: { enabled: boolean; min_chars: number };
    };
}
```

---

## 12. 模块依赖关系

```
hook.ts (入口)
├── transform.ts (Forge 管道)
│   ├── tagger.ts (消息标记)
│   ├── transform-operations.ts (tagMessages, applyFlushedStatuses, stripStructuralNoise)
│   ├── strip-content.ts (reasoning 清除、caveman 回放)
│   ├── compartment-runner.ts → compartment-runner-historian.ts (Historian)
│   │   └── compartment-runner-compressor.ts (压缩器)
│   ├── transform-compartment-phase.ts (compartment 阶段调度)
│   ├── transform-postprocess-phase.ts (后处理)
│   │   ├── heuristic-cleanup.ts (启发式清理)
│   │   ├── nudger.ts (nudge 注入)
│   │   └── caveman-cleanup.ts (caveman 压缩)
│   ├── inject-compartments.ts (compartment 注入)
│   ├── temporal-awareness.ts (时间标记)
│   ├── read-session-chunk.ts (session 消息读取)
│   └── search.ts (自动搜索提示)
├── event-handler.ts (事件分发)
│   ├── storage.ts → storage-db.ts (SQLite)
│   ├── storage-tags.ts (标签 CRUD)
│   ├── storage-meta-persisted.ts (持久化 meta)
│   ├── overflow-detection.ts (overflow 检测)
│   └── compartment-trigger.ts (compartment 触发)
├── system-prompt-hash.ts (Prompt Cache 保护)
├── dreamer/runner.ts (Dreamer)
│   ├── memory/storage-memory.ts (记忆存储)
│   ├── memory/project-identity.ts (项目标识)
│   └── key-files/identify-key-files.ts (关键文件识别)
└── command-handler.ts (命令处理)
```

---

## 13. 关键设计决策

### 决策 1: SQLite vs Pi Entry 系统

**选择**: SQLite
**理由**:
- Entry 系统（`pi.appendEntry`）是追加写入的 JSONL，不支持复杂查询（FTS5、embedding、tag 过滤）
- SQLite 支持事务、索引、全文搜索、向量搜索
- 跨 session 持久化更可靠（Entry 可被 GC 清理）

**代价**:
- 引入外部依赖（better-sqlite3）
- 需要 migration 系统
- 两个持久化系统（Pi Entry + SQLite）需要保持一致性

### 决策 2: 三组独立的 Cache-busting 信号

**问题**: Anthropic prompt cache 依赖 system prompt 前缀不变。如果每次 transform 都修改注入内容，会破坏 cache。

**方案**: 使用三组独立的 Set 信号：
1. `historyRefreshSessions` — 触发 injection cache 重建
2. `systemPromptRefreshSessions` — 触发 system prompt adjunct 刷新
3. `pendingMaterializationSessions` — 触发 pending 操作执行

每组信号有独立的 drain 时机，避免不必要的 cache 重建。

### 决策 3: Historian 作为 Subagent 进程

**选择**: 独立 Pi 进程（而非主进程内调用 LLM）
**理由**:
- 压缩是 CPU/LLM 密集型操作，不阻塞主 agent
- 可以使用不同的模型（便宜模型做压缩）
- 可以设置 timeout（避免压缩卡住整个 session）

### 决策 4: Tag 系统而非扁平消息列表

**选择**: 给每条消息分配 §N§ 递增标签
**理由**:
- 标签提供跨 pass 的稳定引用（消息 ID 可能因 compact 而变化）
- 标签编号可排序，支持 range 查询
- 标签状态可持久化到 SQLite（active/dropped/truncated）
- Agent 可以通过 `ctx_reduce` 工具操作标签

### 决策 5: Subagent 特殊处理

**选择**: Subagent session 走 reduced 模式
**理由**:
- Subagent 的上下文由主 agent 管理，不需要独立压缩
- Subagent 不能运行 Historian/Dreamer
- 但仍然记录 tag 和 token 统计（供主 agent 参考）

---

## 14. 精华提炼：最值得借鉴的设计

### ① 三组 Cache-busting 信号 — 精细的 Cache 保护

**问题**: 注入内容变化会破坏 Anthropic prompt cache。
**设计**: 三组独立信号，每组有独立 drain 时机，最小化 cache 重建。

**借鉴价值**: context-engineering 如果未来需要注入提示（如 nudge），应参考此设计，避免破坏 prompt cache。

### ② Tag 系统 — 跨 Pass 的稳定引用

**问题**: 消息 ID 可能因 compact 而变化，无法跨 pass 稳定引用。
**设计**: §N§ 递增标签 + SQLite 持久化状态。

**借鉴价值**: context-engineering 的 recall ID 是 UUID 前缀。改为递增短 ID + 持久化状态会更好。

### ③ Prompt Cache Hash 检测 — 避免不必要的注入

**设计**: 计算 system prompt SHA256 hash，只在 hash 变化时重新注入。

**借鉴价值**: 任何涉及 system prompt 注入的扩展都应该做 hash 检测。

### ④ Overflow 恢复机制 — 弹性应对 Context Overflow

**设计**:
1. `session.error` 中检测 overflow 模式
2. 设置 `needs_emergency_recovery` 标记
3. 下次 transform bump percentage 到 95%
4. 触发紧急 Historian + abort session
5. 通知用户

**借鉴价值**: context-engineering 的 L2 只做强制过期，没有 overflow 恢复。加入 overflow 检测 + 自动恢复会大幅提升可靠性。

### ⑤ Model 变更检测 — 处理模型切换

**设计**: 检测 provider/model 切换，清除所有陈旧状态（percentage, tokens, overflow 等）。

**借鉴价值**: 用户切换模型时，旧的上下文使用率数据是错误的。清除后重新计算。

---

## 15. 复杂度评估与风险

### 代码复杂度

| 维度 | 评分 | 说明 |
|------|------|------|
| 可读性 | ★★☆☆☆ | 50K+ 行，理解成本极高。hook.ts 的闭包变量超过 20 个 |
| 健壮性 | ★★★★☆ | SQLite 事务、migration 系统、完整的 overflow 恢复 |
| 可测试性 | ★★★☆☆ | 有 40+ 测试文件，但 mock 层复杂 |
| 可维护性 | ★★☆☆☆ | 每次 Pi/OpenCode API 变更都有回归风险 |
| 类型安全 | ★★★★☆ | 有完整的 TypeScript 类型 |

### 关键风险

1. **API 耦合风险**: 大量依赖 OpenCode 的内部 API（session.get、message 格式等），这些 API 没有稳定性保证
2. **SQLite 一致性风险**: context.db 和 opencode.db 是两个独立的 SQLite，没有跨 DB 事务。崩溃可能导致不一致
3. **复杂度风险**: 三组 cache-busting 信号 + deferred drain + emergency recovery + model change detection，交互路径极多
4. **性能风险**: 每次 transform 都要读 SQLite 多次（active tags、session meta、compartments）。50K+ tag 的 session 可能很慢
5. **维护者依赖**: 这个项目基本只有 1-2 个核心开发者，bus factor 很低

### 结论

magic-context 是一个**工程奇迹但过度工程**的项目。它解决了几乎所有上下文管理问题，但代价是 50K 行代码和极高的理解成本。

对于个人开发者来说，**借鉴其设计思想比直接使用或 fork 更有价值**。具体来说：
- Prompt cache 保护机制 — 直接可以移植
- Tag 系统 — 简化版可以移植（不需要 SQLite，用 Pi entry 即可）
- Overflow 恢复 — 概念可以移植
- 但不要试图复制其三层架构或 SQLite 持久化

---

## 附录 A：存储层精确 Schema（源码验证）

> 以下内容基于 `storage-db.ts`、`storage-tags.ts`、`compartment-storage.ts` 完整源码分析，修正了主文中基于部分推断的 Schema。

### tags 表（精确）

```sql
CREATE TABLE tags (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id         TEXT,
  message_id         TEXT,                    -- 关联的消息/调用ID
  type               TEXT,                    -- 'message' | 'tool' | 'file'
  status             TEXT DEFAULT 'active',   -- 'active' | 'dropped' | 'compacted'
  byte_size          INTEGER,
  reasoning_byte_size INTEGER DEFAULT 0,
  tag_number         INTEGER,                 -- §N§ 编号
  harness            TEXT NOT NULL DEFAULT 'opencode',
  drop_mode          TEXT DEFAULT 'full',     -- 'full' | 'truncated'
  tool_name          TEXT,
  input_byte_size    INTEGER DEFAULT 0,
  caveman_depth      INTEGER DEFAULT 0,       -- 压缩深度 0-3
  tool_owner_message_id TEXT DEFAULT NULL,     -- v10: 工具所属 assistant 消息 ID
  UNIQUE(session_id, tag_number)
);
-- v8 部分索引（热路径优化 110×）
CREATE INDEX idx_tags_active_session_tag_number ON tags(session_id, tag_number) WHERE status = 'active';
CREATE INDEX idx_tags_dropped_session_tag_number ON tags(session_id, tag_number) WHERE status = 'dropped';
-- v10 tool-owner 复合索引
CREATE UNIQUE INDEX idx_tags_tool_composite ON tags(session_id, message_id, tool_owner_message_id)
    WHERE type = 'tool' AND tool_owner_message_id IS NOT NULL;
```

**重要澄清**：代码库中 **只有 §N§ 一种标签**，不存在 §S§/§D§/§P§。状态通过 `status` 字段（`active`/`dropped`/`compacted`）管理，不在前缀中体现。

**Tool-owner 三元组**（v10 修复）：不同轮次可能产生相同 callID（如 `read:32`），所以身份由 `(session_id, message_id/callID, tool_owner_message_id)` 三元组唯一确定。

### compartments 表（精确）

```sql
CREATE TABLE compartments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       TEXT NOT NULL,
  sequence         INTEGER NOT NULL,          -- 区间序号
  start_message    INTEGER NOT NULL,          -- 起始消息序号
  end_message      INTEGER NOT NULL,
  start_message_id TEXT DEFAULT '',
  end_message_id   TEXT DEFAULT '',
  title            TEXT NOT NULL,
  content          TEXT NOT NULL,             -- LLM 生成的摘要内容
  created_at       INTEGER NOT NULL,
  harness          TEXT NOT NULL DEFAULT 'opencode',
  UNIQUE(session_id, sequence)
);
```

### memories 表（精确）

```sql
-- 完整字段列表（21 个 migration 演化后的最终形态）
CREATE TABLE memories (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path            TEXT NOT NULL,
  category                TEXT NOT NULL,          -- 9 种分类
  content                 TEXT NOT NULL,
  normalized_hash         TEXT,                   -- 内容去重
  source_session_id       TEXT,
  source_type             TEXT,                   -- historian | agent | dreamer | user
  seen_count              INTEGER DEFAULT 0,
  retrieval_count         INTEGER DEFAULT 0,
  first_seen_at           INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  last_seen_at            INTEGER,
  last_retrieved_at       INTEGER,
  status                  TEXT DEFAULT 'active',  -- active | permanent | archived
  expires_at              INTEGER,                -- NULL = 永不过期
  verification_status     TEXT DEFAULT 'unverified',  -- unverified | verified | stale | flagged
  verified_at             INTEGER,
  superseded_by_memory_id INTEGER,
  merged_from             TEXT,                   -- JSON array of merged memory IDs
  metadata_json           TEXT
);
-- FTS5 触发器自动同步
CREATE VIRTUAL TABLE memories_fts USING fts5(content, category, content=memories, tokenize='porter');
```

### Migration 系统

共 21 个版本化 migration，通过 `schema_migrations` 表追踪。核心策略：
- **Fail-closed**：数据库打开失败直接抛错，不降级为内存 DB
- **幂等 ensureColumn**：`PRAGMA table_info` 检查后 `ALTER TABLE ADD COLUMN`
- **并发安全**：`isSiblingMigrationConflict()` 检测多进程竞态
- **NULL 列 healing**：SQLite `ALTER TABLE ADD COLUMN` 不回填默认值，需显式 UPDATE

---

## 附录 B：搜索系统精确实现（源码验证）

### unifiedSearch 三源合并算法

1. 提前发起 query embedding（`Promise.resolve()` 让出事件循环）
2. 同步执行 message FTS（不依赖 embedding）
3. 等待 embedding 完成
4. 并行执行 memory + git-commit 搜索（共用 queryEmbedding）
5. Memory 搜索走混合路径：FTS5 + cosine similarity，合并公式 `0.7*semantic + 0.3*fts`
6. 统一排序：`score * sourceBoost`，boost 权重 memory=1.3, git_commit=1.2, message=1.15
7. 截断到 limit（默认 10），更新 retrieval_count

**Memory FTS SQL**：`SELECT ... FROM memories_fts INNER JOIN memories ON memories.id = memories_fts.rowid WHERE memories.project_path = ? AND memories.status IN ('active','permanent') AND (memories.expires_at IS NULL OR memories.expires_at > ?) AND memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT 50`

**Message FTS SQL**：`SELECT ... FROM message_history_fts WHERE session_id = ? AND message_history_fts MATCH ? ORDER BY bm25(message_history_fts) LIMIT ?`

**FTS 查询清理**：每个 token 用双引号包裹（防注入）。

---

## 附录 C：Tagger 精确实现（源码验证）

### 标签分配算法 — allocateTag（核心共享逻辑）

1. 内存 Map 快查：`assignments[sessionId][mapKey]` 命中则直接返回
2. DB 快查：`SELECT tag_number FROM tags WHERE session_id=? AND message_id=? AND type=?`
3. DB 命中则加载到内存，`UPSERT session_meta SET counter = MAX(counter, found)` 同步计数器
4. 新分配：`next = max(memCounter, dbMaxTag) + 1`，INSERT INTO tags + UPSERT session_meta
5. UNIQUE 约束冲突重试（最多 5 次）：区分「已被分配」和「计数器竞态」

### Tool 标签特殊路径 — Lazy Adoption

v10 之前创建的 tag 行没有 `tool_owner_message_id`。新版查找流程：

1. 复合键快查：`SELECT tag_number FROM tags WHERE session_id=? AND message_id=callId AND tool_owner_message_id=ownerMsgId`
2. 未命中 → 查找孤儿行：`SELECT id, tag_number FROM tags WHERE session_id=? AND message_id=callId AND tool_owner_message_id IS NULL`
3. 找到孤儿 → CAS 收养：`UPDATE tags SET tool_owner_message_id=ownerMsgId WHERE id=orphanId AND tool_owner_message_id IS NULL`
4. CAS 失败（另一个进程已收养）→ 重查
5. 无孤儿 → 走标准 allocateTag 新建

### DB 缓存刷新 — initFromDb

两个探针避免全量扫描：`PRAGMA data_version` + `SELECT total_changes()`，匹配时跳过（~0.005ms vs ~15ms）。

NULL-owner 行故意不放入内存缓存，留给 lazy adoption 机制处理。

---

## 附录 D：本地 Embedding 实现（源码验证）

### LocalEmbeddingProvider

- 使用 `@huggingface/transformers` 的 `feature-extraction` pipeline
- ONNX Runtime 推理（fp32 精度）
- 跨进程文件锁（`.load.lock`）防止多进程并发加载模型导致 SIGBUS
- Electron 特殊处理：注入 `onnxruntime-web` (WASM) 替代 `onnxruntime-node` (native)
- 3 次重试 + 抖动退避处理瞬态加载错误
- 优雅销毁：等 `inFlight` 计数器归零后再 dispose pipeline

### 三种 Embedding 策略

| 配置 | Provider | 推理方式 |
|------|----------|---------|
| `provider: "local"` | LocalEmbeddingProvider | 本地 ONNX 推理 |
| `provider: "openai-compatible"` | OpenAICompatibleEmbeddingProvider | HTTP API 调用 |
| `provider: "off"` | null | 禁用，搜索退化为纯 FTS |
