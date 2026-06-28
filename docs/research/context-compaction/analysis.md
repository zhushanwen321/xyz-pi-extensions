# Pi 原生 Compaction vs context-engineering 事件：执行链路分析

## 1. 核心结论

**不存在双重压缩风险。** compaction 和 context 事件在不同阶段操作，且互斥：

- **compaction** 在 agent loop 之外（agent_end 或 prompt 提交前）执行，直接修改持久化的 session entries
- **context 事件** 在 agent loop 内部、每次 LLM 调用之前执行，修改的是内存中的 messages 数组

两者的产出物不会互相叠加。

## 2. 完整执行时序图

```
用户输入 prompt
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  AgentSession._handlePrompt()                                       │
│  (agent-session.ts ~L1035)                                         │
│                                                                     │
│  ① 检查是否需要 pre-prompt compaction                               │
│     _checkCompaction(lastAssistant, skipAbortedCheck=false)         │
│     如果需要 → _runAutoCompaction() → compaction 执行              │
│         ↓                                                           │
│     sessionManager.appendCompaction(summary, ...)                   │
│     sessionContext = sessionManager.buildSessionContext()           │
│     agent.state.messages = sessionContext.messages  ← 替换 messages │
│     然后自动 agent.continue() 重试                                  │
└─────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  AgentSession 把 user message 加入 agent.state.messages            │
│  调用 agent.send() 或 agent.continue()                              │
└─────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Agent Loop (agent-loop.ts runLoop)                                 │
│                                                                     │
│  创建 context = { messages: agent.state.messages.slice() }         │
│                                                                     │
│  ┌─── inner loop (per turn) ────────────────────────────────────┐  │
│  │                                                               │  │
│  │  ② streamAssistantResponse(context, config, ...)             │  │
│  │     (agent-loop.ts ~L275)                                    │  │
│  │                                                               │  │
│  │     messages = context.messages                               │  │
│  │                                                               │  │
│  │     ┌─── transformContext (context 事件) ──────────────────┐  │  │
│  │     │  if (config.transformContext) {                      │  │  │
│  │     │    messages = await transformContext(messages)       │  │  │
│  │     │  }                                                   │  │  │
│  │     │                                                      │  │  │
│  │     │  实际调用链：                                         │  │  │
│  │     │  sdk.ts transformContext → runner.emitContext()      │  │  │
│  │     │  → 遍历所有注册了 "context" handler 的扩展           │  │  │
│  │     │  → context-engineering 的 pi.on("context", ...)     │  │  │
│  │     │  → compressContext() [L0/L1/L2]                     │  │  │
│  │     │  → 返回压缩后的 messages                             │  │  │
│  │     └──────────────────────────────────────────────────────┘  │  │
│  │                                                               │  │
│  │     ③ convertToLlm(messages)                                  │  │
│  │     AgentMessage[] → Message[] (LLM 格式)                     │  │
│  │                                                               │  │
│  │     ④ streamSimple(model, llmContext, ...)                    │  │
│  │     发送给 LLM                                                │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ⑤ agent_end 事件                                                  │
└─────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  AgentSession._handlePostAgentRun()                                 │
│                                                                     │
│  ⑥ 检查是否需要 post-turn compaction                                │
│     _checkCompaction(lastAssistant)                                 │
│     两种触发条件：                                                   │
│     - overflow: LLM 返回 context overflow 错误                      │
│     - threshold: contextTokens 超过阈值                              │
│                                                                     │
│     如果需要 → _runAutoCompaction()                                 │
│         sessionManager.appendCompaction()                           │
│         agent.state.messages = buildSessionContext().messages       │
└─────────────────────────────────────────────────────────────────────┘
```

## 3. 逐问题回答

### Q1: Pi 原生 compaction 的触发时机和调用函数

**触发时机**（两处）：

| 时机 | 位置 | 函数 |
|------|------|------|
| prompt 提交前（pre-prompt） | `_handlePrompt()` ~L1041 | `_checkCompaction(lastAssistant, false)` |
| agent 完成后（post-turn） | `_handlePostAgentRun()` ~L2445 | `_checkCompaction(lastAssistant)` |

**触发条件**（两种）：
1. **overflow**: LLM 返回 context overflow 错误（`isContextOverflow` 检测）
2. **threshold**: 上下文 token 数超过阈值（`shouldCompact` 检查，默认 80% 上下文窗口）

**调用链**：
```
_checkCompaction() → _runAutoCompaction(reason, willRetry)
  → prepareCompaction(entries, settings)     // 确定切割点
  → compact(preparation, model, ...)         // 调用 LLM 生成摘要
  → sessionManager.appendCompaction(...)      // 持久化 compaction entry
  → buildSessionContext()                     // 重建消息列表
  → agent.state.messages = newMessages       // 替换 agent 状态
```

### Q2: context 事件的触发时机

**触发时机**：在 agent loop 内部，**每次 LLM 调用之前**。

```
agent-loop.ts streamAssistantResponse() L284-285:
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }
```

**调用链**：
```
config.transformContext (agent-loop.ts L284)
  → sdk.ts transformContext (L375-378)
    → runner.emitContext(messages) (runner.ts L858)
      → 遍历所有扩展的 "context" handler
      → context-engineering 的 handler:
          compressContext(msgs, config, store, contextUsage)
          返回 { messages: compressedMessages }
      → 如果 handlerResult.messages 存在，替换 currentMessages
  返回最终 messages
```

**与 compaction 的关系**：时序上互斥，不存在并发：
- compaction 在 agent loop 外部（prompt 前或 agent_end 后）
- context 事件在 agent loop 内部（每次 LLM call 前）

### Q3: LLM 最终看到的 messages

**LLM 看到的是 context 事件返回的压缩后消息**（如果 context 事件做了压缩）。

完整路径：
```
agent.state.messages  (持久化消息，可能已经过 compaction 精简)
  → context.messages = agent.state.messages.slice()  (浅拷贝)
    → transformContext(context.messages)  (context 事件压缩)
      → 返回压缩后的 messages
    → convertToLlm(messages)  (转为 LLM 格式)
      → 发送给 LLM
```

如果 compaction 先执行了，`agent.state.messages` 已经是 compaction 后的消息（包含摘要，丢弃了旧消息）。context 事件在此基础上再处理一遍。

如果 compaction 没有执行，context 事件处理的是原始完整消息。

### Q4: 是否存在双重压缩？

**不是"双重压缩"意义上的问题，但存在功能重叠**：

| 维度 | Compaction | context 事件 (context-engineering) |
|------|-----------|----------------------------------|
| 执行位置 | agent loop 外 | agent loop 内（每次 LLM call） |
| 操作对象 | 持久化 session entries | 内存中的 messages 数组 |
| 不可逆性 | 不可逆（旧 entries 被摘要替代） | 可逆（原始消息仍保留在 session 中） |
| 触发频率 | 低（达到阈值时才触发） | 高（每次 LLM 调用都触发） |
| 压缩方式 | LLM 生成摘要 | 规则化压缩（过期/截断/结构化摘要） |

**关键区别**：

1. **compaction 的输出会作为 context 事件的输入**。compaction 执行后，`agent.state.messages` 被替换为精简版（摘要 + 保留的消息）。随后 context 事件收到的是这个精简版。但 context-engineering 的 L0/L1/L2 压缩对已压缩消息的再压缩效果有限：
   - 已经过期的 tool result 会被 `isToolResultExpired()` 检测跳过
   - bash output 如果已被 compaction 截断，再次截断几乎无效果
   - L2 emergency 压缩不会再次触发（因为 compaction 已经释放了大量空间）

2. **不是叠加式双重压缩**。compaction 是用 LLM 生成一段自然语言摘要替换大量旧消息。context-engineering 是对每条消息做规则化处理（过期/截断/结构化摘要）。两者的压缩机制不同，不会产生"压缩已压缩内容"的信息损失问题。

### Q5: context 事件返回空对象 `{}` 时的处理

代码位置：`runner.ts L858-881`

```typescript
async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
    let currentMessages = structuredClone(messages);  // 深拷贝原始消息
    for (const ext of this.extensions) {
        const handlers = ext.handlers.get("context");
        if (!handlers || handlers.length === 0) continue;
        for (const handler of handlers) {
            const event: ContextEvent = { type: "context", messages: currentMessages };
            const handlerResult = await handler(event, ctx);
            // 关键判断：只有 handlerResult.messages 存在时才替换
            if (handlerResult && (handlerResult as ContextEventResult).messages) {
                currentMessages = (handlerResult as ContextEventResult).messages!;
            }
        }
    }
    return currentMessages;  // 返回（可能未被修改的）消息
}
```

**返回 `{}` 的效果**：
- `handlerResult` 是 `{}`，`handlerResult.messages` 是 `undefined`
- `if` 条件为 false，`currentMessages` 不变
- 等同于"不修改"——原始消息原封不动传给 LLM

`ContextEventResult` 类型定义确认了这一点：
```typescript
export interface ContextEventResult {
    messages?: AgentMessage[];  // 可选字段
}
```

## 4. 消息被修改的位置汇总

| 阶段 | 位置 | 操作 | 不可逆 |
|------|------|------|--------|
| compaction | `agent-session.ts ~L1694/L1975` | `agent.state.messages = buildSessionContext().messages` | ✅ 持久化 |
| context 事件 | `agent-loop.ts L284-285` | `messages = await transformContext(messages)` | ❌ 仅内存 |
| convertToLlm | `agent-loop.ts L287` | AgentMessage[] → Message[] 格式转换 | 格式转换，非压缩 |

## 5. 设计建议

当前设计中 compaction 和 context-engineering 是互补的：
- **compaction** 负责大幅度上下文缩减（token 级别），不可逆，低频触发
- **context-engineering** 负责细粒度消息级优化（规则化），可逆（recall_context），高频触发

如果要避免两者同时启用时的复杂度，有几个选项：

1. **在 context-engineering 中检测 compaction entry**：如果最近的 entry 是 compaction，跳过 L0/L1 处理（已由 compaction 处理）
2. **在 compaction 阈值检查时考虑 context-engineering 的效果**：如果 context-engineering 已经把上下文压缩到阈值以下，就不触发 compaction
3. **互斥模式**：提供配置项，启用 context-engineering 时禁用 auto-compaction
