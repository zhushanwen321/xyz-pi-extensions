# @zhushanwen/pi-coding-workflow

## 0.3.2

### Patch Changes

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

- Gate Pipeline + Workflow-driven Review-Gate & Test-Fix Loop (P0-P3)

  - Gate Pipeline abstraction: configurable gate chain per phase (review-gate, phase-gate, test-fix-loop)
  - Workflow integration via `pi.__workflowRun` with `runSingleAgent` fallback
  - Phase 1/2 Review-Gate: workflow scripts with L1/L2 routing
  - Phase 3 Review-Gate: 3-stage nested loop (conformance → simulated-data → 5 parallel reviewers + fix-worker)
  - Phase 4 Test-Fix Loop: core→noncore serial, 10-round with incremental strategy
  - 11 agent files, 4 workflow scripts
  - Phase 3 dynamic goal injection, retrospect context injection
  - 4 SKILL.md files updated with workflow gate guidance

## 0.3.0

### Minor Changes

- Gate Pipeline (P0): configurable gate chain abstraction (`lib/gates/`)

  - `Gate`/`GateContext`/`GateResult` interfaces
  - `ReviewGate` — dual-path: `pi.__workflowRun` preferred, `runSingleAgent` fallback
  - `PhaseGate` — reuses `runGateScript`
  - `TestFixLoopGate` — dual-path: `pi.__workflowRun` preferred, `runSingleAgent` fallback
  - `executeGateTool` refactored from hardcoded review→phase to configurable gate chain

- Workflow integration (P1): `pi.__workflowRun` cross-extension call channel

  - `WorkflowOrchestrator.runAndWait()` — synchronous wait with 10min timeout
  - 3 Phase 1/2 agent files: `spec-requirements-reviewer`, `plan-requirements-reviewer`, `plan-bl-requirements-reviewer`
  - 2 workflow scripts: `phase1-review-gate.js`, `phase2-review-gate.js` (L1/L2 routing)
  - ReviewGate upgraded from stub to full `pi.__workflowRun` integration with fallback

- Phase 3/4 workflows (P2): complete Review-Gate + Test-Fix Loop coverage

  - 8 agent files: `spec-plan-conformance-reviewer`, `simulated-data-generator`, `fallow-reviewer`, `review-sync-fix-worker`, `file-fix-subagent`, `test-execute-coordinator`, `test-fix-worker`, `test-case-subagent`
  - 2 workflow scripts: `phase3-review-gate.js` (3-stage nested loop), `phase4-test-fix-loop.js` (core→noncore serial)
  - TestFixLoopGate upgraded from stub to full `pi.__workflowRun` integration

- Goal + Retrospect + SKILL.md cleanup (P3): experience polish
  - Phase 3 dynamic goal task injection (from plan.md Execution Groups)
  - Retrospect context injection (deliverable summaries in steer prompt)
  - 4 SKILL.md files cleaned: removed manual review/gate handoff sections, added workflow gate guidance
  - ADR-020: coding-workflow depends on workflow extension

## 0.2.0

### Minor Changes

- Add Review-Gate auto-loop, Test-Fix Loop, and cross-extension Goal integration

  - goal: expose `initializeGoalFromExternal()` via `pi.__goalInit` for cross-extension access
  - coding-workflow: Review-Gate standard loop (Phase 1/2), Phase 3 three-stage review, Phase 4 Test-Fix Loop, Goal auto-init, Phase-Gate bug fixes
  - workflow: agent file discovery (project/user/npm/local), `resolveAgentOpts()` extraction, structured output failure handling

## 0.1.6

### Patch Changes

- Audit and fix all 11 extensions against project specifications

## 0.1.5

### Patch Changes

- 4de6d3a: i18n adaptation: replace all hardcoded Chinese strings with English across 7 extensions

## 0.1.4

### Patch Changes

- e19ed88: fix: remove hardcoded models and paths from review agents; fix Pi SDK type compat in evolve-daily and workflow

## 0.1.3

### Patch Changes

- Fix GATE_SCRIPT_PATH path for npm packaging, module-level state encapsulation, execute error handling compliance, peerDependencies cleanup, ANSI escaping removal, and directory restructuring

## 0.1.1

### Patch Changes

- Test CI release pipeline
