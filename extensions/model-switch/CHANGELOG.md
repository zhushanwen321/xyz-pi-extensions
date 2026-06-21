# @zhushanwen/pi-model-switch

## 0.2.12

### Patch Changes

- 6cf4c58: 新增 `@zhushanwen/pi-subagents` 包（首次发布，v0.0.1）：进程内 subagent 执行运行时——agent 发现、5 级 fallback 模型解析、并发池（concurrency-pool）、background 任务、execution-record 状态机、turn-limiter、event-bridge（SDK 事件翻译）。提供 `subagent` tool + `/subagents` command。注意：`@zhushanwen/pi-workflow` 当前**不依赖**此包（workflow 仍用 spawn 子进程架构），两者独立——subagents 是独立可用的 subagent 执行运行时。

  ### `@zhushanwen/pi-workflow`（局部行为变更）

  workflow 仍为 spawn 子进程架构（`AgentPool` / `resolveAgentOpts` 不变），orchestrator.ts 做了内部重构（精简 ~200 行，行为等价，已由 orchestrator-stale 等测试覆盖）。两项局部行为变更：

  - **scene→model 解析移除**：`resolveModel` 不再经 `@zhushanwen/pi-model-switch` 的 `resolveModelForScene()` 解析 scene，改为直传调用方显式 `opts.model`。配套移除 peerDependency `@zhushanwen/pi-model-switch`。原依赖 model-switch scene 配置的用户升级后该解析静默失效——如需 scene→model 映射，请直接在 workflow 脚本的 `agent()` 调用中显式传 `model`，或在调用方自行解析。
  - **完成通知唤醒 parent**：workflow 完成时，`sendCompletionNotification` 现以 `{ triggerTurn: true, deliverAs: "steer" }` 注入消息流，唤醒 parent agent 处理结果（默认开启）。此前仅 `display:true` 只渲染不唤醒。无需安装 subagents。

  ### `@zhushanwen/pi-model-switch`（public API 未变，内部清理）

  - **public API unchanged; internal cleanup only**：包入口（顶层 `index.ts`）仍 re-export `resolveModelForScene`（直接从 `./src/advisor.ts`），`import { resolveModelForScene } from "@zhushanwen/pi-model-switch"` 行为不变，下游无需迁移。本次仅清理内部冗余/死代码：移除 `src/index.ts` 尾部那行重复 re-export（顶层已直接从 advisor.ts 导出）、将 `src/setup.ts` 的 `writePolicyConfig`、`src/types.ts` 的 `extractModelCapabilities`/`ModelCapability`、`src/advisor.ts` 的 `parseZaiResetTime` 由 `export` 改为模块内私有（均未从包入口导出，属 `src/*` 子路径非公开 API）。新增 vitest devDep + `test` script + `vitest.config.ts` 测试基础设施。

  ### `@zhushanwen/pi-unified-hooks`

  - `session_start` 钩子状态由 `console.warn` 改为 `ctx.ui.notify`（走通知区，不污染 TUI input 区）+ `appendEntry` 持久化。
  - 新增导出 `HookContext` 类型。

  ### `@zhushanwen/pi-taste-lint`

  - 新增 `no-unsafe-cast` 规则（检测 `as any` / `as unknown as T` / `as never`）。
  - `@typescript-eslint/no-explicit-any` 由 `warn` 收紧为 `error`。

## 0.2.11

### Patch Changes

- 5c35364: fix: replace console.log/info with console.warn to prevent input area leak

  - model-switch/advisor.ts: replace console.info with silent fallback
  - unified-hooks/tool-error-handler.ts: replace console.log with console.warn
  - unified-hooks/index.ts: replace console.log with console.warn
  - Add §10 logging standard to pi-extension-standards.md
  - Add pre-commit hook to detect console.log/info violations

## 0.2.10

### Patch Changes

- Remove per-turn context injection from model-switch; make model-switch an optional peer dep of workflow

## 0.2.9

### Patch Changes

- Updated dependencies [00fb8bd]
  - @zhushanwen/pi-quota-providers@0.5.1

## 0.2.8

### Patch Changes

- Updated dependencies
  - @zhushanwen/pi-quota-providers@0.5.0

## 0.2.7

### Patch Changes

- Fix systemPrompt overwrite bug and KV cache hostile injection

  - Bug A: systemPrompt was completely replacing base prompt instead of appending to event.systemPrompt
  - Bug B: Dynamic context injected into systemPrompt every turn broke KV prefix cache (~10x cost). Split into static systemPrompt (injected once) + dynamic customType message (per-turn)
  - Extract computeSnapshotAndRecommend() to eliminate duplication
  - Extract findModelMatch() to reduce handleSwitch complexity
  - Add @mariozechner/pi-tui and typebox to peerDependencies

## 0.2.6

### Patch Changes

- Audit and fix all 11 extensions against project specifications

## 0.2.5

### Patch Changes

- 8079ae5: Fix config path mismatch and add v1 config migration. The extension was looking for config at `~/.pi/agent/extensions/model-switch/model-policy.json` but the actual file is at `~/.pi/agent/model-policy.json`. Also adds v1→v2 config format migration, proactive model switching triggers in promptSnippet, and specific action recommendations in context injection.

## 0.2.3

### Patch Changes

- Updated dependencies
  - @zhushanwen/pi-quota-providers@0.4.1

## 0.2.2

### Patch Changes

- Updated dependencies [045ade1]
  - @zhushanwen/pi-quota-providers@0.4.0

## 0.2.0

### Minor Changes

- model-switch v2 redesign: provider-keyed config, deterministic recommend, clear prompt labels. quota-providers: normalize IDs to kebab-case.

### Patch Changes

- Updated dependencies
  - @zhushanwen/pi-quota-providers@0.1.2

## 0.1.1

### Patch Changes

- Fix GATE_SCRIPT_PATH path for npm packaging, module-level state encapsulation, execute error handling compliance, peerDependencies cleanup, ANSI escaping removal, and directory restructuring
- Updated dependencies
  - @zhushanwen/pi-quota-providers@0.1.1
