# Compact 触发流程分析

## 事件时序（一个 Turn 内）

```
agent-loop 内部时序:
  ┌─ agent_start
  │   ┌─ turn_start
  │   │   ┌─ context 事件（transformContext）── 扩展组装 messages
  │   │   ├── LLM 调用
  │   │   ├── tool 调用 + toolResult
  │   │   └─ turn_end 事件 ────────────────── 扩展记录 turn
  │   └─ (可能多轮 turn: turn_start → context → LLM → turn_end)
  └─ agent_end ──────────────────────────── Pi 调用 _checkCompaction()
```

**关键时序**：
- `context` 在每个 **LLM 调用前** 触发（`streamAssistantResponse` 内）
- `turn_end` 在 LLM 响应 + tool 执行后触发
- `agent_end` 在所有 turn 结束后触发
- `_checkCompaction()` 在 `agent_end` 后被调用

**两套压缩的触发点**：
| 机制 | 触发点 | 判断条件 | 执行方式 |
|------|--------|---------|---------|
| Pi 原生 compact | `agent_end` → `_checkCompaction()` | `usage.totalTokens > contextWindow - reserveTokens` | 同步 await |
| Tree-compact | `turn_end` 检查 `needsCompressionRef` | `context` 事件中 `shouldCompress` 设置 flag | fire-and-forget `void compressAsync()` |

---

## 场景 A：首次超过阈值（tree 不存在，异步压缩未完成）

```
时间线 ──────────────────────────────────────────────────────────────────►

Turn N（上下文膨胀到 180K/200K）
  │
  ├─ context 事件
  │   ├─ assembleMessages（无 tree，原样返回）
  │   ├─ treeContextTokens ≈ 180K
  │   ├─ shouldCompress(180K, 200K) → 0.9 ≥ 0.7 → true
  │   └─ needsCompressionRef = true    ◄── 设 flag
  │
  ├─ LLM 调用（返回 assistant + usage=180K）
  │
  ├─ turn_end 事件
  │   ├─ tracker.handleTurnEnd(...)
  │   ├─ needsCompressionRef = true → 重置为 false
  │   └─ void compressAsync(...)      ◄── 异步启动，不等待
  │       │
  │       └─[后台] spawn pi --mode json ...（需要 ~30s）
  │
  └─ agent_end 事件
      └─ _handlePostAgentRun()
          └─ _checkCompaction(lastAssistant)
              ├─ calculateContextTokens(usage) = 180K
              ├─ shouldCompact(180K, 200K, settings) → true
              │   （reserveTokens 默认 16384，200K-16K=184K，180K < 184K）
              │   ⚠️ 实际可能不触发！取决于 reserveTokens 和 contextWindow
              │
              └─ 如果触发 → _runAutoCompaction("threshold")
                  ├─ session_before_compact 事件
                  │   └─ compactor.getTree() → undefined  ◄── 异步压缩还没完成
                  │       → { cancel: false }
                  │
                  ├─ Pi 原生 compact 正常执行 ✅
                  ├─ 写入 compaction entry ✅
                  └─ this.agent.state.messages 更新 ✅
```

**结果**：Pi 原生 compact 正常执行，写入 entry。
**问题**：同时 tree-compact 在后台也跑。两套压缩同时运行。下次 `context` 事件时 tree 可能已存在，但 Pi 原生 compact 的 compaction summary 也在 messages 里。

---

## 场景 B：首次超过阈值（异步压缩先完成，tree 已存在）

```
Turn N
  │
  ├─ context → needsCompressionRef = true
  ├─ LLM 调用
  ├─ turn_end → void compressAsync(...)
  │       │
  │       └─[后台] 快速完成（fallback）→ tree 存在了 ✅
  │
  └─ agent_end → _checkCompaction(lastAssistant)
      ├─ shouldCompact → true
      └─ _runAutoCompaction("threshold")
          ├─ session_before_compact
          │   └─ compactor.getTree() → 已存在 ⚡
          │       → { cancel: true }
          │
          ├─ ❌ Pi 原生 compact 被取消
          ├─ ❌ 不写入 compaction entry
          └─ ❌ 不更新 this.agent.state.messages
```

**结果**：Pi 原生 compact 被取消，**没有 compaction entry**。
**后果**：见场景 D（下次 prompt 时重复触发）。

---

## 场景 C：Tree 已存在，新一轮对话超过阈值（常见场景）

```
Turn N（tree 存在，但新消息使上下文再次膨胀）
  │
  ├─ context 事件
  │   ├─ assembleMessages（有 tree，注入摘要 + 新消息）
  │   ├─ treeContextTokens ≈ 150K（摘要 + 新消息仍然很多）
  │   ├─ shouldCompress(150K, 200K) → 0.75 ≥ 0.7 → true
  │   └─ needsCompressionRef = true
  │
  ├─ LLM 调用（返回 usage=150K）
  │
  ├─ turn_end → void compressAsync(...)  ◄── 异步重建 tree
  │
  └─ agent_end → _checkCompaction(lastAssistant)
      ├─ calculateContextTokens(usage) = 150K
      ├─ shouldCompact(150K, 200K, settings) → true
      │
      ├─ 检查 assistantIsFromBeforeCompaction:
      │   ├─ getLatestCompactionEntry() → 上次场景 A 写入的 entry（如果有）
      │   ├─ lastAssistant.timestamp > compactionEntry.timestamp → false
      │   └─ 不跳过，继续检查
      │
      └─ _runAutoCompaction("threshold")
          ├─ session_before_compact
          │   └─ compactor.getTree() → 存在 ⚡
          │       → { cancel: true }
          │
          ├─ ❌ 不写入 compaction entry
          └─ ❌ 返回 false
```

**结果**：每次超过阈值都会被 cancel，永远不写 compaction entry。

---

## 场景 D：下次 prompt 重复触发（场景 B/C 的后果）⚠️ 核心问题

```
用户发送下一条消息 → prompt()
  │
  ├─ _checkCompaction(lastAssistant, skipAbortedCheck=false)
  │   │
  │   │  lastAssistant 还是场景 B/C 中那个（usage=150K/180K）
  │   │
  │   ├─ compactionEntry = getLatestCompactionEntry()
  │   │   └─ 取决于之前是否有 entry：
  │   │       场景 A 后 → 有 entry → 可能被保护 ✅
  │   │       场景 B/C 后 → 无 entry → 无保护 ❌
  │   │
  │   ├─ 如果无保护：
  │   │   ├─ shouldCompact(150K, ...) → true（usage 不变）
  │   │   └─ _runAutoCompaction("threshold")
  │   │       ├─ session_before_compact → tree 存在 → { cancel: true }
  │   │       ├─ ❌ 不写 entry
  │   │       └─ 返回 false
  │   │
  │   └─ 继续发送 prompt
  │
  ├─ agent_start
  ├─ turn_start
  ├─ context 事件
  │   ├─ assembleMessages（用新 tree，token 可能很低 ~600）
  │   ├─ treeContextTokens ≈ 600
  │   ├─ shouldCompress(600, 200K) → 0.003 < 0.7 → false ✅
  │   └─ needsCompressionRef = false  ◄── 正确
  │
  ├─ LLM 调用（新上下文只有 600 token，usage 会很小）
  │
  ├─ turn_end → needsCompressionRef = false → 不触发 ✅
  │
  └─ agent_end → _checkCompaction(newAssistant)
      ├─ calculateContextTokens(newUsage) ≈ 几千 → false ✅
      └─ 正常结束
```

**结论**：场景 D 中，`prompt` 中的 `_checkCompaction` 会多触发一次 cancel，
但后续 `context` 事件中 `shouldCompress` 不会重置 flag，
所以 tree-compact 不会被重复触发。

**实际问题是**：
1. 每次新 prompt 都会先触发一次无用的 `_runAutoCompaction` → `cancel` 循环
2. 如果场景 B（首次、tree 快速完成），之后**每次 prompt 都会**触发这个 cancel 循环

---

## 场景 E：连续多轮对话，反复膨胀（完整的退化路径）

```
Turn 1: 正常对话，tree 不存在
Turn 2: 正常对话
...
Turn N: 上下文超过阈值
  ├─ context → needsCompressionRef = true
  ├─ LLM 调用（usage=180K）
  ├─ turn_end → void compressAsync() [后台]
  └─ agent_end → _checkCompaction()
      ├─ tree 不存在（异步未完成）→ {cancel: false}
      └─ Pi 原生 compact 执行 ✅ → 写入 entry

  [后台] compressAsync 完成 → tree 创建 ✅

Turn N+1: 用户发消息
  ├─ prompt → _checkCompaction(lastAssistant)
  │   ├─ 有 compaction entry → timestamp 保护 ✅
  │   └─ 跳过 ✅
  ├─ context → assembleMessages（有 tree，token 很低）→ shouldCompress = false
  └─ 正常对话 ✅

... 继续对话，上下文再次膨胀 ...

Turn M: 上下文再次超过阈值（tree 已存在）
  ├─ context → shouldCompress = true → needsCompressionRef = true
  ├─ LLM 调用（usage=160K）
  ├─ turn_end → void compressAsync() [后台重建 tree]
  └─ agent_end → _checkCompaction()
      ├─ tree 存在 → {cancel: true} ❌
      └─ 不写 entry ❌

Turn M+1: 用户发消息 ⚠️
  ├─ prompt → _checkCompaction(lastAssistant)
  │   ├─ lastAssistant.usage = 160K（Turn M 的旧 usage）
  │   ├─ getLatestCompactionEntry() → Turn N 的 entry
  │   ├─ lastAssistant.timestamp > Turn N entry.timestamp
  │   ├─ assistantIsFromBeforeCompaction = false ❌
  │   ├─ shouldCompact(160K) = true
  │   └─ _runAutoCompaction → {cancel: true} → 不写 entry ❌
  │
  ├─ context → shouldCompress = false（新 tree 已生效）✅
  └─ 正常对话

Turn M+2: 用户发消息 ⚠️
  ├─ prompt → _checkCompaction(lastAssistant)
  │   ├─ lastAssistant.usage 是 M+1 的 usage（已经很小了）
  │   └─ shouldCompact → false ✅
  └─ 正常 ✅
```

---

## 问题总结

```
┌──────────────────────────────────────────────────────────────────┐
│                     问题 1：Cancel 无副作用                       │
│                                                                  │
│  session_before_compact 返回 {cancel: true} 时：                 │
│  - Pi 不写入 compaction entry                                    │
│  - Pi 不更新 agent.state.messages                                │
│  - _checkCompaction 的 timestamp 保护机制失效                     │
│  → 下次 prompt 会重复触发 → 再次 cancel → 无限循环（仅一次）      │
│                                                                  │
│  影响：每轮新 prompt 开始时多一次无用的 _runAutoCompaction 调用    │
├──────────────────────────────────────────────────────────────────┤
│                     问题 2：两套压缩竞争                          │
│                                                                  │
│  首次超过阈值时：                                                 │
│  - tree-compact 在 turn_end 异步启动（fire-and-forget）          │
│  - Pi 原生 compact 在 agent_end 同步执行                         │
│  - 如果 tree-compact 先完成 → Pi 被取消 → 无 entry              │
│  - 如果 tree-compact 未完成 → Pi 正常执行 → 但 tree-compact      │
│    也在后台跑 → 两套压缩同时运行                                 │
│                                                                  │
│  影响：不确定性，依赖异步时序                                     │
├──────────────────────────────────────────────────────────────────┤
│                     问题 3：异步不阻塞对话流                      │
│                                                                  │
│  compressAsync 是 void（fire-and-forget）：                      │
│  - turn_end 不等待压缩完成                                       │
│  - 下一个 context 事件可能在 tree 更新前触发                      │
│  - assembleMessages 用旧 tree（或无 tree）→ 压缩未生效           │
│                                                                  │
│  影响：压缩和对话流不同步                                         │
└──────────────────────────────────────────────────────────────────┘
```

## 当前触发逻辑对比

| | Pi 原生 Compact | Tree-Compact |
|---|---|---|
| **触发判断** | `_checkCompaction`：`assistant.usage.totalTokens > ctxWindow - reserve` | `context` 事件：`treeTokens / ctxWindow ≥ 0.7` |
| **触发时机** | `agent_end` 后同步检查 | `turn_end` 中异步执行 |
| **执行方式** | 同步 await（阻塞对话直到完成） | fire-and-forget（不阻塞） |
| **compaction entry** | 正常执行时写入；被 cancel 时不写入 | 不写入（只写 ic-compact-tree custom entry） |
| **防重入** | 依赖 compaction entry timestamp | 依赖 needsCompressionRef flag（每轮重置） |
| **协调** | 通过 session_before_compact → {cancel} | 无协调，独立运行 |
