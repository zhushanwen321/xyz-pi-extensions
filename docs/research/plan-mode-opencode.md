# OpenCode Plan Mode 调研报告

> 调研日期：2026-06-11
> 项目：[opencode-ai/opencode](https://github.com/opencode-ai/opencode)（Go 语言 TUI 编码 agent）
> 版本：main 分支浅 clone

## 1. 是否内置 Plan Mode

**结论：OpenCode 没有内置 plan mode。**

代码库中不存在 plan mode、planning phase、planning tool 等概念。grep "plan" 仅出现在工具描述文本中，是工具使用指南的一部分（如 "Plan separate tool calls for each instance"），而非系统功能。

OpenCode 采用的是**单模式 + 逐工具权限审批**的架构。没有 analysis/planning/implementation 阶段划分，agent 从接收 prompt 开始就进入完整的工具循环（read → think → edit → verify），中间通过权限系统控制执行节奏。

---

## 2. 工具系统

### 2.1 工具清单

OpenCode 的 coder agent 配备 11 个内置工具 + MCP 扩展工具：

| 工具 | 文件 | 用途 | 需权限 |
|------|------|------|--------|
| `bash` | `internal/llm/tools/bash.go` | 执行 shell 命令 | 是（只读命令豁免） |
| `edit` | `internal/llm/tools/edit.go` | 文本替换式编辑 | 是 |
| `write` | `internal/llm/tools/write.go` | 整文件写入 | 是 |
| `patch` | `internal/llm/tools/patch.go` | 多文件原子补丁 | 是 |
| `view` | `internal/llm/tools/view.go` | 文件查看（带行号） | 否 |
| `glob` | `internal/llm/tools/glob.go` | 文件名模式匹配 | 否 |
| `grep` | `internal/llm/tools/grep.go` | 内容搜索 | 否 |
| `ls` | `internal/llm/tools/ls.go` | 目录树浏览 | 否 |
| `fetch` | `internal/llm/tools/fetch.go` | URL 抓取 | 是 |
| `sourcegraph` | `internal/llm/tools/sourcegraph.go` | 公开代码搜索 | 否 |
| `diagnostics` | `internal/llm/tools/diagnostics.go` | LSP 诊断 | 否 |
| `agent` | `internal/llm/agent/agent-tool.go` | 子 agent（只读） | 否 |
| MCP tools | 动态加载 | 外部扩展工具 | 按工具类型 |

源码引用：
- `internal/llm/agent/tools.go:14-38` — `CoderAgentTools()` 注册所有 coder 工具
- `internal/llm/agent/tools.go:43-49` — `TaskAgentTools()` 只注册只读工具

### 2.2 工具可用性控制

**没有运行时工具动态启用/禁用机制**。工具集在 agent 创建时固定（`internal/app/app.go:64`），不同 agent 类型获得不同的工具子集：

```go
// internal/llm/agent/tools.go:14
func CoderAgentTools(...) []tools.BaseTool {
    return append([]tools.BaseTool{
        tools.NewBashTool(permissions),
        tools.NewEditTool(...),
        tools.NewWriteTool(...),
        // ... 完整工具集
        NewAgentTool(sessions, messages, lspClients),
    }, otherTools...)
}

// internal/llm/agent/tools.go:43
func TaskAgentTools(lspClients map[string]*lsp.Client) []tools.BaseTool {
    return []tools.BaseTool{
        tools.NewGlobTool(),
        tools.NewGrepTool(),
        tools.NewLsTool(),
        tools.NewSourcegraphTool(),
        tools.NewViewTool(lspClients),
    }
}
```

**设计决策**：通过 agent 类型而非 mode 切换控制工具集。子 agent（task agent）天生只有只读工具，无法修改文件。

---

## 3. 模式管理

### 3.1 Agent 类型（非 mode）

OpenCode 定义了 4 种 agent 类型，但它们是**独立的 agent 实例**，不是同一 agent 的不同 mode：

```go
// internal/config/config.go:37-43
type AgentName string

const (
    AgentCoder      AgentName = "coder"      // 主编码 agent，完整工具集
    AgentSummarizer AgentName = "summarizer"  // 会话摘要
    AgentTask       AgentName = "task"        // 只读子 agent
    AgentTitle      AgentName = "title"       // 生成会话标题
)
```

每种 agent 有独立的 model 配置（`internal/config/config.go:48`）：

```go
type Agent struct {
    Model           models.ModelID `json:"model"`
    MaxTokens       int            `json:"maxTokens"`
    ReasoningEffort string         `json:"reasoningEffort"`
}
```

### 3.2 没有 mode 切换

TUI 中没有 plan mode / edit mode / ask mode 的切换机制。用户只有一个交互模式：输入 prompt → agent 自主执行。

唯一的状态切换是 **模型选择对话框**（`ctrl+o`），允许用户在运行时切换模型（`internal/tui/tui.go:503-509`）。

### 3.3 非交互模式

通过 `opencode -p "prompt"` 运行时进入非交互模式（`internal/app/app.go:141-181`），此模式自动批准所有权限请求（`a.Permissions.AutoApproveSession(sess.ID)`）。

---

## 4. Prompt 模板

### 4.1 Prompt 体系

```
GetAgentPrompt() ──┬── AgentCoder → CoderPrompt()
                   ├── AgentTask → TaskPrompt()
                   ├── AgentTitle → TitlePrompt()
                   └── AgentSummarizer → SummarizerPrompt()
```

源码：`internal/llm/prompt/prompt.go:11-29`

### 4.2 Coder Prompt 分析

Coder prompt 分为两种变体（`internal/llm/prompt/coder.go`）：

- **Anthropic 变体**（`baseAnthropicCoderPrompt`）：详细的行为指南，包含 Memory、Tone/Style、Proactiveness、Following Conventions、Code Style、Doing Tasks 等章节。强调简洁（"fewer than 4 lines"）、不要不必要的解释。
- **OpenAI 变体**（`baseOpenAICoderPrompt`）：更偏向 OpenAI coding agent 规范，强调 patch 和 git 操作。

两者都**没有 plan 相关指令**。agent 被告知直接执行任务（"You are an agent - please keep going until the user's query is completely resolved"）。

### 4.3 Context Paths（记忆机制）

Prompt 系统会自动加载项目级指令文件（`internal/config/config.go:108-116`）：

```go
var defaultContextPaths = []string{
    ".github/copilot-instructions.md",
    ".cursorrules",
    ".cursor/rules/",
    "CLAUDE.md",
    "CLAUDE.local.md",
    "opencode.md",
    "opencode.local.md",
    "OpenCode.md",
    "OpenCode.local.md",
    "OPENCODE.md",
    "OPENCODE.local.md",
}
```

这是 OpenCode 的 "memory" 机制——通过文件注入持久化指令，而非运行时状态。

### 4.4 Task Agent Prompt

```go
// internal/llm/prompt/task.go:10-14
"You are an agent for OpenCode. Given the user's prompt, you should use the tools 
available to you to answer the user's question."
```

极其简洁——子 agent 不需要 plan，只需要搜索和返回结果。

---

## 5. 用户交互与权限系统

### 5.1 权限模型

OpenCode 的核心人机交互机制是**权限审批**，不是 mode 切换：

```go
// internal/permission/permission.go:43-47
type CreatePermissionRequest struct {
    SessionID   string
    ToolName    string
    Description string
    Action      string
    Params      any
    Path        string
}
```

**三级审批**（`internal/tui/components/dialog/permission.go:18-21`）：

| 操作 | 效果 |
|------|------|
| Allow (a) | 仅批准本次操作 |
| Allow for session (s) | 批准该工具+action+path 组合在整个 session 内有效 |
| Deny (d) | 拒绝，终止后续 tool call |

### 5.2 安全命令白名单

Bash 工具有只读命令白名单（`internal/llm/tools/bash.go:50-56`），白名单内的命令自动跳过权限审批：

```go
var safeReadOnlyCommands = []string{
    "ls", "echo", "pwd", "date", ...
    "git status", "git log", "git diff", ...
    "go version", "go test", "go build", ...
}
```

### 5.3 持久权限

`GrantPersistant()` 将权限存储在 session 级别，后续相同 tool+action+path 组合自动通过（`internal/permission/permission.go:64-68`）。

### 5.4 文件安全检查

Edit/Write/Patch 工具实现"读后写"安全机制（`internal/llm/tools/edit.go:155-163`）：

1. 必须先用 View 工具读取文件（`getLastReadTime` 检查）
2. 文件在读取后被修改会报错（modTime > lastRead）

---

## 6. 执行流程

### 6.1 主循环

```
User prompt → agent.Run() → processGeneration() → loop {
    streamAndHandleEvents() → tool call → tool.Run() → 
    permission check → execute → tool result → continue loop
} → final response
```

源码：`internal/llm/agent/agent.go:256-310`

### 6.2 子 Agent（Agent Tool）

Coder agent 可以通过 `agent` tool 启动只读子 agent：

```go
// internal/llm/agent/agent-tool.go:57
agent, err := NewAgent(config.AgentTask, b.sessions, b.messages, TaskAgentTools(b.lspClients))
```

子 agent 特点：
- 只有 Glob/Grep/LS/Sourcegraph/View 工具
- 单次执行，无状态，结果直接返回给父 agent
- 可并行启动多个（"Launch multiple agents concurrently whenever possible"）
- 用途：代码搜索、信息收集

### 6.3 上下文压缩

OpenCode 有会话摘要（compact）功能（`internal/llm/agent/agent.go:357-461`）：
1. 用户触发 `/compact` 命令
2. 使用 Summarizer agent 生成对话摘要
3. 截断历史消息，保留摘要作为新的对话起点

这不是 plan，而是上下文管理。

---

## 7. TUI 组件

### 7.1 对话组件

| 组件 | 文件 | 功能 |
|------|------|------|
| Permission Dialog | `dialog/permission.go` | 工具权限审批，带 diff 预览 |
| Model Dialog | `dialog/models.go` | 模型切换 |
| Command Palette | `dialog/commands.go` | 命令面板（`/compact`, `/init` 等） |
| Init Dialog | `dialog/init.go` | 项目初始化确认 |
| Arguments Dialog | `dialog/arguments.go` | 多参数命令输入 |
| Help Dialog | `dialog/help.go` | 快捷键帮助 |
| File Picker | `dialog/filepicker.go` | 文件选择器 |
| Theme Dialog | `dialog/theme.go` | 主题切换 |
| Quit Dialog | `dialog/quit.go` | 退出确认 |
| Session Dialog | `dialog/session.go` | 会话管理 |

### 7.2 权限对话框设计

Permission Dialog 是最关键的交互组件（`dialog/permission.go`）：

- 显示 Tool Name、Path、Diff/Command 内容
- 三个按钮：Allow / Allow for session / Deny
- 支持 `a`/`s`/`d` 快捷键直接选择
- 内容区域使用 viewport 支持滚动查看大 diff
- 不同工具类型有不同渲染逻辑（bash 显示命令、edit/write 显示 diff）

### 7.3 内置命令

TUI 注册了两个内置命令（`internal/tui/tui.go:916-948`）：

1. **`/init`** — 生成/改进 OpenCode.md 项目记忆文件
2. **`/compact`** — 触发会话摘要

### 7.4 编辑器

输入区域是 `textarea` 组件（`chat/editor.go`），支持：
- `enter` / `ctrl+s` 发送消息
- `ctrl+e` 打开外部编辑器（$EDITOR）
- 附件管理（图片粘贴，最多 5 个）
- Tab 补全（`dialog/complete.go`）

---

## 8. 对 Pi Plan 扩展的启示

### 8.1 OpenCode 的 "Plan" 等价物

OpenCode 没有 plan mode，但通过以下机制隐式实现了 plan 的部分功能：

| Plan Mode 功能 | OpenCode 的替代 |
|----------------|-----------------|
| 分析阶段 | agent 自主使用 View/Grep/Glob 探索代码 |
| 制定方案 | LLM 的 thinking（extended thinking） |
| 用户确认 | 权限审批系统（每步操作可审批/拒绝） |
| 分阶段执行 | 无，agent 直接连续执行 |
| 工具限制 | 子 agent 只有只读工具 |

### 8.2 可借鉴的设计

1. **权限审批作为"检查点"**：OpenCode 的权限系统实际上充当了"plan → confirm → execute"中的 confirm 环节。每个写操作都需要用户审批，diff 预览让用户看清将要发生的变化。这比纯 plan mode 更细粒度。

2. **子 Agent 模式**：`agent` tool 创建只读子 agent 做搜索，天然实现了"分析阶段不修改"的隔离。Pi 的 subagent 已经实现了类似功能。

3. **读后写安全**：edit/write 工具要求先 view 再 edit，且检查文件修改时间。这是防止 agent 基于过时信息做修改的好机制。

4. **Context Paths 记忆机制**：自动加载多种格式的规则文件（CLAUDE.md、.cursorrules 等），降低了用户配置成本。Pi 的 claude-rules-loader 已有类似功能。

### 8.3 OpenCode 方案的局限

1. **无显式 plan 输出**：用户看不到 agent 的执行计划，只能在操作时逐个审批。对于复杂任务，用户难以把握全局。
2. **无法冻结执行**：没有"只分析不执行"的模式。要阻止 agent 执行，只能逐个 deny 权限请求。
3. **无计划修订**：agent 不会在执行前展示计划让用户修改方向。
4. **依赖 LLM 自律**：prompt 中要求 agent "think before you act"，但这是软约束，没有系统级保障。

### 8.4 对 Pi Plan 扩展的设计建议

1. **Plan ≠ Mode，Plan = 工具**：与其做 mode 切换（plan mode / code mode），不如让 plan 成为一个可调用的工具/命令。用户随时可以触发 plan，plan 输出是一个结构化文档而非执行状态。

2. **Plan 的价值在"全局预览"**：OpenCode 逐工具审批的粒度太细（每个文件编辑都要审批），而 plan mode 的价值是提供全局视角。Pi plan 应该输出完整的执行计划（文件列表、变更概要、依赖关系），让用户一次审批一个完整方案。

3. **Plan 输出应可持久化**：OpenCode 的 Context Paths 机制表明用户喜欢持久化配置。Plan 应该能保存为文件（如 `.xyz-harness/plan.md`），后续可引用、修订、对比。

4. **Plan 不应限制工具**：OpenCode 的子 agent 只有只读工具，这过度限制了分析能力。Plan 阶段应该可以使用所有工具（包括 bash），只是不执行写入操作。写入操作由 plan 的执行阶段触发。

5. **权限系统与 plan 协同**：Pi 的 plan 执行阶段可以借鉴 OpenCode 的 "Allow for session" 模式——用户批准 plan 后，plan 内的操作可以批量自动执行，无需逐个审批。
