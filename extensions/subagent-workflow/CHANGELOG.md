# @zhushanwen/pi-subagent-workflow

## 0.3.2

### Patch Changes

- 4ed62ca: Subagent 子进程镜像主进程的 extension/approve flag

  新增 `mirrorMainProcessFlags(argv)`：从主 pi 进程的 `process.argv` 解析
  `--extension` / `--no-extensions` / `--approve`，透传给 `buildSpawnArgs`，
  让 subagent 子进程的 extension 加载行为与主进程一致（之前子进程完全不继承，
  会加载全局自动发现的 extension 且不信任项目级 .pi/skills）。

  - 数据源是主进程 argv（已运行时验证完整保留启动 flag），非 env 传递
  - 向后兼容：argv 无这些 flag 时 `buildSpawnArgs` 行为完全不变
  - 对任意 pi 宿主通用（不只 xyz-agent），xyz-agent 侧零改动
  - 嵌套 subagent（孙进程）自动继承——镜像后父进程 argv 自带这些 flag

## 0.3.1

### Patch Changes

- bb86ee9: Harden 5 tool descriptions + runtime validation against weak-model first-call parameter misuse.

  Triggered by a real session where a flash-tier model (step-3.7-flash) called the `subagent` tool with `task`/`slug` flattened to the top level (missing the `startParam` envelope) and needed a round-trip to self-correct. Root cause analysis found a systemic debt pattern across 5 tools: conditional-required fields expressed as `Type.Optional`, zero JSON call examples in descriptions, no parameter-structure anti-patterns, dry runtime error messages with no Correct example, and no prompt-quality regression tests.

  Three-layer fix applied uniformly to all 5 tools (subagent + workflow + goal_control + todo + ask-user + structured-output):

  - **Runtime friendly correction**: required-field throws now append a copy-pasteable `Correct: {full JSON}` example; common-misuse detectors catch the highest-frequency errors and return a corrected shape (subagent `startParam` flattening; workflow `args` sub-field flattening — a P0 silent failure; todo `text`/`texts` + `id`/`ids` dual-shape trap; ask-user string `options` array).
  - **Description examples + structural anti-patterns**: each tool now ships complete JSON call examples for every high-risk action and a Don't section listing parameter-structure mistakes.
  - **Prompt-quality regression tests**: new source-text assertion test per tool locks the examples / anti-patterns / Correct-usage strings so they cannot silently regress.

  Notable silent-failure closures (worse than the original throw-based failure because they did not error at all):

  - **structured-output**: `schema`/`data` swap detection + keyword-less schema rejection. Previously `Type.Unknown()` + `ajv strict:false` compiled a keyword-less object (e.g. `{}`, `{a:1}`) into an accept-anything validator — swapping schema and data then passed validation and stored garbage silently. Now detected and rejected with a Correct hint.
  - **workflow**: flattened `args` sub-fields (task/items/...) previously fell through to `args = params.args ?? {}`, silently launching a run missing its parameters.

  Other changes:

  - **subagent + workflow**: `slug` `maxLength` relaxed 20 → 35 (single source `SLUG_MAX_LENGTH`; both schemas now reference the constant). Descriptive kebab-case slugs like `fix-subagent-wf-tools` (21) no longer collide; over-limit error now suggests a shorter label.
  - **ask-user**: `InputSchema.options` element intentionally loosened to `OptionSchema | string` so a mistyped string-array `options` reaches `validateInput` (friendly Correct error) instead of being killed by the schema layer's raw ajv error before `execute` runs. Internal `Question`/`Option` types stay strict.
  - **structured-output**: extracted `executeStructuredOutput()` for direct unit testing (internal test helper — not re-exported from the package root, so not part of the public API); deleted stale `STRUCTURED_OUTPUT_SCHEMA` env-name + tool_call block tests (0.3.0 changed to unconditional registration, real env name is `PI_WORKFLOW_SCHEMA`).

  Review follow-up (addressed in the same PR after a 6-dimension multi-agent code review):

  - **structured-output**: `SCHEMA_KEYWORDS` completed with the remaining draft-07 validation keywords (`if`/`then`/`else`/`dependencies`/`propertyNames`/`contains`/`$defs`/`definitions`) so a conditional root schema is no longer wrongly rejected as keyword-less; `executeStructuredOutput` return type widened from `Record<string,unknown>` to `unknown` (data may be a primitive/array per its own tests); `getOrCompileValidator` now accepts `object | boolean` (boolean root schemas are valid draft-07), eliminating an unsafe cast; `tool_execution_end` handler uses a runtime type guard instead of a bare cast; `echo()` now tolerates `undefined` (`JSON.stringify(undefined)` returns undefined and previously crashed `.length` — a latent bug surfaced by the new edge-case tests).
  - **subagent-workflow + todo**: detectors (`hasFlattenedStartFields`, workflow `findFlattenedArgKeys`, todo `handleAdd`/`handleDelete`) now exported to enable behavioural trigger/no-trigger tests — the P0 workflow flatten detector previously had only a fragile source-text lock. Added slug boundary tests (35/36) and a workflow-side runtime slug guard matching subagent's.
  - goal_control `hasGoalDetails` guard tightened to validate the `details` value is an object (not just that the key exists).

  All five packages are bumped `patch`: no breaking API changes, no new public exports forming a supported API contract (the exported detectors are test helpers, not a stable surface), and the ask-user schema loosening + structured-output keyword-less rejection only surface clearer errors for inputs that were already malformed (previously silently corrupted or raw-ajv-rejected). This is defensive hardening + prompt-quality work, conservatively versioned as patch.

- Updated dependencies [bb86ee9]
  - @zhushanwen/pi-structured-output@0.3.4

## 0.3.0

### Minor Changes

- bd68203: Decouple subagent execution record identity from transcript lifecycle (ADR-035):

  - Record id uses `crypto.randomUUID()` for global uniqueness across restarts
  - Atomic manifest persistence (`<uuid>.json`) carrying sessionFile, status, timestamps
  - RPC `get_state` handshake after spawn to resolve sessionFile/sessionId robustly
  - Orphan session detection + tmp residue recovery on startup
  - PID alive timeout narrowed (24h → 1h) to bound stale-record window
  - Manifest write failures surface as errors (no silent swallow)
  - Manifest status enum expanded from 3-state to 4-state (add cancelled; crashed stays as reconstruction-derived state, not persisted in manifest)

### Patch Changes

- 4fe4906: Fix subagent ask_user end-to-end unavailability and generalize UI transit to a two-dimension orthogonal architecture (method interaction model + channel registry).

  Root causes fixed:

  - Protocol format error (expected JSON-RPC 2.0 but Pi emits flattened `{type, method, ...}`)
  - Handler injection completely missing (index.ts session_start did not pass uiRequestHandler)
  - No method/channel dispatch (all UI requests merged into single handler)
  - No TUI/GUI/headless mode dispatch (W4 prompt injected unconditionally)
  - Silent failure when handler missing (no observability)
  - No cross-subprocess concurrency queue (multiple ask_user flood parent UI)

  Architecture (ADR-033): two orthogonal dimensions:

  - Transit + queue strategy determined by method interaction model (dialog classes transit + L2 queue; fire-and-forget not transited under TUI)
  - Business routing determined by channel registry (ask_user / gui_widget / future)

## 0.2.0

### Minor Changes

- ddc1223: Adopt @xyz-agent/extension-protocol@0.2.0 **gui** rendering protocol across three extensions:

  - **subagent-workflow**: migrate local gui-adapter stub to npm package; fix type contract (3 non-existent custom types → protocol primitives: task-list→list-tree, workflow-runs→list-tree, subagent-trace→card); unify isGuiCapable to ctx.mode === 'rpc'; add **gui** output to workflow-script tool; add **gui** field to SubagentToolResult/WorkflowToolDetails/WorkflowScriptToolDetails union types (removes unsafe casts); fix workflow not_found error rendering (danger stats-line instead of success checkmark); enrich subagent start card with slug/agent identity
  - **todo**: replace deprecated \_render with **gui** list-tree (pending→dot, in_progress→circle, completed→check, cancelled→cross)
  - **goal**: add **gui** progress-bar/stats-line output for budget visibility (card variant by status, severity by budget ratio thresholds); complete GoalStatus severity coverage (budget_limited/time_limited/cancelled → danger)

  Note: subagent-workflow's `slug` field is now required (non-optional) on 4 internal domain types (ExecutionRecord, ExecuteOptions, SubagentToolResult start branch, SubagentListItem). These are internal runtime types not constructed by external consumers; deserialization backfills `""` for old persisted records. Tagged minor per internal-types convention.

- 2003e64: Add RPC-mode lifecycle control to /subagents and /workflows command handlers so xyz-agent GUI can trigger cancel/pause/resume/abort via slash command (e.g. `client.prompt("/subagents cancel <id>")`) without LLM round-trip. TUI paths unchanged; headless (print/json) guard tightened from `!ctx.hasUI` to `ctx.mode !== "tui"`.

### Patch Changes

- Updated dependencies [96aed1d]
  - @zhushanwen/pi-structured-output@0.3.3
