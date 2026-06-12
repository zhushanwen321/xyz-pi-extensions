# @zhushanwen/pi-workflow

## 1.1.1

### Patch Changes

- 64405a6: fix(workflow): stop leaking worker diagnostics to the input area; scope TUI to selected phase

  - Worker console.\* calls are captured into `_workerLogs` and surfaced via `instance.errorLogs` in the TUI detail view, not stderr/input
  - All `console.log/warn/error` in the main thread (model-resolver, orchestrator-events, commands, orchestrator, index) are silenced or routed to `ctx.ui.notify` to prevent terminal pollution
  - `unknown fields` warnings from `agent()` no longer write to stderr; captured into worker logs instead
  - `/workflows` TUI level 0 now scopes the right panel to the currently selected phase instead of all phases
  - `workflow-script-format` example no longer uses `review-round-N` naming

- Updated dependencies [5c35364]
  - @zhushanwen/pi-model-switch@0.2.11

## 1.1.0

### Minor Changes

- feat(workflow): CC compat, structured output reliability, fullscreen TUI view, domain refactor

  - Claude Code format compatibility (outputSchema → schema mapping)
  - Structured output reliability with conditional activation
  - Fullscreen TUI view with three-level navigation (phase → agent → detail)
  - Domain layer architecture refactor (domain/engine/infra/interface)
  - 65 new tests (284 → 349), 21 code review fixes

## 1.0.1

### Patch Changes

- Fix unhandled rejection crash when aborting/pausing/resuming workflows in terminal or non-applicable states

## 1.0.0

### Minor Changes

- structured-output: unconditional global tool (schema+data params), remove env-gated mode. workflow: remove text fallback, rely on tool call only.

### Patch Changes

- Updated dependencies
  - @zhushanwen/pi-structured-output@0.3.0

## 0.3.2

### Patch Changes

- Fix structured-output peerDep version range: workspace:_ → _

## 0.3.1

### Patch Changes

- Remove per-turn context injection from model-switch; make model-switch an optional peer dep of workflow
- Updated dependencies
  - @zhushanwen/pi-model-switch@0.2.10

## 0.3.0

### Minor Changes

- Add `runAndWait()` method and `pi.__workflowRun` cross-extension channel

  - `WorkflowOrchestrator.runAndWait()`: synchronous wait with configurable timeout
  - `pi.__workflowRun` exposed in session_start for cross-extension programmatic access
  - Extract `orchestrator-budget.ts` for reuse

## 0.2.2

### Patch Changes

- Expose subagent sessionId for post-run session log access

## 0.2.1

### Patch Changes

- Fix parsedOutput capture: two-phase validation (tool_execution_start stash + tool_execution_end confirm)
- Updated dependencies
  - @zhushanwen/pi-structured-output@0.2.1

## 0.2.0

### Minor Changes

- Add Review-Gate auto-loop, Test-Fix Loop, and cross-extension Goal integration

  - goal: expose `initializeGoalFromExternal()` via `pi.__goalInit` for cross-extension access
  - coding-workflow: Review-Gate standard loop (Phase 1/2), Phase 3 three-stage review, Phase 4 Test-Fix Loop, Goal auto-init, Phase-Gate bug fixes
  - workflow: agent file discovery (project/user/npm/local), `resolveAgentOpts()` extraction, structured output failure handling

## 0.1.10

### Patch Changes

- 18b88fa: Fix agent subprocess killed prematurely by 120s timeout and add abort propagation for cleanup

## 0.1.9

### Patch Changes

- f7367e8: Fix agent subprocess killed prematurely by 120s hard timeout. Increase to 24h safety net and add proper abort signal propagation on terminate/pause/abort.

## 0.1.8

### Patch Changes

- Fix model polling, widget rendering, and reduce complexity

## 0.1.6

### Patch Changes

- Audit and fix all 11 extensions against project specifications
- Updated dependencies
  - @zhushanwen/pi-model-switch@0.2.6

## 0.1.5

### Patch Changes

- Add storage externalization, approval/verification gates, soft budget warning, and AgentPool optimizations

## 0.1.4

### Patch Changes

- Add auto/force mode to workflow-run tool with progressive discovery

## 0.1.3

### Patch Changes

- e19ed88: fix: remove hardcoded models and paths from review agents; fix Pi SDK type compat in evolve-daily and workflow

## 0.1.2

### Patch Changes

- Fix GATE_SCRIPT_PATH path for npm packaging, module-level state encapsulation, execute error handling compliance, peerDependencies cleanup, ANSI escaping removal, and directory restructuring
