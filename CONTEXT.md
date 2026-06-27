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

**Plan Mode**
用户通过 `/plan [描述]` 触发的轻量级规划模式。融合 brainstorming + writing-plans 能力，产出 plan 文件。退出后可衔接 Goal 执行。与 Coding Workflow 的区别：无 gate/review/retrospect。产出物存储在项目 `.xyz-harness/{slug}/plan.md`。
_Avoid_: 规划模式（口语可，正式文档用 Plan Mode）

**Plan File**
Plan Mode 的产出物，存储在 `.xyz-harness/{slug}/plan.md`（相对于项目根目录）。含 YAML frontmatter（template, created, status）和模板章节。生命周期：随项目 `.xyz-harness/` 目录管理。

**Plan Template**
Plan 文件的模板结构，内置 5 种（feature-plan, bugfix-plan, refactor-plan, research-plan, implementation-plan），支持用户自定义。存放位置：全局 `~/.pi/agent/plan-templates/`，项目级 `<project>/.pi/plan-templates/`。

**Brainstorming**
Plan Mode 的需求探索阶段（Phase B）。包含 Quick Overview、渐进式提问、方案探索、假设审计四个步骤。借鉴 xyz-harness-brainstorming skill 但更精简。

### Goal

**Goal**
用户通过 `/goal <objective>` 发起的持久化自主循环。有预算约束、7 态状态机、与 Todo 扩展集成的任务清单。保证目标一定被完成、被阻塞、或被资源耗尽兜底终止。V2 重构后 Goal 不再内嵌任务系统，统一通过 Todo 扩展管理任务。
_Avoid_: 目标（口语可，正式文档用 Goal）

**GoalStatus**
Goal 的生命周期状态，共 7 种：
- `active` — 唯一驱动 agent 循环的状态
- `paused` — 用户主动暂停，不计时不消耗预算，可恢复
- `blocked` — agent 主动报告卡住，与 paused 行为对称（不续跑/不消耗预算），可恢复
- `complete` — 终态，所有任务（含验证任务）完成且有证据
- `budget_limited` — 终态，token 预算耗尽
- `time_limited` — 终态，时间预算耗尽
- `cancelled` — 终态，用户清除
终态不可被覆盖。状态转换严格三分层：agent（complete/blocked）、用户（pause/resume/clear）、系统（budget/time_limited）。

**Evidence**
Agent 声明 goal 完成时必须提供的具体验证信息（如"测试 X 通过"、"文件 F 已创建"）。防止无证据标记完成。完成前置检查还要求任务清单中所有任务（含验证任务）已完成。

**Budget**
Goal 的资源约束，两个维度（V2 重构删除了 Max Turns 和 Max Stall Turns，对齐 Codex）：
- **Token Budget** — token 消耗上限
- **Time Budget** — 墙钟时间上限（分钟）
资源耗尽由持久化单一检查点兜底判定（不依赖分散的事件检查），转 `budget_limited` / `time_limited` 终态。

**Verification Todo（验证任务）**
Todo 清单中标记 `isVerification: true` 的任务项。Agent 完成一个 goal 前必须建执行任务与验证任务，且验证任务不可取消（必须 completed），作为 completion audit 的硬检查依据。

**Stall（已废弃概念）**
V2 重构删除了 stallCount/maxStallTurns 自动终态机制（对齐 Codex）。停滞检测退化为基于单任务级 `lastUpdatedTurn` 的提示词提醒（注入 staleness reminder），不再自动转 blocked。

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
任务管理扩展。V2 重构后是 Goal 任务管理的**唯一来源**（Goal 不再内嵌任务系统）。Todo 项四态：`pending` / `in_progress` / `completed` / `cancelled`，可选字段 `isVerification?: boolean` 标记验证任务（completion audit 硬检查依据，不可取消）。`add` 和 `delete` 操作只接受数组参数（批量），单条操作通过长度为 1 的数组实现。Goal 通过只读快照接口读取 Todo 进度（瞬态快照，未加载时 Goal 降级运行但完成能力受限）。
_Avoid_: 待办

### Subagent

**Subagent**
通过 Pi SDK `createAgentSession()` 在进程内创建独立 session 执行委派任务。与主 agent 共享进程，拥有独立对话历史（`SessionManager.inMemory`）。主 agent 与 Subagent 之间通过 task prompt（下行）和 `session.subscribe()` 事件回调（上行）通信。
_Avoid_: 子 agent（口语可，正式文档用 Subagent）

**AgentRuntime**
`@zhushanwen/pi-agent-runtime` 包，Subagent 执行的底层运行时（L1+L2）。提供 agent session 管理、agent 发现、配置合并、模型解析、tool 过滤、并发控制、事件桥接等能力。编排层（workflow）通过 `runAgent()` 或 `createSession()` 调用。
_Avoid_: 运行时（口语可，正式文档用 AgentRuntime）

**ManagedSession**
AgentRuntime 提供的可控 agent session。创建后可多次 `prompt()`、`steer()`、`abort()`，不自动销毁。供编排层的多步执行（chain）使用。与 Pi SDK `AgentSession` 的关系：ManagedSession 封装了 AgentSession + turn tracking + soft limit + event bridging。

**Execution Mode**
Workflow 脚本中 Subagent 的执行模式（由编排层定义，AgentRuntime 不感知编排模式）：
- **Single** — 一个 agent 执行一个 task，阻塞等待
- **Parallel** — 多个 agent 并发执行多个独立 task
- **Pipeline** — 多个 agent 串行执行，前一步输出作为参数传递给下一步

**AgentScope**
Agent 定义文件的发现范围：`user`（`~/.pi/agent/agents/`）、`project`（`.pi/agents/`）、`both`。

**TaskComplexity**
任务复杂度等级，用于自动模型选择：`low`（简单快速）、`medium`（中等）、`high`（复杂）。从 `~/.pi/agent/subagent-models.json` 读取模型映射。

**ThinkingLevel**
模型的推理深度：`high`（标准推理）或 `max`（最大推理）。按 TaskComplexity 默认：low→high, medium→high, high→max。

**Background Job**
`background: true` 模式下的 Subagent 运行实例。结果通过 Pi 的 `sendMessage({ deliverAs: "followUp", triggerTurn: true })` 自动注入到主对话，无需轮询。

### Context Engineering

**Context Engineering**
Pi Extension，通过 `context` 事件在 LLM 调用前对消息做渐进式压缩。增强（不替代）原生 Compaction。
_Avoid_: 上下文工程

**L0 / L1 / L2**
三级压缩管道：
- **L0** — 零成本客户端清理（过期 toolResult、截断 bash output、清理 thinking）
- **L1** — 规则化摘要（正则提取关键行）
- **L2** — 紧急截断（强制过期 Protected Turn 外的 toolResult）

**RecallStore**
内存 Map，存储被压缩消息的原始内容。ID 格式 `ctx-{12hex}`。无持久化，`session_start` 时重建。

**Recall**
LLM 通过 `recall_context` 工具按 ID 获取被压缩前的原始内容。Context Engineering 压缩的可逆性保障。

**Protected Turn**
最近 N 个 Turn Boundary，其中的 toolResult 不被过期或强制截断。N 由 `protectRecentTurns` 配置（默认 2）。

**Turn Boundary**
以 user 消息为分界的消息分组，用于判断 Protected Turn 范围。

### Evolve 自进化系统

**Detector**
被动观测器。监听 Pi 事件 → match() → appendEntry() 写入数据，不解入 AI 行为。适用于 compact 频率、tool 错误率等纯统计场景。AI 不知道自己在被追踪。
_Avoid_: 检测器

**Tracker**
主动引导器。监听 Pi 事件 → steering 注入 → AI 调用 tool 汇报状态 → 状态机流转。适用于 skill 使用、错误修复等需要 AI 自我汇报的场景。
_Avoid_: 追踪器

**TrackedItem**
Tracker 状态机中的单个实例。包含 id、name、status（loaded/completed/error/recorded）、metadata、anchor。由 createTracker 工厂函数管理生命周期。

**Anchor**
TrackedItem 中的数据锚点字段（triggerType/triggerTurn/triggerSummary），记录触发事件的时间位置和摘要。供 L3 Python extractor 在 session JSONL 中定位原始上下文。

**Sample**
L3 extractor 从 session JSONL 提取的叙事级上下文片段。包含 trigger_context、ai_response、turns_to_complete 等字段。附加到 daily-report.json 的 issue 中，供 L4 /evolve LLM 进行具体分析。

### Workflow

**External State Pointer**
session JSONL 中指向外部 state 文件的轻量 entry（`customType === "workflow-state-link"`），字段含 runId、path、updatedAt。用于替代内联 state 持久化，解决主 JSONL 膨胀问题。
_Avoid_: reference, alias, stub

**State-Lost**
workflow 终态，表示外部 state 文件不可读（删除/损坏/权限拒绝），无法 rehydrate。属 TERMINAL_STATUSES，无 outgoing transitions。
_Avoid_: broken, missing, dead

**Approval Memory**
session-level 持久化已确认 workflow 名称集合，通过 `workflow-approval-memory` entries 跨 session_start 重建。`workflow-run` tool 的 `auto` 模式走此 cache 避免重复弹 confirm UI。临时 workflow（`.tmp/` 目录）不进入此 cache。
_Avoid_: trust list, whitelist

**Verification Strategy**
workflow 节点验证模式分类，可选值 `internal` / `follow-up` / `none`。仅在 `ExecutionTraceNode.verifyStrategy?` 可选字段存在，**不**序列化到 JSONL。是 debug 辅助，不强制 AI 标注。
_Avoid_: check mode, validation level

## Flagged Ambiguities

**"压缩"同时存在于 Pi 原生（Compaction）和 Context Engineering（L0/L1/L2）**
Compaction 在 agent loop 外做 token 级 LLM 摘要（不可逆），Context Engineering 在 agent loop 内做消息级规则化处理（可逆 Recall）。两者互补不冲突。

**"任务"统一到 Todo（V2 重构已解决）**
V2 重构后 Goal 不再内嵌任务系统（GoalTask/TaskVerification/verified 已删除），任务管理统一到 Todo 扩展。Goal 通过只读快照接口读取 Todo 进度，验证任务由 Todo 的 `isVerification` 标记承载，完成审计（completion audit）以任务清单完成状态为唯一硬检查。

## Example Dialogue

> **Dev**: 我要让 goal 扩展支持时间预算，达到上限就自动终止。
>
> **Expert**: 你的 **GoalStatus** 已经有 `budget_limited`，但那是给 token 用的。你要加一个新终态还是复用它？
>
> **Dev**: 加一个 `time_limited`。token 和时间是两个独立的预算维度，终态应该分开，这样用户知道是哪种资源耗尽了。
>
> **Dev**: 现在子任务完成后我不想每次都手动调用 complete_task。可以让 **Todo** 自动追踪吗？
>
> **Expert**: V2 重构后正是如此——Goal 不再内嵌任务系统，统一用 **Todo** 管理任务。完成审计通过在 Todo 清单中标记 `isVerification: true` 的**验证任务**实现：agent 完成 goal 前必须先完成所有任务（含验证任务，且验证任务不可取消）并提交 **Evidence**。这样既保留了"防止模型跳过验证"的核心设计，又消除了两套任务系统的冲突。
