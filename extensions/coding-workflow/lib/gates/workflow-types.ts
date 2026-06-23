/**
 * Cross-extension type contract: coding-workflow ↔ workflow (D-8).
 *
 * Single source of truth for the `pi.__workflowRun` RPC shape consumed by
 * ReviewGate / TestFixLoopGate. Previously duplicated across 4 files
 * (review-gate.ts, test-fix-loop.ts, and both __tests__) — MI-1 round-4
 * de-duplication: now defined once here, imported everywhere.
 *
 * DESIGN NOTE — why local file, not `import from "@zhushanwen/pi-workflow"`?
 *   coding-workflow declares the workflow extension as an **optional** runtime
 *   dependency (extension-dependencies.json) and degrades gracefully when
 *   `pi.__workflowRun` is absent (fallback to runSingleAgent). Importing
 *   workflow's *types* at compile time would invert that: coding-workflow would
 *   fail to type-check unless workflow's package is resolvable. The shapes here
 *   are a narrow, stable RPC contract (D-8) intentionally kept independent.
 *
 *   The canonical definitions live in the workflow extension:
 *     - DoneReason        → extensions/workflow/src/engine/models/types.ts
 *     - WorkflowRunResult → extensions/workflow/src/engine/launcher.ts
 *   These mirrors MUST stay byte-identical. If workflow changes the union,
 *   update both files + the gate tests in one commit.
 *
 * 参考：
 *   - workflow extension clarification.md D-8 (WorkflowRunResult 签名)
 *   - round-4 review MI-1 (this de-duplication)
 */

// ── DoneReason (mirror of workflow's canonical union) ─────────

/**
 * Terminal reason for a workflow run. Mirror of
 * `extensions/workflow/src/engine/models/types.ts:DoneReason`.
 */
export type DoneReason =
  | "completed"
  | "failed"
  | "aborted"
  | "budget_limited"
  | "time_limited";

// ── WorkflowRunResult (mirror of workflow's D-8 return shape) ─

/**
 * Return shape of `pi.__workflowRun`. Mirror of
 * `extensions/workflow/src/engine/launcher.ts:WorkflowRunResult`.
 *
 * `status` is always `"done"` (the RPC blocks until the run reaches a terminal
 * state). The specific terminal reason is in `reason`.
 */
export interface WorkflowRunResult {
  /** Always `"done"` — RPC blocks until terminal. */
  status: "done";
  /** Terminal reason. */
  reason: DoneReason;
  /** Script return value (present when reason === "completed"). */
  scriptResult?: unknown;
  /** Error message (may be present when reason !== "completed"). */
  error?: string;
  /** Run identifier. */
  runId: string;
}

// ── WorkflowRunFn (the RPC signature) ─────────────────────────

/**
 * Signature of `pi.__workflowRun` exposed by the workflow extension (D-8).
 *
 * Gates detect this at runtime via `typeof api.__workflowRun === "function"`
 * and invoke it; absence triggers the fallback path (runSingleAgent).
 */
export type WorkflowRunFn = (
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs?: number,
) => Promise<WorkflowRunResult>;
