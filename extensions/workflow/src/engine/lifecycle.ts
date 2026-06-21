/**
 * lifecycle.ts — Workflow run lifecycle operations.
 *
 * Extracted from orchestrator.ts (Wave 6).
 *
 * All functions are stateless — they receive an `OrchestratorCore` handle for
 * state access and worker-manager delegation. The orchestrator class stays
 * the sole owner of `runs`.
 *
 * Lifecycle: run → pause/resume → abort/retry/skip/restart. Agent calls are
 * routed through worker-manager via the core handle.
 */

import * as fs from "node:fs";

import {
  type AgentResult as StateAgentResult,
  createInstance as createStateInstance,
  isTerminal,
  transitionStatus,
} from "../domain/state.js";
import { AgentPool } from "../infra/agent-pool.js";
import { getWorkflow } from "../infra/config-loader.js";
import {
  DEFAULT_RUNANDWAIT_TIMEOUT_MS,
  RUNID_RADIX,
  RUNID_SLICE_END,
  RUNID_SLICE_START,
  STATUS_POLL_INTERVAL_MS,
} from "../infra/constants.js";
import { lintScript } from "../infra/script-lint.js";
import type { OrchestratorCore } from "./core.js";
import { scheduleTimeBudgetCheck } from "./orchestrator-budget.js";
import { terminateInstance } from "./terminate-instance.js";

// ── Constants ────────────────────────────────────────────────

/** 生成 workflow runId：wf-<timestamp>-<base36 random> */
export function generateRunId(): string {
  return `wf-${Date.now()}-${Math.random().toString(RUNID_RADIX).slice(RUNID_SLICE_START, RUNID_SLICE_END)}`;
}

// ── run ──────────────────────────────────────────────────────

/** Start a workflow. Returns runId for lifecycle operations. Signal propagated to AgentPool. */
export async function runWorkflow(
  core: OrchestratorCore,
  name: string,
  args: Record<string, unknown>,
  budgetTokens?: number,
  budgetTimeMs?: number,
  signal?: AbortSignal,
): Promise<string> {
  // P1-2: Honor pre-aborted signal — fail fast before any setup
  if (signal?.aborted) {
    throw new Error("Workflow run aborted before start");
  }

  const workflow = await getWorkflow(name);
  if (!workflow || !workflow.available) {
    throw new Error(`Workflow '${name}' not found or unavailable`);
  }

  // Read and normalize script: strip 'export' from 'export const meta' for CJS Worker
  let scriptSource = fs.readFileSync(workflow.path, "utf-8");
  scriptSource = scriptSource.replace(/\bexport\s+const\s+meta\b/, "const meta");

  // Pre-flight lint: catch common API misuse before executing
  const lintResult = lintScript(scriptSource);
  if (!lintResult.valid) {
    const errors = lintResult.findings
      .filter((f) => f.severity === "error")
      .map((f) => `  L${f.line}: ${f.message}\n         Suggestion: ${f.suggestion}`)
      .join("\n");
    throw new Error(
      `Workflow script '${name}' has ${lintResult.findings.filter((f) => f.severity === "error").length} error(s):\n${errors}`,
    );
  }
  // Log warnings (non-blocking)
  for (const w of lintResult.findings.filter((f) => f.severity === "warning")) {
    console.warn(`[workflow] Script lint warning at L${w.line}: ${w.message}`);
  }
  const runId = generateRunId();

  const instance = createStateInstance({
    runId,
    name,
    worker: workflow.path,
    status: "running",
    budget: { maxTokens: budgetTokens, maxTimeMs: budgetTimeMs },
  });
  instance.startedAt = new Date().toISOString();
  instance.description = workflow.description;

  core.setRun(runId, {
    instance,
    meta: { scriptSource, args, budgetTokens, budgetTimeMs, signal },
    retryCount: 0,
  });

  // Create per-run AbortController for agent subprocess cleanup.
  // Orchestrator owns this controller — abort() on terminate/pause/abort.
  const runAbortController = new AbortController();
  core.getRun(runId)!.abortController = runAbortController;

  // Create per-workflow AgentPool with soft-limit warning callback
  // Each workflow run gets its own pool so agent call counts are isolated per AC-4.5
  const pool = new AgentPool({
    maxConcurrency: 4,
    runName: instance.name,
    onSoftLimitReached: ({ runName, totalCalls, budget }) => {
      core.pi.sendUserMessage(
        `[workflow:${runName}] Reached ${totalCalls} agent calls. ` +
        `Budget: ${budget.usedTokens}/${budget.maxTokens ?? "unlimited"} tokens. ` +
        `Consider aborting if this is unintended.`,
      );
    },
  });
  pool.setBudget(instance.budget);
  core.getRun(runId)!.pool = pool;

  // P1-2: Tool-signal forwarders: (1) kill agent subprocess; (2) pause workflow
  if (signal) {
    signal.addEventListener("abort", () => runAbortController.abort(), { once: true });
    signal.addEventListener("abort", () => core.pauseOnSignal(runId), { once: true });
  }
  await core.persistState();

  core.startWorker(runId, instance, scriptSource, args);

  if (budgetTimeMs) {
    scheduleTimeBudgetCheck(
      (id) => core.getRun(id)?.instance,
      runId,
      budgetTimeMs,
      core.budgetCallbacks(),
    );
  }

  return runId;
}

// ── pause ────────────────────────────────────────────────────

/**
 * Pause a running workflow. Terminates the Worker thread but preserves
 * the callCache so it can be resumed later from the point of interruption.
 *
 * Wave 5 (A4): cleanup runs BEFORE the status mutation so a terminateWorker
 * failure leaves the workflow in its pre-pause state (status unchanged).
 * terminateWorker is called with keepController=true so retry during pause
 * can still write callCache (Round 3 MF2). The pool is preserved for resume.
 */
export async function pauseRun(core: OrchestratorCore, runId: string): Promise<void> {
  const run = core.getRun(runId);
  const instance = run?.instance;
  if (!instance) {
    throw new Error(`Workflow '${runId}' not found`);
  }
  if (instance.status !== "running") {
    throw new Error(
      `Cannot pause workflow in state '${instance.status}': only 'running' can be paused`,
    );
  }

  // pausedAt is pause-specific bookkeeping — terminateInstance deliberately
  // does not touch it so the orchestrator stays the sole owner.
  instance.pausedAt = new Date().toISOString();
  await terminateInstance(
    run!,
    {
      status: "paused",
      cleanupWorker: true,
      keepController: true,
      cleanupTempFiles: true,
      deletePool: false,
    },
    core.terminateDeps(),
  );
}

// ── resume ───────────────────────────────────────────────────

/**
 * Resume a paused workflow. Creates a new Worker thread with the
 * preserved callCache. Cached agent calls replay immediately from
 * the cache; uncached calls dispatch fresh.
 *
 * Wave 5 (A4 mirror): startWorker (the side effect that can throw) runs
 * BEFORE the status mutation. If the Worker constructor throws, the
 * workflow stays paused and the caller can retry.
 */
export async function resumeRun(core: OrchestratorCore, runId: string): Promise<void> {
  const run = core.getRun(runId);
  const instance = run?.instance;
  if (!instance) {
    throw new Error(`Workflow '${runId}' not found`);
  }
  if (instance.status !== "paused") {
    throw new Error(
      `Cannot resume workflow in state '${instance.status}': only 'paused' can be resumed`,
    );
  }

  const meta = run?.meta;
  if (meta) {
    // Recreate AbortController for the resumed run (old one was aborted on pause)
    core.recreateRunAbortController(runId);

    // Worker-backed instance: restart Worker with preserved callCache.
    // Do this BEFORE the status mutation so a throw leaves status=paused.
    core.startWorker(runId, instance, meta.scriptSource, meta.args);

    // P1-6: Re-schedule time budget check after resume
    if (meta.budgetTimeMs) {
      scheduleTimeBudgetCheck(
        (id) => core.getRun(id)?.instance,
        runId,
        meta.budgetTimeMs,
        core.budgetCallbacks(),
      );
    }
  }

  // Status mutation happens AFTER startWorker succeeds.
  instance.pausedAt = undefined;
  transitionStatus(instance, "running");
  core.events.emit(runId, { type: "status", status: "running" });
  await core.persistState();
}

// ── abort ────────────────────────────────────────────────────

/**
 * Abort a workflow immediately. Terminates the Worker thread and
 * marks the instance as aborted (terminal state).
 *
 * Wave 5 (A4): cleanup runs BEFORE transitionStatus so a terminateWorker
 * throw leaves the workflow running/paused — caller can retry or observe.
 * Delegate the full pipeline (cleanup → mutate → persist → notify) to
 * terminateInstance so this site shares the same ordering as every other
 * terminal transition.
 */
export async function abortRun(core: OrchestratorCore, runId: string, reason?: string): Promise<void> {
  const run = core.getRun(runId);
  const instance = run?.instance;
  if (!instance) {
    throw new Error(`Workflow '${runId}' not found`);
  }

  // P1-4: Allow abort from running or paused
  if (instance.status !== "running" && instance.status !== "paused") {
    throw new Error(
      `Cannot abort workflow in state '${instance.status}': only 'running' or 'paused' can be aborted`,
    );
  }

  await terminateInstance(
    run!,
    {
      status: "aborted",
      error: reason,
      cleanupWorker: true,
      cleanupTempFiles: true,
      deletePool: true,
    },
    core.terminateDeps(),
  );
}

// ── retryNode ────────────────────────────────────────────────

/**
 * Retry a specific agent call. Removes the cached result for the
 * given callId, terminates the current Worker, and starts a new one.
 * The script re-executes from the top — completed calls replay from
 * cache, the retried call dispatches fresh.
 */
export async function retryRunNode(core: OrchestratorCore, runId: string, callId: number): Promise<void> {
  const run = core.getRun(runId);
  const instance = run?.instance;
  if (!instance) {
    throw new Error(`Workflow '${runId}' not found`);
  }
  // P1-7: Only running or paused can retry
  if (instance.status !== "running" && instance.status !== "paused") {
    throw new Error(
      `Cannot retry node in state '${instance.status}': only 'running' or 'paused' allowed`,
    );
  }

  // Remove the cached result for this call
  instance.callCache.delete(callId);

  // Reset the trace node so it re-dispatches
  const node = instance.trace.find((n) => n.stepIndex === callId);
  if (node) {
    node.status = "pending";
    node.result = undefined;
    node.completedAt = undefined;
  }

  core.terminateWorker(runId);

  // P1-7: Reset retry counts for fresh start
  if (run) run.retryCount = 0;

  const meta = run?.meta;
  if (meta) {
    // Recreate AbortController after terminate (old was aborted)
    core.recreateRunAbortController(runId);
    core.startWorker(runId, instance, meta.scriptSource, meta.args);
  }

  await core.persistState();
}

// ── skipNode ─────────────────────────────────────────────────

/** Skip a specific agent call. Injects placeholder into callCache for immediate resolution. */
export async function skipRunNode(core: OrchestratorCore, runId: string, callId: number): Promise<void> {
  const instance = core.getRun(runId)?.instance;
  if (!instance) {
    throw new Error(`Workflow '${runId}' not found`);
  }

  const placeholder: StateAgentResult = {
    content: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };

  instance.callCache.set(callId, placeholder);

  const node = instance.trace.find((n) => n.stepIndex === callId);
  if (node) {
    node.status = "completed";
    node.result = placeholder;
    node.completedAt = new Date().toISOString();
  }

  // If worker is alive, send cached result immediately for any pending call
  if (core.getRun(runId)?.worker) {
    try {
      core.postMessage(runId, { type: "agent-result", callId, result: placeholder, cached: true });
    // eslint-disable-next-line taste/no-silent-catch
    } catch {
      // P1-8: Worker may have exited between has() and postMessage().
      // This is an expected race condition — no recovery needed.
    }
  }

  await core.persistState();
}

// ── restart ──────────────────────────────────────────────────

/**
 * Restart a workflow: create a fresh instance from the same script,
 * then clean up the old one. Returns the new runId.
 *
 * Note: intentionally does NOT forward the original AbortSignal to the
 * new instance. Restart is a user-initiated action — the new run should
 * have an independent lifecycle from the original tool-execute caller's
 * signal (which may already be aborted).
 */
export async function restartRun(core: OrchestratorCore, runId: string): Promise<string> {
  const run = core.getRun(runId);
  const instance = run?.instance;
  if (!instance) {
    throw new Error(`Workflow '${runId}' not found`);
  }

  const meta = run?.meta;
  if (!meta) {
    throw new Error("No metadata for restart — cannot re-run without original script");
  }

  const name = instance.name;
  const scriptSource = meta.scriptSource;
  const args = meta.args;
  const budgetTokens = meta.budgetTokens;
  const budgetTimeMs = meta.budgetTimeMs;

  // 1. Abort old instance if still alive. Wave 5: route through terminateInstance
  //    so the A4 ordering (cleanup before status) holds here too. We avoid
  //    persisting mid-restart — persistState happens once below for the new run.
  if (instance.status === "running" || instance.status === "paused") {
    await terminateInstance(
      run!,
      { status: "aborted", cleanupWorker: true, cleanupTempFiles: true, deletePool: true },
      { ...core.terminateDeps(), persistState: async () => { /* skip — persisted below */ } },
    );
  }

  // 2. Create new instance directly from cached scriptSource (skip getWorkflow + readFile).
  const newRunId = generateRunId();
  const newInstance = createStateInstance({
    runId: newRunId,
    name,
    worker: instance.worker,
    budget: { maxTokens: budgetTokens, maxTimeMs: budgetTimeMs },
  });
  newInstance.startedAt = new Date().toISOString();

  core.setRun(newRunId, {
    instance: newInstance,
    meta: { scriptSource, args, budgetTokens, budgetTimeMs },
    retryCount: 0,
    // Round 4 MF#1: create per-run AbortController so executeWithRetry can abort in-flight pi subprocess on user abort.
    abortController: new AbortController(),
  });
  core.startWorker(newRunId, newInstance, scriptSource, args);

  // 3. Schedule time budget check if needed
  if (budgetTimeMs) {
    scheduleTimeBudgetCheck(
      (id) => core.getRun(id)?.instance,
      newRunId,
      budgetTimeMs,
      core.budgetCallbacks(),
    );
  }

  // 4. Persist new instance before cleaning old one
  await core.persistState();

  // 5. Clean up old run entry (keeps memory tight — restart is the only
  //    path that fully drops a non-terminal run; terminal runs are kept for
  //    history until session end).
  core.deleteRun(runId);
  await core.persistState();

  return newRunId;
}

// ── runAndWait ───────────────────────────────────────────────

/**
 * Run a workflow and wait for it to complete (synchronous from caller's POV).
 * Polls instance status at 500ms intervals until terminal state.
 *
 * Designed for cross-extension programmatic calls (e.g. pi.__workflowRun).
 * NOT intended for interactive use — use `run()` + lifecycle tools instead.
 */
export async function runWorkflowAndWait(
  core: OrchestratorCore,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_RUNANDWAIT_TIMEOUT_MS,
): Promise<{ status: string; scriptResult?: unknown; error?: string; runId: string }> {
  const runId = await runWorkflow(core, name, args, undefined, undefined, signal);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      try { await abortRun(core, runId); } catch { /* already terminal */ void undefined; }
      return { status: "aborted", runId, error: "Aborted by signal" };
    }
    const instance = core.getRun(runId)?.instance;
    if (!instance) {
      return { status: "unknown", runId, error: "Instance not found" };
    }
    if (isTerminal(instance.status)) {
      return {
        status: instance.status,
        scriptResult: instance.scriptResult,
        error: instance.error,
        runId,
      };
    }
    await new Promise((r) => setTimeout(r, STATUS_POLL_INTERVAL_MS));
  }
  // Timeout — abort the workflow
  try { await abortRun(core, runId); } catch { /* already terminal */ void undefined; }
  return { status: "timeout", runId, error: `Workflow timed out after ${timeoutMs}ms` };
}
