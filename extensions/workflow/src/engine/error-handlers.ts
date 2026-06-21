/**
 * Workflow error handlers — extracted from orchestrator for file size management.
 *
 * Handles Worker thread errors, exits, and script-level errors with retry logic.
 * Terminal paths clean up the AgentPool to prevent leaks.
 */

import type { Worker } from "node:worker_threads";

import type { RunResources } from "../domain/run-resources.js";
import {
  isTerminal,
  type WorkflowInstance,
  type WorkflowStatus,
} from "../domain/state.js";
import { WorkflowEventEmitter } from "./orchestrator-events.js";
import { terminateInstance } from "./terminate-instance.js";

// ── Constants ─────────────────────────────────────────────────

const MAX_WORKER_RETRIES = 3;
const RETRY_BACKOFF_MS = 1000;
const EXPONENTIAL_BACKOFF_BASE = 2;

// ── Context interface ─────────────────────────────────────────

/** Callbacks and state needed by error handlers, provided by the orchestrator. */
export interface ErrorHandlerContext {
  /** Look up the aggregated per-run resources. */
  getRun(runId: string): RunResources | undefined;
  events: WorkflowEventEmitter;
  terminateWorker(runId: string, keepController?: boolean): void;
  cleanupAllTempFiles(): void;
  recreateRunAbortController(runId: string): void;
  startWorker(runId: string, instance: WorkflowInstance, scriptSource: string, args: Record<string, unknown>): void;
  persistState(): Promise<void>;
  onCompletion?(runId: string): void;
  /** Remove the AgentPool for a run to prevent memory leaks. */
  deleteRunPool(runId: string): void;
}

/** Adapt ErrorHandlerContext into the TerminateDeps shape expected by terminateInstance. */
function terminateDepsFromCtx(ctx: ErrorHandlerContext) {
  return {
    terminateWorker: (id: string, keepController: boolean) => ctx.terminateWorker(id, keepController),
    cleanupAllTempFiles: () => ctx.cleanupAllTempFiles(),
    emit: (id: string, event: { type: "status"; status: WorkflowStatus }) => ctx.events.emit(id, event),
    persistState: () => ctx.persistState(),
    deletePool: (id: string) => ctx.deleteRunPool(id),
    onCompletion: (id: string) => ctx.onCompletion?.(id),
  };
}

// ── Error handlers ────────────────────────────────────────────

/** Handle a Worker thread uncaught error. */
export async function handleWorkerError(
  ctx: ErrorHandlerContext,
  runId: string,
  err: Error,
): Promise<void> {
  const run = ctx.getRun(runId);
  const instance = run?.instance;
  if (!instance || isTerminal(instance.status)) return;

  // Wave 5: route through terminateInstance so the A4 ordering (cleanup
  // before status) holds. Worker is already gone (error event fired) —
  // terminateWorker still runs to clear the in-memory handle + abort
  // subprocesses. error message is set on the instance.
  if (!run) return;
  await terminateInstance(
    run,
    { status: "failed", error: err.message, cleanupWorker: true, cleanupTempFiles: true, deletePool: true },
    terminateDepsFromCtx(ctx),
  );
}

/** Handle Worker thread exit. */
export async function handleWorkerExit(
  ctx: ErrorHandlerContext,
  runId: string,
  code: number,
  exitedWorker: Worker,
): Promise<void> {
  const run = ctx.getRun(runId);
  const instance = run?.instance;
  if (!instance) return;

  // Guard: only process exit if the exited worker is still the current one.
  // Prevents race: terminateWorker(old) → startWorker(new) → old exit fires →
  // would delete new worker and incorrectly mark instance as failed.
  const currentWorker = run?.worker;
  if (currentWorker !== exitedWorker) return;
  if (run) run.worker = undefined;

  // Paused/terminal exits are intentional — skip failure marking
  if (instance.status === "paused" || isTerminal(instance.status)) return;

  // Non-zero exit without explicit error message → mark as failed.
  // Wave 5: route through terminateInstance so persist/emit/onCompletion
  // share the unified ordering. Worker is already gone — terminateWorker
  // just clears the AbortController (no live worker to kill).
  if (code !== 0 && !instance.error) {
    await terminateInstance(
      run!,
      {
        status: "failed",
        error: `Worker exited with code ${code}`,
        cleanupWorker: true,
        cleanupTempFiles: true,
        deletePool: true,
      },
      terminateDepsFromCtx(ctx),
    );
  }
}

/**
 * Worker-emitted log entry captured by the in-worker console.* interceptor.
 * Kept here (instead of inline) so the orchestrator can decide how to surface
 * the messages (TUI widget, pi.sendMessage, etc.) without leaking to the
 * input area via raw stderr.
 */
export interface WorkerLogEntry {
  level: "log" | "warn" | "error" | "info";
  message: string;
}

/**
 * Handle a workflow script-level error (type: "error" from worker).
 * Retries with exponential backoff up to MAX_WORKER_RETRIES.
 *
 * @param workerLogs - Captured console.* calls from the worker (never leaked
 *                     to the input area). Surfaced to the TUI when the
 *                     workflow reaches a terminal state.
 */
export async function handleScriptError(
  ctx: ErrorHandlerContext,
  runId: string,
  errorMsg: string,
  workerLogs: WorkerLogEntry[] = [],
): Promise<void> {
  const run = ctx.getRun(runId);
  const instance = run?.instance;
  if (!instance || isTerminal(instance.status)) return;

  const attempt = (run?.retryCount ?? 0) + 1;
  if (run) run.retryCount = attempt;

  // P2-2: Always attach the latest worker logs to the instance so the
  // TUI/result view can render them inside the widget area, not the
  // input prompt. Stale logs from previous attempts are replaced.
  if (workerLogs.length > 0) {
    instance.errorLogs = workerLogs;
  }

  if (attempt <= MAX_WORKER_RETRIES) {
    ctx.terminateWorker(runId);
    ctx.cleanupAllTempFiles();

    const delay = RETRY_BACKOFF_MS * Math.pow(EXPONENTIAL_BACKOFF_BASE, attempt - 1);
    setTimeout(() => {
      // P0-3: Stale state checking before restart
      if (instance.status !== "running") return;
      const meta = run?.meta;
      if (meta) {
        // Recreate AbortController after terminate (old was aborted)
        ctx.recreateRunAbortController(runId);
        ctx.startWorker(runId, instance, meta.scriptSource, meta.args);
      }
    }, delay);
  } else {
    // Wave 5: route the terminal transition through terminateInstance so the
    // A4 ordering holds. terminateWorker + cleanupAllTempFiles already ran
    // above on the retry path, but the final failure path hasn't cleaned up
    // — terminateInstance does both, plus deletePool + persist + notify.
    if (run) {
      await terminateInstance(
        run,
        {
          status: "failed",
          error: `Workflow failed after ${MAX_WORKER_RETRIES} retries: ${errorMsg}`,
          cleanupWorker: true,
          cleanupTempFiles: true,
          deletePool: true,
        },
        terminateDepsFromCtx(ctx),
      );
    }
  }
}
