# OpenCode 上下文压缩（Summarization）机制分析

> 分析对象：[opencode-ai/opencode](https://github.com/opencode-ai/opencode)
> 分析日期：2026-05-30
> 核心文件路径均相对于项目根目录 `internal/`

---

## 1. 概述

OpenCode 采用**全量摘要替换式压缩**策略：当对话 token 使用量接近上下文窗口上限时，自动调用独立的 Summarizer Agent 对整个对话历史进行摘要，然后将摘要作为一条 `assistant` 消息存入当前 session，后续对话从摘要消息处截断开始。这是一种**有损压缩**——原始对话被丢弃，仅保留摘要文本作为后续上下文。

---

## 2. 涉及的核心文件

| 文件 | 职责 |
|------|------|
| `internal/llm/prompt/summarizer.go` | Summarizer Agent 的系统提示词 |
| `internal/llm/prompt/prompt.go` | Agent 提示词路由（`GetAgentPrompt`） |
| `internal/llm/agent/agent.go` | Agent 核心逻辑：压缩触发、摘要生成、摘要恢复 |
| `internal/tui/tui.go` | TUI 层：自动压缩触发、进度展示、手动命令注册 |
| `internal/config/config.go` | 配置：`autoCompact` 开关、`AgentSummarizer` 定义 |
| `internal/llm/models/local.go` | 本地模型默认配置（含 summarizer agent） |
| `internal/session/session.go` | Session 数据模型：`SummaryMessageID` 字段 |
| `internal/db/models.go` | 数据库模型：持久化 `summary_message_id` |

---

## 3. 压缩提示词完整内容

### 3.1 System Prompt（系统提示词）

> 来源：`internal/llm/prompt/summarizer.go`

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

**要点：**
- 非常简短的系统提示词（约 60 个词）
- 明确列出摘要需覆盖的 4 个维度：已完成工作、当前工作、修改的文件、下一步计划
- 不区分 provider（忽略 `ModelProvider` 参数）
- **没有**结构化输出要求（如 JSON、Markdown 格式约束）
- **没有**长度限制指示
- **没有**工具调用能力（`Summarize` 方法传空工具列表）

### 3.2 User Prompt（用户提示词）

> 来源：`internal/llm/agent/agent.go` → `Summarize` 方法，第 590 行

```go
summarizePrompt := "Provide a detailed but concise summary of our conversation above. Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next."
```

**要点：**
- 作为最后一条 `User` 消息附加到对话历史末尾
- 与系统提示词高度重复（相同的 4 个维度）
- 采用了"our conversation above"的表述，暗示模型需要回溯上方所有消息

---

## 4. 压缩触发条件与策略

### 4.1 自动触发

> 来源：`internal/tui/tui.go`，第 336-341 行

```go
} else if payload.Done && payload.Type == agent.AgentEventTypeResponse && a.selectedSession.ID != "" {
    model := a.app.CoderAgent.Model()
    contextWindow := model.ContextWindow
    tokens := a.selectedSession.CompletionTokens + a.selectedSession.PromptTokens
    if (tokens >= int64(float64(contextWindow)*0.95)) && config.Get().AutoCompact {
        return a, util.CmdHandler(startCompactSessionMsg{})
    }
}
```

**触发逻辑：**
1. 每次 Coder Agent 完成一次响应（`AgentEventTypeResponse` + `Done=true`）时检查
2. 计算当前 session 累积 token：`CompletionTokens + PromptTokens`
3. 与模型上下文窗口比较：`tokens >= contextWindow * 0.95`
4. 且配置中 `autoCompact` 为 `true`（默认值，见 `config.go` 第 328 行：`viper.SetDefault("autoCompact", true)`）

**即：当对话 token 消耗达到上下文窗口的 95% 时，自动触发压缩。**

### 4.2 手动触发

> 来源：`internal/tui/tui.go`，第 945-953 行

用户可通过 TUI 命令面板执行 `compact` 命令：

```go
model.RegisterCommand(dialog.Command{
    ID:          "compact",
    Title:       "Compact Session",
    Description: "Summarize the current session and create a new one with the summary",
    Handler: func(cmd dialog.Command) tea.Cmd {
        return func() tea.Msg {
            return startCompactSessionMsg{}
        }
    },
})
```

### 4.3 配置项

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `autoCompact` | `bool` | `true` | 是否在 token 达到 95% 时自动压缩 |
| `agents.summarizer.model` | `string` | 与 coder 同模型 | Summarizer Agent 使用的模型 |

---

## 5. 压缩输入格式

### 5.1 输入构建

> 来源：`internal/llm/agent/agent.go` → `Summarize` 方法

```
[System Prompt: SummarizerPrompt()]        ← 系统提示词，由 provider 层注入
[Message 1: User]                          ← 原始对话历史（全部消息）
[Message 2: Assistant]
[Message 3: Tool]
[Message 4: Assistant]
...
[Message N: User]                          ← summarizePrompt（摘要请求）
```

**关键细节：**
- **传入全部对话历史**：`a.messages.List(summarizeCtx, sessionID)` 获取该 session 的所有消息
- 没有分批/分片机制——如果对话本身已经很长，摘要请求本身也会消耗大量 token
- 摘要请求不带工具（`make([]tools.BaseTool, 0)`），Summarizer Agent 无法调用任何工具
- 使用独立的 `summarizeProvider`（可以与 coder 使用不同模型）

### 5.2 输入来源的 Provider

```go
summarizeProvider, err = createAgentProvider(config.AgentSummarizer)
```

Summarizer Agent 拥有独立的 provider 实例，通过 `createAgentProvider` 创建，加载 `agents.summarizer.model` 配置的模型。

---

## 6. 压缩输出格式与存储

### 6.1 输出处理

> 来源：`internal/llm/agent/agent.go` → `Summarize` 方法，第 620-670 行

```go
summary := strings.TrimSpace(response.Content)

// 在同一 session 中创建一条 assistant 消息
msg, err := a.messages.Create(summarizeCtx, oldSession.ID, message.CreateMessageParams{
    Role: message.Assistant,
    Parts: []message.ContentPart{
        message.TextContent{Text: summary},
        message.Finish{
            Reason: message.FinishReasonEndTurn,
            Time:   time.Now().Unix(),
        },
    },
    Model: a.summarizeProvider.Model().ID,
})

// 记录摘要消息 ID 到 session
oldSession.SummaryMessageID = msg.ID
oldSession.CompletionTokens = response.Usage.OutputTokens
oldSession.PromptTokens = 0   // 重置 prompt token 计数
```

**关键设计：**
1. **不创建新 session**——摘要消息直接追加到当前 session
2. 摘要作为一条 `assistant` 消息存入
3. session 的 `SummaryMessageID` 指向这条摘要消息
4. `PromptTokens` 重置为 0（因为旧消息不再发送）
5. token 使用量和费用正常累积

### 6.2 摘要后的上下文恢复

> 来源：`internal/llm/agent/agent.go` → `processGeneration` 方法，第 253-264 行

```go
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
        msgs[0].Role = message.User  // 关键：将摘要消息的 Role 改为 User！
    }
}
```

**关键行为：**
1. 加载消息时，从 `SummaryMessageID` 指向的消息开始截断
2. **摘要消息的角色从 `assistant` 被篡改为 `user`**
   - 这意味着摘要以"用户消息"的形式出现给模型
   - 可能是为了让模型将摘要视为"背景信息"而非"自己的回复"
3. 截断后只有：`[摘要(伪装为user)] + [后续新消息...]`

### 6.3 消息流可视化

```
压缩前 session 中的消息：
  [User] → [Assistant] → [Tool] → [Assistant] → ... → [User] → [Assistant]
                                                                        ↓
                                                              触发自动压缩
                                                                        ↓
压缩后 session 中的消息：
  [User] → [Assistant] → [Tool] → ... → [Assistant(摘要)] ← SummaryMessageID 指向这里
                                                                        ↓
                                              下次 processGeneration 加载时：
  [User(摘要，角色被篡改)] → [User(新)] → ...发送给 LLM
```

---

## 7. 压缩进度展示

> 来源：`internal/tui/tui.go`

压缩过程通过 3 个阶段的进度事件展示：

| 阶段 | 进度文本 | AgentEvent |
|------|----------|------------|
| 1 | "Starting summarization..." | 初始事件 |
| 2 | "Analyzing conversation..." | 消息列表加载后 |
| 3 | "Generating summary..." | 开始 LLM 调用前 |
| 4 | "Creating new session..." | 摘要生成后 |
| 5 | "Summary complete" | 完成 |

UI 层在 `isCompacting` 状态下显示覆盖层：

```go
overlay := style.Render("Summarizing\n" + a.compactingMessage)
```

---

## 8. 整体数据流

```
┌─────────────────────────────────────────────────┐
│                    TUI Layer                     │
│                                                 │
│  token >= 95% contextWindow ──┐                 │
│                               │ autoCompact=true│
│  用户执行 /compact ───────────┤                 │
│                               ↓                 │
│                    startCompactSessionMsg        │
└───────────────────────────────┬─────────────────┘
                                │
                                ↓
┌─────────────────────────────────────────────────┐
│                 Agent Layer                      │
│                                                 │
│  agent.Summarize(sessionID)                     │
│    │                                            │
│    ├── messages.List(sessionID) → 全部消息      │
│    ├── 附加 summarizePrompt 到末尾              │
│    ├── summarizeProvider.SendMessages()          │
│    │     └── System: SummarizerPrompt()         │
│    │     └── Messages: 全部历史 + 摘要请求      │
│    │     └── Tools: 无                          │
│    ├── response.Content → summary               │
│    ├── messages.Create(Assistant, summary)       │
│    ├── session.SummaryMessageID = msg.ID        │
│    └── session.PromptTokens = 0                 │
│                                                 │
│  下次 processGeneration:                        │
│    ├── 从 SummaryMessageID 截断消息             │
│    └── 摘要消息 Role 改为 User                  │
└─────────────────────────────────────────────────┘
```

---

## 9. 与其他 Coding Agent 压缩机制对比

| 维度 | OpenCode | Claude Code | Cursor | Aider |
|------|----------|-------------|--------|-------|
| **压缩策略** | 全量摘要替换 | 全量摘要替换 | 滑动窗口 + 摘要 | 仓库地图 + 精选上下文 |
| **触发阈值** | 95% 上下文窗口 | ~95% 上下文窗口 | 不透明 | 无显式压缩 |
| **是否可配置** | `autoCompact` 开关 | `/compact` 手动 | 不可配置 | N/A |
| **摘要角色** | assistant → 篡改为 user | 保持为 assistant | N/A | N/A |
| **摘要粒度** | 整个对话 | 整个对话 | N/A | N/A |
| **是否分批** | 否 | 否 | N/A | N/A |
| **摘要模型** | 可独立配置 | 与主模型相同 | N/A | N/A |
| **工具调用** | 不允许 | 不允许 | N/A | N/A |
| **结构化输出** | 无 | 无 | N/A | N/A |
| **系统提示词长度** | ~60 词 | ~80 词 | N/A | N/A |
| **创建新 Session** | 否（同 session 内） | 否 | N/A | N/A |

### 9.1 与 Claude Code 的关键差异

1. **角色篡改**：OpenCode 将摘要消息从 `assistant` 改为 `user`，Claude Code 保持原始角色。OpenCode 的做法可能让模型将摘要视为"事实性输入"而非"自己的历史回复"，减少模型否认摘要内容的风险。

2. **独立 Summarizer 模型**：OpenCode 允许为 Summarizer 配置独立模型（可以用更便宜的模型做摘要），Claude Code 始终使用当前对话模型。

3. **提示词风格**：两者都采用"4 要点"结构（做了什么、正在做什么、涉及的文件、下一步），但 OpenCode 更简洁。

4. **Token 重置**：OpenCode 在压缩后将 `PromptTokens` 重置为 0，重新计数。这是一种乐观估计——实际摘要消息仍会消耗 token。

### 9.2 设计局限性

1. **无增量压缩**：每次压缩都对全量对话做摘要，如果对话已经很长，摘要请求本身也可能接近上下文上限
2. **无结构化摘要**：没有要求模型按固定格式输出（如 JSON、Markdown 结构），摘要质量完全依赖模型理解
3. **无质量验证**：摘要生成后不做任何质量检查（如空摘要检查有，但无内容准确性验证）
4. **单次压缩限制**：如果压缩后的摘要 + 新对话再次达到 95%，会再次压缩（对摘要做摘要），信息损失会累积
5. **工具输出丢失**：工具调用结果在摘要中可能被大幅简化，关键细节（如代码 diff、文件内容）容易丢失

---

## 10. 关键代码路径摘要

### 10.1 压缩触发链路

```
TUI: agent response done
  → 检查 tokens >= contextWindow * 0.95 && autoCompact
  → 发送 startCompactSessionMsg
  → agent.Summarize(ctx, sessionID)
```

### 10.2 摘要生成链路

```
agent.Summarize()
  → messages.List(sessionID)           // 获取全部消息
  → 附加 summarizePrompt               // User 消息
  → summarizeProvider.SendMessages()   // 调用 LLM（System: SummarizerPrompt）
  → messages.Create(Assistant, summary) // 存储摘要
  → session.SummaryMessageID = msg.ID  // 记录断点
  → session.PromptTokens = 0           // 重置计数
```

### 10.3 摘要恢复链路

```
agent.processGeneration()
  → messages.List(sessionID)
  → 检查 session.SummaryMessageID != ""
  → 从 SummaryMessageID 位置截断消息列表
  → 将摘要消息 Role 改为 User
  → 继续正常对话流程
```

---

## 11. 总结

OpenCode 的上下文压缩是一个**简洁但完整**的实现：

- **提示词极简**（~60 词系统提示 + ~40 词用户提示），聚焦 4 个信息维度
- **独立 Agent 架构**，Summarizer Agent 有自己的模型配置和 provider
- **95% 自动触发 + 手动命令**双重触发机制
- **同 Session 内截断恢复**，通过 `SummaryMessageID` 标记断点
- **角色篡改技巧**（assistant → user），尝试改善摘要的利用效果

主要改进空间在于：增量压缩、结构化输出、质量验证、以及对长对话的分批处理。
