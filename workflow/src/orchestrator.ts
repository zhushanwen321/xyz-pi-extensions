/**
 * Workflow Extension — Orchestrator
 *
 * Core workflow runtime engine. Manages lifecycle, Worker threads, agent
 * call routing, callCache, budget enforcement, and state persistence.
 *
 * Lifecycle:
 *   run() → Worker thread with injected agent/parallel/pipeline globals
 *         → Worker sends agent-call messages → AgentPool enqueue → response
 *         → Worker completes → mark completed
 *   pause() → terminate Worker, keep callCache for resume
 *   resume() → new Worker with preserved callCache, script re-executes
 *   abort() → terminate Worker, mark aborted (terminal)
 *   retryNode() → clear cached entry, restart Worker
 *   skipNode() → add placeholder to callCache, mark trace
 */

import * as fs from "node:fs";
import { Worker } from "node:worker_threads";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { AgentPool, type AgentCallOpts } from "./agent-pool.js";
import { getWorkflow } from "./config-loader.js";
import { appendTraceNode } from "./execution-trace.js";
import {
  type AgentResult as StateAgentResult,
  type ExecutionTraceNode,
  type WorkflowInstance,
  type WorkflowBudget,
  type WorkflowStatus,
  createInstance as createStateInstance,
  transitionStatus,
  isTerminal,
  serializeState,
} from "./state.js";
import { buildWorkerScript } from "./worker-script.js";

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
}

/** Worker→Main message shapes. */
interface AgentCallMsg {
  type: "agent-call";
  callId: number;
  opts: AgentCallOpts;
}

interface ReturnMsg {
  type: "return";
  runId: string;
  result: unknown;
}

interface ErrorMsg {
  type: "error";
  runId: string;
  error: string;
}

type WorkerInMsg = AgentCallMsg | ReturnMsg | ErrorMsg;

// ── Constants ─────────────────────────────────────────────────

const MAX_WORKER_RETRIES = 3;
const RETRY_BACKOFF_MS = 1000;
const MAX_AGENT_RETRIES = 3;

// ── Orchestrator ──────────────────────────────────────────────

export class WorkflowOrchestrator {
  private readonly instances = new Map<string, WorkflowInstance>();
  private readonly workers = new Map<string, Worker>();
  private readonly runMetaMap = new Map<string, RunMeta>();
  private readonly retryCounts = new Map<string, number>();
  private readonly agentPool: AgentPool;
  private readonly pi: ExtensionAPI;
  private readonly ctx: ExtensionContext;
  /** Called after every trace node state change for live TUI updates */
  onTraceUpdate?: (runId: string) => void;

  constructor(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    maxConcurrency?: number,
  ) {
    this.pi = pi;
    this.ctx = ctx;
    this.agentPool = new AgentPool(maxConcurrency);
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Start a workflow. Reads the workflow script file via config-loader,
   * builds a Worker thread with injected globals, and returns a runId
   * for subsequent lifecycle operations.
   */
  async run(
    name: string,
    args: Record<string, unknown>,
    budgetTokens?: number,
    budgetTimeMs?: number,
  ): Promise<string> {
    const workflow = await getWorkflow(name);
    if (!workflow || !workflow.available) {
      throw new Error(`Workflow '${name}' not found or unavailable`);
    }

    // Read and normalize script: strip 'export' from 'export const meta' for CJS Worker
    let scriptSource = fs.readFileSync(workflow.path, "utf-8");
    scriptSource = scriptSource.replace(/\bexport\s+const\s+meta\b/, "const meta");
    const runId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const instance = createStateInstance({
      runId,
      name,
      worker: workflow.path,
      budget: { maxTokens: budgetTokens, maxTimeMs: budgetTimeMs },
    });
    instance.startedAt = new Date().toISOString();
    transitionStatus(instance, "running");

    this.runMetaMap.set(runId, { scriptSource, args, budgetTokens, budgetTimeMs });
    this.instances.set(runId, instance);
    this.persistState();

    this.startWorker(runId, instance, scriptSource, args);

    if (budgetTimeMs) {
      this.scheduleTimeBudgetCheck(runId, budgetTimeMs);
    }

    return runId;
  }

  /**
   * Pause a running workflow. Terminates the Worker thread but preserves
   * the callCache so it can be resumed later from the point of interruption.
   */
  pause(runId: string): void {
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
    this.terminateWorker(runId);
    this.persistState();
  }

  /**
   * Resume a paused workflow. Creates a new Worker thread with the
   * preserved callCache. Cached agent calls replay immediately from
   * the cache; uncached calls dispatch fresh.
   */
  resume(runId: string): void {
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

    const meta = this.runMetaMap.get(runId);
    if (meta) {
      // Worker-backed instance: restart Worker with preserved callCache
      this.startWorker(runId, instance, meta.scriptSource, meta.args);

      // P1-6: Re-schedule time budget check after resume
      if (meta.budgetTimeMs) {
        this.scheduleTimeBudgetCheck(runId, meta.budgetTimeMs);
      }
    }
    // State-machine-only instances (no runMeta): just transition status

    this.persistState();
  }

  /**
   * Abort a workflow immediately. Terminates the Worker thread and
   * marks the instance as aborted (terminal state).
   */
  abort(runId: string): void {
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
    this.terminateWorker(runId);
    this.persistState();
  }

  /**
   * Retry a specific agent call. Removes the cached result for the
   * given callId, terminates the current Worker, and starts a new one.
   * The script re-executes from the top — completed calls replay from
   * cache, the retried call dispatches fresh.
   */
  retryNode(runId: string, callId: number): void {
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
      this.startWorker(runId, instance, meta.scriptSource, meta.args);
    }

    this.persistState();
  }

  /**
   * Skip a specific agent call. Injects a placeholder into the
   * callCache so that on resume/retry the call resolves immediately.
   * If the worker is actively running and a pending call exists for
   * this callId, sends the cached result directly.
   */
  skipNode(runId: string, callId: number): void {
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
      } catch {
        // P1-8: Worker may have exited between has() and postMessage()
      }
    }

    this.persistState();
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
   * Create a state-machine-only instance (no Worker thread).
   * Used by the workflow tool's create action.
   */
  createInstance(params: {
    runId: string;
    name: string;
    worker: string;
    budget?: Partial<WorkflowBudget>;
  }): WorkflowInstance {
    const instance = createStateInstance(params);
    this.instances.set(params.runId, instance);
    this.persistState();
    return instance;
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
      this.handleWorkerError(runId, err);
    });

    worker.on("exit", (code: number) => {
      this.handleWorkerExit(runId, code);
    });

    this.workers.set(runId, worker);
  }

  /**
   * Terminate and clean up a worker thread. Fires and forgets the
   * terminate promise — the exit handler handles state reconciliation.
   */
  private terminateWorker(runId: string): void {
    const worker = this.workers.get(runId);
    if (worker) {
      this.workers.delete(runId);
      worker.terminate().catch(() => { /* ignore terminate errors */ });
    }
  }

  /**
   * Post a message to the worker thread.
   */
  private postMessage(runId: string, msg: unknown): void {
    const worker = this.workers.get(runId);
    if (worker) {
      worker.postMessage(msg);
    }
  }

  // ── Message routing ─────────────────────────────────────────

  /**
   * Route a message from the worker thread based on its type.
   */
  private handleWorkerMessage(runId: string, raw: unknown): void {
    const msg = raw as WorkerInMsg;

    const instance = this.instances.get(runId);
    if (!instance) return;

    switch (msg.type) {
      case "agent-call":
        this.handleAgentCall(runId, instance, msg.callId, msg.opts);
        break;
      case "return": {
        // P0-1: Guard against stale return messages after terminate/pause/budget
        if (isTerminal(instance.status) || instance.status === "budget_limited" || instance.status === "paused") return;
        instance.completedAt = new Date().toISOString();
        transitionStatus(instance, "completed");
        this.workers.delete(runId);
        this.persistState();
        this.onTraceUpdate?.(runId);
        break;
      }
      case "error": {
        // P0-1: Guard against stale error messages after terminate/pause/budget
        if (isTerminal(instance.status) || instance.status === "budget_limited" || instance.status === "paused") return;
        this.handleScriptError(runId, msg.error);
        break;
      }
    }
  }

  /**
   * Process an agent-call from the worker. Checks callCache first;
   * on miss, enqueues via AgentPool, caches the result, and responds.
   */
  private handleAgentCall(
    runId: string,
    instance: WorkflowInstance,
    callId: number,
    opts: AgentCallOpts,
  ): void {
    // Cache hit — respond immediately
    const cached = instance.callCache.get(callId);
    if (cached) {
      this.postMessage(runId, { type: "agent-result", callId, result: cached, cached: true });
      return;
    }

    // Record pending trace node
    const now = new Date().toISOString();
    const node: ExecutionTraceNode = {
      stepIndex: callId,
      agent: opts.description ?? "unknown",
      task: opts.prompt.slice(0, 200),
      model: opts.model ?? "default",
      status: "running",
      startedAt: now,
    };
    instance.trace.push(node);
    appendTraceNode(this.pi, runId, node);
    this.onTraceUpdate?.(runId);

    // Enqueue via AgentPool with retry
    this.executeWithRetry(runId, callId, opts, instance, node);
  }

  /**
   * Execute an agent call with retry logic. Retries up to MAX_AGENT_RETRIES
   * on failure with exponential backoff (1s, 2s, 4s).
   */
  private executeWithRetry(
    runId: string,
    callId: number,
    opts: AgentCallOpts,
    instance: WorkflowInstance,
    node: ExecutionTraceNode,
    attempt = 1,
  ): void {
    this.agentPool.enqueue(opts).then((poolResult) => {
      // P0-2: Stale state check — instance may have been paused/aborted during agent call
      if (instance.status !== "running") return;

      const result: StateAgentResult = {
        content: poolResult.output,
        parsedOutput: poolResult.parsedOutput,
        usage: poolResult.usage,
        durationMs: poolResult.durationMs,
        error: poolResult.success ? undefined : poolResult.error,
      };

      // Retry on failure with exponential backoff
      if (!poolResult.success && attempt < MAX_AGENT_RETRIES) {
        const delay = RETRY_BACKOFF_MS * Math.pow(2, attempt - 1);
        setTimeout(() => {
          // P0-2: Stale state check before retry
          if (instance.status !== "running") return;
          this.executeWithRetry(runId, callId, opts, instance, node, attempt + 1);
        }, delay);
        return;
      }

      // Cache the result for potential pause/resume
      instance.callCache.set(callId, result);

      // Send result back to worker
      this.postMessage(runId, { type: "agent-result", callId, result, cached: false });

      // Update trace node
      const traceNode = instance.trace.find((n) => n.stepIndex === callId);
      if (traceNode) {
        traceNode.status = poolResult.success ? "completed" : "failed";
        traceNode.result = result;
        traceNode.completedAt = new Date().toISOString();
        appendTraceNode(this.pi, runId, traceNode);
      }

      // Accumulate budget
      if (poolResult.usage) {
        instance.budget.usedTokens += poolResult.usage.input + poolResult.usage.output;
        instance.budget.usedCost += poolResult.usage.cost;
      }

      // Enforce budget limits
      this.checkBudget(runId);

      this.persistState();
      this.onTraceUpdate?.(runId);
    });
  }

  /**
   * Handle a Worker thread uncaught error.
   */
  private handleWorkerError(runId: string, err: Error): void {
    const instance = this.instances.get(runId);
    if (!instance || isTerminal(instance.status)) return;

    this.workers.delete(runId);
    instance.error = err.message;
    // P1-5: Mark failed — error event may not be followed by exit event
    instance.completedAt = new Date().toISOString();
    transitionStatus(instance, "failed");
    this.persistState();
  }

  /**
   * Handle Worker thread exit.
   */
  private handleWorkerExit(runId: string, code: number): void {
    const instance = this.instances.get(runId);
    if (!instance) return;

    this.workers.delete(runId);

    // Paused/terminal exits are intentional — skip failure marking
    if (instance.status === "paused" || isTerminal(instance.status)) return;

    // Non-zero exit without explicit error message → mark as failed
    if (code !== 0 && !instance.error) {
      instance.error = `Worker exited with code ${code}`;
      instance.completedAt = new Date().toISOString();
      transitionStatus(instance, "failed");
      this.persistState();
    }
  }

  /**
   * Handle a workflow script-level error (type: "error" from worker).
   * Retries with exponential backoff up to MAX_WORKER_RETRIES.
   */
  private handleScriptError(runId: string, errorMsg: string): void {
    const instance = this.instances.get(runId);
    if (!instance || isTerminal(instance.status)) return;

    const attempt = (this.retryCounts.get(runId) ?? 0) + 1;
    this.retryCounts.set(runId, attempt);

    if (attempt <= MAX_WORKER_RETRIES) {
      this.terminateWorker(runId);

      const delay = RETRY_BACKOFF_MS * Math.pow(2, attempt - 1);
      setTimeout(() => {
        // P0-3: Stale state check before restart
        if (instance.status !== "running") return;
        const meta = this.runMetaMap.get(runId);
        if (meta && instance) {
          this.startWorker(runId, instance, meta.scriptSource, meta.args);
        }
      }, delay);
    } else {
      instance.error = `Workflow failed after ${MAX_WORKER_RETRIES} retries: ${errorMsg}`;
      instance.completedAt = new Date().toISOString();
      transitionStatus(instance, "failed");
      this.terminateWorker(runId);
      this.persistState();
    }
  }

  // ── Budget enforcement ──────────────────────────────────────

  /**
   * Check token and cost budgets. If exceeded, send a budget-warning
   * to the Worker, terminate it, and mark the instance as
   * budget_limited (terminal).
   */
  private checkBudget(runId: string): void {
    const instance = this.instances.get(runId);
    if (!instance || isTerminal(instance.status)) return;

    const b = instance.budget;
    let exceeded = false;
    let reason = "";

    if (b.maxTokens !== undefined && b.usedTokens >= b.maxTokens) {
      exceeded = true;
      reason = `Token budget exceeded: ${b.usedTokens} >= ${b.maxTokens}`;
    } else if (b.maxCost !== undefined && b.usedCost >= b.maxCost) {
      exceeded = true;
      reason = `Cost budget exceeded: ${b.usedCost} >= ${b.maxCost}`;
    }

    // Send warning at 90% threshold (only once)
    if (!exceeded && !b._budgetWarningSent && b.maxTokens !== undefined && b.usedTokens >= b.maxTokens * 0.9) {
      b._budgetWarningSent = true;
      this.postMessage(runId, {
        type: "budget-warning",
        budget: b,
        reason: `Token budget warning: ${b.usedTokens} >= ${Math.floor(b.maxTokens * 0.9)} (90%)`,
      });
    }

    if (exceeded) {
      this.postMessage(runId, { type: "budget-warning", budget: b, reason });
      this.terminateWorker(runId);

      instance.error = reason;
      instance.completedAt = new Date().toISOString();
      transitionStatus(instance, "budget_limited");
      this.persistState();
    }
  }

  /**
   * Schedule a one-shot time budget check. Fires after maxTimeMs
   * and marks the instance as time_limited if still running.
   */
  private scheduleTimeBudgetCheck(runId: string, maxTimeMs: number): void {
    const timer = setTimeout(() => {
      const instance = this.instances.get(runId);
      if (!instance || isTerminal(instance.status) || instance.status !== "running") return;
      if (!instance.startedAt) return;

      const elapsed = Date.now() - new Date(instance.startedAt).getTime();
      if (elapsed >= maxTimeMs) {
        this.postMessage(runId, {
          type: "budget-warning",
          budget: instance.budget,
          reason: `Time budget exceeded: ${elapsed}ms >= ${maxTimeMs}ms`,
        });
        this.terminateWorker(runId);

        instance.error = `Time budget exceeded: ${elapsed}ms >= ${maxTimeMs}ms`;
        instance.completedAt = new Date().toISOString();
        transitionStatus(instance, "time_limited");
        this.persistState();
      }
    }, maxTimeMs);
    timer.unref();
  }

  // ── Persistence ─────────────────────────────────────────────

  /**
   * Flush the current state to session JSONL via pi.appendEntry.
   *
   * GC strategy: this method only appends entries. Deduplication and
   * pruning happen naturally in reconstructState (index.ts), which reads
   * all workflow-state entries but only keeps the last valid snapshot per
   * runId. Old entries accumulate in the JSONL but are ignored on rehydrate.
   */
  persistState(): void {
    this.pi.appendEntry("workflow-state", serializeState(this.instances));
  }
}
