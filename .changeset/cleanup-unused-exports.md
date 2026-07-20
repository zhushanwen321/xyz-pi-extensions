---
"@zhushanwen/pi-goal": patch
"@zhushanwen/pi-coding-workflow": patch
"@zhushanwen/pi-subagent-workflow": patch
---

Remove unused exports identified by `fallow dead-code` static analysis.

Each symbol was verified via cross-project grep (to catch dynamic imports fallow may miss) and ESLint side-effect check (to surface cascading dead code). Symbols with internal consumers were un-exported (kept private); symbols with zero usage were deleted entirely.

### @zhushanwen/pi-goal (7)
- `constants.ts`: remove `MS_PER_SECOND`, `BUDGET_RATIO_TIGHT`, `BUDGET_PERCENT_HIGH`, `BUDGET_PERCENT_LOW`
- `projection/widget.ts`: un-export `formatTokens`, `getTitle` (internal use)
- `service.ts`: remove `checkResumeBudget` + now-unused `checkBudgetOnResume` import

### @zhushanwen/pi-coding-workflow (5)
- `lib/gates/review-gate.ts`: remove `hasReviewWorkflowApi` + now-unused `ExtensionAPI` import
- `src/cw/checks/shared.ts`: remove `extractUcIds`, `extractTestIds`, `ISSUE_HEADING_RE`
- `src/index.ts`: un-export `dispatch` (internal use)

### @zhushanwen/pi-subagent-workflow (18 of 20)
- `execution/execution-record.ts`: remove `jsonlToAgentEvent` + orphan helpers (`JsonlEvent`, `accumulateMessageEndForRecord`) + unused `ToolCallResult` import (−109 lines)
- `interface/views/format.ts`: remove `segFillColored` (dead code — WorkflowsView never imported it)
- `interface/views/WorkflowsView.ts`: remove stale re-export block (`buildDetailContent`/`detailContentLength`/`processDetailKey` + `DetailKeyResult`/`DetailScrollContext` types) — tests now import directly from `detail-content.ts`
- `orchestration/models/types.ts`: remove `ALL_RUN_STATUSES`, `ALL_DONE_REASONS`, `isDone`; un-export `VALID_RUN_TRANSITIONS` (internal use by `canRunTransition`)
- Un-export 10 others (internal use only): `BorderedBgBox`, `formatToolCall`, `processKey`, `statusLabel`, `STALE_CONTEXT_PATTERNS`, `isStaleContextErrorMsg`, `SNAPSHOT_VERSION`, `scanDirectorySync`, `readPackageManifestSync`, `scanNpmDirSync`

### Retained (fallow false positives)
- `plan/compact.ts: detectGoalCapability` — dynamic import in `tool.ts:296` (`(await import("./compact.js")).detectGoalCapability(pi)`)
- `subagent-workflow/index.ts: getOrCreateChannelRegistry` — declared stable public API surface for cross-extension consumers
