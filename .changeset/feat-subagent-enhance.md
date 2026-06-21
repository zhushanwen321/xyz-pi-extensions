---
"@zhushanwen/pi-subagents": minor
"@zhushanwen/pi-workflow": major
"@zhushanwen/pi-model-switch": patch
"@zhushanwen/pi-unified-hooks": minor
"@zhushanwen/pi-taste-lint": minor
---

新增 `@zhushanwen/pi-subagents` 包（首次发布）：进程内 subagent 执行运行时——agent 发现、5 级 fallback 模型解析、并发池（concurrency-pool）、background 任务、execution-record 状态机、turn-limiter、event-bridge（SDK 事件翻译）。提供 `subagent` tool + `/subagents` command。注意：`@zhushanwen/pi-workflow` 当前**不依赖**此包（workflow 仍用 spawn 子进程架构），两者独立——subagents 是独立可用的 subagent 执行运行时。

### `@zhushanwen/pi-workflow` 2.0（BREAKING — 局部行为变更，非架构级）

major bump 因含 2 项真实 BREAKING（semver 要求）。workflow 仍为 spawn 子进程架构（`AgentPool` / `resolveAgentOpts` 不变），orchestrator.ts 做了内部重构（精简 ~200 行，行为等价，已由 orchestrator-stale 等测试覆盖）。真实 breaking 仅以下两项局部行为：

- **BREAKING（scene→model 解析移除）**：`resolveModel` 不再经 `@zhushanwen/pi-model-switch` 的 `resolveModelForScene()` 解析 scene，改为直传调用方显式 `opts.model`。配套移除 peerDependency `@zhushanwen/pi-model-switch`。原依赖 model-switch scene 配置的用户升级后该解析静默失效——如需 scene→model 映射，请直接在 workflow 脚本的 `agent()` 调用中显式传 `model`，或在调用方自行解析。
- **BREAKING（完成通知唤醒 parent）**：workflow 完成时，`sendCompletionNotification` 现以 `{ triggerTurn: true, deliverAs: "steer" }` 注入消息流，唤醒 parent agent 处理结果（默认开启）。此前仅 `display:true` 只渲染不唤醒。无需安装 subagents。

### `@zhushanwen/pi-model-switch`（public API 未变，内部清理）

- **public API unchanged; internal cleanup only**：包入口（顶层 `index.ts`）仍 re-export `resolveModelForScene`（直接从 `./src/advisor.ts`），`import { resolveModelForScene } from "@zhushanwen/pi-model-switch"` 行为不变，下游无需迁移。本次仅清理内部冗余/死代码：移除 `src/index.ts` 尾部那行重复 re-export（顶层已直接从 advisor.ts 导出）、将 `src/setup.ts` 的 `writePolicyConfig`、`src/types.ts` 的 `extractModelCapabilities`/`ModelCapability`、`src/advisor.ts` 的 `parseZaiResetTime` 由 `export` 改为模块内私有（均未从包入口导出，属 `src/*` 子路径非公开 API）。新增 vitest devDep + `test` script + `vitest.config.ts` 测试基础设施。

### `@zhushanwen/pi-unified-hooks`

- `session_start` 钩子状态由 `console.warn` 改为 `ctx.ui.notify`（走通知区，不污染 TUI input 区）+ `appendEntry` 持久化。
- 新增导出 `HookContext` 类型。

### `@zhushanwen/pi-taste-lint`

- 新增 `no-unsafe-cast` 规则（检测 `as any` / `as unknown as T` / `as never`）。
- `@typescript-eslint/no-explicit-any` 由 `warn` 收紧为 `error`。
