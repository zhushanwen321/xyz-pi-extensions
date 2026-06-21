/**
 * Workflow orchestrator — manages lifecycle, Worker threads, agent calls,
 * callCache, budget enforcement, and state persistence.
 *
 * Wave 6: lifecycle operations (run/pause/resume/abort/retry/skip/restart)
 * are extracted to engine/lifecycle.ts; Worker management and message routing
 * are extracted to engine/worker-manager.ts. This class stays the sole owner
 * of the `runs` map and delegates the operational logic via an
 * OrchestratorCore view of itself (`implements OrchestratorCore`).
 *
 * Lifecycle: run → pause/resume → abort. Agent calls routed via AgentPool.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { RunResources } from "./domain/run-resources.js";
import {
  type ExecutionTraceNode,
  type WorkflowBudget,
  type WorkflowInstance,
  type WorkflowStatus,
} from "./domain/state.js";
import type { OrchestratorCore } from "./engine/core.js";
import {
  abortRun,
  pauseRun,
  restartRun,
  resumeRun,
  retryRunNode,
  runWorkflow,
  runWorkflowAndWait,
  skipRunNode,
} from "./engine/lifecycle.js";
import { WorkflowEventEmitter } from "./engine/orchestrator-events.js";
import {
  agentCallContext,
  budgetCallbacks,
  errorHandlerContext,
  handleAgentCall,
  handleWorkerMessage,
  pauseOnSignal,
  postMessage,
  recreateRunAbortController,
  resolveAgentOpts,
  startWorker,
  terminateDeps,
  terminateWorker,
} from "./engine/worker-manager.js";
import { AgentRegistry } from "./infra/agent-discovery.js";
import { cleanupAllTempFiles as cleanupAllFiles, cleanupTempFile as cleanupFile } from "./infra/agent-opts-resolver.js";
import type { AgentCallOpts } from "./infra/agent-pool.js";
import { DEFAULT_RUNANDWAIT_TIMEOUT_MS } from "./infra/constants.js";
import { persistState as persistInstances } from "./infra/state-store.js";

// ── Public types ──────────────────────────────────────────────

export interface WorkflowInstanceSummary {
  runId: string;
  name: string;
  status: WorkflowStatus;
  worker: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  traceLength: number;
  cachedCalls: number;
  budget: WorkflowBudget;
  /** Full trace nodes for live progress rendering */
  traceNodes: ExecutionTraceNode[];
}

// ── Orchestrator ──────────────────────────────────────────────

export class WorkflowOrchestrator implements OrchestratorCore {
  /** All per-run resources aggregated by runId — single source of truth. */
  readonly runs = new Map<string, RunResources>();
  readonly agentRegistry: AgentRegistry;
  /** Active temp files created for agent system prompts — cleaned up on completion or abort. */
  readonly activeTempFiles = new Set<string>();
  // Bound helpers that carry activeTempFiles closure
  cleanupTempFile = (fp: string): void => cleanupFile(fp, this.activeTempFiles);
  /** Bound helper for agent-opts-resolver temp file cleanup. */
  cleanupAllTempFiles = (): void => cleanupAllFiles(this.activeTempFiles);
  readonly pi: ExtensionAPI;
  private readonly ctx: ExtensionContext;
  readonly sessionDir: string;
  /** Called after every trace node state change for live TUI updates */
  onTraceUpdate?: (runId: string) => void;
  /** Called when a workflow reaches a terminal state (completed/failed/aborted/budget_limited/time_limited) */
  onCompletion?: (runId: string) => void;
  /** Event emitter for real-time TUI subscriptions (FR-5). */
  readonly events = new WorkflowEventEmitter();

  constructor(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    _maxConcurrency?: number,
    _poolOptions?: Record<string, never>,
  ) {
    this.pi = pi;
    this.ctx = ctx;
    this.sessionDir = path.join(os.homedir(), ".pi", "agent");

    // Override with session-scoped directory (same as Pi's session JSONL location).
    // Pi encodes the project path as: /a/b/c → --a-b-c-- (subdirectory under sessions/).
    // RISK: This relies on Pi's internal directory naming convention. If Pi changes
    // the encoding scheme, state files will be orphaned. No public API exposes
    // the session directory path — fallback to ~/.pi/agent/ if detection fails.
    const sessionSlug = "--" + process.cwd().replace(/^\//, "").replace(/\//g, "-") + "--";
    const sessionScopedDir = path.join(os.homedir(), ".pi", "agent", "sessions", sessionSlug);
    if (fs.existsSync(sessionScopedDir)) {
      this.sessionDir = sessionScopedDir;
    }
    // AgentPool is created per-workflow-run in `run()`, not in constructor
    this.agentRegistry = new AgentRegistry(process.cwd());
    this.agentRegistry.discoverAll();
  }

  // ── Public API: state accessors ─────────────────────────────

  /** Return the aggregated resources for a run. */
  getRun(runId: string): RunResources | undefined {
    return this.runs.get(runId);
  }

  /** Set/replace the aggregated resources for a run. */
  setRun(runId: string, run: RunResources): void {
    this.runs.set(runId, run);
  }

  /** Remove a run entry (restart path). */
  deleteRun(runId: string): void {
    this.runs.delete(runId);
  }

  /** Return the number of discovered agents. */
  getAgentCount(): number {
    return this.agentRegistry.list().length;
  }

  /** Return a summary of all discovered agents. */
  getAgents(): Array<{ name: string; source: string; model?: string }> {
    return this.agentRegistry.list().map((a) => ({
      name: a.name,
      source: a.source,
      model: a.model,
    }));
  }

  // ── Lifecycle (delegated to engine/lifecycle.ts) ────────────

  /** Start a workflow. Returns runId for lifecycle operations. Signal propagated to AgentPool. */
  async run(
    name: string,
    args: Record<string, unknown>,
    budgetTokens?: number,
    budgetTimeMs?: number,
    signal?: AbortSignal,
  ): Promise<string> {
    return runWorkflow(this, name, args, budgetTokens, budgetTimeMs, signal);
  }

  /**
   * Pause a running workflow. Terminates the Worker thread but preserves
   * the callCache so it can be resumed later from the point of interruption.
   */
  async pause(runId: string): Promise<void> {
    return pauseRun(this, runId);
  }

  /**
   * Resume a paused workflow. Creates a new Worker thread with the
   * preserved callCache.
   */
  async resume(runId: string): Promise<void> {
    return resumeRun(this, runId);
  }

  /** Abort a workflow immediately. Terminal state. */
  async abort(runId: string, reason?: string): Promise<void> {
    return abortRun(this, runId, reason);
  }

  /** Retry a specific agent call. */
  async retryNode(runId: string, callId: number): Promise<void> {
    return retryRunNode(this, runId, callId);
  }

  /** Skip a specific agent call. Injects placeholder into callCache. */
  async skipNode(runId: string, callId: number): Promise<void> {
    return skipRunNode(this, runId, callId);
  }

  /** Restart a workflow: fresh instance from the same script. Returns new runId. */
  async restart(runId: string): Promise<string> {
    return restartRun(this, runId);
  }

  /**
   * Run a workflow and wait for completion (synchronous from caller's POV).
   * Designed for cross-extension programmatic calls (e.g. pi.__workflowRun).
   */
  async runAndWait(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs: number = DEFAULT_RUNANDWAIT_TIMEOUT_MS,
  ): Promise<{ status: string; scriptResult?: unknown; error?: string; runId: string }> {
    return runWorkflowAndWait(this, name, args, signal, timeoutMs);
  }

  // ── Worker lifecycle (delegated to engine/worker-manager.ts) ──

  /** Create and wire a Worker thread for a given instance. */
  startWorker(runId: string, instance: WorkflowInstance, scriptSource: string, args: Record<string, unknown>): void {
    return startWorker(this, runId, instance, scriptSource, args);
  }

  /** Pause workflow on tool-signal abort. */
  pauseOnSignal(runId: string): void {
    return pauseOnSignal(this, runId);
  }

  /** Recreate AbortController for a run after terminateWorker aborted the old one. */
  recreateRunAbortController(runId: string): void {
    return recreateRunAbortController(this, runId);
  }

  /** Terminate and clean up a worker thread. */
  terminateWorker(runId: string, keepController: boolean = false): void {
    return terminateWorker(this, runId, keepController);
  }

  /** Post a message to the worker thread. */
  postMessage(runId: string, msg: unknown): void {
    return postMessage(this, runId, msg);
  }

  /** Route a message from the worker thread based on its type. */
  async handleWorkerMessage(runId: string, raw: unknown): Promise<void> {
    return handleWorkerMessage(this, runId, raw);
  }

  /** Resolve agent name and schema to systemPromptFiles (delegates to agent-opts-resolver). */
  resolveAgentOpts(opts: AgentCallOpts): { opts: AgentCallOpts; error?: string } {
    return resolveAgentOpts(this, opts);
  }

  /** Process an agent-call from the worker. */
  async handleAgentCall(
    runId: string,
    instance: WorkflowInstance,
    callId: number,
    opts: AgentCallOpts,
    phase?: string,
  ): Promise<void> {
    return handleAgentCall(this, runId, instance, callId, opts, phase);
  }

  // ── Context factories (delegated to engine/worker-manager.ts) ──

  /** Build the context object for error handler functions. */
  errorHandlerContext() {
    return errorHandlerContext(this);
  }

  /** Build the context object for agent-call-handler.executeWithRetry. */
  agentCallContext() {
    return agentCallContext(this);
  }

  /** Shared BudgetCallbacks instance. */
  budgetCallbacks() {
    return budgetCallbacks(this);
  }

  /** Build the TerminateDeps for terminateInstance. */
  terminateDeps() {
    return terminateDeps(this);
  }

  // ── Query API ───────────────────────────────────────────────

  /**
   * List all workflow instances in the current session as summaries.
   */
  list(): WorkflowInstanceSummary[] {
    return Array.from(this.runs.values()).map(({ instance: inst }) => ({
      runId: inst.runId,
      name: inst.name,
      status: inst.status,
      worker: inst.worker,
      startedAt: inst.startedAt,
      completedAt: inst.completedAt,
      error: inst.error,
      traceLength: inst.trace.length,
      cachedCalls: inst.callCache.size,
      budget: inst.budget,
      traceNodes: inst.trace,
    }));
  }

  /**
   * Get a workflow instance by runId.
   */
  getInstance(runId: string): WorkflowInstance | undefined {
    return this.getRun(runId)?.instance;
  }

  /**
   * Restore previously serialized instances into the orchestrator.
   * Used during session_start/session_tree to rehydrate state.
   *
   * Rehydrated runs only carry the persisted WorkflowInstance — meta/pool/
   * worker/abortController are recreated lazily on resume/run (see
   * RunResources.lifecycle note).
   */
  restoreInstances(instances: Map<string, WorkflowInstance>): void {
    for (const [runId, instance] of instances) {
      const existing = this.runs.get(runId);
      if (existing) {
        existing.instance = instance;
      } else {
        this.runs.set(runId, { instance, retryCount: 0 });
      }
    }
  }

  /**
   * Reconstruct workflow instances from session JSONL and restore them.
   * Delegates to state-store's reconstructState, then calls restoreInstances.
   */
  async reconstructAndRestore(): Promise<void> {
    const { reconstructState } = await import("./infra/state-store.js");
    const instances = await reconstructState(this.ctx);
    this.restoreInstances(instances);
  }

  // ── Persistence ─────────────────────────────────────────────

  /**
   * Flush the current state to external JSONL files (delegates to state-store).
   * Kept as instance method to preserve public API used by index.ts.
   *
   * Persistence layer only knows about WorkflowInstance (not the in-memory
   * RunResources aggregate), so we project runs → instance map here.
   */
  async persistState(): Promise<void> {
    const instances = new Map<string, WorkflowInstance>();
    for (const [runId, run] of this.runs) {
      instances.set(runId, run.instance);
    }
    await persistInstances(this.pi, this.sessionDir, instances);
  }
}
