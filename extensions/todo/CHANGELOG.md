# @zhushanwen/pi-todo

## 0.4.1

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

## 0.4.0

### Minor Changes

- ddc1223: Adopt @xyz-agent/extension-protocol@0.2.0 **gui** rendering protocol across three extensions:

  - **subagent-workflow**: migrate local gui-adapter stub to npm package; fix type contract (3 non-existent custom types → protocol primitives: task-list→list-tree, workflow-runs→list-tree, subagent-trace→card); unify isGuiCapable to ctx.mode === 'rpc'; add **gui** output to workflow-script tool; add **gui** field to SubagentToolResult/WorkflowToolDetails/WorkflowScriptToolDetails union types (removes unsafe casts); fix workflow not_found error rendering (danger stats-line instead of success checkmark); enrich subagent start card with slug/agent identity
  - **todo**: replace deprecated \_render with **gui** list-tree (pending→dot, in_progress→circle, completed→check, cancelled→cross)
  - **goal**: add **gui** progress-bar/stats-line output for budget visibility (card variant by status, severity by budget ratio thresholds); complete GoalStatus severity coverage (budget_limited/time_limited/cancelled → danger)

  Note: subagent-workflow's `slug` field is now required (non-optional) on 4 internal domain types (ExecutionRecord, ExecuteOptions, SubagentToolResult start branch, SubagentListItem). These are internal runtime types not constructed by external consumers; deserialization backfills `""` for old persisted records. Tagged minor per internal-types convention.

## 0.3.0

### Minor Changes

- Four-state task model + verification flag for goal↔todo merge (FR-1).

  `pi-todo` is upgraded from a three-state to a **four-state** model to become
  the shared task backend for `@zhushanwen/pi-goal` (0.4.0+) and to mirror
  Codex's task lifecycle:

  - Status enum: `pending | in_progress | completed | cancelled`
    (`cancelled` is terminal and non-recoverable)
  - New optional `isVerification` field — marks verification tasks used by
    goal's prompt-driven completion audit (FR-6). Verification tasks must reach
    `completed`, never `cancelled`
  - Legacy data migration on read:
    - `status: "verifying"` → `"in_progress"`
    - `status: "failed"` → `"pending"`
    - `done: boolean` → `status: "completed" | "pending"`
    - `isVerification` preserved when present (absent on old data is fine — field
      is optional)

  Backward compatible: existing stored todo lists load unchanged after migration.
  Goal 0.4.0 depends on this model — pair this release with `pi-goal@0.4.0`.

## 0.2.0

### Minor Changes

- ee8a22d: Simplify the todo state model from 4 states (pending / in_progress / verifying / failed) to 3 states (pending / in_progress / completed) and remove the verification interception. The dual-column TUI widget is now CJK-aware via `pi-tui`'s `visibleWidth`, and a completion steer is injected when every todo is done.

  **Breaking changes**

  - Removed `verifying` and `failed` states; `verifyText` / `verifyAttempts` / `evidence` fields are gone
  - Removed the `verify` action and the `verifyTexts` / `verified` / `evidence` parameters on `update` actions
  - `migrateTodo` now maps `verifying → in_progress` and `failed → pending` on legacy state load

  **Additions**

  - Dual-column widget layout (active list on the left, completed list on the right) with a vertical divider
  - CJK-aware column sizing using `pi-tui`'s `visibleWidth` (replaces custom `visualLen` that ignored east-asian width)
  - Completion steer: when every todo is `completed`, a one-shot summary check is injected into the next agent turn
  - Reduced reminder interval (3 → 2) and switched to a minimal reminder that mentions only the next pending task

### Patch Changes

- 167fdf3: Widget layout now switches between single and dual column based on Pi's widget line limit.

  - Discovered Pi caps extension widgets at `InteractiveMode.MAX_WIDGET_LINES = 10` strings per widget.
  - Todo widget reserves the header line and uses `max - 1 = 9` as the safe content budget.
  - When the task count is 8 or fewer, the widget renders in a single column; 9 or more tasks switch to the existing dual-column layout to stay within the budget and avoid Pi's truncation.

## 0.1.6

### Patch Changes

- 15b68f6: Fix evolve analyzer to find session files in project subdirectories, unify pi.extensions to ./index.ts

## 0.1.5

### Patch Changes

- Audit and fix all 11 extensions against project specifications

## 0.1.4

### Patch Changes

- 4de6d3a: i18n adaptation: replace all hardcoded Chinese strings with English across 7 extensions

## 0.1.3

### Patch Changes

- Fix GATE_SCRIPT_PATH path for npm packaging, module-level state encapsulation, execute error handling compliance, peerDependencies cleanup, ANSI escaping removal, and directory restructuring

## 0.1.1

### Patch Changes

- Test CI release pipeline
