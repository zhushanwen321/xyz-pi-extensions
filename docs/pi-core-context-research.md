# Pi 核心上下文修改能力调研

> 调研 Pi 源码，分析在 Pi 中修改 LLM 上下文需要做哪些事情。

---

## 一、核心发现：Pi 已经有完整的上下文修改钩子

**结论：不需要对 Pi 核心做任何改动。扩展已经可以修改 LLM 上下文中的消息。**

### 1.1 已有的 `context` 事件

Pi 在 `packages/agent/src/agent-loop.ts` 第 284-285 行，**每次 LLM 调用前**会执行：

```typescript
if (config.transformContext) {
  messages = await config.transformContext(messages, signal);
}
```

这个 `transformContext` 在 `packages/coding-agent/src/core/sdk.ts` 中被桥接到 `runner.emitContext()`：

```typescript
transformContext: async (messages) => {
  const runner = extensionRunnerRef.current;
  if (!runner) return messages;
  return runner.emitContext(messages);
},
```

`runner.emitContext()` 执行所有扩展注册的 `context` 事件处理器：

```typescript
async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
  let currentMessages = structuredClone(messages);
  for (const ext of this.extensions) {
    for (const handler of ext.handlers.get("context")) {
      const event: ContextEvent = { type: "context", messages: currentMessages };
      const handlerResult = await handler(event, ctx);
      if (handlerResult?.messages) {
        currentMessages = handlerResult.messages!;
      }
    }
  }
  return currentMessages;
}
```

**关键点**：
- `context` 事件在每次 LLM 调用前触发
- handler 可以接收完整的 messages 数组并返回修改后的版本
- 消息是 `structuredClone` 过的，扩展可以安全修改
- 多个扩展的 handler 会链式调用

### 1.2 数据流全貌

```
SessionManager.buildSessionContext()
         │
         ▼
  AgentMessage[]  (原始对话历史)
         │
         ├── compaction 摘要已在这里处理 (buildSessionContext 内部)
         │
         ▼
  agent.state.messages
         │
         ▼
  agent.runTurn() 开始
         │
         ├── 追加 injectMessages (steering 消息)
         │
         ▼
  transformContext(messages) ← context 事件在此触发
         │
         ▼
  convertToLlm(messages)  → LLM API
```

---

## 二、已有的相关 API 全貌

### 2.1 `context` 事件 (P0 - 核心)

**来源**：`packages/agent/src/agent-loop.ts` + `packages/coding-agent/src/core/extensions/runner.ts`

```typescript
// 扩展侧使用
pi.on("context", async (event, ctx) => {
  // event.messages: AgentMessage[] - 即将发送给 LLM 的全部消息
  // 可以增删改

  // 例如：移除旧的工具输出
  const pruned = event.messages.filter(m => {
    if (m.role === "toolResult" && isOldAndRedundant(m)) return false;
    return true;
  });

  // 例如：注入锚节点
  pruned.unshift(createAnchorMessage());

  return { messages: pruned };
});
```

**类型定义** (`types.ts`)：

```typescript
export interface ContextEvent {
  type: "context";
  messages: AgentMessage[];
}

export interface ContextEventResult {
  messages?: AgentMessage[];
}
```

**AgentMessage 类型**（可被 context handler 创建/修改的）：

```typescript
type AgentMessage =
  | UserMessage         // { role: "user", content: ... }
  | AssistantMessage    // { role: "assistant", content: ... }
  | ToolResultMessage   // { role: "toolResult", ... }
  | CustomMessage       // { role: "custom", customType, content }
  | BashExecutionMessage // { role: "bashExecution", command, output }
  | BranchSummaryMessage // { role: "branchSummary", summary }
  | CompactionSummaryMessage; // { role: "compactionSummary", summary }
```

### 2.2 `session_before_compact` 事件 (P1 - 压缩定制)

**来源**：`packages/coding-agent/src/core/compaction/` → `runner.emit()`

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  // event.preparation: {
  //   messagesToSummarize: AgentMessage[]  // 待压缩的消息
  //   turnPrefixMessages: AgentMessage[]   // 被拆分的turn前缀
  //   tokensBefore: number,
  //   previousSummary?: string,
  //   settings: CompactionSettings,
  // }

  // 可以：
  // 1. 取消压缩: return { cancel: true }
  // 2. 替换压缩内容: return { compaction: { summary, firstKeptEntryId, tokensBefore } }
  // 3. 不返回: 使用 Pi 默认压缩
});
```

**参考示例**：`examples/extensions/custom-compaction.ts` 展示了如何完全接管压缩流程，用自定义模型和 prompt 生成摘要。

### 2.3 `before_agent_start` 事件 (P1 - 注入消息)

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // 可以注入 custom message:
  return {
    message: {
      customType: "infinite-context",
      content: "锚节点摘要...",
      display: false,   // 不显示在 TUI
    },
    // 也可以修改 systemPrompt:
    systemPrompt: modifiedSystemPrompt,
  };
});
```

**限制**：只能注入**新增**消息，不能**删除**已有消息。`context` 事件更底层，可以增删改。

### 2.4 `ctx.getContextUsage()` (P1 - 用量查询)

```typescript
const usage = ctx.getContextUsage();
// → {
//   tokens: number | null,     // 估算的上下文 tokens
//   contextWindow: number,     // 模型上下文窗口
//   percent: number | null,    // 使用百分比
// }
```

### 2.5 `pi.appendEntry()` + `pi.sendUserMessage()` (P1 - 状态持久化 + 消息注入)

已有 API，在 goal 扩展中广泛使用。`CustomEntry` 不参与 LLM 上下文，`CustomMessageEntry` 会参与。

---

## 三、Pi 核心已有的 compaction 机制

### 3.1 触发方式

1. **自动触发**：`estimateContextTokens() > contextWindow - reserveTokens(16384)` 时触发
2. **手动触发**：用户 `/compact` 命令
3. **扩展触发**：`ctx.compact(options)`

### 3.2 压缩流程

```
prepareCompaction()
├── 找到 cut point (keepRecentTokens = 20000)
├── 提取 messagesToSummarize (待压缩)
└── 提取 turnPrefixMessages (如果切分在 turn 中间)

compact()
├── 用 LLM 生成 summary (structured markdown)
├── 如果 splitTurn: 同时生成 turn prefix summary
└── 生成 CompactionResult { summary, firstKeptEntryId, tokensBefore }

SessionManager.appendCompaction()
├── 写入 CompactionEntry 到 session
└── buildSessionContext() 读取时自动:
    ├── 先放入 compactionSummary 消息
    ├── 再放入 firstKeptEntryId 之后的未压缩消息
    └── 跳过 firstKeptEntryId 之前的消息 (已被摘要替代)
```

### 3.3 压缩配置

```typescript
interface CompactionSettings {
  enabled: boolean;        // 默认 true
  reserveTokens: number;   // 默认 16384 (留给输出的空间)
  keepRecentTokens: number; // 默认 20000 (保留最近 ~20K tokens 对话)
}
```

---

## 四、扩展能做的全部操作

| 操作 | 需要改 Pi 核心？ | 使用的 API |
|------|:---:|------|
| 监听工具调用 | 否 | `pi.on("turn_end")` |
| 持久化自定义状态 | 否 | `pi.appendEntry(type, data)` |
| 文件系统读写 | 否 | Node.js `fs` |
| 注册 LLM 可调用的工具 | 否 | `pi.registerTool()` |
| 注册用户命令 | 否 | `pi.registerCommand()` |
| 注入消息到对话 | 否 | `pi.sendUserMessage()` / `before_agent_start` |
| 查询上下文用量 | 否 | `ctx.getContextUsage()` |
| **在 LLM 调用前修改全部消息** | **否** | **`pi.on("context", handler)`** |
| 自定义 compaction 行为 | 否 | `pi.on("session_before_compact", handler)` |
| 触发 compaction | 否 | `ctx.compact(options)` |
| 启动 subagent 异步处理 | 否 | Pi 提供的 `subagent` 工具 |
| TUI 渲染 | 否 | `ctx.ui.setWidget/Status/notify` |

**结论：不需要对 Pi 核心做任何代码改动。**

---

## 五、对无限上下文方案的影响

### 5.1 之前以为需要 Pi 改动的 API

| 之前以为需要的 API | 实际情况 |
|------|------|
| `before:context:assemble` hook | **已有** — 就是 `context` 事件 |
| `getTokenBudget()` | **已有近似** — `ctx.getContextUsage()` (返回 tokens/contextWindow/percent) |
| `pi.on("segment:boundary")` | **不需要** — 可以在 `context` handler 中自行检测 |

### 5.2 新发现的能力

| 能力 | 说明 |
|------|------|
| `context` 事件可以**增删改**全部消息 | 不仅可以注入锚节点，还可以**移除旧的工具输出** |
| `session_before_compact` 可以**替换压缩行为** | 可以用自己的模型和 prompt 生成结构化摘要 |
| `CustomMessage` 可以作为消息类型注入 | 比 `sendUserMessage` 更灵活，可以选择在 TUI 中隐藏 |

### 5.3 Phase 2 现在可以做到的事情

有了 `context` 事件，Phase 2 的核心功能——真正的上下文缩减——完全可以在纯扩展中实现：

```
context handler:
├── 1. 遍历全部 messages
├── 2. 找到旧的工具输出 (如 read 返回的完整文件内容)
├── 3. 替换为压缩引用 ("读取了 auth.ts L1-210")
├── 4. 在消息开头注入锚节点 (CustomMessage)
├── 5. 注入最近完成的温数据片段
└── 6. 返回修改后的 messages
```

这意味着 **Phase 1 和 Phase 2 之间的分隔线消失了**。之前认为 Phase 2 需要 Pi 核心改动，现在知道不需要。

---

## 六、需要注意的限制

### 6.1 `context` 事件的使用注意

1. **必须返回 messages**：如果 handler 没有 return `{ messages: [...] }`，消息不会改变
2. **链式处理**：多个扩展的 handler 会按顺序调用，后面的可以看到前面的修改
3. **性能敏感**：在每次 LLM 调用前触发，handler 要轻量。L1 规则压缩(O(1) per message)没问题，LLM 调用不行
4. **structuredClone**：传入的 messages 是克隆的，handler 可以安全修改

### 6.2 不能做的

1. **不能修改已经持久化的 session entries**：`context` 事件只影响本次 LLM 调用发送的消息，不改变磁盘上的 session。如果要持久化压缩效果，需要配合 `pi.appendEntry()` 记录，或者利用 `session_before_compact` 在 compaction 时写入。
2. **不能阻止 Pi 原生 compact**：如果 compact 已经触发，`context` handler 的修改会在 compact 之后、下一个 turn 之前。两者是并行设计——compact 处理持久化层（session entries），`context` 事件处理发送层（LLM messages）。

### 6.3 与 Pi 原生 compact 的协作

最佳策略：**不阻止 Pi 原生 compact，而是利用 `context` 事件做日常的轻量上下文管理**。

```
日常: context 事件做 L1 压缩 (每次 LLM 调用前，零延迟)
阈值: Pi 原生 compact 触发时，通过 session_before_compact 定制压缩行为
      (或用 ctx.compact() 主动触发)
```

---

## 七、更新后的实施计划

### Phase 1 — 核心上下文管理 (纯扩展，不需要 Pi 改动)

| 步骤 | 使用的 API | 说明 |
|------|-----------|------|
| P1.1 段索引观察器 | `pi.on("turn_end")` | 监听工具调用，构建段结构 |
| P1.2 **L1 上下文压缩** | **`pi.on("context")`** | **在每次 LLM 调用前，将旧的工具输出替换为压缩引用** |
| P1.3 **锚节点注入** | **`pi.on("context")`** | **在消息开头注入锚节点事实** |
| P1.4 冷数据持久化 | `pi.appendEntry()` + `fs` | 段文件归档到 `.pi/infinite-context/` |
| P1.5 recall 工具 | `pi.registerTool()` | LLM 可检索历史内容 |
| P1.6 /context-status 命令 | `pi.registerCommand()` | 查看上下文使用情况 |
| P1.7 上下文用量监控 | `ctx.getContextUsage()` | 在 context handler 中检查用量 |

### Phase 2 — 记忆生命周期 (纯扩展)

| 步骤 | 使用的 API | 说明 |
|------|-----------|------|
| P2.1 L2 结构化摘要 | `subagent` 工具 (异步) | 段结束时自动生成摘要 |
| P2.2 锚节点资格规则引擎 | 纯逻辑 | 自动判定哪些事实应成为锚节点 |
| P2.3 温数据片段存储 | `pi.appendEntry()` + `fs` | 跨 session 记忆 |
| P2.4 定制 compaction | `pi.on("session_before_compact")` | 用自己的 prompt 和结构化输出替代默认 compact |
| P2.5 遗忘机制 | 纯逻辑 + `context` handler | 在 context 事件中应用遗忘规则 |

### Phase 3 — 树结构 + 多级压缩

树结构在温数据层组织方式升级时引入。

---

## 八、关键源码文件索引

| 文件 | 关键内容 |
|------|---------|
| `packages/agent/src/agent-loop.ts:284` | `transformContext` 调用位置 |
| `packages/coding-agent/src/core/sdk.ts:378` | `transformContext → runner.emitContext` 桥接 |
| `packages/coding-agent/src/core/extensions/runner.ts:858` | `emitContext` 实现 |
| `packages/coding-agent/src/core/extensions/types.ts` | `ContextEvent`, `ContextEventResult`, `AgentMessage` 类型 |
| `packages/coding-agent/src/core/compaction/compaction.ts` | 压缩逻辑: `prepareCompaction`, `compact`, `shouldCompact` |
| `packages/coding-agent/src/core/session-manager.ts` | `buildSessionContext`, compaction entry 处理 |
| `examples/extensions/custom-compaction.ts` | 自定义压缩示例 (利用 `session_before_compact`) |
