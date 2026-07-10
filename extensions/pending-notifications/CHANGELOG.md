# @zhushanwen/pi-pending-notifications

## 0.2.0

### Minor Changes

- 2a3fed0: Introduce `pending-notifications` extension and wire workflow/subagent background operations into it.

  - New `pending-notifications` extension tracks active async operations (workflow/subagent) via EventBus + session entries.
  - Workflow `run` / `abort` / terminal error paths emit `pending:register` and `pending:unregister` through a single EventBus port.
  - Subagent background mode now emits the same events via `pi.events.emit`; stale-context errors during subagent child sessions are now tolerated.
  - Goal's `before_agent_start` reads pending entries and injects a waiting hint when async work is active.
  - Added `workflow:log`, `pending:log`, and `goal:log` debug entries for tracing the register/unregister flow.
  - Workflow UI rendering improvements: themed border helpers and fixed overlay ghost rows.
