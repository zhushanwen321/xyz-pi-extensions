# @zhushanwen/pi-subagents

> **⚠️ DEPRECATED**：本包已被 `@zhushanwen/pi-subagents-workflow` 取代（ADR-030，subagents + workflow 合并为单包）。
> 迁移：`pi uninstall npm:@zhushanwen/pi-subagents && pi install npm:@zhushanwen/pi-subagents-workflow`
> 本包不再维护，仅保留供已安装用户追溯。

## 0.1.3

### Patch Changes

- 2a3fed0: Introduce `pending-notifications` extension and wire workflow/subagent background operations into it.

  - New `pending-notifications` extension tracks active async operations (workflow/subagent) via EventBus + session entries.
  - Workflow `run` / `abort` / terminal error paths emit `pending:register` and `pending:unregister` through a single EventBus port.
  - Subagent background mode now emits the same events via `pi.events.emit`; stale-context errors during subagent child sessions are now tolerated.
  - Goal's `before_agent_start` reads pending entries and injects a waiting hint when async work is active.
  - Added `workflow:log`, `pending:log`, and `goal:log` debug entries for tracing the register/unregister flow.
  - Workflow UI rendering improvements: themed border helpers and fixed overlay ghost rows.

## 0.1.2

### Patch Changes

- 2b0cb54: Fix stale skill-state prompts after navigate/fork + improve background subagent notifications.

  **evolve-daily**: Stop spurious "skills being tracked" prompts after navigate/fork/clone. Three root causes fixed:

  - Cross-branch state bleed: `reconstructState` now reads only the current branch path (`getBranch()`) instead of all entries from every branch.
  - Immediate injection on fork: `handleSessionRestore` no longer triggers a turn on session switch; `before_agent_start` injects on the user's next message instead.
  - Abandoned-item zombie prompts: abandoned items are no longer surfaced in the prompt list (only loaded/error).

  **subagents**: Background completion notification improvements:

  - Fix background color break after ellipsis (truncLine's `\x1b[0m` global reset was clearing the purple background mid-line).
  - Shorten head line: use `shortId` instead of full job id, truncate model name.
  - Add rounded purple border (`╭─╮│╰─╯`) matching the workflow notify visual style.

## 0.1.1

### Patch Changes

- 8ced632: Rewrite worktree reaper with a global `WorktreeRegistry` + pid-liveness judgment.

  Replaces per-cwd `git rev-parse` scan + `.session`/`.finalized`/`.cancelled` sidecar state machine. Fixes:

  - Reaper crashed when pi started in a non-git dir (workspace root, `/tmp`)
  - Crashed worktrees leaked (terminal markers never written on crash)
  - Worktrees from other repos were unreachable (scan only hit current repo)
  - `cleanup()` failed worktree-remove skipped `branch -D`, leaking the branch

## 0.1.0

### Minor Changes

- e39160d: Subagent execution moves from in-process to a spawned child `pi` process, and gains fork/worktree isolation. Several public types gain required fields and `ExecutionStatus` gains a `crashed` member.

  ## Breaking changes

  **Execution model rewritten (in-process → spawn)** — sync/background subagents now run in an isolated spawned `pi` child process (via `child_process.spawn`) instead of in the host extension process. This is a behavior-level breaking change: the child owns its own tool/runtime lifecycle, signals are propagated via SIGTERM/SIGKILL, and a watchdog governs shutdown. See commits `d29c27676`, `6ec1e687d`.

  **`ExecutionStatus` gains `"crashed"`** — the status union adds a new terminal state `crashed` to distinguish un-graceful termination (kill -9 / OOM / power loss) from normal failure. Detected at startup via the absence of a `.finalized` sidecar (D-006). Downstream consumers switching on status must handle the new branch.

  **New required fields on public records** — `SubagentRecord`/`ExecutionRecord` gain required fields: `task`, `rootSessionId`, `parentRecordId`, `depth`, and `displayItems`. Existing code constructing these records must populate the new fields; `deserializeState`/reconstruction paths default them for backward compatibility with on-disk records.

  **New `ExecuteOptions.fork` / `ExecuteOptions.worktree` and new errors** — `ExecuteOptions` exposes `fork?: boolean` (inherit parent conversation context) and `worktree?: boolean` (file-system isolation via a dedicated git worktree). New error types `ForkDepthExceededError` and `DirtyWorktreeError` are thrown from the corresponding failure paths.

  ## Non-breaking additions

  - `subagent` tool gains an optional `cwd?: string` param (absolute path) to override the subagent's working directory (priority: worktreePath > explicit cwd > mainCwd).
  - Fork depth is capped at `MAX_FORK_DEPTH` (10); nested spawning is now authorized (legacy anti-recursion bans in `agents/*.md` removed — D-031).
  - Sync subagents no longer enter the concurrency pool; only background subagents are pool-limited (D-032) — fixes a nested-sync deadlock.

## 0.0.4

### Patch Changes

- 4e095f3: Show subagent id in `/subagents` view. The left column now displays a short id (`run-N` / `bg-N`) at the start of each row so you can see which subagent is which at a glance without entering detail mode. The right-column preview adds a full-id line (including the background timestamp) for precise reference when cancelling or reading the session file.

## 0.0.2

### Patch Changes

- b7d010e: ExecutionRecord consolidated as the single source of truth for execution data.
  Scattered storage (eventLog slices / \_currentTurnText buffer / closure accumulators /
  session.messages reads) is replaced by `turns: Turn[]`. eventLog / currentActivity /
  result text are now derived from turns[] (getEventLog / getCurrentActivity / getFullText).

  ## Breaking changes (types.ts public API)

  **`AgentEventLogEntry.type`** — removed `"text_output"` and `"thinking"` variants.
  eventLog now carries only discrete semantic events (tool_start / tool_end / turn_end /
  error). Streaming text/thinking content lives in `record.turns[].text` / `.thinking`
  (full content, not 100-char slices). Consumers reading eventLog for streaming text
  should read `currentActivity.label` (running) or `result` (terminal) instead.

  **`RecordSnapshot`** — removed `eventLog` field. Snapshot consumers that read eventLog
  should use `project()` → `SubagentToolDetails.eventLog` instead. The `SubagentRecord`
  (TUI list merge) still carries eventLog.

  **`AgentUsageTotal`** — added `cost: number` field (accumulated from
  `SdkEvent.message.usage.cost.total`). Previously cost was accumulated at runtime but
  not declared on the type; now the type and runtime are consistent.

  **`ToolCall`** — removed internal `_status` field. It moved to `InternalToolCall`
  (ToolCall + \_status + startedTs), used only inside `ExecutionRecord.turns[].toolCalls`.
  `getAllToolCalls()` strips internal fields when exporting, so `AgentResult.toolCalls`
  no longer leaks the running/done/failed state machine.

  ## Bug fixes

  - **compact view `text: }` tail fragment** — the root cause (eventLog stored 100-char
    text slices with residual tail entries) is eliminated. Text is now accumulated in
    full in `turns[].text`; `getCurrentActivity()` derives the label from the text
    **start**, never a tail fragment.
  - **phantom empty turn on `message_end` after `turn_end`** — usage now accumulates
    field-wise into `turn.usageDelta` instead of overwriting, and `message_end` writes
    to the last turn directly (no ghost turn creation).
  - **transient error recovery** — `turn_end` now clears `lastError`, so a transient
    error that recovers no longer flips a successful run to `success=false`.
  - **lagged `tool_end` after `turn_end`** — tool_end matching now scans across all
    turns (not just current), preventing phantom ToolCall duplication.
  - **derived eventLog timestamps** — `getEventLog` now uses real wall-clock timestamps
    (tool: `startedTs`, turn_end: `closedTs`) instead of synthetic `ts += 1` increments.
  - **tool label truncation** — restored truncation (`TOOL_LABEL_MAX = 100`) in
    `extractLabelFromArgs` to keep TUI column-width stable (a 10KB bash command no
    longer inflates the compact view).

- 012035b: Model resolution falls back to the main agent's current model. The category-based
  5-level fallback system has been removed.

  ## Breaking changes

  **Tool parameter schema** — the `subagent` tool moved from positional params to an
  `action` discriminator. Old `{ task, backgroundId?, poll? }` → new
  `{ action, startParam?, listParam?, cancelParam? }`. All callers (LLMs, scripts)
  must switch to the action-based schema.

  **Config schema** — `~/.pi/agent/subagents/config.json` now only reads `version`
  and `maxConcurrent`. Legacy fields (`categories`, `fallback`, `yoloByDefault`,
  `agentCategoryOverrides`) are ignored on load. Delete them from your config —
  they no longer affect anything.

  **Removed source files** (internal, not re-exported from package entry — no
  compile-time impact on consumers):

  - `src/core/event-bridge.ts` + test
  - `src/core/session-factory.ts`
  - `src/tui/config-wizard.ts`
  - `src/tui/format-helpers.ts`

  **Removed types** (internal, not re-exported from package entry):

  - `QueryResult`, `backgroundId` (old query surface)
  - `SessionModelState` (categoryConfirmed/categoryModels/agentModels/yoloMode — all dead fields)
  - `CategoryDefinition` (categories config retired)

  ## New model resolution order (top wins)

  1. `paramOverride.model` (explicit tool param) — registry lookup + auth, throws on miss
  2. `agentConfig.model` (agent .md frontmatter) — registry lookup + auth, throws on miss
  3. `ctx.model` (main agent's current model) — direct passthrough, zero-config default

  Explicit overrides no longer silently fall back to the main model — if you ask
  for a model that's missing or unauthed, you get an error.

  ## Internal notes

  Version is 0.0.1 (pre-1.0 semver): minor is allowed to carry breaking changes.
  Deleted types/files were never re-exported from `index.ts`, so compile-time
  impact is confined to the package itself. The runtime breaking change that
  affects all consumers is the tool parameter schema reshape.

- 6868ad9: Completed/background subagents are reconstructed from `session.jsonl` instead of
  lingering in memory. `history.jsonl` and `HistoryStore` are removed; `session.jsonl`
  (the Pi SDK append-only file, real-time flush) is now the single source of truth.

  ## Breaking changes

  **Completed records no longer retained in memory** — terminal records are evicted
  immediately on `archive()` and reconstructed from disk on the next `list`/`collect`
  call. Previously they lingered via an arbitrary sync-expire timer and a background
  FIFO. In-memory state now only holds records that are still running.

  **`HistoryStore` removed** — `runtime/execution/history-store.ts` and its test are
  deleted. `RecordStore` constructor now takes `sessionsDir: string` instead of a
  `HistoryStore`. The separate `history.jsonl` persistence layer is gone.

  **`PersistedAgentRecord` type removed** — `ExecutionRecord.toPersisted()` and
  `truncatePreview`/`PREVIEW_MAX` helpers are deleted (no more history-row shaping).

  **No migration** — records persisted to `history.jsonl` before this change will not
  be reconstructed (that format is unreadable by the new reconstructor). Only records
  with a `session.jsonl` that contains a `subagent-identity` custom entry are visible.

  ## New persistence model

  - **`core/session-reconstructor.ts`** — reads `session.jsonl` line-by-line and
    rebuilds `turns[]`/`eventLog`/`result`/`error`/`status`. Identity (id/agent/mode/
    task) comes from a `subagent-identity` custom entry written at session creation.
    Status is derived from the last assistant message `stopReason`
    (`error`/`aborted` → `failed`, else `done`); `lastError` clears on a clean stop.
    Degrades to `undefined` on any file/format failure.
  - **`runtime/execution/tombstone-store.ts`** — `.cancelled` sidecar tombstone
    persists cancelled state, since `session.abort()` truncates `session.jsonl`
    mid-run with no final marker.
  - **`collectRecords(limit, statusFilter)`** — status filtering is now a service/
    store core capability. Merges in-memory running records with disk
    reconstruction (cached, invalidated on change). Tombstone sidecar overrides
    status to `cancelled`.

  ## Why

  The 5s memory linger and the background FIFO were arbitrary (no design doc), and
  `history.jsonl` duplicated content already present in `session.jsonl`. The
  extension never read `session.jsonl` back. Making `session.jsonl` the single
  source of truth removes the duplication, the expiry timers, and the FIFO
  enforcement — and means `/subagents` and the `subagent` tool `list` action reuse
  the exact same reconstruction path with only a different status filter.

## 0.0.1

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
