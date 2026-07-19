# @zhushanwen/pi-subagent-workflow

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
