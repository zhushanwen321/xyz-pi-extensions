---
"@zhushanwen/pi-subagent-workflow": minor
"@zhushanwen/pi-todo": minor
"@zhushanwen/pi-goal": minor
---

Adopt @xyz-agent/extension-protocol@0.2.0 __gui__ rendering protocol across three extensions:

- **subagent-workflow**: migrate local gui-adapter stub to npm package; fix type contract (3 non-existent custom types → protocol primitives: task-list→list-tree, workflow-runs→list-tree, subagent-trace→card); unify isGuiCapable to ctx.mode === 'rpc'; add __gui__ output to workflow-script tool; add __gui__ field to SubagentToolResult/WorkflowToolDetails/WorkflowScriptToolDetails union types (removes unsafe casts); fix workflow not_found error rendering (danger stats-line instead of success checkmark); enrich subagent start card with slug/agent identity
- **todo**: replace deprecated _render with __gui__ list-tree (pending→dot, in_progress→circle, completed→check, cancelled→cross)
- **goal**: add __gui__ progress-bar/stats-line output for budget visibility (card variant by status, severity by budget ratio thresholds); complete GoalStatus severity coverage (budget_limited/time_limited/cancelled → danger)

Note: subagent-workflow's `slug` field is now required (non-optional) on 4 internal domain types (ExecutionRecord, ExecuteOptions, SubagentToolResult start branch, SubagentListItem). These are internal runtime types not constructed by external consumers; deserialization backfills `""` for old persisted records. Tagged minor per internal-types convention.
