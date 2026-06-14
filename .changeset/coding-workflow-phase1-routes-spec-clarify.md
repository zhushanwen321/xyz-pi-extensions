---
"@zhushanwen/pi-coding-workflow": minor
---

Phase 1 routing moved from the bundled brainstorming skill to @zhushanwen/pi-spec-clarify.

- Phase 1 now uses `xyz-harness-spec-clarify` (Model-First clarification) instead of `xyz-harness-brainstorming` (linear 10-step checklist)
- spec-clarify skills extracted out of the coding-workflow bundle into a standalone extension
- Declares runtime dependency on `@zhushanwen/pi-spec-clarify` — both must be installed for Phase 1 to work
- `xyz-harness-brainstorming` marked deprecated (trigger words removed) but retained for rollback

Note: a full coding-workflow refactor (atomic operations, declarative orchestrator) is specced but not yet implemented; this release only changes the Phase 1 entry skill.
