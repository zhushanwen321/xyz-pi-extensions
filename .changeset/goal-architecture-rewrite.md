---
"@zhushanwen/pi-goal": minor
"@zhushanwen/pi-coding-workflow": patch
"@zhushanwen/pi-plan": patch
---

Architecture rewrite + Codex-parity behavior model for `@zhushanwen/pi-goal`.

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
