---
"@zhushanwen/pi-todo": minor
---

Normalize error handling and document the todo extension.

**Breaking**: tool handlers now `throw new Error()` on failure instead of
returning an error-success structure (`details.error`). The `TodoDetails.error`
field is removed and `renderTodoResult` no longer has an error branch.
`model.ts` pure functions still return Result objects (`{error, resultText}`),
which is a valid functional pattern — the tool dispatcher throws when it sees
an error, per the project's "Tool Design" convention in CLAUDE.md.

**Additions**
- `ARCHITECTURE.md`: module dependency graph, session-state field table, event
  lifecycle timeline, and the steer mechanism in detail (agent_end flow,
  four sub-mechanism thresholds, four counter-intuitive points).
- `src/__tests__/steer.test.ts`: real state-machine tests for the
  completion-steer / auto-clear / stall / reminder mechanisms and
  `reconstructState` replay+GC+migration, replacing the previous
  arithmetic-only simulation.
- `handlers.ts` internal functions exported to enable direct testing.

**Docs**
- `README.md` rewritten: accurate action×parameter matrix, `updates[]`
  priority, error-handling contract table, steer mechanism, implicit
  persistence (reuses toolResult entries, no `appendEntry`), three-layer
  rendering, real 8-file structure.
- `PLAN.md` marked SUPERSEDED.
- `src/index.ts` header comment cleaned (removed stale four-state / verifyText
  / phantom `buildPendingContext` references).
