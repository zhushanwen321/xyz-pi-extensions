---
"@zhushanwen/pi-workflow": minor
---
Internal refactor: merge 7 parallel lifecycle maps into a single
`runs: Map<string, RunResources>`, unify workflow termination through
`terminateInstance` (A4 atomicity — cleanup before status mutation),
and split index.ts/orchestrator.ts under the 1000-line limit.

Behavioral changes:
- `saveWorkflow` unified to rename semantics (tmp disappears after save),
  project scope only — TUI loses the user-scope Tab toggle (decision 2)
- Agent one-liner in workflow view now separates elapsed with 4 spaces
  instead of ` · ` (decision 1)

New public types: `RunResources`, `RunMeta` (from `domain/run-resources.ts`).
