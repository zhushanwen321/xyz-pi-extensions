/**
 * Unified workflow termination — single source of truth for the side-effect
 * ordering that previously lived as 8 copy-pasted "三件套" blocks across
 * orchestrator.ts, error-handlers.ts and orchestrator-budget.ts.
 *
 * A4 atomicity principle (Wave 5):
 *   1. cleanup (worker / tempFiles / pool) — may throw; do it FIRST so a
 *      failure leaves the workflow in its pre-termination state.
 *   2. transitionStatus + emit       — status change comes AFTER cleanup
 *      succeeds. If cleanup threw, status is unchanged and the caller can
 *      retry or observe the real (still running/paused) state.
 *   3. persistState                  — flush the mutated instance to disk.
 *   4. onCompletion                  — notify (fires notifications etc.).
 *
 * History: orchestrator.pause/abort previously ran transitionStatus BEFORE
 * terminateWorker. When terminateWorker threw, status was already mutated
 * while the worker stayed alive — index.ts masked this with a 3-layer
 * fallback. This function inverts the order so callers no longer need the
 * fallback.
 */

import type { RunResources } from "../domain/run-resources.js";
import {
  isTerminal,
  transitionStatus,
  type WorkflowStatus,
} from "../domain/state.js";

/** Options controlling what the terminator writes and which cleanup runs. */
export interface TerminateOptions {
  /** Target status. Must be a valid transition from the instance's current status. */
  status: WorkflowStatus;
  /** Overwrite instance.error (e.g. budget reason, abort reason, worker crash message). */
  error?: string;
  /** Set instance.scriptResult (only the normal "return" path uses this). */
  scriptResult?: unknown;
  /** Whether to terminate the worker thread. Default: true. Pass false for
   *  transitions that must keep the worker alive (none currently — paused
   *  uses cleanupWorker:true with keepController). */
  cleanupWorker?: boolean;
  /** If cleanupWorker is true, forward keepController to terminateWorker.
   *  paused needs the AbortController kept so retry during pause can still
   *  write callCache; terminal transitions clear it. Default: false. */
  keepController?: boolean;
  /** Whether to remove all agent-call temp files. Default: true. */
  cleanupTempFiles?: boolean;
  /** Whether to release the AgentPool. pause keeps the pool for resume;
   *  every terminal transition clears it. Default: true. */
  deletePool?: boolean;
}

/** Orchestrator dependencies injected to avoid circular imports. */
export interface TerminateDeps {
  terminateWorker: (runId: string, keepController: boolean) => void;
  cleanupAllTempFiles: () => void;
  emit: (runId: string, event: { type: "status"; status: WorkflowStatus }) => void;
  persistState: () => Promise<void>;
  /** Nullify run.pool. Separate from terminateWorker because the worker is
   *  recreated lazily while the pool is a long-lived resource. */
  deletePool?: (runId: string) => void;
  onCompletion?: (runId: string) => void;
}

/**
 * Run the full terminate pipeline for a workflow run.
 *
 * @param run    Aggregated per-run resources (Wave 4 RunResources).
 * @param opts   What to set + which cleanup steps to run.
 * @param deps   Orchestrator callbacks — injected to avoid importing orchestrator.
 *
 * Side-effect order follows A4 (see file header). If cleanup throws, the
 * instance status is left untouched and the error propagates to the caller.
 */
export async function terminateInstance(
  run: RunResources,
  opts: TerminateOptions,
  deps: TerminateDeps,
): Promise<void> {
  const { instance } = run;
  const runId = instance.runId;

  // Skip entirely if already terminal (idempotent guard — mirrors the
  // isTerminal checks the inline blocks previously repeated at each site).
  if (isTerminal(instance.status) && instance.status === opts.status) return;

  const cleanupWorker = opts.cleanupWorker ?? true;
  const keepController = opts.keepController ?? false;
  const cleanupTempFiles = opts.cleanupTempFiles ?? true;
  const deletePool = opts.deletePool ?? true;

  // ── 1. Cleanup (may throw — do it BEFORE any state mutation) ──
  if (cleanupWorker) {
    deps.terminateWorker(runId, keepController);
  }
  if (cleanupTempFiles) {
    deps.cleanupAllTempFiles();
  }
  if (deletePool && deps.deletePool) {
    deps.deletePool(runId);
  }

  // ── 2. Status mutation + event (only after cleanup succeeds) ──
  if (opts.error !== undefined) {
    instance.error = opts.error;
  }
  if (opts.scriptResult !== undefined) {
    instance.scriptResult = opts.scriptResult;
  }
  // Only set completedAt for genuine terminal states. paused sets pausedAt
  // at the call site (terminateInstance does not touch pausedAt) so the
  // existing pause/resume bookkeeping stays in orchestrator.
  if (isTerminal(opts.status)) {
    instance.completedAt = new Date().toISOString();
  }
  transitionStatus(instance, opts.status);
  deps.emit(runId, { type: "status", status: opts.status });

  // ── 3. Persist ──
  await deps.persistState();

  // ── 4. Notify ──
  if (isTerminal(opts.status)) {
    deps.onCompletion?.(runId);
  }
}
