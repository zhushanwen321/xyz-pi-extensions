# @zhushanwen/pi-workflow

> **⚠️ DEPRECATED**：本包已被 `@zhushanwen/pi-subagents-workflow` 取代（ADR-030，subagents + workflow 合并为单包）。
> 迁移：`pi uninstall npm:@zhushanwen/pi-workflow && pi install npm:@zhushanwen/pi-subagents-workflow`
> 本包不再维护，仅保留供已安装用户追溯。

## 1.1.7

### Patch Changes

- 2a3fed0: Introduce `pending-notifications` extension and wire workflow/subagent background operations into it.

  - New `pending-notifications` extension tracks active async operations (workflow/subagent) via EventBus + session entries.
  - Workflow `run` / `abort` / terminal error paths emit `pending:register` and `pending:unregister` through a single EventBus port.
  - Subagent background mode now emits the same events via `pi.events.emit`; stale-context errors during subagent child sessions are now tolerated.
  - Goal's `before_agent_start` reads pending entries and injects a waiting hint when async work is active.
  - Added `workflow:log`, `pending:log`, and `goal:log` debug entries for tracing the register/unregister flow.
  - Workflow UI rendering improvements: themed border helpers and fixed overlay ghost rows.

## 1.1.6

### Patch Changes

- dde92ef: Remove user confirmation gate for workflow execution; fix 3 workflow discovery bugs (EISDIR on directory manifest entries, symlink filtering, bare+worktree root resolution); refactor config injection behind the registry port.

## 1.1.5

### Patch Changes

- 1fde548: **coding-workflow (minor)** — ADR-029 full workflow takeover + machine-enforced test gate:

  - `execute-full-workflow.js`: full dev+test+review orchestration via worktree
    isolation (per-call cwd, parallel dev waves, 2-way review cross-check).
  - `test-orchestrator` tool: 4-action machine-recomputed E2E test state machine.
  - `lib/gates`: ReviewGate + TestFixLoopGate machine gates (no human judgment bypass).
  - Replan action handler + state machine (illegal_transition recovery).
  - Tier-based budget config (lite/mid/full token + time budgets).
  - `_cw.json` JSON store (replaces node:sqlite `_cw.db` for portability).
  - Plan.json test scheduling fields (dependsOn/parallelGroup).
  - Skill doc improvements: workspace guard, no-fallback rule, schema validation.

  **workflow (patch)** — dev extension workflow discovery fix:

  - config-loader now scans `~/.pi/agent/extensions/` (dev symlinked extensions)
    in addition to `~/.pi/agent/npm/node_modules`. Extensions with
    `pi.workflows` manifest in dev mode were previously invisible to
    `workflow run` / `workflow-script list`.

## 1.1.4

### Patch Changes

- 3f4d93d: Fix agent subprocess killed ~2ms after spawn (fire-and-forget IIFE) + schema-error masking

  - **lint**: detect bare async IIFE wrapping agent/parallel/pipeline as error (fire-and-forget statement) or warning (assigned/returned, may still drop Promise). Root cause of daily-news-impact 2ms subprocess kill: worker's outer IIFE posted `return` before inner IIFE's agent() resolved, main thread torn down runtime → controller.abort() → SIGKILL.
  - **subprocess-agent-runner / concurrency-gate**: schema-error branch now carries exitCode + stderr instead of masking real failures (abort, crash, spawn error) with "Agent did not call structured-output tool".
  - **SKILL.md**: document the IIFE anti-pattern with error/warning severity rules.

## 1.1.2

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

## 1.1.1

### Patch Changes

- 64405a6: fix(workflow): stop leaking worker diagnostics to the input area; scope TUI to selected phase

  - Worker console.\* calls are captured into `_workerLogs` and surfaced via `instance.errorLogs` in the TUI detail view, not stderr/input
  - All `console.log/warn/error` in the main thread (model-resolver, orchestrator-events, commands, orchestrator, index) are silenced or routed to `ctx.ui.notify` to prevent terminal pollution
  - `unknown fields` warnings from `agent()` no longer write to stderr; captured into worker logs instead
  - `/workflows` TUI level 0 now scopes the right panel to the currently selected phase instead of all phases
  - `workflow-script-format` example no longer uses `review-round-N` naming

- Updated dependencies [5c35364]
  - @zhushanwen/pi-model-switch@0.2.11

## 1.1.0

### Minor Changes

- feat(workflow): CC compat, structured output reliability, fullscreen TUI view, domain refactor

  - Claude Code format compatibility (outputSchema → schema mapping)
  - Structured output reliability with conditional activation
  - Fullscreen TUI view with three-level navigation (phase → agent → detail)
  - Domain layer architecture refactor (domain/engine/infra/interface)
  - 65 new tests (284 → 349), 21 code review fixes

## 1.0.1

### Patch Changes

- Fix unhandled rejection crash when aborting/pausing/resuming workflows in terminal or non-applicable states

## 1.0.0

### Minor Changes

- structured-output: unconditional global tool (schema+data params), remove env-gated mode. workflow: remove text fallback, rely on tool call only.

### Patch Changes

- Updated dependencies
  - @zhushanwen/pi-structured-output@0.3.0

## 0.3.2

### Patch Changes

- Fix structured-output peerDep version range: workspace:_ → _

## 0.3.1

### Patch Changes

- Remove per-turn context injection from model-switch; make model-switch an optional peer dep of workflow
- Updated dependencies
  - @zhushanwen/pi-model-switch@0.2.10

## 0.3.0

### Minor Changes

- Add `runAndWait()` method and `pi.__workflowRun` cross-extension channel

  - `WorkflowOrchestrator.runAndWait()`: synchronous wait with configurable timeout
  - `pi.__workflowRun` exposed in session_start for cross-extension programmatic access
  - Extract `orchestrator-budget.ts` for reuse

## 0.2.2

### Patch Changes

- Expose subagent sessionId for post-run session log access

## 0.2.1

### Patch Changes

- Fix parsedOutput capture: two-phase validation (tool_execution_start stash + tool_execution_end confirm)
- Updated dependencies
  - @zhushanwen/pi-structured-output@0.2.1

## 0.2.0

### Minor Changes

- Add Review-Gate auto-loop, Test-Fix Loop, and cross-extension Goal integration

  - goal: expose `initializeGoalFromExternal()` via `pi.__goalInit` for cross-extension access
  - coding-workflow: Review-Gate standard loop (Phase 1/2), Phase 3 three-stage review, Phase 4 Test-Fix Loop, Goal auto-init, Phase-Gate bug fixes
  - workflow: agent file discovery (project/user/npm/local), `resolveAgentOpts()` extraction, structured output failure handling

## 0.1.10

### Patch Changes

- 18b88fa: Fix agent subprocess killed prematurely by 120s timeout and add abort propagation for cleanup

## 0.1.9

### Patch Changes

- f7367e8: Fix agent subprocess killed prematurely by 120s hard timeout. Increase to 24h safety net and add proper abort signal propagation on terminate/pause/abort.

## 0.1.8

### Patch Changes

- Fix model polling, widget rendering, and reduce complexity

## 0.1.6

### Patch Changes

- Audit and fix all 11 extensions against project specifications
- Updated dependencies
  - @zhushanwen/pi-model-switch@0.2.6

## 0.1.5

### Patch Changes

- Add storage externalization, approval/verification gates, soft budget warning, and AgentPool optimizations

## 0.1.4

### Patch Changes

- Add auto/force mode to workflow-run tool with progressive discovery

## 0.1.3

### Patch Changes

- e19ed88: fix: remove hardcoded models and paths from review agents; fix Pi SDK type compat in evolve-daily and workflow

## 0.1.2

### Patch Changes

- Fix GATE_SCRIPT_PATH path for npm packaging, module-level state encapsulation, execute error handling compliance, peerDependencies cleanup, ANSI escaping removal, and directory restructuring
