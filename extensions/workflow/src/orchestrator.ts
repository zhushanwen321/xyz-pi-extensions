/**
 * Workflow orchestrator — manages lifecycle, Worker threads, agent calls,
 * callCache, budget enforcement, and state persistence.
 *
 * Lifecycle: run → pause/resume → abort. Agent calls routed via AgentPool.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { cleanupAllTempFiles as cleanupAllFiles, cleanupTempFile as cleanupFile, resolveAgentOpts as resolveOpts } from "./infra/agent-opts-resolver.js";
import { AgentRegistry } from "./infra/agent-discovery.js";
import { type AgentCallOpts,AgentPool } from "./infra/agent-pool.js";
import { getWorkflow } from "./infra/config-loader.js";
import { appendTraceNode } from "./infra/execution-trace.js";
import { resolveModel } from "./engine/model-resolver.js";
import { lintScript } from "./infra/script-lint.js";
import {
  type AgentResult as StateAgentResult,
  createInstance as createStateInstance,
  type ExecutionTraceNode,
  isTerminal,
  transitionStatus,
  type WorkflowBudget,
  type WorkflowInstance,
  type WorkflowStatus,
} from "./domain/state.js";
import { persistState as persistInstances } from "./infra/state-store.js";
import { WorkflowEventEmitter } from "./engine/orchestrator-events.js";
import { type WorkerInMsg as ImportedWorkerInMsg, buildWorkerScript } from "./engine/worker-script.js";
import { checkBudget, scheduleTimeBudgetCheck } from "./engine/orchestrator-budget.js";
import { handleWorkerError, handleWorkerExit, handleScriptError, type ErrorHandlerContext } from "./engine/error-handlers.js";
import { executeWithRetry, isBudgetExceeded, type AgentCallContext } from "./engine/agent-call-handler.js";
// Re-export for backward compat (tests import isStaleContextErrorMsg from src/orchestrator).
export { isStaleContextErrorMsg, STALE_CONTEXT_PATTERNS } from "./engine/agent-call-handler.js";
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
// ── Internal types ────────────────────────────────────────────

/** Per-run metadata needed for resume/retry/re-run operations. */
interface RunMeta {
  scriptSource: string;
  args: Record<string, unknown>;
  budgetTokens?: number;
  budgetTimeMs?: number;
  /** P1-2: Abort signal from the tool execute caller — propagated to AgentPool
   *  and used to pause the workflow if triggered. */
  signal?: AbortSignal;
}

/** Worker→Main message type — unified with worker-script.ts definition. */
type WorkerInMsg = ImportedWorkerInMsg;

// ── Constants ─────────────────────────────────────────────────

const RUNID_RADIX = 36;
const RUNID_SLICE_START = 2;
const RUNID_SLICE_LENGTH = 8;

// ── Orchestrator ──────────────────────────────────────────────

export class WorkflowOrchestrator {
  private readonly instances = new Map<string, WorkflowInstance>();
  private readonly workers = new Map<string, Worker>();
  private readonly runMetaMap = new Map<string, RunMeta>();
  private readonly retryCounts = new Map<string, number>();
  private readonly runPools = new Map<string, AgentPool>();
  private readonly agentRegistry: AgentRegistry;
  /** Active temp files created for agent system prompts — cleaned up on completion or abort. */
  private readonly activeTempFiles = new Set<string>();
  // Bound helpers that carry activeTempFiles closure
  private cleanupTempFile = (fp: string): void => cleanupFile(fp, this.activeTempFiles);
  /** Bound helper for agent-opts-resolver temp file cleanup. */
  cleanupAllTempFiles = (): void => cleanupAllFiles(this.activeTempFiles);
  /** Per-run AbortController for killing agent subprocesses on terminate/pause/abort. */
  private readonly runAbortControllers = new Map<string, AbortController>();
  private readonly pi: ExtensionAPI;
  private readonly ctx: ExtensionContext;
  private readonly sessionDir: string;
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

  // ── Public API ──────────────────────────────────────────────

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


  /** Start a workflow. Returns runId for lifecycle operations. Signal propagated to AgentPool. */
  async run(
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
    const runId = `wf-${Date.now()}-${Math.random().toString(RUNID_RADIX).slice(RUNID_SLICE_START, RUNID_SLICE_LENGTH)}`;

    const instance = createStateInstance({
      runId,
      name,
      worker: workflow.path,
      status: "running",
      budget: { maxTokens: budgetTokens, maxTimeMs: budgetTimeMs },
    });
    instance.startedAt = new Date().toISOString();
    instance.description = workflow.description;

    this.runMetaMap.set(runId, { scriptSource, args, budgetTokens, budgetTimeMs, signal });
    this.instances.set(runId, instance);

    // Create per-run AbortController for agent subprocess cleanup.
    // Orchestrator owns this controller — abort() on terminate/pause/abort.
    const runAbortController = new AbortController();
    this.runAbortControllers.set(runId, runAbortController);

    // Create per-workflow AgentPool with soft-limit warning callback
    // Each workflow run gets its own pool so agent call counts are isolated per AC-4.5
    const pool = new AgentPool({
      maxConcurrency: 4,
      runName: instance.name,
      onSoftLimitReached: ({ runName, totalCalls, budget }) => {
        this.pi.sendUserMessage(
          `[workflow:${runName}] Reached ${totalCalls} agent calls. ` +
          `Budget: ${budget.usedTokens}/${budget.maxTokens ?? "unlimited"} tokens. ` +
          `Consider aborting if this is unintended.`,
        );
      },
    });
    pool.setBudget(instance.budget);
    this.runPools.set(runId, pool);

    // P1-2: Tool-signal forwarders: (1) kill agent subprocess; (2) pause workflow
    if (signal) {
      signal.addEventListener("abort", () => runAbortController.abort(), { once: true });
      signal.addEventListener("abort", () => this.pauseOnSignal(runId), { once: true });
    }
    await this.persistState();

    this.startWorker(runId, instance, scriptSource, args);

    if (budgetTimeMs) {
      scheduleTimeBudgetCheck(
        (id) => this.instances.get(id),
        runId,
        budgetTimeMs,
        this.budgetCallbacks(),
      );
    }

    return runId;
  }

  /**
   * Pause a running workflow. Terminates the Worker thread but preserves
   * the callCache so it can be resumed later from the point of interruption.
   */
  async pause(runId: string): Promise<void> {
    const instance = this.instances.get(runId);
    if (!instance) {
      throw new Error(`Workflow '${runId}' not found`);
    }
    if (instance.status !== "running") {
      throw new Error(
        `Cannot pause workflow in state '${instance.status}': only 'running' can be paused`,
      );
    }

    // Set paused status BEFORE terminating so the exit handler skips cleanup
    instance.pausedAt = new Date().toISOString();
    transitionStatus(instance, "paused");
    this.events.emit(runId, { type: "status", status: "paused" });
    // Round 3 MF2: pause 保留 controller——失败的 retry 仍能写 callCache，
    // resume 后新 worker 不会因为 retry 跳过而丢失结果。
    this.terminateWorker(runId, true);
    // Cleanup in-flight temp files from agent calls that were killed mid-flight.
    // Without this, files written for --append-system-prompt leak to disk.
    this.cleanupAllTempFiles();
    await this.persistState();
  }

  /**
   * Resume a paused workflow. Creates a new Worker thread with the
   * preserved callCache. Cached agent calls replay immediately from
   * the cache; uncached calls dispatch fresh.
   */
  async resume(runId: string): Promise<void> {
    const instance = this.instances.get(runId);
    if (!instance) {
      throw new Error(`Workflow '${runId}' not found`);
    }
    if (instance.status !== "paused") {
      throw new Error(
        `Cannot resume workflow in state '${instance.status}': only 'paused' can be resumed`,
      );
    }

    instance.pausedAt = undefined;
    transitionStatus(instance, "running");
    this.events.emit(runId, { type: "status", status: "running" });

    const meta = this.runMetaMap.get(runId);
    if (meta) {
      // Recreate AbortController for the resumed run (old one was aborted on pause)
      this.recreateRunAbortController(runId);

      // Worker-backed instance: restart Worker with preserved callCache
      this.startWorker(runId, instance, meta.scriptSource, meta.args);

      // P1-6: Re-schedule time budget check after resume
      if (meta.budgetTimeMs) {
        scheduleTimeBudgetCheck(
          (id) => this.instances.get(id),
          runId,
          meta.budgetTimeMs,
          this.budgetCallbacks(),
        );
      }
    }
    // State-machine-only instances (no runMeta): just transition status

    await this.persistState();
  }

  /**
   * Abort a workflow immediately. Terminates the Worker thread and
   * marks the instance as aborted (terminal state).
   */
  async abort(runId: string): Promise<void> {
    const instance = this.instances.get(runId);
    if (!instance) {
      throw new Error(`Workflow '${runId}' not found`);
    }

    // P1-4: Allow abort from running or paused
    if (instance.status !== "running" && instance.status !== "paused") {
      throw new Error(
        `Cannot abort workflow in state '${instance.status}': only 'running' or 'paused' can be aborted`,
      );
    }

    // Set terminal status BEFORE terminating
    instance.completedAt = new Date().toISOString();
    transitionStatus(instance, "aborted");
    this.events.emit(runId, { type: "status", status: "aborted" });
    this.terminateWorker(runId);
    this.cleanupAllTempFiles();
    this.runPools.delete(runId);
    await this.persistState();
    this.onCompletion?.(runId);
  }

  /**
   * Retry a specific agent call. Removes the cached result for the
   * given callId, terminates the current Worker, and starts a new one.
   * The script re-executes from the top — completed calls replay from
   * cache, the retried call dispatches fresh.
   */
  async retryNode(runId: string, callId: number): Promise<void> {
    const instance = this.instances.get(runId);
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

    this.terminateWorker(runId);

    // P1-7: Reset retry counts for fresh start
    this.retryCounts.delete(runId);

    const meta = this.runMetaMap.get(runId);
    if (meta) {
      // Recreate AbortController after terminate (old was aborted)
      this.recreateRunAbortController(runId);
      this.startWorker(runId, instance, meta.scriptSource, meta.args);
    }

    await this.persistState();
  }

  /** Skip a specific agent call. Injects placeholder into callCache for immediate resolution. */
  async skipNode(runId: string, callId: number): Promise<void> {
    const instance = this.instances.get(runId);
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
    if (this.workers.has(runId)) {
      try {
        this.postMessage(runId, { type: "agent-result", callId, result: placeholder, cached: true });
      }
      // eslint-disable-next-line taste/no-silent-catch
      catch {
        // P1-8: Worker may have exited between has() and postMessage().
        // This is an expected race condition — no recovery needed, and
        // surfacing it would leak to the input area.
      }
    }

    await this.persistState();
  }

  /**
   * Restart a workflow: create a fresh instance from the same script,
   * then clean up the old one. Returns the new runId.
   *
   * Note: intentionally does NOT forward the original AbortSignal to the
   * new instance. Restart is a user-initiated action — the new run should
   * have an independent lifecycle from the original tool-execute caller's
   * signal (which may already be aborted).
   */
  async restart(runId: string): Promise<string> {
    const instance = this.instances.get(runId);
    if (!instance) {
      throw new Error(`Workflow '${runId}' not found`);
    }

    const meta = this.runMetaMap.get(runId);
    if (!meta) {
      throw new Error("No metadata for restart — cannot re-run without original script");
    }

    const name = instance.name;
    const scriptSource = meta.scriptSource;
    const args = meta.args;
    const budgetTokens = meta.budgetTokens;
    const budgetTimeMs = meta.budgetTimeMs;

    // 1. Abort old instance if still alive
    if (instance.status === "running" || instance.status === "paused") {
      instance.completedAt = new Date().toISOString();
      transitionStatus(instance, "aborted");
      this.events.emit(runId, { type: "status", status: "aborted" });
      this.terminateWorker(runId);
      this.cleanupAllTempFiles();
    }

    // 2. Create new instance directly from cached scriptSource (skip getWorkflow + readFile).
    const newRunId = `wf-${Date.now()}-${Math.random().toString(RUNID_RADIX).slice(RUNID_SLICE_START, RUNID_SLICE_LENGTH)}`;
    const newInstance = createStateInstance({
      runId: newRunId,
      name,
      worker: instance.worker,
      budget: { maxTokens: budgetTokens, maxTimeMs: budgetTimeMs },
    });
    newInstance.startedAt = new Date().toISOString();

    this.instances.set(newRunId, newInstance);
    this.runMetaMap.set(newRunId, { scriptSource, args, budgetTokens, budgetTimeMs });
    // Round 4 MF#1: create per-run AbortController so executeWithRetry can abort in-flight pi subprocess on user abort.
    this.runAbortControllers.set(newRunId, new AbortController());
    this.startWorker(newRunId, newInstance, scriptSource, args);

    // 3. Schedule time budget check if needed
    if (budgetTimeMs) {
      scheduleTimeBudgetCheck(
        (id) => this.instances.get(id),
        newRunId,
        budgetTimeMs,
        this.budgetCallbacks(),
      );
    }

    // 4. Persist new instance before cleaning old one
    await this.persistState();

    // 5. Clean up old instance
    this.instances.delete(runId);
    this.runMetaMap.delete(runId);
    this.retryCounts.delete(runId);
    this.runAbortControllers.delete(runId);
    this.runPools.delete(runId);
    await this.persistState();

    return newRunId;
  }

  /**
   * List all workflow instances in the current session as summaries.
   */
  list(): WorkflowInstanceSummary[] {
    return Array.from(this.instances.values()).map((inst) => ({
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
    return this.instances.get(runId);
  }

  /**
   * Restore previously serialized instances into the orchestrator.
   * Used during session_start/session_tree to rehydrate state.
   */
  restoreInstances(instances: Map<string, WorkflowInstance>): void {
    for (const [runId, instance] of instances) {
      this.instances.set(runId, instance);
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

  // ── Worker lifecycle ────────────────────────────────────────

  /**
   * Create and wire a Worker thread for a given instance.
   */
  private startWorker(
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
      this.handleWorkerMessage(runId, raw);
    });

    worker.on("error", (err: Error) => {
      handleWorkerError(this.errorHandlerContext(), runId, err);
    });

    worker.on("exit", (code: number) => {
      handleWorkerExit(this.errorHandlerContext(), runId, code, worker);
    });

    this.workers.set(runId, worker);
  }

  /**
   * P1-2 + Round 5 MF#3: pause workflow on tool-signal abort. 提取为 helper——
   * run() 和 recreateRunAbortController() 都需注册此 listener（resume 后必须重注册）。
   * Round 3 MF2: pause 保留 controller，避免 retry 误判后丢失 callCache/worker 通知。
   */
  private pauseOnSignal(runId: string): void {
    const inst = this.instances.get(runId);
    if (!inst || inst.status !== "running") return;
    inst.pausedAt = new Date().toISOString();
    try {
      transitionStatus(inst, "paused");
    // eslint-disable-next-line taste/no-silent-catch
    } catch {
      // State machine refused — leave as-is
    }
    this.terminateWorker(runId, true);
    void this.persistState();
  }

  /**
   * Recreate AbortController for a run after terminateWorker aborted the old one.
   * Re-wires the tool-level signal: (1) kill agent subprocess; (2) pause workflow.
   * Round 5 MF#3: resume 后必须重注册 pause-on-abort listener，否则 tool signal 再次
   * abort 只杀 agent 子进程、workflow 状态不变 paused，worker 死了但实例仍 running。
   */
  private recreateRunAbortController(runId: string): void {
    const newController = new AbortController();
    this.runAbortControllers.set(runId, newController);
    const meta = this.runMetaMap.get(runId);
    if (meta?.signal && !meta.signal.aborted) {
      meta.signal.addEventListener("abort", () => newController.abort(), { once: true });
      meta.signal.addEventListener("abort", () => this.pauseOnSignal(runId), { once: true });
    }
  }

  /**
   * Terminate and clean up a worker thread. Also aborts all in-flight
   * agent subprocesses via the per-run AbortController.
   *
   * @param runId           Workflow run ID
   * @param keepController  Round 3 MF2: pause 调用时传 true——保留 controller 在 map 中，
   *                        让 pause→resume 期间失败的 retry 仍能写 callCache 并通知 worker，
   *                        避免 resume 后新 worker 重复执行有 side-effect 的 agent。
   *                        abort/retry/delete/budget 仍传 false，完整清理。
   */
  private terminateWorker(runId: string, keepController: boolean = false): void {
    // Abort all agent subprocesses for this run
    const controller = this.runAbortControllers.get(runId);
    if (controller) {
      if (!keepController) {
        this.runAbortControllers.delete(runId);
      }
      controller.abort();
    }

    const worker = this.workers.get(runId);
    if (worker) {
      this.workers.delete(runId);
      worker.terminate().catch(() => {
        // Best-effort termination; failures are expected when the worker
        // is already exiting. Surfacing to terminal would leak to the
        // input area and confuse the user during normal teardown.
      });
    }
  }

  /** Post a message to the worker thread. */
  private postMessage(runId: string, msg: unknown): void {
    const worker = this.workers.get(runId);
    if (worker) worker.postMessage(msg);
  }

  /** Build the context object for error handler functions. */
  private errorHandlerContext(): ErrorHandlerContext {
    return {
      instances: this.instances,
      workers: this.workers,
      retryCounts: this.retryCounts,
      getRunMeta: (id) => this.runMetaMap.get(id),
      events: this.events,
      terminateWorker: (id) => this.terminateWorker(id),
      cleanupAllTempFiles: () => this.cleanupAllTempFiles(),
      recreateRunAbortController: (id) => this.recreateRunAbortController(id),
      startWorker: (id, inst, src, args) => this.startWorker(id, inst, src, args),
      persistState: () => this.persistState(),
      onCompletion: (id) => this.onCompletion?.(id),
      deleteRunPool: (id) => this.runPools.delete(id),
    };
  }

  /** Build the context object for agent-call-handler.executeWithRetry.
   *  Mirrors errorHandlerContext() — stateless handler + injected orchestrator deps. */
  private agentCallContext(): AgentCallContext {
    return {
      pi: this.pi,
      events: this.events,
      runPools: this.runPools,
      runAbortControllers: this.runAbortControllers,
      postMessage: (id, msg) => this.postMessage(id, msg),
      persistState: () => this.persistState(),
      budgetCallbacks: () => this.budgetCallbacks(),
      cleanupTempFile: (fp) => this.cleanupTempFile(fp),
      onTraceUpdate: (id) => this.onTraceUpdate?.(id),
    };
  }

  /** Shared BudgetCallbacks 实例——executeWithRetry / handleAgentCall /
   *  scheduleTimeBudgetCheck 都需要同样的 5 个回调。集中创建避免在调用点
   *  重复 6 行内联（orchestrator.ts 文件行数 1000+ 紧贴上限）。 */
  private budgetCallbacks() {
    return {
      postMessage: (id: string, msg: unknown) => this.postMessage(id, msg),
      terminateWorker: (id: string) => this.terminateWorker(id),
      cleanupAllTempFiles: () => this.cleanupAllTempFiles(),
      persistState: () => this.persistState(),
      onCompletion: (id: string) => this.onCompletion?.(id),
    };
  }

  // ── Message routing ─────────────────────────────────────────

  /**
   * Route a message from the worker thread based on its type.
   */
  private async handleWorkerMessage(runId: string, raw: unknown): Promise<void> {
    const msg = raw as WorkerInMsg;

    const instance = this.instances.get(runId);
    if (!instance) return;

    switch (msg.type) {
      case "agent-call":
        this.handleAgentCall(runId, instance, msg.callId, msg.opts as AgentCallOpts, msg.phase);
        break;
      case "return": {
        // P0-1: Guard against stale return messages after terminate/pause/budget
        if (isTerminal(instance.status) || instance.status === "budget_limited" || instance.status === "paused") return;
        // FR-1: Capture script return value
        instance.scriptResult = msg.result;
        // P2-2: Surface worker diagnostics via the TUI widget, never the input area.
        if (Array.isArray(msg.workerLogs) && msg.workerLogs.length > 0) {
          instance.errorLogs = msg.workerLogs;
        }
        instance.completedAt = new Date().toISOString();
        transitionStatus(instance, "completed");
        this.events.emit(runId, { type: "status", status: "completed" });
        this.workers.delete(runId);
        this.runPools.delete(runId);
        await this.persistState();
        this.onTraceUpdate?.(runId);
        this.onCompletion?.(runId);
        break;
      }
      case "error": {
        // P0-1: Guard against stale error messages after terminate/pause/budget
        if (isTerminal(instance.status) || instance.status === "budget_limited" || instance.status === "paused") return;
        handleScriptError(this.errorHandlerContext(), runId, msg.error, Array.isArray(msg.workerLogs) ? msg.workerLogs : undefined);
        break;
      }
    }
  }

  /** Resolve agent name and schema to systemPromptFiles (delegates to agent-opts-resolver). */
  private resolveAgentOpts(opts: AgentCallOpts): { opts: AgentCallOpts; error?: string } {
    return resolveOpts(opts, this.agentRegistry, this.sessionDir, this.activeTempFiles);
  }

  /**
   * Process an agent-call from the worker. Checks callCache first;
   * on miss, enqueues via AgentPool, caches the result, and responds.
   */
  private async handleAgentCall(
    runId: string,
    instance: WorkflowInstance,
    callId: number,
    opts: AgentCallOpts,
    phase?: string,
  ): Promise<void> {
    const cached = instance.callCache.get(callId);
    if (cached) {
      this.postMessage(runId, { type: "agent-result", callId, result: cached, cached: true });
      return;
    }

    // Round 5 SUG#4 + Must-fix #4: 入口先 checkBudget。budget 是软限制——若 worker
    // 在检查生效前连续 enqueue N 个调用，这 N 个仍会执行并累加 token，budget 可被
    // 突破 maxTokens 的 N 倍。入口检查只能终止后续调用；硬限制需在 pool.enqueue
    // 内加 budget gate（未实现，引入 pool↔budget 耦合且仍有并发竞态窗口）。
    if (isBudgetExceeded(instance)) {
      const b = instance.budget;
      const errorResult: StateAgentResult = {
        content: "",
        error: `Budget exceeded before dispatch: ${b.usedTokens}/${b.maxTokens ?? "?"} tokens`,
      };
      instance.callCache.set(callId, errorResult);
      this.postMessage(runId, { type: "agent-result", callId, result: errorResult, cached: false });
      await checkBudget(instance, runId, this.budgetCallbacks());
      return;
    }

    // Agent resolution
    const resolved = this.resolveAgentOpts(opts);
    if (resolved.error) {
      const errorResult: StateAgentResult = { content: "", error: resolved.error };
      instance.callCache.set(callId, errorResult);
      this.postMessage(runId, { type: "agent-result", callId, result: errorResult, cached: false });
      return;
    }
    let enrichedOpts = resolved.opts;

    // Resolve model from scene if needed
    const resolvedModel = await resolveModel(enrichedOpts);
    if (resolvedModel) {
      enrichedOpts = { ...enrichedOpts, model: resolvedModel };
    }

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
    appendTraceNode(this.pi, runId, node);
    this.events.emit(runId, { type: "trace", node: { stepIndex: node.stepIndex, agent: node.agent, status: node.status, phase: node.phase } });
    this.onTraceUpdate?.(runId);
    executeWithRetry(this.agentCallContext(), runId, callId, enrichedOpts, instance, node);
  }

  // ── Synchronous run (for programmatic callers) ────────────

  /**
   * Run a workflow and wait for it to complete (synchronous from caller's POV).
   * Polls instance status at 500ms intervals until terminal state.
   *
   * Designed for cross-extension programmatic calls (e.g. pi.__workflowRun).
   * NOT intended for interactive use — use `run()` + lifecycle tools instead.
   */
  async runAndWait(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs: number = 600_000, // 10 minutes
  ): Promise<{ status: string; scriptResult?: unknown; error?: string; runId: string }> {
    const runId = await this.run(name, args, undefined, undefined, signal);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        try { await this.abort(runId); } catch { /* already terminal */ void undefined; }
        return { status: "aborted", runId, error: "Aborted by signal" };
      }
      const instance = this.instances.get(runId);
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
      await new Promise((r) => setTimeout(r, 500));
    }
    // Timeout — abort the workflow
    try { await this.abort(runId); } catch { /* already terminal */ void undefined; }
    return { status: "timeout", runId, error: `Workflow timed out after ${timeoutMs}ms` };
  }

  // ── Persistence ─────────────────────────────────────────────

  /**
   * Flush the current state to external JSONL files (delegates to state-store).
   * Kept as instance method to preserve public API used by index.ts.
   */
  async persistState(): Promise<void> {
    await persistInstances(this.pi, this.sessionDir, this.instances);
  }
}
