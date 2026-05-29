# 无限上下文引擎 — 范围划定讨论稿

> 整合现有调研结果，基于 Pi 真实 API 能力，划定可实施范围。

---

## 一、关键事实（已验证）

### 1.1 Pi 已有的 API 能力

| API | 能力 | 来源 |
|-----|------|------|
| `pi.on("context", handler)` | 每次 LLM 调用前触发，handler 可增删改全部 `messages` 数组 | `agent-loop.ts:284` → `runner.emitContext()` |
| `pi.on("session_before_compact")` | 可取消/替换 Pi 原生 compaction | `compaction.ts` → `runner.emit()` |
| `pi.on("turn_end")` | 每轮结束后触发 | 扩展事件 |
| `pi.on("before_agent_start")` | agent 开始前注入 steering 消息 | 扩展事件 |
| `ctx.getContextUsage()` | 返回 `{ tokens, contextWindow, percent }` | SDK |
| `ctx.compact(options)` | 编程式触发 compaction | SDK |
| `pi.appendEntry(type, data)` | 持久化自定义状态到 session JSONL | SDK |
| `ctx.sessionManager.getEntries()` | 读取当前分支的所有 entries | SDK |

**结论：不需要任何 Pi 核心改动。** `context` 事件是核心杠杆——每次 LLM 调用前，扩展可以自由重组发给 LLM 的消息。

### 1.2 关键约束（源码验证）

| 约束 | 说明 | 影响 |
|------|------|------|
| **AgentMessage 不携带 entryId** | `buildSessionContext()` 将 entries 转为 messages 时，丢弃了 `id`/`parentId` 等 entry 元数据 | context handler 无法直接定位"这条 message 对应哪个 entry" |
| **context handler 不影响持久化** | handler 只影响本次 LLM 调用发送的内容，不改变磁盘上的 session JSONL | 符合"保留原始、加工替换"的诉求 |
| **CompactionSummaryMessage 是 1:N 聚合** | 一个 compaction entry 将多条历史 entry 压缩为一条 summary message | 需要和我们的 L1 压缩协调 |
| **多扩展链式调用** | 多个扩展的 context handler 按注册顺序链式执行 | 我们的 handler 不能假设 messages 数组是原始状态 |

### 1.3 Entry → Message 映射规则

| Entry 类型 | 产出 Message | 映射 |
|------------|-------------|------|
| `message` (SessionMessageEntry) | 直接复用 `entry.message` | 1:1 |
| `custom_message` | `CustomMessage` | 1:1 |
| `branch_summary` | `BranchSummaryMessage` | 1:1 |
| `compaction` | `CompactionSummaryMessage` | 1:N（聚合） |
| `model_change` / `custom` / `label` 等 | 无 message | 跳过 |

---

## 二、核心诉求确认

1. **原始上下文全量保留** — session JSONL 不动，context handler 只改"发给 LLM 的内容"
2. **需要对话 ID 定位** — 压缩替换时，需要知道"这条 message 对应哪个原始 entry"，以便 recall 时找回
3. **自动化的上下文管理** — 不依赖用户手动 `/compact`，系统自动在 context handler 中完成压缩

---

## 三、ID 定位问题（核心设计挑战）

AgentMessage 不携带 entryId。要在 context handler 中做"定位+替换"，有以下方案：

### 方案 A：扩展自建映射表（推荐）

**思路**：扩展通过 `turn_end` 事件监听每一轮的工具调用，自建一个 `turnIndex → entryId` 的映射表，持久化到 `pi.appendEntry()`。在 context handler 中，通过 message 的 `timestamp` + `role` + 内容特征匹配到映射表中的 entryId。

```
turn_end 事件 → 记录 { turnIndex, entryIds[], toolCalls[] }
                    ↓ 持久化
              pi.appendEntry("ic-turn-index", data)

context handler → 遍历 messages
                 → 通过 timestamp 近似匹配 + role + toolName 精确定位
                 → 查映射表获取 entryId
                 → 替换为压缩引用（含 entryId 用于 recall）
```

**优点**：不依赖 Pi 改动，完全在扩展内完成
**缺点**：timestamp 匹配不是 100% 可靠（理论上可能有 timestamp 碰撞，实践中极罕见）

### 方案 B：在 before_agent_start 注入 ID 标记

**思路**：在 `before_agent_start` 中注入一条 CustomMessage，包含当前所有 entries 的 ID 列表。context handler 读取这条标记消息，建立映射。

**缺点**：标记消息本身也会进入 LLM 上下文（虽然 `display: false`），增加噪音；而且 `before_agent_start` 注入的是新消息，无法给已有消息打标签

### 方案 C：向 Pi 提 PR，给 AgentMessage 加 entryId 字段

**思路**：修改 `buildSessionContext()`，在构造 message 时保留源 entry 的 `id`。

**优点**：最干净的方案
**缺点**：需要 Pi 核心改动，不在本次实施范围内

### 推荐方案

**方案 A（自建映射表）** 作为当前实施路径，方案 C 作为远期优化。理由：
- 方案 A 完全在扩展内完成，不依赖 Pi 发布周期
- timestamp + role + 内容特征 的组合在实践中足够唯一
- 映射表通过 `pi.appendEntry()` 持久化，不会丢失

---

## 四、方案设计（基于推荐方案 A）

### 4.1 架构总览

```
                         Pi 进程
┌──────────────────────────────────────────────────┐
│                                                  │
│  Session JSONL (原始数据, 不修改)                   │
│  ├─ entry_001: user message                      │
│  ├─ entry_002: assistant (tool call: read)        │
│  ├─ entry_003: toolResult (文件内容 5000 行)       │
│  ├─ entry_004: assistant (分析结果)                │
│  └─ ...                                          │
│                                                  │
│  ┌─────────────────────────────────────┐         │
│  │  infinite-context 扩展              │         │
│  │                                     │         │
│  │  1. turn_end 事件                    │         │
│  │     → 构建 TurnIndex                 │         │
│  │     → 记录 entryId + 工具调用元数据   │         │
│  │     → pi.appendEntry() 持久化        │         │
│  │                                     │         │
│  │  2. context 事件 (每次 LLM 调用前)   │         │
│  │     → 读取 TurnIndex                 │         │
│  │     → 遍历 messages，匹配定位        │         │
│  │     → 旧的工具输出 → L1 压缩引用     │         │
│  │     → 注入锚节点 (消息开头)          │         │
│  │     → 注入 recall 提示               │         │
│  │     → 返回修改后的 messages          │         │
│  │                                     │         │
│  │  3. recall 工具                      │         │
│  │     → 接收 entryId 或关键词          │         │
│  │     → 从 session entries 取原始数据  │         │
│  │     → 返回给 LLM                    │         │
│  └─────────────────────────────────────┘         │
│                                                  │
│  冷数据文件 (.pi/infinite-context/)               │
│  ├─ segments/<sessionId>/<segId>.json            │
│  └─ recall-index.json                            │
│                                                  │
└──────────────────────────────────────────────────┘
```

### 4.2 数据模型

```typescript
// === Turn 索引 ===
// 通过 turn_end 事件构建，pi.appendEntry("ic-turn-index", ...) 持久化

interface TurnIndex {
  turns: TurnRecord[];
}

interface TurnRecord {
  turnIndex: number;           // 从 0 递增
  userEntryId: string;         // 用户消息的 entry ID
  assistantEntryId: string;    // AI 回复的 entry ID
  toolCalls: ToolCallRecord[]; // 本轮的工具调用
  timestamp: number;           // 时间戳（用于 context handler 匹配）
}

interface ToolCallRecord {
  toolCallId: string;          // assistant message 中 ToolCall 的 id
  toolName: string;            // read / bash / edit / write / grep / glob / subagent / ...
  toolEntryId: string;         // toolResult 对应的 entry ID
  params: Record<string, unknown>;   // 工具调用参数
  resultSummary?: string;      // 工具结果摘要（由观察器提取）
}

// === L1 压缩引用 ===
// 在 context handler 中替换旧 toolResult 的内容

interface L1Reference {
  type: "l1-ref";
  originalEntryId: string;     // 原始 entry ID（用于 recall）
  originalToolName: string;
  compressed: string;          // 人类可读的压缩描述
  // 例: "读取了 src/auth/token.ts L1-210 (原始 5000 行，ID: entry_003)"
}

// === 段索引 ===
// 一组相关 turn 的集合

interface Segment {
  segmentId: string;
  type: "task" | "exploration" | "debugging" | "conversation";
  turnRange: [number, number]; // [startTurnIndex, endTurnIndex]
  objective: string;           // 段目标的简短描述
  archived: boolean;           // 是否已归档到冷数据文件
}
```

### 4.3 核心数据流

```
┌─────────────────────────────────────────────────────────┐
│                    每轮结束时                              │
│                                                         │
│  turn_end 事件                                           │
│    │                                                    │
│    ├── 1. 读取本轮新增的 entries                          │
│    │      (通过 ctx.sessionManager.getEntries() diff)    │
│    │                                                    │
│    ├── 2. 构建 TurnRecord                                │
│    │      { turnIndex, entryIds, toolCalls, timestamp }  │
│    │                                                    │
│    ├── 3. L1 压缩：为每个 toolCall 生成 compressed 摘要   │
│    │      "read src/auth/token.ts" → "读取了 auth/token.ts L1-210" │
│    │                                                    │
│    ├── 4. 检测段边界（是否应该结束当前段、开始新段）        │
│    │                                                    │
│    └── 5. pi.appendEntry("ic-turn-index", turnRecord)    │
│                                                         │
├─────────────────────────────────────────────────────────┤
│                 每次 LLM 调用前                           │
│                                                         │
│  context 事件                                            │
│    │                                                    │
│    ├── 1. 读取 TurnIndex（从 session entries）            │
│    │                                                    │
│    ├── 2. 遍历 messages:                                │
│    │      for each message:                              │
│    │        if role == "toolResult" && isOld(message):   │
│    │          匹配 TurnRecord → 找到 entryId             │
│    │          替换内容为 L1Reference                     │
│    │        fi                                          │
│    │                                                    │
│    ├── 3. 在 messages 开头注入:                          │
│    │      - 锚节点事实（如果有的话）                       │
│    │      - recall 使用提示                               │
│    │      - 上下文用量警告（如果 >80%）                   │
│    │                                                    │
│    └── 4. return { messages: modified }                  │
│                                                         │
├─────────────────────────────────────────────────────────┤
│                  recall 工具调用                          │
│                                                         │
│  recall({ query: "auth token" })                         │
│    │                                                    │
│    ├── 1. 搜索 TurnIndex 中的 toolCalls                  │
│    │      (关键词匹配 compressed 摘要 + 文件路径)         │
│    │                                                    │
│    ├── 2. 找到匹配的 toolEntryId                         │
│    │                                                    │
│    ├── 3. 从 ctx.sessionManager.getEntries()             │
│    │      中获取原始 entry 的完整数据                     │
│    │                                                    │
│    └── 4. 返回原始内容给 LLM                             │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 4.4 "旧"的判定策略

context handler 需要决定哪些 toolResult 被压缩、哪些保留原文。策略：

| 策略 | 说明 | 阈值 |
|------|------|------|
| **时间距离** | 保留最近 N 轮的原文 | 默认 N=8 |
| **上下文用量** | 用量越高，压缩越激进 | >60%: N=6, >80%: N=4, >90%: N=2 |
| **工具类型** | 某些工具输出天然更大，优先压缩 | read > bash > grep > glob |
| **段边界** | 当前段内的保留，历史段的压缩 | 段索引判断 |

---

## 五、实施范围划定

### 5.1 本次实施（MVP）

| 编号 | 功能 | Pi API | 复杂度 |
|:---:|------|--------|:---:|
| M1 | **Turn 索引观察器** — turn_end 构建映射表 | `turn_end` + `appendEntry` | 中 |
| M2 | **L1 规则压缩** — context handler 替换旧 toolResult | `context` | 中 |
| M3 | **锚节点注入** — context handler 在消息开头注入 | `context` | 低 |
| M4 | **recall 工具** — 搜索 TurnIndex + 取原始 entry | `registerTool` + `getEntries` | 中 |
| M5 | **上下文用量监控** — context handler 中检查用量 | `getContextUsage` | 低 |
| M6 | **/context-status 命令** — 查看使用情况 | `registerCommand` | 低 |

**预估规模**：~1200 行 TypeScript，6 个核心文件

### 5.2 增强层（后续迭代）

| 编号 | 功能 | 依赖 |
|:---:|------|------|
| E1 | 冷数据归档（段完成后写到文件系统） | M1 |
| E2 | 段索引（自动检测段边界） | M1 |
| E3 | 自定义 compaction（替代 Pi 原生压缩） | M2 + `session_before_compact` |
| E4 | 锚节点持久化存储（跨 session） | M3 |
| E5 | L2 LLM 摘要（subagent 异步生成） | M1 + subagent |

### 5.3 远期（不在讨论范围）

- 温数据层 + 向量检索
- 三重遗忘机制
- 异步写入管道
- 锚节点版本化追踪
- 跨 session 记忆迁移

---

## 六、已有文档处置建议

| 文档 | 处置 |
|------|------|
| `living-memory-architecture.md` | 保留作为远景参考，标记为"Phase 3+ 理论框架" |
| `comparison-and-architecture.md` | 保留作为调研存档，标记为"已完成" |
| `flat-approach-implementation.md` | **归档** — 核心前提已被推翻（"扩展无法修改消息"），但 L1 压缩规则、段划分策略仍有参考价值 |
| `pi-core-context-research.md` | **保留** — 最可靠的 API 参考，实施过程中的权威文档 |
| `tree-structure-approach.md` | 保留作为 Phase 3 参考 |

---

## 七、待讨论的开放问题

1. **ID 定位方案**：方案 A（自建映射表）可接受吗？还是倾向于向 Pi 提 PR（方案 C）？
2. **"旧"的判定**：默认保留最近 8 轮原文，是否合适？
3. **冷数据归档**：MVP 阶段是否需要冷数据文件归档？还是直接从 session entries 取原始数据（简化实现，但长 session 下 getEntries() 会很慢）？
4. **锚节点的初始来源**：MVP 阶段锚节点从哪里来？用户手动配置？还是从 CLAUDE.md 自动提取？
5. **与 Pi 原生 compaction 的关系**：我们的 L1 压缩和 Pi 的 compaction 是并行关系还是替代关系？如果并行，compaction 触发后我们的 context handler 还会生效吗？
