---
"@zhushanwen/pi-workflow": major
"@zhushanwen/pi-coding-workflow": minor
---
Workflow extension refactor: 3-layer architecture (Interface/Engine/Infra)
replacing the legacy domain/orchestrator design (D-12). 33 tasks across 5
waves; test count 488 → 529.

**BREAKING** — `pi.__workflowRun` return shape changed (D-8):
- Old: `{ status: string, scriptResult?, error?, runId }` where `status`
  could be `"running"`, `"aborted"`, `"timeout"`, etc.
- New: `{ status: "done", reason: DoneReason, scriptResult?, error?, runId }`
  where `status` is always `"done"` and the outcome is encoded in
  `reason: "completed" | "failed" | "aborted" | "budget_limited" | "time_limited"`.

The two in-workspace consumers (`coding-workflow/lib/gates/review-gate.ts`,
`test-fix-loop.ts`) are migrated in lockstep. External callers must update.

Other changes:
- State machine simplified 8 → 3 states (`running` / `paused` / `done`) +
  `doneReason` (D-6). Removes 5 duplicate `terminateInstance` call sites.
- Tools consolidated 4 → 2 (FR-5): `workflow` (run/list/abort/pause/resume/
  status/retry-node/skip-node) + `workflow-script` (generate/lint/save/
  delete/list).
- Commands consolidated 6 → 1 (FR-6): only `/workflows` remains. Removed
  `/workflow run|list|abort|save|delete`.
- `restart` action removed (D-9) — use `run` for new semantics.
- `ConcurrencyGate` (renamed from `AgentPool`) now enforces `maxConcurrency=4`
  via `withSlot()` in the dispatch path (previously dead code).
- `budget_limited` and completion notification (`notifyDone`) are now wired
  through (previously declared but never triggered).
- `ApprovalPolicy` deleted (D-11) → 2-line Interface helper.
- JSONL persistence format changed (D-5) — old session history not
  loadable; the guard returns empty for old-format files.
