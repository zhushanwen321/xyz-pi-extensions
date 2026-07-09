---
"@zhushanwen/pi-coding-workflow": minor
"@zhushanwen/pi-workflow": patch
---

**coding-workflow (minor)** — ADR-029 full workflow takeover + machine-enforced test gate:

- `execute-full-workflow.js`: full dev+test+review orchestration via worktree
  isolation (per-call cwd, parallel dev waves, 2-way review cross-check).
- `test-orchestrator` tool: 4-action machine-recomputed E2E test state machine.
- `lib/gates`: ReviewGate + TestFixLoopGate machine gates (no human judgment bypass).
- Replan action handler + state machine (illegal_transition recovery).
- Tier-based budget config (lite/mid/full token + time budgets).
- `_cw.json` JSON store (replaces node:sqlite `_cw.db` for portability).
- Plan.json test scheduling fields (dependsOn/parallelGroup).
- Skill doc improvements: workspace guard, no-fallback rule, schema validation.

**workflow (patch)** — dev extension workflow discovery fix:

- config-loader now scans `~/.pi/agent/extensions/` (dev symlinked extensions)
  in addition to `~/.pi/agent/npm/node_modules`. Extensions with
  `pi.workflows` manifest in dev mode were previously invisible to
  `workflow run` / `workflow-script list`.
