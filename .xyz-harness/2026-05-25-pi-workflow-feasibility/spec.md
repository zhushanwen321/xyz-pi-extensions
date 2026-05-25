---
verdict: pass
---

# Pi Workflow Extension — 通用多 Agent 编排引擎

## Background

### 动机

Pi 当前的 Subagent Extension 提供了单个 `agent()` 调用的能力，但缺少确定性多 Agent 编排能力。用户需要一种方式定义多步骤、多子 Agent 的工作流，支持：
- 用代码控制执行顺序（确定性编排）而非依赖 LLM 主会话判断
- 子 Agent 结果在阶段间直接传递，不经过主会话上下文（避免 token 膨胀）
- 工作流后台运行，主会话可继续其他工作
- 支持暂停/恢复/重试等运维操作

Claude Code v2.1.147 引入的 Workflow 功能提供了类似能力，但该功能处于未发布预览状态且依赖 Claude Code 特有 API。本设计目标是在 Pi 上实现兼容 Claude Code Workflow JS 脚本格式的通用多 Agent 编排引擎。

### 用户

- 需要批量处理任务的开发者（如批量代码审查、批量 issue 分诊）
- 需要固定流程自动化的工作流设计者
- 后续版本中：xyz-harness 编码工作流的底层引擎

### 成功定义

P0 完成后，用户可以通过以下方式运行 workflow：

1. **命令方式**：`/workflow run triage-sentry --args minUsers=30`
2. **Tool 调用**：AI 在对话中调用 `workflow-run` tool
3. 用户可以通过 `/workflows` 命令查看运行中的 workflow 状态、暂停/恢复/重试
4. workflow 在后台运行，不阻塞主会话
5. 多个 workflow 可以并发运行
6. 暂停的 workflow 可跨 Pi 重启恢复
7. workflow 结果通过 `_render` 协议支持 TUI 和 xyz-agent GUI 渲染

### 参考文档

- [Claude Code Workflow 调研报告](/Users/zhushanwen/Code/chat_project/workflow/Claude-Code-Workflow-调研报告.md)
- [Pi Workflow 集成方案](/Users/zhushanwen/Code/chat_project/workflow/Pi-Workflow-集成方案.md)
- [xyz-harness coding-workflow 集成分析](/Users/zhushanwen/Code/chat_project/workflow/xyz-harness-coding-workflow-集成分析.md)
- 项目 `CLAUDE.md`（架构约束、`_render` 协议）
- 现有 Subagent Extension 代码（`subagent/src/index.ts` 中的 spawn/JSONL 通信/模型选择）

## Functional Requirements

### FR1: Workflow 脚本定义

**FR1.1** 系统支持 `.pi/workflows/*.js`（项目级）和 `~/.pi/agent/workflows/*.js`（用户级）的 JS 脚本作为 workflow 定义。

**FR1.2** JS 脚本格式兼容 Claude Code Workflow：必须包含 `const meta = { name, description, phases }` 元数据块，使用 `agent()`/`parallel()`/`pipeline()` API 定义执行逻辑，通过 `$ARGS` 接收外部参数。

**FR1.3** Worker 线程注入以下 API：
- `agent(opts)` — 调用子 Agent。opts: `{ prompt, schema?, model?, description? }`。返回结构化结果（如果指定了 schema，引擎尝试从子 Agent 输出中提取 JSON 并验证）。
- `parallel(calls)` — 并行执行多个 agent 调用，返回 `Promise.all`。
- `pipeline(stages)` — 顺序执行多个阶段，每阶段可包含 `parallel()`。
- `$ARGS` — 从命令行或 tool 参数注入的对象。
- `meta` — 脚本的 meta 块（Worker 全局注入，避免引擎额外解析）。
- `$WORKSPACE` — 当前 Pi 工作目录。
- `$BUDGET` — `{ total, used, remaining }`，每次 agent 调用完成后更新。

**FR1.4** JS 脚本中可以使用完整的 JS 控制流（`if`/`for`/`while`/`try-catch`/函数定义等）。

**FR1.5** 系统扫描 workflow 目录时，从 JS 文件中提取 `meta` 块用于 `/workflow list` 命令展示。提取方式：Worker 线程中 `import()` 脚本，获取 meta 导出，缓存结果。如果 import 失败（语法错误），标记该脚本不可用但不影响其他脚本。

### FR2: Worker 线程执行模型

**FR2.1** 每个 workflow 运行实例创建一个独立的 Node.js Worker 线程，在独立 V8 isolate 中执行 JS 脚本。

**FR2.2** Worker 线程中的 `agent()` 调用不是真正 spawn 子进程，而是通过 `postMessage` 给主线程发起 RPC 请求。主线程收到后 spawn `pi --mode json` 子进程执行，完成后将结果 `postMessage` 返回给 Worker。

**FR2.3** Worker 线程中的 JS 脚本按 `async/await` 语义单线程执行。多个 `parallel()` 中的 agent 调用通过主线程并发处理子进程，但 Worker 侧的 JS 控制流保持单线程。

**FR2.4** 每个 agent 调用在主线程中记录为一个 DAG 节点（见 FR3）。DAG 图是线性执行轨迹日志，callId 递增，仅用于观测和恢复，不影响 JS 脚本的控制流逻辑。

**FR2.5** 并发执行的 agent 子进程数上限为 4（独立常量，与 Subagent Extension 的默认值一致但互不依赖）。用户可通过 `~/.pi/agent/settings.json` 中 `workflow.maxConcurrency` 字段调整。

### FR3: DAG 执行轨迹

**FR3.1** 每个 agent 调用记录为一个执行轨迹节点（ExecutionTraceNode），包含：
```typescript
interface DAGNode {
  callId: number;       // 递增（从 1 开始，0 保留为 workflow 入口）
  prompt: string;
  schema?: object;
  model?: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  output?: unknown;
  startTime?: number;
  endTime?: number;
  durationMs?: number;
  retryCount: number;   // 失败重试次数
}
```

**FR3.2** 节点由主线程在收到 Worker 的 agent-call 消息时创建（status=pending），子进程启动后更新为 running，完成后更新为 done/failed 并写入 output。

**FR3.3** 执行轨迹是线性节点序列（callId 递增），不含显式边或拓扑排序。执行顺序完全由 Worker 中的 JS 控制流决定，节点只是执行轨迹日志。命名使用"ExecutionTrace"而非"DAG"以避免误导。

**FR3.4** 每个 workflow 实例的节点状态持久化在 Session JSONL 中（每次 status 变更写入一条 `"workflow-node-update"` entry）。

### FR4: 暂停与恢复

**FR4.1** 用户可通过 `/workflows` 面板暂停运行中的 workflow。实现：向 Worker 线程发送 `abort` 消息 → Worker 中断当前执行 → 主线程保留 `callCache`（已完成 agent 调用的 callId → output 映射）。

**FR4.2** 恢复 workflow 时：
1. 主线程从 Session JSONL 恢复 callCache
2. 创建新 Worker 线程
3. 注入 callCache 到 Worker 的 agent 代理中
4. Worker 重新执行 JS 脚本
5. agent 代理发现 callId 对应的缓存结果时立即 resolve（不重新 spawn 子进程）
6. 首次未命中的 callId 则正常 spawn 子进程执行

**FR4.3** 恢复是"幂等重放"语义：agent() 调用结果从缓存获取（不重复执行），但 JS 脚本中的非 agent 副作用（如 `console.log`、Worker 内部变量赋值）会重复执行。如果脚本依赖这些副作用做控制流决策，结果可能与原始执行不同。这是已知限制，在文档中说明。

**FR4.4** 恢复后的 workflow 从上次暂停位置继续执行，不需要重新执行已完成的 agent 调用。

**FR4.5** Pi 进程重启后，workflow 状态从 Session JSONL 恢复。用户可使用 `/workflows` 查看历史 workflow 并选择恢复处于 `paused` 或 `failed` 状态的实例。

### FR5: 用户交互

**FR5.1** 提供以下 Command：
- `/workflow run <name> [--args key=val ...]` — 启动 workflow
- `/workflows` — 交互式进度面板，显示所有活跃和已完成的 workflow，支持 P（暂停）、X（跳过当前 agent）、R（重试失败 agent）、Enter（查看详情）
- `/workflow list` — 列出所有可用的 workflow 定义（名称、描述、phases）
- `/workflow abort <run-id>` — 终止指定 workflow

**FR5.2** 提供 `workflow-run` Tool（参数：`name: string, args?: object`），供 AI 在对话中调用。Tool 返回 `runId`，AI 可后续通过消息通知获取结果。

**FR5.3** workflow 运行结果通过 `pi.sendMessage({ customType: "workflow-result" })` 注入到主对话，附带 `_render` 描述符（`task-list` 类型，包含 DAG 节点状态列表）。

**FR5.4** `/workflows` 面板提供 TUI 交互式视图。列表视图（所有 workflow 状态概览）通过 `setWidget` 渲染，仅展示不处理键盘。交互通过两种方式实现：
- **全局快捷键**：`pi.registerShortcut("ctrl+p", ...)` 暂停当前选中 workflow，`ctrl+x` 跳过当前 agent，`ctrl+r` 重试失败 agent
- **详情 Overlay**：`ctx.ui.custom()` 创建全屏 overlay 组件显示单个 workflow 的 DAG 节点列表（含 prompt 摘要、status、duration），在该 overlay 内通过 `Component.handleInput` 处理按键交互

Pi TUI 的 `setWidget` 渲染的组件不会被设焦点，因此需通过 `registerShortcut`（全局）和 `custom()` overlay（焦点模式）组合实现交互。

### FR6: 后台运行 & 多 workflow 并发

**FR6.1** workflow 在后台运行，不阻塞主会话。启动 workflow 后用户可立即继续与 AI 对话。

**FR6.2** 支持同时运行多个独立 workflow。每个 workflow 有独立的 Worker 线程、独立的 callCache、独立的 DAG 日志。

**FR6.3** 多 workflow 并发时，agent 子进程也并发运行（受 `MAX_CONCURRENCY` 限制）。不同 workflow 的 agent 请求共享全局进程池，先到先得。

**FR6.4** 主会话关闭时，所有运行中的 workflow 自动暂停。callCache 和 DAG 状态已持久化，下次会话可恢复。

### FR7: 错误处理与重试

**FR7.1** agent 子进程失败（exitCode != 0 或 stopReason === "error"）时，自动重试最多 3 次。每次重试间隔递增（1s → 3s → 9s）。超过 3 次标记节点为 `failed`，Worker 收到 Error。

**FR7.2** Worker 线程崩溃时，主线程捕获 `worker.on("error")`，将 workflow 标记为 `failed`。已完成的节点保留，用户可选择恢复。

**FR7.3** JS 脚本语法错误或运行时异常（非 agent 相关的 Error）由 Worker 线程的 try-catch 包裹捕获，workflow 标记 `failed`，错误信息展示。

**FR7.4** 用户可通过 `/workflows` 面板的 R 操作手动重试失败的单个 agent 节点（清除该节点的 callCache 条目，Worker 下次恢复时重新执行）。

**FR7.5** 用户可通过 `/workflows` 面板的 X 操作跳过当前执行的 agent 调用（标记为 `skipped`，Worker 收到 `undefined` 结果）。此操作下 JS 脚本中的 `agent()` 返回 `undefined`，脚本需要处理 null/undefined。

### FR8: 预算控制

**FR8.1** 可选参数 `--tokens N` 设定 token 预算上限。每个 agent 子进程完成后累加 token 消耗到 `$BUDGET.used`。

**FR8.2** 消耗达 90% 时，主线程向 Worker 发送 `budget-warning` 消息。Worker 中的 JS 脚本可检查 `$BUDGET.remaining` 做收尾处理。

**FR8.3** 消耗达 100% 时，终止 Worker 线程，workflow 状态为 `budget_limited`（终态）。已完成的 agent 结果保留。

**FR8.4** 可选参数 `--time N`（分钟）设定时间预算上限。墙钟超时后同 FR8.3 处理，状态为 `time_limited`。

### FR9: Claude Code 兼容性

**FR9.1** JS 脚本文件格式兼容：Workflow 脚本使用与 Claude Code Workflow 相同的 `const meta = { name, description, phases }` 元数据格式和 `agent()`/`parallel()`/`pipeline()` 三个 API 签名。

**FR9.2** 兼容范围限定为"文件格式 + API 签名"层级。行为语义差异（如模型映射、错误处理策略）由 Pi 运行时决定，不保证与 Claude Code 完全一致。

**FR9.3** 不兼容的部分明确记录：Pi 使用 taskComplexity 自动模型选择（而非固定模型名），子 Agent 通过 `spawn pi --mode json` 执行（而非 Claude Code 内置 agent tool），预算单位支持 token + 时间（Claude Code 仅 token）。

### FR10: GUI 兼容（`_render` 协议）

**FR10.1** `workflow-run` Tool 的 `execute()` 返回的 `details` 中包含 `_render` 字段，遵循 CLAUDE.md 中的 GUI 渲染描述符协议。`_render.type` 为 `"task-list"`，`data.items` 为 DAG 节点列表。

**FR10.2** workflow 完成通知消息也包含 `_render` 字段，供 xyz-agent GUI 渲染结果摘要。

**FR10.3** `_render` 是增量字段，不影响现有 TUI 的 `renderResult`。缺失时 GUI fallback 到 content 文本渲染。

### FR11: 生命周期

**FR11.1** workflow 实例状态机：
```
created → running → paused → running → completed
              ↘  failed (JS异常 / agent失败且重试耗尽 / Worker崩溃)
              ↘  budget_limited (终态)
              ↘  time_limited (终态)
              ↘  aborted (用户主动终止，终态)
```
终态不可逆转。

**FR11.2** workflow 完成后在 Session JSONL 中保留完整历史（节点 + callCache + 最终结果），`/workflows` 命令可查看。

## Acceptance Criteria

### AC1: 最小可用验证

用户在 `.pi/workflows/demo.js` 中定义包含 `meta` + 2 个 agent 调用的 workflow，通过 `/workflow run demo` 启动：
- [ ] 命令返回 runId
- [ ] 2 个 agent 调用顺序执行，每个启动一个 `pi --mode json` 子进程
- [ ] `/workflows` 显示 `running` 状态
- [ ] workflow 完成后主对话收到结果通知

### AC2: 暂停/恢复

- [ ] `/workflows` 面板中按 P 暂停运行中的 workflow，Worker 线程终止，callCache 保留
- [ ] 同一 session 中恢复 workflow 后，已完成的 agent 不重新执行，从断点继续
- [ ] 关闭并重新打开 Pi session 后，历史 workflow 可见，可选择恢复

### AC3: parallel 并发

- [ ] 脚本中 `await parallel([agent(A), agent(B), agent(C)])`，A/B/C 的子进程同时运行
- [ ] 3 个子进程完成时间不同时，Worker 正确等待全部完成后继续下一步

### AC4: 错误重试

- [ ] 一个 agent 子进程失败（非零退出），自动重试最多 3 次
- [ ] 3 次全部失败后，节点状态为 `failed`，Worker 收到 Error
- [ ] 用户手动 R 重试后，该节点重新执行，成功则 workflow 继续

### AC5: 多 workflow 并发

- [ ] 同时启动 3 个 workflow，它们在后台并发运行
- [ ] `/workflows` 面板显示 3 个 running 条目
- [ ] agent 子进程最多 4 个同时运行（全局限制）
- [ ] 一个完成后不影响其他 workflow

### AC6: Token 预算

- [ ] `--tokens 50000` 启动 workflow
- [ ] agent 调用累加 token，达 90% 时 Worker 收到 warning
- [ ] 达 100% 时 Workflow 标记为 `budget_limited`，已完成的 agent 结果保留

### AC7: Schema 结构化输出

- [ ] agent 调用指定 schema 时，引擎在子 Agent prompt 末尾追加 schema 要求
- [ ] 子 Agent 返回文本中包含 JSON 时，引擎提取并验证
- [ ] 验证通过，返回解析后的对象；失败时返回原始文本

### AC8: CC 兼容性

- [ ] `/workflow list` 命令列出所有可用 workflow（从 `.pi/workflows/` 和 `~/.pi/agent/workflows/` 读取）
- [ ] 脚本使用 CC 格式（`const meta = { name, description, phases }`）可正常解析和执行
- [ ] `agent()`/`parallel()`/`pipeline()` 三种 API 签名与 CC 一致

### AC9: _render 输出

- [ ] `workflow-run` Tool 返回的 `details._render` 包含 `type: "task-list"`
- [ ] `_render.data.items` 包含 DAG/trace 节点状态列表
- [ ] workflow 完成通知消息也包含 `_render` 字段

## Constraints

### 技术约束

- **运行环境**：Pi Extension 运行在 Pi 进程内，通过 Node.js `worker_threads` 模块创建 Worker 线程。`worker_threads` 是 CLAUDE.md 中"扩展不能依赖 fs 之外的 Node.js 原生模块"规则的例外——理由与 Subagent Extension 使用 `child_process.spawn` 的例外相同：JS 脚本在独立 V8 isolate 中执行是 Workflow 的核心需求，`vm` 模块无法提供独立 isolate 隔离。此例外需在 CLAUDE.md 中明确记录。
- **子进程执行**：使用与 Subagent Extension 相同的 `spawn pi --mode json` + JSONL 解析机制，但不直接引用 Subagent Extension 内部函数。Workflow Extension 独立实现 `agent-pool.ts` 模块（使用相同的 `spawn` + JSONL 协议），保持与 Subagent Extension 的解耦。
- **进程池上限**：全局 agent 子进程并发数上限 4（可配置 `workflow.maxConcurrency`）。
- **Worker 全局上限**：每个 workflow 一个 Worker 线程，全局 Worker 上限默认 16（Node.js 默认值）。
- **持久化**：使用 Session JSONL（`pi.appendEntry`）写入 `CustomEntry`。当前会话内的状态恢复通过 `ctx.sessionManager.getEntries()` 过滤 `customType === "workflow"` 实现。跨会话（Pi 重启）恢复需要 Extension 在 `session_start` 时扫描 `~/.pi/agent/sessions/<cwd>/` 目录下的 JSONL 文件，加载上次会话的 workflow 状态。恢复前向用户确认："检测到中断的 workflow `xxx`，是否恢复？"
- **模型选择**：使用与 Subagent Extension 相同的 `taskComplexity` + `model` 选择机制（从 `subagent-models.json` 读取），Workflow Extension 独立调用 `ctx.modelRegistry`，不直接引用 Subagent Extension 内部函数。

### 兼容约束

- **JS 脚本格式**：兼容 Claude Code Workflow 的 `meta` + `agent()`/`parallel()`/`pipeline()` 格式。不在语法层面做限制。
- **Schema 格式**：兼容 Claude Code 的 JSON Schema `{ type, properties }` 格式，不要求 TypeBox。
- **目录**：仅扫描 `.pi/workflows/` 和 `~/.pi/agent/workflows/`。不扫描 `.claude/workflows/`（P0 范围外）。

### 安全约束

- Worker 线程运行在独立 V8 isolate 中，与主线程隔离。Worker 无法访问主线程的 `process`、`fs` 等 API（除非通过注入的白名单）。
- Workflow 脚本由用户自己编写，引擎不在 Worker 中执行额外的安全沙箱策略。用户对脚本内容负责。

## Out of Scope (P0)

| 项目 | 原因 | 未来扩展 |
|------|------|---------|
| 扫描 `.claude/workflows/` 目录 | P0 只做 Pi 生态 | Config Loader 加路径即可 |
| 内置 `gate()`/`review()`/`retrospect()` API | 这些是 xyz-harness 专用 stage type，P1 再做 | Worker 注入新代理函数 + 主线程新增 message type 路由即可 |
| 热重载 | P0 不做 | 暂停/恢复机制天然支持（重启 Worker + 重放 callCache） |
| Adversarial/Judge Panel 专用 API | 这 4 种是 `agent()`+`parallel()`+JS 控制流的组合，API 已覆盖 | 不需要引擎层支持 |
| Workflow 嵌套（workflow 内调另一 workflow） | 复杂度高 | Worker 注入 `$WORKFLOW.run()` 代理 + 主线程启动子 workflow Worker |
| 进度面板的跳过(X)到 JS 控制流分支 | 跳过 agent 返回 undefined，JS 脚本自行处理 | 可能需要更丰富的信号语义 |

## Decisions

### D1: Worker 线程执行 JS 脚本

**选择**：Node.js `worker_threads` 模块（独立 V8 isolate），通过 `postMessage` 通信。

**原因**：比 `vm` 模块隔离性好（独立 isolate），比外部子进程通信开销低（零拷贝 MessagePort）。满足暂停（SIGTERM Worker）、恢复（重新创建 Worker + callCache 重放）的需求。

### D2: agent() 是代理而非直接调用

**选择**：Worker 中注入的 `agent()` 通过 postMessage RPC 委托主线程执行，不在 Worker 中直接 spawn 子进程。

**原因**：Worker 线程无法（也不应）直接管理子进程生命周期。主线程集中管理子进程池、callCache、DAG 日志、budget 跟踪。Worker 只负责 JS 控制流。

### D3: DAG 图是线性日志而非显式图

**选择**：DAG 节点是 callId 递增的线性序列，不含显式边或拓扑排序。Worker 中的 JS 控制流决定执行顺序。

**原因**：不需要从 JS 脚本中静态提取依赖关系。执行顺序由 Worker 的 async/await 自然保证，DAG 节点只是执行轨迹日志。这简化了实现，同时仍然支持观测和恢复。

### D4: 恢复通过 callCache 重放而非状态序列化

**选择**：恢复 workflow 时重新执行 JS 脚本，agent 代理通过 callCache 跳过已完成的调用。

**原因**：JS 脚本的执行状态（调用栈、局部变量、while 循环当前迭代）无法序列化。重新执行 + callCache 重放是唯一可行的恢复方案。

## Complexity Assessment

| 组件 | 复杂度 | 风险点 |
|------|--------|--------|
| Worker 通信协议 | 中 | parallel/pipeline 的消息格式定义需要处理部分失败 |
| Config Loader | 低 | 正则提取 meta，参考现有 skills 扫描模式 |
| Agent Executor | 低 | 独立实现 agent-pool.ts（spawn pi --mode json + JSONL 解析），与 Subagent Extension 使用相同底层协议但代码独立 |
| DAG 日志 | 低 | JSONL append，单线程无并发问题 |
| callCache 恢复 | 低 | Map<number, unknown>，JSONL 读写 |
| TUI 面板 | 中 | 需要使用 `registerShortcut` + `ctx.ui.custom()` overlay + `setWidget` 三组合实现交互式面板（Pi TUI API 已确认支持） |
| 预算控制 | 低 | 累加计数器 + 百分比判断 |
| Schema 验证 | 低 | JSON 提取 + 类型检查，无需外部库 |

整体复杂度评级：**中高**。最大复杂度在 Worker 通信协议设计，其次是 TUI 面板交互。
