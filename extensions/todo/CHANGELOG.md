# @zhushanwen/pi-todo

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
