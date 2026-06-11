/**
 * Workflow error handlers — extracted from orchestrator for file size management.
 *
 * Handles Worker thread errors, exits, and script-level errors with retry logic.
 * Terminal paths clean up the AgentPool to prevent leaks.
 */

import type { Worker } from "node:worker_threads";
import {
  type WorkflowInstance,
  isTerminal,
  transitionStatus,
} from "../domain/state.js";
import { WorkflowEventEmitter } from "./orchestrator-events.js";

// ── Constants ─────────────────────────────────────────────────

const MAX_WORKER_RETRIES = 3;
const RETRY_BACKOFF_MS = 1000;
const EXPONENTIAL_BACKOFF_BASE = 2;

// ── Context interface ─────────────────────────────────────────

/** Callbacks and state needed by error handlers, provided by the orchestrator. */
export interface ErrorHandlerContext {
  instances: Map<string, WorkflowInstance>;
  workers: Map<string, Worker>;
  retryCounts: Map<string, number>;
  /** Access per-run metadata (scriptSource, args) for retry/restart. */
  getRunMeta(runId: string): { scriptSource: string; args: Record<string, unknown> } | undefined;
  events: WorkflowEventEmitter;
  terminateWorker(runId: string): void;
  recreateRunAbortController(runId: string): void;
  startWorker(runId: string, instance: WorkflowInstance, scriptSource: string, args: Record<string, unknown>): void;
  cleanupAllTempFiles(): void;
  persistState(): Promise<void>;
  onCompletion?(runId: string): void;
  /** Remove the AgentPool for a run to prevent memory leaks. */
  deleteRunPool(runId: string): void;
}

// ── Error handlers ────────────────────────────────────────────

/** Handle a Worker thread uncaught error. */
export async function handleWorkerError(
  ctx: ErrorHandlerContext,
  runId: string,
  err: Error,
): Promise<void> {
  const instance = ctx.instances.get(runId);
  if (!instance || isTerminal(instance.status)) return;

  ctx.workers.delete(runId);
  instance.error = err.message;
  // P1-5: Mark failed — error event may not be followed by exit event
  instance.completedAt = new Date().toISOString();
  transitionStatus(instance, "failed");
  ctx.events.emit(runId, { type: "status", status: "failed" });
  ctx.deleteRunPool(runId);
  ctx.cleanupAllTempFiles();
  await ctx.persistState();
  ctx.onCompletion?.(runId);
}

/** Handle Worker thread exit. */
export async function handleWorkerExit(
  ctx: ErrorHandlerContext,
  runId: string,
  code: number,
  exitedWorker: Worker,
): Promise<void> {
  const instance = ctx.instances.get(runId);
  if (!instance) return;

  // Guard: only process exit if the exited worker is still the current one.
  // Prevents race: terminateWorker(old) → startWorker(new) → old exit fires →
  // would delete new worker and incorrectly mark instance as failed.
  const currentWorker = ctx.workers.get(runId);
  if (currentWorker !== exitedWorker) return;
  ctx.workers.delete(runId);

  // Paused/terminal exits are intentional — skip failure marking
  if (instance.status === "paused" || isTerminal(instance.status)) return;

  // Non-zero exit without explicit error message → mark as failed
  if (code !== 0 && !instance.error) {
    instance.error = `Worker exited with code ${code}`;
    instance.completedAt = new Date().toISOString();
    transitionStatus(instance, "failed");
    ctx.events.emit(runId, { type: "status", status: "failed" });
    ctx.deleteRunPool(runId);
    await ctx.persistState();
    ctx.onCompletion?.(runId);
  }
}

/**
 * Handle a workflow script-level error (type: "error" from worker).
 * Retries with exponential backoff up to MAX_WORKER_RETRIES.
 */
export async function handleScriptError(
  ctx: ErrorHandlerContext,
  runId: string,
  errorMsg: string,
): Promise<void> {
  const instance = ctx.instances.get(runId);
  if (!instance || isTerminal(instance.status)) return;

  const attempt = (ctx.retryCounts.get(runId) ?? 0) + 1;
  ctx.retryCounts.set(runId, attempt);

  if (attempt <= MAX_WORKER_RETRIES) {
    ctx.terminateWorker(runId);

    const delay = RETRY_BACKOFF_MS * Math.pow(EXPONENTIAL_BACKOFF_BASE, attempt - 1);
    setTimeout(() => {
      // P0-3: Stale state check before restart
      if (instance.status !== "running") return;
      const meta = ctx.getRunMeta(runId);
      if (meta && instance) {
        // Recreate AbortController after terminate (old was aborted)
        ctx.recreateRunAbortController(runId);
        ctx.startWorker(runId, instance, meta.scriptSource, meta.args);
      }
    }, delay);
  } else {
    instance.error = `Workflow failed after ${MAX_WORKER_RETRIES} retries: ${errorMsg}`;
    instance.completedAt = new Date().toISOString();
    transitionStatus(instance, "failed");
    ctx.events.emit(runId, { type: "status", status: "failed" });
    ctx.terminateWorker(runId);
    ctx.deleteRunPool(runId);
    // Cleanup in-flight agent temp files that were killed mid-flight.
    ctx.cleanupAllTempFiles();
    await ctx.persistState();
    ctx.onCompletion?.(runId);
  }
}
