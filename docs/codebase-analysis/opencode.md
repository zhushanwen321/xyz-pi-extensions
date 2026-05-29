# OpenCode 上下文管理分析报告

> 项目: github.com/opencode-ai/opencode  
> 语言: Go  
> 分析日期: 2026-05-28  

---

## 1. 项目概述

OpenCode 是一个 terminal-based agentic coding assistant，支持多 provider（Anthropic、OpenAI、Gemini、Groq、Bedrock、Azure、VertexAI、Copilot 等），使用 SQLite 持久化会话和消息。

核心结构:

```
cmd/root.go              — CLI 入口
internal/app/app.go      — 应用编排（Sessions/Messages/Agent 初始化）
internal/session/        — 会话 CRUD（SQLite 持久化）
internal/message/        — 消息结构与 CRUD（多种 ContentPart 类型）
internal/llm/agent/      — Agent 执行循环、Summarization
internal/llm/provider/   — LLM Provider 客户端（Anthropic/OpenAI/Gemini 等）
internal/llm/prompt/     — System Prompt 构造
internal/llm/models/     — 模型定义（ContextWindow, MaxTokens, Cost）
internal/db/             — SQLite 数据模型（sqlc 生成）
internal/tui/tui.go      — TUI 主循环（含 AutoCompact 触发逻辑）
```

---

## 2. 上下文管理架构

OpenCode 的上下文管理由**四层**构成：

### 2.1 数据持久化层（SQLite）

所有消息存储在 SQLite `messages` 表中，按 `session_id` 分组，按 `created_at ASC` 排序。

**Schema 关键字段:**

```sql
-- sessions 表
summary_message_id TEXT   -- 指向最新的 summary 消息 ID

-- messages 表
id TEXT PRIMARY KEY,
session_id TEXT NOT NULL,    -- 外键 → sessions.id
role TEXT NOT NULL,          -- "user" / "assistant" / "tool" / "system"
parts TEXT NOT NULL,         -- JSON 格式的 ContentPart 数组
model TEXT,                  -- 生成此消息的模型 ID
created_at INTEGER,         -- Unix 时间戳
finished_at INTEGER         -- 完成时间（辅助消息用）
```

**SQL 触发器自动维护:**

- `update_session_message_count_on_insert` — 插入消息时自动递增 `sessions.message_count`
- `update_session_message_count_on_delete` — 删除消息时自动递减
- `update_sessions_updated_at` — 更新 session 时自动更新时间戳

### 2.2 Prompt 构造层

**文件:** `internal/llm/prompt/prompt.go` + `coder.go`

- `GetAgentPrompt()` 根据 agent 类型（coder/title/task/summarizer）选择系统提示词
- 对 coder 和 task agent，自动加载项目级上下文文件（通过 `contextPaths` 配置）:
  - `.github/copilot-instructions.md`
  - `.cursorrules`
  - `.cursor/rules/`
  - `CLAUDE.md` / `CLAUDE.local.md`
  - `opencode.md` / `OpenCode.md` / `OPENCODE.md`（及其 .local 变体）
- 使用 `sync.Once` + goroutine 并行读取，支持通配目录

**System Prompt 的构成:**
1. Base prompt（Anthropic/OpenAI 版本，含行为规范、代码风格、工具使用规则）
2. 环境信息（cwd、git repo 状态、平台、日期、当前目录文件列表）
3. LSP 信息（如果配置了 LSP）
4. 项目级上下文文件内容（格式: `# From:<路径>\n<内容>`）

### 2.3 Agent 执行循环

**文件:** `internal/llm/agent/agent.go`

#### `processGeneration()` — 核心循环

```
1. 从 DB 加载 session 的所有消息（按时间升序）
2. 如果 session.SummaryMessageID 非空:
   → 裁剪消息历史，只保留从 summaryMessage 开始的消息
   → 将 summary 消息的 role 改为 "user"（即替代历史上下文）
3. 追加用户新消息
4. 进入循环:
   a. 调用 provider.StreamResponse(msgHistory, tools)
   b. 处理 streaming 事件（文本/tool_use/thinking delta）
   c. 执行 tool calls → 生成 tool results 消息
   d. 将 assistant 消息 + tool results 追加到 msgHistory
   e. 如果 finish_reason 是 tool_use → 继续循环
   f. 否则返回最终结果
```

#### 关键特性: 无截断策略

- **没有**消息数量限制
- **没有** token 预算检查或上下文窗口溢出的自动处理
- 所有消息和 tool result 都持续累加到 `msgHistory` 中
- 唯一"缩减"上下文的机制是 **Summarization**

#### Provider 端消息转换

**Anthropic (`anthropic.go`):**
```go
func (a *anthropicClient) convertMessages(messages []message.Message) {
    for i, msg := range messages {
        cache := false
        if i > len(messages)-3 {  // 最后 3 条消息启用缓存
            cache = true
        }
        // 根据 role 转换: user → NewUserMessage, assistant → NewAssistantMessage, tool → NewUserMessage(tool results)
    }
}
```

**OpenAI (`openai.go`):**
```go
func (o *openaiClient) convertMessages(messages []message.Message) {
    // 在消息数组开头插入 system message（含完整系统提示词）
    openaiMessages = append(openaiMessages, openai.SystemMessage(providerOptions.systemMessage))
    // user → 可能包含 text + imageURL + binary
    // assistant → text + tool_calls
    // tool → role: "tool", 每个 result 一条消息
}
```

### 2.4 Summarization（唯一上下文压缩机制）

#### 触发方式

1. **手动触发:** TUI 中 `@compact` 命令
2. **自动触发 (AutoCompact):** TUI 主循环监听 `AgentEventTypeResponse`，检查:
   ```go
   tokens := session.CompletionTokens + session.PromptTokens
   if tokens >= int64(float64(contextWindow) * 0.95) && config.Get().AutoCompact {
       // 自动启动 summary
   }
   ```
   `autoCompact` 默认值为 `true`。

#### Summarization 流程

```
1. Summarize(ctx, sessionID):
   - 创建可取消的 context
   - 发布 AgentEventTypeSummarize（开始）事件
   - 从 DB 加载全部消息
   - 在末尾追加 summarize prompt:
     "Provide a detailed but concise summary of our conversation above..."
   - 调用 summarizeProvider.SendMessages()（无 tools）
   - 将返回的 summary 文本作为一条 assistant 消息写入 session
   - 设置 session.SummaryMessageID = 新消息的 ID
   - 更新 session 的 token/cost 统计
   - 发布完成事件
```

#### Summarization 效果

在下次 `processGeneration()` 中:
```go
if session.SummaryMessageID != "" {
    // 找到 summary 消息在消息列表中的索引
    // 裁剪: msgs = msgs[summaryMsgIndex:]
    // 将 summary 消息的 role 改为 "user"（作为后续对话的上下文种子）
}
```

效果: 之前的所有消息被一条 summary 消息替代，接入后续对话。

#### 总结器系统提示词

```go
func SummarizerPrompt(_ models.ModelProvider) string {
    return `You are a helpful AI assistant tasked with summarizing conversations.

When asked to summarize, provide a detailed but concise summary of the conversation.
Focus on information that would be helpful for continuing the conversation, including:
- What was done
- What is currently being worked on
- Which files are being modified
- What needs to be done next

Your summary should be comprehensive enough to provide context but concise enough to be quickly understood.`
}
```

### 2.5 Token 追踪（用于成本计算，非截断）

**每次 LLM 响应完成后更新 session:**

```go
func (a *agent) TrackUsage(ctx context.Context, sessionID string, model models.Model, usage provider.TokenUsage) error {
    cost := model.CostPer1MInCached/1e6*float64(usage.CacheCreationTokens) + ...
    sess.Cost += cost
    sess.CompletionTokens = usage.OutputTokens + usage.CacheReadTokens
    sess.PromptTokens = usage.InputTokens + usage.CacheCreationTokens
    // 更新 DB
}
```

- 区分 cached/uncached tokens（Anthropic 完整支持，OpenAI 部分支持）
- Token 计数被 TUI 用于 `AutoCompact` 触发判断

---

## 3. 核心代码片段

### 3.1 消息历史剪裁（Summarization 后）

```go
// agent.go - processGeneration()
session, _ := a.sessions.Get(ctx, sessionID)
if session.SummaryMessageID != "" {
    summaryMsgIndex := -1
    for i, msg := range msgs {
        if msg.ID == session.SummaryMessageID {
            summaryMsgIndex = i
            break
        }
    }
    if summaryMsgIndex != -1 {
        msgs = msgs[summaryMsgIndex:]
        msgs[0].Role = message.User  // summary 消息冒充用户消息
    }
}
```

### 3.2 Agent 执行循环

```go
// agent.go - processGeneration()
for {
    agentMessage, toolResults, err := a.streamAndHandleEvents(ctx, sessionID, msgHistory)
    // 如果是 tool_use → 继续循环
    if (agentMessage.FinishReason() == message.FinishReasonToolUse) && toolResults != nil {
        msgHistory = append(msgHistory, agentMessage, *toolResults)
        continue
    }
    return AgentEvent{Type: AgentEventTypeResponse, Message: agentMessage, Done: true}
}
```

### 3.3 AutoCompact 触发

```go
// tui.go
if payload.Done && payload.Type == agent.AgentEventTypeResponse && a.selectedSession.ID != "" {
    model := a.app.CoderAgent.Model()
    contextWindow := model.ContextWindow
    tokens := a.selectedSession.CompletionTokens + a.selectedSession.PromptTokens
    if (tokens >= int64(float64(contextWindow)*0.95)) && config.Get().AutoCompact {
        return a, util.CmdHandler(startCompactSessionMsg{})
    }
}
```

### 3.4 Anthropic 缓存控制

```go
// anthropic.go - convertMessages()
for i, msg := range messages {
    cache := false
    if i > len(messages)-3 { cache = true }
    // 系统提示词、最后 3 条消息、最后一个 tool 定义都设置 CacheControl
}
```

---

## 4. 评价与总结

### 架构优点

1. **简单可靠**: 整体上下文管理策略非常简洁，没有复杂的 token budget 计算或消息评分
2. **持久化完善**: 完整的 SQLite 持久化 + 触发器自动维护消息计数
3. **Provider 泛化**: 统一的消息格式 + Provider 层的消息转换，支持多种 LLM API
4. **AutoCompact 实用**: 基于 token 使用量百分比自动触发 summary，解决了长会话的常见问题
5. **缓存利用率高**: Anthropic 端正确设置了 system prompt、最近消息和 tools 的缓存控制

### 局限性

1. **缺乏精细的上下文窗口管理**: 
   - 没有 token 预算分配（system message / messages / tools 各占多少）
   - 没有智能消息丢弃策略（如丢弃已完成 tool call 的详细输出）
   - 所有消息一视同仁，没有重要性评分

2. **Summarization 是唯一的压缩机制**:
   - 没有滑动窗口（丢弃最早的消息但保留工具结果）
   - 没有分段压缩（仅压缩工具输出而不压缩对话）
   - 没有按类型差异化保留策略

3. **AutoCompact 触发时机偏晚**:
   - 在 tokens ≥ 95% context window 时才触发
   - 此时下一次 LLM 请求可能已超过窗口限制
   - 压缩期间 blocking（有 `isCompacting` 锁）

4. **无 tool result 压缩**:
   - Tool 执行结果（尤其 bash、view 的输出）原样存储并发送
   - 没有对工具输出做摘要或截断

5. **Session 树支持但未充分利用**:
   - `parent_session_id` 和 `task session` 提供了会话树结构
   - AgentTool 创建子 session（`CreateTaskSession`），有父子关系
   - 但没有利用跨 session 的上下文合并或引用

### 对无限上下文方案的启示

| 特性 | OpenCode 做法 | 可改进方向 |
|------|-------------|-----------|
| 消息持久化 | SQLite 全量存储 | + 数据库级切片查询 |
| 上下文剪裁 | Summarization 替代历史 | + 滑动窗口 + 混合策略 |
| Token 追踪 | 仅用于成本 + 触发 AutoCompact | + 用于提前预警 + 预算分配 |
| Tool Result 管理 | 原样无限累加 | + 自动摘要 + 过期丢弃 |
| 系统提示词 | 固定不变 | + 按需增量注入 |
| 缓存 | Anthropic 缓存控制 | + 对旧消息渐进式降级缓存优先级 |

---

*报告完毕*
