---
"@zhushanwen/pi-subagents": minor
"@zhushanwen/pi-workflow": major
"@zhushanwen/pi-unified-hooks": minor
"@zhushanwen/pi-taste-lint": minor
---

新增 `@zhushanwen/pi-subagents` 包（首次发布）：进程内 subagent 执行运行时（agent 发现、模型解析、并发控制、background 任务）。

### `@zhushanwen/pi-workflow` 2.0（BREAKING）

- 改用 subagents 进程内执行，移除 spawn 子进程模型；新增 `@zhushanwen/pi-subagents` 硬依赖。
- 移除 peerDependency `@zhushanwen/pi-model-switch`。
- 删除 3 个此前随 `files:["src/"]` 发布的内部模块（`agent-discovery.ts` / `jsonl-parser.ts` / `pi-runner.ts`）；移除 `cleanupAllTempFiles` / `cleanupTempFile` 导出；`resolveAgentOpts` 签名变更。package.json 无 `exports` map，深路径导入将断链。
- ⚠️ **行为变更（scene→model 解析迁移）**：`resolveModel` 不再经 `@zhushanwen/pi-model-switch`，改由 subagents 的 `resolveModelForScene()` 读取 `~/.pi/agent/subagents/config.json` 的 categories 解析。原 model-switch scene 配置升级后**静默失效**；未检测到 subagents 运行时时会输出一次性 dev 警告。迁移：`pi install @zhushanwen/pi-subagents`，将原 scene→model 配置迁至 subagents config。
- **行为变更（完成通知）**：workflow 完成时，`sendCompletionNotification` 现以 `{ triggerTurn: true, deliverAs: "steer" }` 注入消息流，唤醒 parent agent 处理结果（默认开启，无 opt-in）。此前仅 `display:true` 只渲染不唤醒。

### `@zhushanwen/pi-unified-hooks`

- `session_start` 钩子状态由 `console.warn` 改为 `ctx.ui.notify`（走通知区，不污染 TUI input 区）+ `appendEntry` 持久化。
- 新增导出 `HookContext` 类型。

### `@zhushanwen/pi-taste-lint`

- 新增 `no-unsafe-cast` 规则（检测 `as any` / `as unknown as T` / `as never`）。
- `@typescript-eslint/no-explicit-any` 由 `warn` 收紧为 `error`。
