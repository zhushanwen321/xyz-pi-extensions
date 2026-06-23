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
- `resolveAgentOpts` restored in dispatch path (BL-1): agent/skill/schema
  inline overrides (`agent({agent,skill,schema})`) are again resolved into
  `--append-system-prompt` / `--skill` / `PI_WORKFLOW_SCHEMA` injection. This
  was silently dropped during the D-12 engine refactor and is now wired back
  via `LifecycleDeps.agentRegistry/sessionDir/activeTempFiles`.
- Round-4 review cleanup (non-blocking SUGGESTIONs):
  - `WorkflowToolDetails` / `WorkflowScriptToolDetails` discriminated unions
    replace `Record<string, unknown>` for the two tools' `details` payloads;
    `save`/`delete` now surface structured `{ok:false}` details on failure
    (S2/S3).
  - `DoneReason` / `WorkflowRunResult` / `WorkflowRunFn` de-duplicated into
    `coding-workflow/lib/gates/workflow-types.ts` (single source of truth),
    consumed by both gates + both gate tests (MI-1).
  - Test coverage backfilled: `/workflows` command handler (5 tests, was
    zero-covered) and `format.ts` pure functions (29 tests — formatElapsed /
    formatTokenStat / formatActivityLine / visibleLen / padVisible) (S4/S5).
- Critical regression fixes (found via session-log analysis post-link):
  - **Bug #1 (workflow scripts didn't execute)**: `WorkflowScriptRegistryImpl`
    returned `WorkflowScript` with `sourceCode: ""` (placeholder comment
    claimed "Interface layer reads file as needed", but no layer did).
    `launcher.runAndWait` / `tool-workflow.actionRun` called
    `script.toExecutable()` on the empty source → worker received an empty
    script → workflows silently completed in ~13ms with 0 agent calls.
    Fixed per spec FR-2 (registry is the single filesystem reader, 扫描+缓存+去重):
    registry now `readFileSync`-populates `sourceCode`; 60s TTL cache remains
    the single read path. Callers consume `validate()`/`toExecutable()` directly.
  - **Bug #2 (/workflows command lost its TUI)**: the T27/T31 transition left
    `registerWorkflowsCommand` emitting text via `ctx.ui.notify` instead of
    opening the `WorkflowsView` interactive panel (UC-3, FR-6). Restored the
    TUI handler: `/workflows` → sort runs (active first) → `ctx.ui.select`
    → `createWorkflowsView`; `/workflows <runId>` does exact/prefix direct-open.
    `ViewActions` (pause/resume/abort) injected from `LauncherDeps`.
  - **Bug #3 (TUI crashed on open — `tui.on is not a function`)**: the T31
    WorkflowsView rewrite used a non-existent `tui.on(key, cb)` API and
    returned a raw `Text` component. The real SDK `TUI` class has no `.on()`;
    `ctx.ui.custom` expects a `Component{render(width), handleInput(data),
    invalidate()}`. Rewrote the view body to the SDK-conformant Component
    pattern (aligned with `main`): keys parsed via `matchesKey(data, Key.*)`
    from `@mariozechner/pi-tui` (handles xterm/iTerm/kitty escape-sequence
    differences), render cache mirrors main's width-keyed cache, escape/ctrl+c
    exit, p/a lifecycle shortcuts preserved (no restart per D-9).
