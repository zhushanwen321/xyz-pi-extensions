---
verdict: pass
---

# Agent Runtime + Workflow 进程内执行改造

## Background

当前 xyz-pi-extensions 的 workflow 扩展通过 `spawn("pi", ["--mode", "json"])` 子进程模式执行 agent。这带来三个问题：

1. **启动慢**：每次 agent 调用都 spawn 一个新 Pi 进程，包含完整的扩展加载、模型初始化
2. **无法实时控制**：子进程模式不支持 steer（注入消息到运行中的 agent）和优雅 abort
3. **资源浪费**：每个子进程独立加载扩展、独立初始化 SDK，无法复用主进程资源

Pi SDK 提供了 `createAgentSession()` API，可在当前进程内创建独立 session 执行 agent。tintinweb/pi-subagents 和 nicobailon/pi-subagents 均采用此方式。

本方案将 agent 执行能力从 workflow 中抽出，形成独立的底层运行时包（`@zhushanwen/pi-agent-runtime`），并改造 workflow 的 agent-pool 使用进程内执行。

## Functional Requirements

### FR-1: Agent Session 管理（L1）

**FR-1.1** 封装 Pi SDK `createAgentSession()`，提供 `runAgent(options)` 函数，完成从参数解析到 session 创建到执行到结果收集的完整流程。

**FR-1.2** 支持 `ManagedSession` 模式：创建 session 后可多次 `prompt()`、`steer()`、`abort()`，不自动销毁。供编排层（如 chain 的多步执行）使用。

**FR-1.3** 通过 `session.subscribe()` 事件流收集 agent 输出文本（`message_update.text_delta`），最终文本从 `session.messages` 提取。封装为 `collectResponseText()` 工具函数。

**FR-1.4** 支持 soft turn limit + hard abort：当 turn 数达到 `maxTurns` 时 steer "wrap up" 消息，grace turns 后 `session.abort()` 硬终止。

**FR-1.5** 支持 `AbortSignal` 外部取消：signal 触发时调用 `session.abort()`。

**FR-1.6** Session 清理：执行完成后调用 `session.dispose()`，释放内存。

### FR-2: Agent 发现与注册（L2）

**FR-2.1** `AgentRegistry` 扫描 `~/.pi/agent/agents/`（user 级）和 `.pi/agents/`（project 级）下的 `.md` 文件，解析 YAML frontmatter（name、description、tools、extensions、skills 等）。

**FR-2.2** 支持 builtin agent 注册：代码中预定义的 agent 配置（如 worker、reviewer、researcher）。

**FR-2.3** `get(name)` 方法按名称查找 agent，优先 project 级 > user 级 > builtin。

### FR-3: Agent 配置合并（L2）

**FR-3.1** 3 级配置优先级（后者覆盖前者）——v1 简化版：
1. agent 定义文件的默认值（frontmatter）
2. 调用时参数覆盖（`model`、`tools`、`maxTurns` 等）
3. 环境变量覆盖（`SUBAGENT_MODEL`，仅作为 fallback）

> v2 考虑加入 `invocation-config` 配置文件和 `--force-*` 参数，借鉴 tintinweb 的 5 级体系

**FR-3.2** System prompt 构建策略：`replace`（agent 的 systemPrompt 替换默认）、`append`（追加到默认）、`none`（不注入）。

### FR-4: 模型解析（L2）

**FR-4.1** `resolveModel()` 从 complexity 等级（low/medium/high）映射到具体模型，读取 `~/.pi/agent/subagent-models.json` 配置。

**FR-4.2** 支持 model fallback：首选模型不可用时，按 `modelCandidates` 列表依次尝试。fallback 触发条件：模型在 `ModelRegistry` 中不存在（未配置 provider）。API 运行时错误（rate limit、quota exceeded）不触发 fallback，直接报错。

### FR-5: 父对话 Fork（L2）

**FR-5.1** `forkContext()` 从父 session（`ctx.sessionManager.getBranch()`）提取 user/assistant 消息文本，跳过 toolResult。

**FR-5.2** fork 模式下，将提取的父对话作为 `# Parent Conversation Context` 拼接到子 agent 的 task prompt 前。

### FR-6: Tool 过滤（L2）

**FR-6.1** 三层过滤机制：
1. `builtinTools`：agent 配置允许的内置 tool（undefined=全部，[]=无）
2. `extensions`：extension tool 加载策略（true=全部，false=无，string[]=白名单）
3. `excludeTools`：明确排除的 tool 名

**FR-6.2** 递归排除：子 agent 不应继承编排层的 tool（防止无限嵌套）。通过 `EXCLUDED_TOOL_NAMES` 常量控制。

### FR-7: 并发管理（L1）

**FR-7.1** `ConcurrencyPool` 控制最大并发数（默认 4），超过限制的任务排队等待。

**FR-7.2** 支持优先级：高优先级任务插队。

**FR-7.3** 提供活跃数/排队数/最大并发数的只读属性。

### FR-8: 事件桥接（L1）

**FR-8.1** 将子 session 的 `AgentSessionEvent` 转换为 agent-runtime 的 `AgentEvent` 回调。

**FR-8.2** 事件类型：`tool_start`、`tool_end`、`text_delta`、`turn_end`、`message_end`、`compaction`、`error`。

**FR-8.3** Token usage 从 `message_end` 事件中提取（input/output/cacheRead/cacheWrite/cost）。

### FR-9: Workflow Agent-Pool 改造

**FR-9.1** `AgentPool.runAgent()` 从 spawn 子进程改为调用 `agentRuntime.runAgent()`。

**FR-9.2** 删除以下文件（被 agent-runtime 替代）：
- `infra/pi-runner.ts` — 子进程管理
- `infra/jsonl-parser.ts` — JSONL 解析
- `engine/model-resolver.ts` — 模型解析
- `infra/agent-discovery.ts` — agent 发现

**FR-9.3** 保留但适配的文件：
- `infra/agent-opts-resolver.ts` — 参数解析，改为构建 `RunAgentOptions`
- `infra/execution-trace.ts` — 执行追踪，事件源从 JSONL 改为 agent-runtime 回调
- `infra/state-store.ts` — 状态持久化，不变
- `infra/config-loader.ts` — workflow 脚本加载，不变

**FR-9.4** `AgentCallOpts` 接口适配 `RunAgentOptions`，保持 Worker 脚本 API 不变（`agent()` 函数签名不变）。

**FR-9.5** 事件处理从 JSONL 解析改为 agent-runtime 回调。

**FR-9.6** 错误处理适配：子进程 exit code 改为 agent-runtime 的异常类型。

### FR-10: 包结构与依赖

**FR-10.1** 新建 `extensions/agent-runtime/` 目录，包含完整的 L1+L2 实现。

**FR-10.2** `package.json` 命名为 `@zhushanwen/pi-agent-runtime`，声明 `pi.extensions`。

**FR-10.3** workflow 的 `package.json` 添加 `@zhushanwen/pi-agent-runtime` 为 `peerDependency`。

**FR-10.4** 更新 `extension-dependencies.json`，声明 workflow 对 agent-runtime 的 runtime 依赖。

**FR-10.5** 更新 CLAUDE.md 的目录结构说明。

## Acceptance Criteria

### AC-1: Agent Runtime 核心

- `runAgent({ agent: "worker", task: "Fix typo" })` 能在进程内创建 session 并返回结果
- `runAgent()` 返回的 `AgentResult` 包含 `text`、`usage`、`turns`、`durationMs`
- soft turn limit：达到 `maxTurns` 时自动 steer "wrap up" 消息
- hard abort：grace turns 后 session 被 abort，返回已收集的部分结果
- `AbortSignal` 触发时 session 被 abort

### AC-2: Agent 发现

- `AgentRegistry.discover()` 返回 user 级 + project 级 + builtin agents
- frontmatter 解析支持 name、description、tools、extensions、skills 字段
- `get("nonexistent")` 抛出明确错误

### AC-3: Tool 过滤

- `builtinTools: ["read"]` 只允许 read tool
- `extensions: false` 不加载任何 extension tool
- `excludeTools: ["bash"]` 排除 bash
- 三层组合过滤结果正确

### AC-4: 并发控制

- `ConcurrencyPool(maxConcurrent=2)` 同时只跑 2 个任务，其余排队
- 完成一个后自动启动下一个
- 优先级任务插队到队首

### AC-5: Workflow 改造

- 现有 workflow 脚本无需修改即可运行
- `agent("worker", "task")` 在 Worker 线程中调用，主线程通过 agent-runtime 执行
- workflow 的 pause/resume/abort 正常工作
- `pi-runner.ts`、`jsonl-parser.ts`、`model-resolver.ts`、`agent-discovery.ts` 已删除
- `pnpm --filter @zhushanwen/pi-workflow typecheck` 零错误
- `pnpm -r typecheck` 全量零错误

### AC-6: 包管理

- `extension-dependencies.json` 包含 agent-runtime 条目和 workflow 对它的依赖
- CLAUDE.md 目录结构已更新
- `bash .githooks/check-structure --quick` 通过

## Constraints

- **Pi SDK API 限制**：`createAgentSession()` 创建的 session 是进程内的，不提供进程级隔离。多个 agent 共享主进程的内存和 LLM API quota
- **Worker 线程限制**：`agent()` 调用在 Worker 线程中发起，但 `createAgentSession()` 必须在主线程执行（Worker 没有 Pi SDK 上下文）。通信通过 `postMessage`
- **扩展加载**：子 session 需要通过 `session.bindExtensions()` 加载扩展。扩展加载可能失败，需要 fallback 处理
- **Session 内存**：每个 `ManagedSession` 在完成前持有完整的消息历史。长 chain 或大 parallel 可能导致内存压力
- **向后兼容**：workflow 脚本 API（`agent()`、`parallel()`、`pipeline()`）必须保持不变。现有的所有 workflow 脚本无需修改

## 业务用例

### UC-1: 开发者用 workflow 脚本编排多 agent 任务

- **Actor**: 开发者（通过 `/workflow` 命令）
- **场景**: 开发者编写了一个 3 步 workflow 脚本（review → fix → test），通过 `/workflow review-pipeline` 触发
- **预期结果**: 3 个 agent 依次在进程内执行，每步的结果正确传递给下一步，最终汇总结果展示给用户。预期显著减少 agent 调用开销（无进程启动、无重复扩展加载）

### UC-2: 开发者在运行中的 workflow 里 steer 子 agent

- **Actor**: 开发者（通过 `/workflow` 命令的交互模式）
- **场景**: workflow 执行到第 2 步时，开发者发现方向不对，通过 UI 注入 steer 消息
- **预期结果**: 子 agent 在当前 tool 执行完成后收到 steer 消息，调整执行方向。改造前无法做到（子进程模式不支持 steer）

### UC-3: 第三方扩展基于 agent-runtime 构建自己的编排

- **Actor**: 第三方开发者（安装 `@zhushanwen/pi-agent-runtime`）
- **场景**: 第三方开发者想构建自己的 agent 调度系统，需要底层的 session 创建、agent 发现、模型解析能力
- **预期结果**: 安装 agent-runtime 后，可以 `import { runAgent, AgentRegistry } from "@zhushanwen/pi-agent-runtime"` 直接使用，不需要自己封装 Pi SDK

## Complexity Assessment

- **agent-runtime（L1+L2）**: 高。涉及 Pi SDK 的 `createAgentSession` 深度集成、agent 发现的文件系统扫描、配置合并的 5 级优先级、tool 过滤的 3 层机制。估计 1900 行
- **workflow 改造（L3B）**: 中。主要是 `agent-pool.ts` 重写 + 删除 4 个文件 + 接口适配。核心改动集中，风险可控
- **包管理**: 低。更新 `extension-dependencies.json`、`CLAUDE.md`、`package.json`
