---
"@zhushanwen/pi-workflow": patch
---

fix(workflow): stop leaking worker diagnostics to the input area; scope TUI to selected phase

- Worker console.* calls are captured into `_workerLogs` and surfaced via `instance.errorLogs` in the TUI detail view, not stderr/input
- All `console.log/warn/error` in the main thread (model-resolver, orchestrator-events, commands, orchestrator, index) are silenced or routed to `ctx.ui.notify` to prevent terminal pollution
- `unknown fields` warnings from `agent()` no longer write to stderr; captured into worker logs instead
- `/workflows` TUI level 0 now scopes the right panel to the currently selected phase instead of all phases
- `workflow-script-format` example no longer uses `review-round-N` naming
