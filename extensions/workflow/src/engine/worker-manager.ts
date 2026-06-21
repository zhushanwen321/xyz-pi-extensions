/**
 * worker-manager.ts — Worker thread lifecycle & message routing.
 *
 * Extracted from orchestrator.ts (Wave 6).
 *
 * All functions are stateless — they receive an `OrchestratorCore` handle that
 * exposes the orchestrator's private state (runs map, pi, events, …) and the
 * delegated methods they need to call across modules. The orchestrator class
 * stays the sole owner of `runs`.
 */

import { Worker } from "node:worker_threads";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { RunResources } from "../domain/run-resources.js";
import type { WorkflowStatus } from "../domain/state.js";
import {
  type AgentResult as StateAgentResult,
  type ExecutionTraceNode,
  isTerminal,
  transitionStatus,
  type WorkflowInstance,
} from "../domain/state.js";
import type { AgentRegistry } from "../infra/agent-discovery.js";
import { resolveAgentOpts as resolveOpts } from "../infra/agent-opts-resolver.js";
import type { AgentCallOpts } from "../infra/agent-pool.js";
import { appendTraceNode } from "../infra/execution-trace.js";
import { type AgentCallContext, executeWithRetry, isBudgetExceeded } from "./agent-call-handler.js";
import {
  isStaleContextErrorMsg,
  STALE_CONTEXT_PATTERNS,
} from "./agent-call-handler.js";
import { type ErrorHandlerContext, handleScriptError, handleWorkerError, handleWorkerExit } from "./error-handlers.js";
import { checkBudget } from "./orchestrator-budget.js";
import type { WorkflowEventEmitter } from "./orchestrator-events.js";
import { type TerminateDeps,terminateInstance } from "./terminate-instance.js";
import { buildWorkerScript, type WorkerInMsg } from "./worker-script.js";

// Re-export for backward compat (tests import isStaleContextErrorMsg from src/orchestrator).
export { isStaleContextErrorMsg, STALE_CONTEXT_PATTERNS };

/** Worker→Main message type — re-exported so lifecycle.ts can share it. */
export type { WorkerInMsg };

// ── OrchestratorCore: the access contract ────────────────────

/**
 * The slice of WorkflowOrchestrator that worker-manager / lifecycle functions
 * may touch. The orchestrator class `implements OrchestratorCore`; extracted
 * modules receive `this` and stay decoupled from the concrete class.
 *
 * Fields are `readonly` (the orchestrator owns mutation); methods are the
 * delegated entry points the modules call into.
 */
export interface OrchestratorCore {
  // ── State ──
  readonly pi: ExtensionAPI;
  readonly events: WorkflowEventEmitter;
  readonly sessionDir: string;
  readonly agentRegistry: AgentRegistry;
  readonly activeTempFiles: Set<string>;
  readonly runs: ReadonlyMap<string, RunResources>;
  onTraceUpdate?: (runId: string) => void;
  onCompletion?: (runId: string) => void;

  // ── Run map accessors ──
  getRun(runId: string): RunResources | undefined;
  setRun(runId: string, run: RunResources): void;
  deleteRun(runId: string): void;

  // ── Persistence / cleanup ──
  persistState(): Promise<void>;
  cleanupTempFile(fp: string): void;
  cleanupAllTempFiles(): void;

  // ── Worker-manager delegated methods (implemented in this module) ──
  startWorker(runId: string, instance: WorkflowInstance, scriptSource: string, args: Record<string, unknown>): void;
  terminateWorker(runId: string, keepController?: boolean): void;
  postMessage(runId: string, msg: unknown): void;
  handleWorkerMessage(runId: string, raw: unknown): Promise<void>;
  handleAgentCall(runId: string, instance: WorkflowInstance, callId: number, opts: AgentCallOpts, phase?: string): Promise<void>;
  pauseOnSignal(runId: string): void;
  recreateRunAbortController(runId: string): void;
  resolveAgentOpts(opts: AgentCallOpts): { opts: AgentCallOpts; error?: string };

  // ── Context factories (implemented in this module) ──
  errorHandlerContext(): ErrorHandlerContext;
  agentCallContext(): AgentCallContext;
  budgetCallbacks(): BudgetCallbacksShape;
  terminateDeps(): TerminateDeps;
}

/**
 * Shape of the BudgetCallbacks returned by `budgetCallbacks()`. Mirrors the
 * object literal the orchestrator currently builds; kept here so lifecycle.ts
 * can name the type without importing the engine internals.
 */
export interface BudgetCallbacksShape {
  postMessage(id: string, msg: unknown): void;
  terminateWorker(id: string, keepController?: boolean): void;
  cleanupAllTempFiles(): void;
  persistState(): Promise<void>;
  onCompletion(id: string): void;
  getRun(id: string): RunResources | undefined;
  emit(id: string, event: { type: "status"; status: WorkflowStatus }): void;
  deletePool(id: string): void;
}

// ── startWorker ──────────────────────────────────────────────

export function startWorker(
  core: OrchestratorCore,
  runId: string,
  instance: WorkflowInstance,
  scriptSource: string,
  args: Record<string, unknown>,
): void {
  const workerCode = buildWorkerScript(scriptSource);

  // Inject runId into args so .then()/.catch() can send it back
  const workerArgs = { ...args, _runId: runId };

  const worker = new Worker(workerCode, {
    eval: true,
    workerData: {
      scriptPath: instance.worker,
      args: workerArgs,
      callCache: instance.callCache,
      budget: instance.budget,
      workspace: process.cwd(),
      meta: {},
    },
  });

  worker.on("message", (raw: unknown) => {
    core.handleWorkerMessage(runId, raw);
  });

  worker.on("error", (err: Error) => {
    handleWorkerError(core.errorHandlerContext(), runId, err);
  });

  worker.on("exit", (code: number) => {
    handleWorkerExit(core.errorHandlerContext(), runId, code, worker);
  });

  const run = core.getRun(runId);
  if (run) run.worker = worker;
}

// ── pauseOnSignal ────────────────────────────────────────────

/**
 * P1-2 + Round 5 MF#3: pause workflow on tool-signal abort. run() and
 * recreateRunAbortController() both register this listener (resume must
 * re-register). Round 3 MF2: pause keeps the controller so a mistaken retry
 * doesn't lose callCache/worker notifications.
 */
export function pauseOnSignal(core: OrchestratorCore, runId: string): void {
  const inst = core.getRun(runId)?.instance;
  if (!inst || inst.status !== "running") return;
  inst.pausedAt = new Date().toISOString();
  try {
    transitionStatus(inst, "paused");
  // eslint-disable-next-line taste/no-silent-catch
  } catch {
    // State machine refused — leave as-is
  }
  core.terminateWorker(runId, true);
  void core.persistState();
}

// ── recreateRunAbortController ───────────────────────────────

/**
 * Recreate AbortController for a run after terminateWorker aborted the old one.
 * Re-wires the tool-level signal: (1) kill agent subprocess; (2) pause workflow.
 * Round 5 MF#3: resume 后必须重注册 pause-on-abort listener.
 */
export function recreateRunAbortController(core: OrchestratorCore, runId: string): void {
  const newController = new AbortController();
  const run = core.getRun(runId);
  if (run) run.abortController = newController;
  const meta = run?.meta;
  if (meta?.signal && !meta.signal.aborted) {
    meta.signal.addEventListener("abort", () => newController.abort(), { once: true });
    meta.signal.addEventListener("abort", () => core.pauseOnSignal(runId), { once: true });
  }
}

// ── terminateWorker ──────────────────────────────────────────

/**
 * Terminate and clean up a worker thread. Also aborts all in-flight agent
 * subprocesses via the per-run AbortController.
 *
 * @param keepController  Round 3 MF2: pause passes true — keeps the controller
 *                        in the map so a failed retry during pause can still
 *                        write callCache and notify the worker. abort/retry/
 *                        delete/budget pass false for full cleanup.
 */
export function terminateWorker(core: OrchestratorCore, runId: string, keepController: boolean = false): void {
  const run = core.getRun(runId);
  if (run?.abortController) {
    const controller = run.abortController;
    if (!keepController) {
      run.abortController = undefined;
    }
    controller.abort();
  }

  const worker = run?.worker;
  if (worker) {
    run!.worker = undefined;
    worker.terminate().catch(() => {
      // Best-effort termination; failures are expected when the worker
      // is already exiting. Surfacing to terminal would leak to the
      // input area and confuse the user during normal teardown.
    });
  }
}

// ── postMessage ──────────────────────────────────────────────

export function postMessage(core: OrchestratorCore, runId: string, msg: unknown): void {
  const worker = core.getRun(runId)?.worker;
  if (worker) worker.postMessage(msg);
}

// ── resolveAgentOpts ─────────────────────────────────────────

export function resolveAgentOpts(
  core: OrchestratorCore,
  opts: AgentCallOpts,
): { opts: AgentCallOpts; error?: string } {
  return resolveOpts(opts, core.agentRegistry, core.sessionDir, core.activeTempFiles);
}

// ── Context factories ────────────────────────────────────────

export function errorHandlerContext(core: OrchestratorCore): ErrorHandlerContext {
  return {
    getRun: (id) => core.getRun(id),
    events: core.events,
    terminateWorker: (id, keepController) => core.terminateWorker(id, keepController),
    cleanupAllTempFiles: () => core.cleanupAllTempFiles(),
    recreateRunAbortController: (id) => core.recreateRunAbortController(id),
    startWorker: (id, inst, src, args) => core.startWorker(id, inst, src, args),
    persistState: () => core.persistState(),
    onCompletion: (id) => core.onCompletion?.(id),
    deleteRunPool: (id) => {
      const run = core.getRun(id);
      if (run) run.pool = undefined;
    },
  };
}

export function agentCallContext(core: OrchestratorCore): AgentCallContext {
  return {
    pi: core.pi,
    events: core.events,
    getRun: (id) => core.getRun(id),
    postMessage: (id, msg) => core.postMessage(id, msg),
    persistState: () => core.persistState(),
    budgetCallbacks: () => core.budgetCallbacks(),
    cleanupTempFile: (fp) => core.cleanupTempFile(fp),
    onTraceUpdate: (id) => core.onTraceUpdate?.(id),
  };
}

/**
 * Shared BudgetCallbacks instance — executeWithRetry / handleAgentCall /
 * scheduleTimeBudgetCheck all need the same callbacks. Centralized to avoid
 * inlining 6 lines at every call site (orchestrator.ts file size).
 * Wave 5: added getRun / emit / deletePool so checkBudget / time budget can
 * route to terminateInstance (unified termination ordering).
 */
export function budgetCallbacks(core: OrchestratorCore): BudgetCallbacksShape {
  return {
    postMessage: (id, msg) => core.postMessage(id, msg),
    terminateWorker: (id, keepController = false) => core.terminateWorker(id, keepController),
    cleanupAllTempFiles: () => core.cleanupAllTempFiles(),
    persistState: () => core.persistState(),
    onCompletion: (id) => core.onCompletion?.(id),
    getRun: (id) => core.getRun(id),
    emit: (id, event) => core.events.emit(id, event),
    deletePool: (id) => {
      const r = core.getRun(id);
      if (r) r.pool = undefined;
    },
  };
}

export function terminateDeps(core: OrchestratorCore): TerminateDeps {
  return {
    terminateWorker: (id, keepController) => core.terminateWorker(id, keepController),
    cleanupAllTempFiles: () => core.cleanupAllTempFiles(),
    emit: (id, event) => core.events.emit(id, event),
    persistState: () => core.persistState(),
    deletePool: (id) => {
      const r = core.getRun(id);
      if (r) r.pool = undefined;
    },
    onCompletion: (id) => core.onCompletion?.(id),
  };
}

// ── Message routing ──────────────────────────────────────────

export async function handleWorkerMessage(core: OrchestratorCore, runId: string, raw: unknown): Promise<void> {
  const msg = raw as WorkerInMsg;

  const run = core.getRun(runId);
  const instance = run?.instance;
  if (!instance) return;

  switch (msg.type) {
    case "agent-call":
      core.handleAgentCall(runId, instance, msg.callId, msg.opts as AgentCallOpts, msg.phase);
      break;
    case "return": {
      // P0-1: Guard against stale return messages after terminate/pause/budget
      if (isTerminal(instance.status) || instance.status === "paused") return;
      // P2-2: Surface worker diagnostics via the TUI widget, never the input area.
      if (Array.isArray(msg.workerLogs) && msg.workerLogs.length > 0) {
        instance.errorLogs = msg.workerLogs;
      }
      if (!run) return;
      // Worker is exiting normally — release pool via terminateInstance so
      // persist/emit/onCompletion share the unified ordering.
      await terminateInstance(
        run,
        {
          status: "completed",
          scriptResult: msg.result,
          cleanupWorker: false,
          cleanupTempFiles: true,
          deletePool: true,
        },
        core.terminateDeps(),
      );
      core.onTraceUpdate?.(runId);
      break;
    }
    case "error": {
      // P0-1: Guard against stale error messages after terminate/pause/budget
      if (isTerminal(instance.status) || instance.status === "paused") return;
      handleScriptError(core.errorHandlerContext(), runId, msg.error, Array.isArray(msg.workerLogs) ? msg.workerLogs : undefined);
      break;
    }
  }
}

// ── handleAgentCall ──────────────────────────────────────────

export async function handleAgentCall(
  core: OrchestratorCore,
  runId: string,
  instance: WorkflowInstance,
  callId: number,
  opts: AgentCallOpts,
  phase?: string,
): Promise<void> {
  const cached = instance.callCache.get(callId);
  if (cached) {
    core.postMessage(runId, { type: "agent-result", callId, result: cached, cached: true });
    return;
  }

  // Round 5 SUG#4 + Must-fix #4: budget gate at entry. Budget is a soft limit.
  if (isBudgetExceeded(instance)) {
    const b = instance.budget;
    const errorResult: StateAgentResult = {
      content: "",
      error: `Budget exceeded before dispatch: ${b.usedTokens}/${b.maxTokens ?? "?"} tokens`,
    };
    instance.callCache.set(callId, errorResult);
    core.postMessage(runId, { type: "agent-result", callId, result: errorResult, cached: false });
    await checkBudget(instance, runId, core.budgetCallbacks());
    return;
  }

  // Agent resolution
  const resolved = core.resolveAgentOpts(opts);
  if (resolved.error) {
    const errorResult: StateAgentResult = { content: "", error: resolved.error };
    instance.callCache.set(callId, errorResult);
    core.postMessage(runId, { type: "agent-result", callId, result: errorResult, cached: false });
    return;
  }
  const enrichedOpts = resolved.opts;

  // Record pending trace node
  const now = new Date().toISOString();
  const node: ExecutionTraceNode = {
    stepIndex: callId,
    agent: opts.description ?? opts.agent ?? "unknown",
    task: opts.prompt,
    model: enrichedOpts.model ?? "default",
    status: "running",
    phase,
    startedAt: now,
  };
  instance.trace.push(node);
  appendTraceNode(core.pi, runId, node);
  core.events.emit(runId, { type: "trace", node: { stepIndex: node.stepIndex, agent: node.agent, status: node.status, phase: node.phase } });
  core.onTraceUpdate?.(runId);
  executeWithRetry(core.agentCallContext(), runId, callId, enrichedOpts, instance, node);
}
