# Subagent Extension — 父规格（Consolidated Master Spec）

> **本文件是所有 subagent 子规格的索引和共享契约。**
> 整合自 5 个历史 spec（见底部"源规格映射表"），解决历史规格分散、术语漂移、架构边界不清的问题。
>
> Verdict: draft · Revision: 1.0 (2026-06-15)

---

## 1. 这个 extension 做什么

`@zhushanwen/pi-subagents` 让主 agent 把任务委派给**隔离的子 agent**（独立 session、独立 context、独立 model）运行。支持三种执行时机（同步 / 后台 / 查询）和四种编排模式（single / chain / parallel / fanout）。

核心设计原则：**进程内执行**（`createAgentSession()`，不 spawn 子进程），所有子 agent 共享主进程的 model registry 和 LLM API quota，但拥有独立的对话历史和工具集。

---

## 2. 两层架构（核心层 + 展示层）

这是整个 extension 的架构基石。历史问题的根因是**层边界模糊**——展示逻辑泄漏进执行逻辑，状态散落在 11 个形状里。本规格强制以下分层：

```
┌─────────────────────────────────────────────────────────────┐
│                    展示层（Presentation）                      │
│   tui/subagent-render.ts    — 对话流 block（single）           │
│   tui/orchestration-render.ts — 对话流 block（orchestration）  │
│   tui/subagents-view.ts     — /subagents list 全屏 overlay     │
│   tui/format.ts             — 格式化纯函数（tokens/events）     │
│                                                              │
│   契约：只读 AnyToolDetails，产出 string[]。不执行 agent、       │
│         不解析 model、不计数 turn。所有数据来自核心层。           │
└──────────────────────────┬──────────────────────────────────┘
                           │ AnyToolDetails（唯一数据契约）
                           │ （核心层 → 展示层的唯一桥梁）
┌──────────────────────────┴──────────────────────────────────┐
│                    核心层（Core）                              │
│   runtime.ts        — SubagentRuntime 单例（runAgent/bg/cancel）│
│   core/run-agent.ts — 一次执行的全生命周期                      │
│   core/event-bridge.ts — SDK 事件 → AgentEvent 翻译            │
│   state/             — 统一状态对象 AgentExecutionState        │
│   resolution/        — model/category/tool 解析                │
│   orchestration/     — chain/parallel/fanout DAG 执行          │
│   tools/subagent-tool.ts — LLM 工具入口（薄：dispatch + 投影）  │
│                                                              │
│   契约：产出 AnyToolDetails 给展示层。不关心怎么画。             │
└─────────────────────────────────────────────────────────────┘
```

### 层间契约（不可违反）

| 规则 | 说明 |
|------|------|
| **数据单向流** | 核心层 → 展示层。展示层**绝不**回写状态。 |
| **唯一桥梁** | `AnyToolDetails`（见 architecture.md §统一状态模型）。所有路径产出同一个类型。 |
| **展示层纯函数** | `buildRenderLines(details, width, theme)` 等是纯函数，输入 details 输出 string[]。不持有状态、不调 runtime。 |
| **核心层不画 UI** | 核心层不 import pi-tui 的 Box/Text/颜色。它只产出数据（AnyToolDetails）。 |
| **投影唯一入口** | 每种状态对象有且只有一个 `toDetails()` 方法投影到 AnyToolDetails。消灭 6 个手工构造点。 |

---

## 3. 子规格索引

| 子规格 | 层 | 内容 | 源规格 |
|--------|---|------|--------|
| **[architecture.md](./architecture.md)** | 跨层 | 统一状态模型、数据流、层契约、缺陷根因 | rethink 分析 |
| **[core-runtime.md](./core-runtime.md)** | 核心 | SubagentRuntime、runAgent、ManagedSession、ConcurrencyPool | agent-runtime-workflow FR-1/FR-7/FR-11 |
| **[core-state.md](./core-state.md)** | 核心 | AgentExecutionState（统一状态）、BgRecord、CompletedAgentRecord、HistoryStore | rethink + subagent-tui FR-3 |
| **[core-model.md](./core-model.md)** | 核心 | resolveModelForAgent、5 级 fallback、category、session 状态、YOLO | agent-runtime-workflow FR-3/FR-4 |
| **[core-orchestration.md](./core-orchestration.md)** | 核心 | chain/parallel/fanout DAG、ChainOutputMap、dynamic fanout、cancel | subagent-orchestration FR-O3/FR-O5 |
| **[core-background.md](./core-background.md)** | 核心 | startBackground、回注通知、merge window、dedup、per-agent defaultBackground | subagent-orchestration FR-O1/FR-O2/FR-O5 |
| **[core-session.md](./core-session.md)** | 核心 | 隔离 session、worktree、memory session、session file GC | agent-runtime-workflow FR-1 + memory-session |
| **[tui-conversation.md](./tui-conversation.md)** | 展示 | 对话流 block（single + orchestration）：compact/expanded、glyph、spinner、分隔符 | subagent-tui FR-2 + orchestration FR-O6.3/6.4 |
| **[tui-list.md](./tui-list.md)** | 展示 | /subagents list 全屏 overlay：Level 0/1/2、导航、cancel | subagent-tui FR-3 + orchestration FR-O6.6 |
| **[tui-format.md](./tui-format.md)** | 展示 | 格式化约定：tokens/duration/events 分隔符语义、truncation、ANSI 保留 | subagent-tui FR-1/FR-2 + impeccable 审查 |

---

## 4. 关键术语表（Glossary）

| 术语 | 定义 | 所属层 |
|------|------|--------|
| **AgentExecutionState** | 统一的 agent 执行状态对象。**所有路径（sync/bg/poll）的唯一数据源**。包含 id/agent/status/model/eventLog/turns/tokens/startedAt/endedAt/result/error。 | 核心 |
| **AnyToolDetails** | 核心层→展示层的唯一投影。`SubagentToolDetails \| OrchestrationToolDetails`。展示层只读这个类型。 | 跨层 |
| **AgentEvent** | SDK 事件翻译后的内部事件联合（tool_start/tool_end/text_delta/thinking_delta/turn_end/message_end/compaction/error）。 | 核心 |
| **AgentEventLogEntry** | eventLog 的一条记录（tool_start/tool_end/turn_end/text_output/thinking）。展示层渲染的基本单位。 | 跨层 |
| **AgentResult** | 一次 runAgent 的最终结果（text/usage/turns/durationMs/success/error/sessionId/toolCalls）。**完成后的权威源**。 | 核心 |
| **BgRecord** | 后台任务记录。内嵌 AgentExecutionState。存于 runtime._bgRecords。 | 核心 |
| **SubagentRuntime** | 进程单例。组合所有能力：runAgent/startBackground/getBackground/cancel/resolveModel/registry。 | 核心 |
| **DAG** | 有向无环图。orchestration 模式的执行结构（chain=线性，parallel=单层扇出，fanout=动态展开）。 | 核心 |
| **ChainOutputMap** | chain 模式的步骤间输出传递表 `Record<name, {text, structured?}>`。执行期中间数据，完成后清理。 | 核心 |
| **对话流 block** | Pi 对话流中以背景色渲染的 tool 输出区域（renderResult 返回的 Component）。 | 展示 |
| **全屏 overlay** | /subagents list 打开的全屏视图（ctx.ui.custom()），支持 j/k 导航。 | 展示 |

---

## 5. 执行模式总览

| 模式 | 触发 | 阻塞？ | 编排？ | 状态对象 | 渲染路径 |
|------|------|--------|--------|---------|---------|
| **single sync** | `subagent({task})` | 是 | 否 | AgentExecutionState（runtime map） | 对话流 block |
| **single background** | `subagent({task, wait:false})` | 否 | 否 | AgentExecutionState（BgRecord） | 对话流 block（live）+ 完成通知 |
| **poll** | `subagent({backgroundId})` | 是 | 否 | 读 BgRecord 内的 AgentExecutionState | 对话流 block |
| **chain** | `orchestrate({chain:[...]})` | 是* | 是 | 多个 AgentExecutionState + DAG | 对话流 block（orchestration） |
| **parallel** | `orchestrate({tasks:[...]})` | 是* | 是 | 同上 | 同上 |
| **fanout** | `orchestrate({chain:[{expand,...}]})` | 是* | 是 | 同上 + 动态展开 | 同上 |
| **orchestration async** | `orchestrate({...,async:true})` | 否 | 是 | BgRecord（聚合） | 对话流 block（live）+ 完成通知 |

`*` sync orchestration 阻塞调用者直到 DAG 完成；`async:true` 立即返回 runId。

---

## 6. 源规格映射表

本规格整合了以下 5 个历史规格。子规格中标注的"源"指回这些：

| 源规格目录 | 核心内容 | 映射到子规格 |
|-----------|---------|-------------|
| `2026-06-13-agent-runtime-workflow` | runtime 架构、runAgent、model 解析、registry、concurrency、workflow 集成 | core-runtime, core-model, core-session |
| `2026-06-14-subagent-tui` | 对话流 block 渲染、/subagents list、事件日志格式 | tui-conversation, tui-list, tui-format |
| `2026-06-14-subagent-orchestration` | chain/parallel/fanout、background 回注、orchestration TUI | core-orchestration, core-background, tui-conversation |
| `2026-06-13-spec-clarify` | （使用 subagent 的 skill，不定义 runtime 内部）— 仅确认隔离 context 原则 | core-session（隔离原则） |
| `2026-05-24-subagent-memory-session` | memory 参数、session 文件复用 | core-session（memory） |

### 已知的历史规格间矛盾（本规格已裁定）

| 矛盾 | 裁定 | 理由 |
|------|------|------|
| memory-session 用 `--fork`/`--session` CLI（spawn 架构）vs runtime-workflow 用 `createAgentSession()`（进程内） | **以进程内为准**。memory 功能需重新设计为 SessionManager 持久化（非 inMemory） | spawn 架构已废弃 |
| subagent-tui spec 说 spinner 用 `setInterval(250ms)` | **改为 seed-frame（事件驱动）** | setInterval 导致滚动锁死（Bug #4）；seed-frame 已验证可行 |
| subagent-tui spec 说 `alt+o` 展开 | **改为 `Ctrl+O`** | Pi 源码 keybindings.ts:85 确认是 ctrl+o |
| subagent-tui spec 第 1 行含硬编码 "subagent" 标题词 + 第 6 行独立 stats | **改为 inline：glyph + bold(agent) + dim(meta) + dim(·stats)** | impeccable 审查：信息内聚、消除记忆桥 |
| elapsedSeconds 有 6 个计算点（Math.floor vs Math.round 混用） | **统一存 startedAt 时间戳，投影时用唯一 helper** | 消灭不一致 |

---

## 7. 验收标准（跨规格汇总）

### 核心 API（AC-CORE）

1. `runAgent({agent:"worker", task:"Fix typo"})` 进程内创建 session，返回 AgentResult
2. AgentResult 含 text/usage/turns/durationMs/success/error/sessionId
3. `createManagedSession()` 支持多次 prompt/steer/abort（P2）
4. ConcurrencyPool 限制并发 + priority 排队（sync=0 高，bg=1000 低）
5. AbortSignal 触发 session abort，返回 partial result
6. `getRuntime()` 返回单例；session_start 前调用 resolveModel 抛清晰错误

### 状态一致性（AC-STATE）— **新增，针对 rethink 诊断的缺陷**

1. **三种路径（sync/bg-live/poll）产出的 AnyToolDetails 字段一致**：model/thinkingLevel/turns/totalTokens/elapsedSeconds 都正确填充，无 undefined 丢失
2. **poll 一个 running background** 能看到实时 turns/tokens/agent 名（非 default/0）
3. **elapsedSeconds 跨路径一致**（同一次执行，sync 和 poll 显示相同值）
4. **eventLog 在 background 路径完整**（text_output/thinking 条目不丢失——修复 updateRecordEventLog 的 sink reset bug）
5. **每种状态对象有且只有一个 toDetails() 方法**（grep 验证无手工构造）

### 展示（AC-TUI）

1. single sync/background：对话流 block 6 行（status inline + 4 scroll + hint）
2. 全零 stats 隐藏（不显示 `0 turns · 0 · 0s`）
3. running 时底部 accent 色 `Press Ctrl+O` 提示
4. Ctrl+O 展开显示完整 eventLog + result
5. 截断保留 ANSI 背景色（`…` 前无裸 `\x1b[0m`）
6. 用户可自由滚动（spinner 不抢占 viewport）
7. /subagents list 三级视图（list → DAG/agent detail → step detail），j/k 导航

### 编排（AC-ORCH）

1. parallel：tasks 并发（concurrency 限制），返回聚合结果
2. chain：步骤顺序执行，`{outputs.name}` 替换为前序输出
3. fanout：动态展开 + collect，maxItems 必须显式配置
4. async orchestration：立即返回 runId，完成后单次回注
5. cancel：abort 整个 DAG（cascade AbortController），已完成结果保留
6. 对话流 block 8 行（2 header + 6 step），>6 步按模式截断

### 后台（AC-BG）

1. background 完成 → sendMessage({customType:"subagent-bg-notify", triggerTurn:true})
2. 主 agent 执行中 → 消息进 steering 队列（不中断）
3. 多个 background 完成在 2000ms 窗口内合并为一条通知
4. cancel 路径 dedup（只发一次 cancelled 通知）
5. per-agent defaultBackground：`researcher` 配置后，不传 wait 默认后台
