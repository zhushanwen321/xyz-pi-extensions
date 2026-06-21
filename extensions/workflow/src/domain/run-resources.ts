/**
 * Per-run resource aggregate — bundles all runtime state for a single workflow
 * run so the orchestrator maintains one `Map<string, RunResources>` instead of
 * 6 parallel lifecycle maps.
 *
 * Lifecycle semantics:
 *   - `worker` / `abortController` are set to `undefined` (NOT removed from the
 *     map) when terminateWorker runs — the instance + callCache + meta stay so
 *     resume/retry/restart can rebuild them.
 *   - `pool` is cleared on terminal transitions (abort/completed/failed) to
 *     release agent slots.
 *   - `meta` / `pool` / `worker` / `abortController` are optional because
 *     restoreInstances() rehydrates from JSONL which only carries the
 *     WorkflowInstance — runtime resources are recreated lazily on resume/run.
 */

import type { Worker } from "node:worker_threads";

import type { AgentPool } from "../infra/agent-pool.js";
import type { WorkflowInstance } from "./state.js";

/**
 * Per-run metadata needed for resume/retry/re-run operations.
 * Not persisted to JSONL — held only in-memory for the live session.
 */
export interface RunMeta {
  scriptSource: string;
  args: Record<string, unknown>;
  budgetTokens?: number;
  budgetTimeMs?: number;
  /** P1-2: Abort signal from the tool execute caller — propagated to AgentPool
   *  and used to pause the workflow if triggered. */
  signal?: AbortSignal;
}

/**
 * Aggregated per-run resources. Replaces the 6 parallel maps previously on the
 * orchestrator (instances / workers / runMetaMap / retryCounts / runPools /
 * runAbortControllers).
 */
export interface RunResources {
  /** Persisted workflow state (status, callCache, trace, budget, ...). */
  instance: WorkflowInstance;
  /** Script source + original args — needed for resume/retry/restart. */
  meta?: RunMeta;
  /** Per-run agent call pool — cleared on terminal transitions. */
  pool?: AgentPool;
  /** Worker thread — `undefined` after terminateWorker (instance still alive). */
  worker?: Worker;
  /** Per-run AbortController for killing agent subprocesses. Recreated on resume. */
  abortController?: AbortController;
  /** Script-error retry counter (resets on success or manual retry). */
  retryCount: number;
}
