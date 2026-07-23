# @zhushanwen/pi-goal

## 0.5.1

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

## 0.5.0

### Minor Changes

- ddc1223: Adopt @xyz-agent/extension-protocol@0.2.0 **gui** rendering protocol across three extensions:

  - **subagent-workflow**: migrate local gui-adapter stub to npm package; fix type contract (3 non-existent custom types → protocol primitives: task-list→list-tree, workflow-runs→list-tree, subagent-trace→card); unify isGuiCapable to ctx.mode === 'rpc'; add **gui** output to workflow-script tool; add **gui** field to SubagentToolResult/WorkflowToolDetails/WorkflowScriptToolDetails union types (removes unsafe casts); fix workflow not_found error rendering (danger stats-line instead of success checkmark); enrich subagent start card with slug/agent identity
  - **todo**: replace deprecated \_render with **gui** list-tree (pending→dot, in_progress→circle, completed→check, cancelled→cross)
  - **goal**: add **gui** progress-bar/stats-line output for budget visibility (card variant by status, severity by budget ratio thresholds); complete GoalStatus severity coverage (budget_limited/time_limited/cancelled → danger)

  Note: subagent-workflow's `slug` field is now required (non-optional) on 4 internal domain types (ExecutionRecord, ExecuteOptions, SubagentToolResult start branch, SubagentListItem). These are internal runtime types not constructed by external consumers; deserialization backfills `""` for old persisted records. Tagged minor per internal-types convention.

## 0.4.1

### Patch Changes

- 2a3fed0: Introduce `pending-notifications` extension and wire workflow/subagent background operations into it.

  - New `pending-notifications` extension tracks active async operations (workflow/subagent) via EventBus + session entries.
  - Workflow `run` / `abort` / terminal error paths emit `pending:register` and `pending:unregister` through a single EventBus port.
  - Subagent background mode now emits the same events via `pi.events.emit`; stale-context errors during subagent child sessions are now tolerated.
  - Goal's `before_agent_start` reads pending entries and injects a waiting hint when async work is active.
  - Added `workflow:log`, `pending:log`, and `goal:log` debug entries for tracing the register/unregister flow.
  - Workflow UI rendering improvements: themed border helpers and fixed overlay ghost rows.

## 0.4.0

### Minor Changes

- b868113: Architecture rewrite + Codex-parity behavior model for `@zhushanwen/pi-goal`.

  **Round 1 — 6-layer ports/adapters architecture:**

  - Layered split: `engine/` (zero Pi deps, pure state machines) → `ports.ts`
    (machine-checkable boundary) → `service.ts` (dual entry) → `adapters/` →
    `projection/` → `index.ts` (thin factory)
  - Deleted 9 legacy god-files (state/budget/widget/templates/tool-handler/
    action-handlers/command-handler/agent-end-handler/before-agent-start-handler)
  - Engine never imports `@mariozechner/*`; budget decisions and persistence are
    pure and independently tested
  - FR-5: strict serialize/deserialize (no legacy format compat — clean break)
  - FR-6.2: token/time budget warning flags are independent (4 flags)
  - FR-6.5: time accumulation extracted to a pure `tick()` (no double-write)
  - FR-6.7: ESC is a pure interrupt via `ctx.signal.aborted`; removed
    `pendingPause` field and module-level `lastCtx`

  **Round 2 — Codex-parity behavior model (FR-1…FR-7):**

  - FR-1: goal reuses `pi-todo` as its task model. `pi-todo` upgraded to a
    four-state model (`pending`/`in_progress`/`completed`/`cancelled`) with an
    optional `isVerification` flag and legacy migration
  - FR-2: new lightweight `goal_control` tool (`create`/`complete`/
    `report_blocked`); `goal_manager` task CRUD retired
  - FR-3: **7-state goal machine** per ADR-002
    (`active | paused | blocked | complete | budget_limited | time_limited |
cancelled`). Pi adds `time_limited` + `cancelled` vs Codex and deliberately
    omits `usage_limited` (Extension model doesn't own session-level quotas).
    `paused` is retained — `/goal pause` + `/goal resume` (recovers
    `paused|blocked → active`) work as before
  - FR-4: staleness reminder via `lastUpdatedTurn`; `agent_end` is warning-only
    with a single budget checkpoint
  - FR-5: budget auto-trigger on the event path (`persistAndUpdate` fallback,
    fires only for `active`)
  - FR-6: prompt-driven completion audit — `complete` is a soft suggestion, not
    a hard tool action; prerequisites enforced
  - FR-7: plan↔goal automatic linkage; goal↔todo dependency is `optional`
    (degrades gracefully when todo is missing)

  `pi-coding-workflow` / `pi-plan` receive a patch: their inline `GoalInitFn`
  type alias is updated to mirror goal's new required-`ctx` signature (no runtime
  change; callers already pass `ctx`).

  See `docs/adr/002-goal-7-state-machine.md` for the 7-state rationale.

## 0.3.0

### Minor Changes

- Goal abort command, task verification lifecycle, ESC pause, subtask support, enriched steering prompts, and unit tests

## 0.2.0

### Minor Changes

- Add Review-Gate auto-loop, Test-Fix Loop, and cross-extension Goal integration

  - goal: expose `initializeGoalFromExternal()` via `pi.__goalInit` for cross-extension access
  - coding-workflow: Review-Gate standard loop (Phase 1/2), Phase 3 three-stage review, Phase 4 Test-Fix Loop, Goal auto-init, Phase-Gate bug fixes
  - workflow: agent file discovery (project/user/npm/local), `resolveAgentOpts()` extraction, structured output failure handling

## 0.1.6

### Patch Changes

- 15b68f6: Fix evolve analyzer to find session files in project subdirectories, unify pi.extensions to ./index.ts

## 0.1.5

### Patch Changes

- Audit and fix all 11 extensions against project specifications

## 0.1.4

### Patch Changes

- ffd4c59: fix: remove hasPendingInjection blocking agent_end continuation; align maxTurns with currentTurnIndex

## 0.1.3

### Patch Changes

- 4de6d3a: i18n adaptation: replace all hardcoded Chinese strings with English across 7 extensions

## 0.1.2

### Patch Changes

- Fix GATE_SCRIPT_PATH path for npm packaging, module-level state encapsulation, execute error handling compliance, peerDependencies cleanup, ANSI escaping removal, and directory restructuring
