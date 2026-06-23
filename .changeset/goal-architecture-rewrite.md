---
"@zhushanwen/pi-goal": minor
"@zhushanwen/pi-coding-workflow": patch
"@zhushanwen/pi-plan": patch
---

Architecture rewrite: 6-layer ports/adapters architecture with zero-Pi-dep engine.

This is a major internal refactor that preserves all user-facing behavior (tool
schema, command subcommands, event handling) while restructuring the codebase
into clear layers (engine → ports → service → adapters → projection).

**Behavior-equivalent** for the happy path. Architecture-necessary behavior
changes (all documented in spec FR-4/5/6):

- FR-5: Serialization clean break (strict deserialize, no legacy compat)
- FR-6.2: Token/time budget warning flags are now independent (4 flags instead
  of 2 combined)
- FR-6.4: Removed `hasPendingInjection` zombie field
- FR-6.5: Time accumulation extracted to pure `tick()` function (no double-write)
- FR-6.6: `hasUI` guard centralized in ports
- FR-6.7: ESC is now a pure interrupt via `ctx.signal.aborted` (3-handler guard);
  removed `pendingPause` field
- FR-4.1: `__goalInit` delegates to `service.createGoal` (dual-track eliminated)
- FR-4.2/D-16: `ctx` is now required (removed `lastCtx` module-level mutable state)

`pi-coding-workflow` / `pi-plan` receive a patch: their inline `GoalInitFn` type
alias is updated to mirror goal's new required-ctx signature (no runtime change;
callers already pass `ctx`).

**ADR-002: `paused` state removed** (user-visible behavior change):

- Removed the `paused` goal status and the `/goal pause` command.
- ESC interrupt no longer needs `paused` — Pi's native abort mechanism already
  stops the agent and waits for the next user message (FR-6.7).
- Context-usage protection (>85%) now keeps the goal `active` and only injects
  a wrap-up instruction (no state transition).
- `/goal resume` now only recovers `blocked → active` (was `paused|blocked`).
- The `blocked` status (AI `report_blocked` action + auto-block on stall) is
  retained unchanged — it is independent of ESC/pause.
- Goal status enum is now 6 states: `active | blocked | complete | budget_limited | time_limited | cancelled`.

Users who previously used `/goal pause` should rely on ESC (pure interrupt) or
`/goal clear`/`/goal abort` instead. See
`.xyz-harness/2026-06-21-goal-architecture-rewrite/changes/adr-002-remove-paused-state.md`
for full rationale.
