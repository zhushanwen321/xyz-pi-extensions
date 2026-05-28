# xyz-pi-extensions

Pi coding agent 的扩展工具箱。每个扩展是一个独立可安装的 Pi 插件，解决 AI coding agent 工作流中的特定问题。

## Pi 平台

**Extension**
TypeScript 模块，通过 `export default function(pi: ExtensionAPI)` 注册到 Pi 运行时。可注册 Tool、Command、Event Handler、UI 组件。放置于 `~/.pi/agent/extensions/` 或 `.pi/extensions/`。
_Avoid_: 插件（口语可，正式文档用 Extension）

**ExtensionAPI**
Pi 传递给 Extension 工厂函数的 API 对象。提供 `registerTool()`、`registerCommand()`、`on()`、`registerMessageRenderer()`、`appendEntry()` 等方法。

**Tool**
Extension 通过 `pi.registerTool()` 注册的能力单元。定义 name、parameters schema、execute handler、renderCall/renderResult。模型通过 function calling 调用。
_Avoid_: 工具（口语可，正式文档用 Tool）

**Command**
Extension 通过 `pi.registerCommand()` 注册的用户命令，以 `/` 开头。用户在编辑器中输入触发，不由模型调用。

**Event**
Pi 运行时生命周期事件。Extension 通过 `pi.on(event, handler)` 监听。核心事件：`session_start`、`before_agent_start`、`agent_start`、`turn_end`、`message_end`、`agent_end`、`session_shutdown`。

**Session**
一次 Pi 对话的完整生命周期。以 JSONL 文件持久化，支持树状分支。状态通过 `ctx.sessionManager` 访问。

**Entry**
Session 中的单条记录。`ctx.sessionManager.getEntries()` 返回全部，`ctx.sessionManager.getBranch()` 返回当前分支。Extension 通过 `pi.appendEntry(type, data)` 写入自定义记录，通过 `type === "custom" && customType === "..."` 读取。
_Avoid_: 记录、条目

**CustomEntry**
带 `customType` 字段的 Entry，用于 Extension 持久化私有状态。写入：`pi.appendEntry("my-type", data)`；读取：过滤 `entry.type === "custom" && entry.customType === "my-type"`。

**Theme**
TUI 颜色系统。通过 `ctx.ui.theme.fg(token, text)` 使用语义 token（如 "toolTitle"、"success"、"error"）着色，不硬编码 ANSI。

**Agent**
`.md` 文件定义的 agent 配置，包含 frontmatter（name、description、tools）和 body（systemPrompt）。放置于 `~/.pi/agent/agents/`（user 级）或 `.pi/agents/`（project 级）。

**Context Files**
`AGENTS.md` 或 `CLAUDE.md`，作为系统提示词的一部分加载。从 `~/.pi/agent/`、父目录、当前目录自动发现并拼接。

**Skill**
On-demand 能力包，Markdown 格式。通过 `/skill:name` 触发或由 agent 自动加载。放置于 `~/.pi/agent/skills/`、`~/.agents/skills/`、`.pi/skills/`。

**Prompt Template**
可复用的提示词模板，Markdown 格式，支持 `{{variable}}` 插值。通过 `/name` 展开。

**Steering**
Pi 的消息投递机制之一。`deliverAs: "steer"` 在当前 assistant turn 执行完 tool call 后注入，高优先级。用于目标更新、预算警告等需要立即响应的场景。
_Avoid_: 舵向、引导

**Follow-up**
Pi 的消息投递机制之一。`deliverAs: "followUp"` 在 agent 完成所有工作后注入，低优先级。用于常规 continuation。

**Compaction**
长 session 的上下文压缩机制。将旧消息摘要，保留近期消息。有损操作，完整历史保留在 JSONL 中。

**Pi Package**
Extension + Skill + Prompt Template + Theme 的分发单元，通过 npm 或 git 安装。

## 本项目概念

### Goal

**Goal**
用户通过 `/goal <objective>` 发起的持久化自主循环。有预算约束、7 态状态机、任务清单、stall 检测。保证目标一定被完成或被显式取消。
_Avoid_: 目标（口语可，正式文档用 Goal）

**GoalStatus**
Goal 的生命周期状态，共 7 种：
- `active` — 唯一驱动 agent 循环的状态
- `paused` — 用户暂停，不计时不消耗 turn
- `blocked` — 连续无进展触发，可 resume
- `complete` — 终态，所有任务完成且有证据
- `budget_limited` — 终态，token 预算耗尽
- `time_limited` — 终态，时间预算耗尽
- `cancelled` — 终态，用户清除
终态不可被覆盖。

**GoalTask**
Goal 内的可追踪工作单元。每个 GoalTask 有四种状态：`pending`（未开始）、`in_progress`（执行中）、`completed`（已完成，必须提供 **Evidence**）、`cancelled`（已取消，不阻碍 goal 完成）。ID 为递增整数。终态（completed / cancelled）不可再变更。
_Avoid_: 任务（指 Goal 的 task 时用 GoalTask，避免与通用"任务"混淆）

**Evidence**
完成任务（`complete_task`）或完成目标（`complete_goal`）时必须提供的具体验证信息。如"测试 X 通过"、"文件 F 已创建"。防止无证据标记完成。

**Budget**
Goal 的资源约束，包含四个维度：
- **Token Budget** — token 消耗上限
- **Time Budget** — 墙钟时间上限（分钟）
- **Max Turns** — 最大 agent turn 数（默认 50，上限 100）
- **Max Stall Turns** — 连续无进展轮数阈值（默认 5，上限 20），触发 blocked

**Stall**
连续无 **GoalTask** 完成的 turn 数。达到 `maxStallTurns` 时 Goal 自动转为 `blocked`。

**Steering Template**
Goal 扩展的四种提示词模板：
- **Continuation** — 每个 agent turn 结束时注入，驱动下一轮工作
- **Budget Limit** — token 预算达 90% 时注入，引导收尾
- **Objective Updated** — 用户 `/goal update` 修改目标时注入
- **Context Injection** — `before_agent_start` 时注入，提供当前 Goal 上下文

**Budget Warning**
预算消耗的两阶段预警：70% 提示注意，90% 提示收尾。token 和时间预算共享预警 flag。

### Todo

**Todo**
轻量级三态任务项：`pending` / `in_progress` / `completed`。无预算、无状态机、无 Evidence 要求。agent 的短期工作记忆，3-8 项为宜。`add` 和 `delete` 操作只接受数组参数（批量），单条操作通过长度为 1 的数组实现。
_Avoid_: 待办

### Subagent

**Subagent**
通过 `spawn("pi", ["--mode", "json"])` 启动独立操作系统进程执行委派任务。与主 agent 进程隔离，拥有独立对话历史。主 agent 与 Subagent 之间通过 task prompt（下行）和 stdout JSON 事件流（上行）通信。

**Execution Mode**
Subagent 的四种执行模式：
- **Single** — 一个 agent 执行一个 task，阻塞等待
- **Parallel** — 多个 agent 并发执行多个独立 task
- **Chain** — 多个 agent 串行执行，前一步输出通过 `{previous}` 占位符传递给下一步
- **Background** — 异步运行的 Single 模式，完成后自动注入结果到主对话

**AgentScope**
Agent 定义文件的发现范围：`user`（`~/.pi/agent/agents/`）、`project`（`.pi/agents/`）、`both`。

**TaskComplexity**
任务复杂度等级，用于自动模型选择：`low`（简单快速）、`medium`（中等）、`high`（复杂）。从 `~/.pi/agent/subagent-models.json` 读取模型映射。

**ThinkingLevel**
模型的推理深度：`high`（标准推理）或 `max`（最大推理）。按 TaskComplexity 默认：low→high, medium→high, high→max。

**Background Job**
`background: true` 模式下的 Subagent 运行实例。结果通过 Pi 的 `sendMessage({ deliverAs: "followUp", triggerTurn: true })` 自动注入到主对话，无需轮询。

### UsageTracker

**UsageStats**
`~/.pi/agent/usage-stats.json` 文件，记录 skill 全文加载次数和 agent 调用次数。由 usage-tracker extension 维护，read-before-write 防跨 session 覆盖。

**EvolutionData**
`~/.pi/agent/evolution-data/` 目录，存储 Agent 自我进化所需的信号数据：
- `daily/YYYY-MM-DD.json` — 每日汇总（工具调用、token 消耗、skill 触发、agent 调用按天聚合）
- `tool-stats.json` — 工具执行累积统计（按工具名的调用次数、失败次数、累计耗时）
- `skill-triggers.json` — Skill 触发累积统计（触发次数、最后触发时间）
- `session-manifest.json` — Session 清单（sessionId、cwd、起止时间、turn 数、总 token）

**TurnBuffer**
内存中的单轮信号缓冲区。在 `before_agent_start` 时重置，在 `agent_end` 时 flush 到 DailySummary。采集内容：toolCalls、tokenUsage、skillTriggers、agentCalls。

**DailySummary**
按日期聚合的进化信号汇总。由 TurnBuffer 逐轮累积，在每次 `agent_end` 时写入磁盘。同一天的多次 session 数据会被合并到同一个 DailySummary 中。

### EvolutionEngine

**Evolution Engine**
自我进化闭环 Extension。安装于 `~/.pi/agent/extensions/evolution-engine/`。注册 `/evolve`、`/evolve-apply`、`/evolve-stats`、`/evolve-rollback` 四个 command。通过 spawn 独立 Pi 子进程调用 LLM Judge，通过文件系统 I/O 应用修改。
_Avoid_: 进化引擎

**LLM Judge**
运行在独立 Pi 子进程（`spawn("pi", ["--mode", "json", "-p"])`）中的演进分析器。固定使用 `glm-5.1` 模型，只读访问信号数据，输出结构化 `EvolutionSuggestion[]` JSON。不修改任何文件。
_Avoid_: Judge Subagent

**EvolutionSuggestion**
LLM Judge 产出的单条进化建议。包含：id (UUID)、target (claude-md/skill)、targetPath、severity (high/medium/low)、confidence (0-1)、title、description、rationale、diff (unified format)、status (pending/approved/rejected/applied/failed)。

**PendingFile**
`~/.pi/agent/evolution-data/suggestions/pending.json`，存储当前待审批的 EvolutionSuggestion 列表。`/evolve` 写入，`/evolve-apply` 读取。

**EvolutionHistory**
`~/.pi/agent/evolution-data/history.jsonl`，每行一条 JSON 记录每次 apply/rollback 操作（timestamp、action、suggestionId、targetPath、backupPath、diff）。

**AutoTriggerFlag**
`~/.pi/agent/evolution-data/auto-trigger.flags/` 下的标志文件。monitor.ts 在 session_start 时检查 token/skill/error 三个维度的阈值，命中时写入对应 flag 文件（24h 去重）。不自动执行分析，仅在下次 session 开始时提示用户。

**Applier**
Evolution Engine 的建议应用引擎。执行流程：预检查 diff 可应用性 → 备份原文件 → 写入 diff → git commit（如有仓库）→ 记录 history。diff 应用失败时跳过该条并标记 failed，不中断后续建议。

### InfiniteContext

**Segment**
每次 user message 触发的所有 agent turn 组成的工作单元。是树压缩的叶子节点。段边界仅依据新的 user message，不做语义分析。
_Avoid_: 分段、块（口语可，正式文档用 Segment）

**Tree Compact**
通过 subagent 调用主模型，对所有历史 Segment 一次性构建摘要树的操作。替代 Pi 原生 compaction。在 `turn_end` 中同步执行，不停止对话。
_Avoid_: 树压缩（口语可，正式文档用 Tree Compact）

**TreeNode**
树压缩产出的节点，类型为 `group`（分组节点，含 children）或 `leaf`（叶子节点，对应一个 Segment）。不在树中的 Segment 及其子孙被隐式 drop。
_Avoid_: 节点（口语可，正式文档用 TreeNode）

**Recall**
LLM 主动检索被压缩内容的工具。两次调用模式：`mode: "structure"` 返回子树结构（不含原始内容），`mode: "content"` 返回指定节点的完整原始 messages。
_Avoid_: 召回、检索（口语可，正式文档用 Recall）

**Tree-Context**
InfiniteContext 扩展独立估算的实际发给 LLM 的 token 数量。使用 chars/4 启发式，区别于 Pi 的 `getContextUsage()`（基于原始 entries，不反映压缩效果）。用于压缩触发判断和状态显示。
_Avoid_: 树上下文（口语可，正式文档用 Tree-Context）

**NodeId**
每个 TreeNode 的唯一标识符。格式为 `seg_N`（leaf）或 `gN`（group）。LLM 通过 NodeId 调用 Recall 检索该节点子树。全局唯一。
_Avoid_: 节点ID（口语可，正式文档用 NodeId）

### Workflow

**Workflow**
基于 `worker_threads` 的多 Agent 编排引擎。用户编写 JS 脚本描述任务流程（`agent()`/`parallel()`/`pipeline()`），脚本在 Worker 线程中执行，通过消息传递与主线程通信。
_Avoid_: 工作流（口语可，正式文档用 Workflow）

**Worker Script**
用户编写的 Workflow 定义文件（`.pi/workflows/*.js`）。运行在 Worker 线程中，可调用 `agent()`、`parallel()`、`pipeline()` 等全局函数。支持 `$ARGS`、`$WORKSPACE`、`$BUDGET` 全局变量。

**AgentPool**
Workflow 内部管理的 Pi 子进程池。以 FIFO 顺序调度 agent 调用，受 `maxConcurrency` 限制。自动重试 3 次（指数退避）。

**CallCache**
Workflow 暂停/恢复时的 agent 调用结果缓存。已完成的调用在恢复时从缓存重放，不重新执行。

## Flagged Ambiguities

**"任务"同时存在于 Goal（GoalTask）和 Todo（Todo item）**
两者定位不同：GoalTask 要求 Evidence，是完成目标的强制路径；Todo 是可选的轻量备忘。在 Goal 激活时不应同时使用 Todo 追踪同类工作。

## Example Dialogue

> **Dev**: 我要让 goal 扩展支持时间预算，达到上限就自动终止。
>
> **Expert**: 你的 **GoalStatus** 已经有 `budget_limited`，但那是给 token 用的。你要加一个新终态还是复用它？
>
> **Dev**: 加一个 `time_limited`。token 和时间是两个独立的预算维度，终态应该分开，这样用户知道是哪种资源耗尽了。
>
> **Dev**: 现在子任务完成后我不想每次都手动调用 complete_task。可以让 **Todo** 自动追踪吗？
>
> **Expert**: 不建议。**GoalTask** 要求 **Evidence**，这是核心设计——防止模型跳过验证。**Todo** 没有这个保证。在 Goal 激活时，用 GoalTask，不用 Todo。
