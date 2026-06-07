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

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { AgentRegistry } from "./agent-discovery.js";
import { type AgentCallOpts,AgentPool } from "./agent-pool.js";
import { getWorkflow } from "./config-loader.js";
import { appendTraceNode } from "./execution-trace.js";
import { resolveModel } from "./model-resolver.js";
import {
  type AgentResult as StateAgentResult,
  createInstance as createStateInstance,
  type ExecutionTraceNode,
  isTerminal,
  serializeInstance,
  transitionStatus,
  type WorkflowBudget,
  type WorkflowInstance,
  type WorkflowStatus,
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
  /** P1-2: Abort signal from the tool execute caller — propagated to AgentPool
   *  and used to pause the workflow if triggered. */
  signal?: AbortSignal;
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
const RUNID_RADIX = 36;
const RUNID_SLICE_START = 2;
const RUNID_SLICE_LENGTH = 8;
const PROMPT_PREVIEW_LENGTH = 200;
const EXPONENTIAL_BACKOFF_BASE = 2;
const BUDGET_WARNING_THRESHOLD = 0.9;

// P1-5: Stale context detection — matches patterns reported when
// pi's session context was compacted or canceled between agent calls.
const STALE_CONTEXT_PATTERNS = ["stale context", "stalecontext", "context canceled", "aborted"];

/** Check if an error message indicates a stale/canceled pi session context. */
function isStaleContextErrorMsg(msg: string | undefined): boolean {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return STALE_CONTEXT_PATTERNS.some((p) => lower.includes(p));
}

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
  private readonly pi: ExtensionAPI;
  private readonly ctx: ExtensionContext;
  private readonly sessionDir: string;
  /** Called after every trace node state change for live TUI updates */
  onTraceUpdate?: (runId: string) => void;
  /** Called when a workflow reaches a terminal state (completed/failed/aborted/budget_limited/time_limited) */
  onCompletion?: (runId: string) => void;

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

  /** Clean up a temp file created for agent system prompt. */
  private cleanupTempFile(filePath: string): void {
    try {
      fs.unlinkSync(filePath);
    // eslint-disable-next-line taste/no-silent-catch
    } catch {
      // File may already be deleted or never created
    }
    this.activeTempFiles.delete(filePath);
  }

  /** Clean up all remaining active temp files (e.g. on abort/error). */
  cleanupAllTempFiles(): void {
    for (const filePath of this.activeTempFiles) {
      try {
        fs.unlinkSync(filePath);
      // eslint-disable-next-line taste/no-silent-catch
      } catch {
        // File may already be deleted or never created
      }
    }
    this.activeTempFiles.clear();
  }

  /**
   * Start a workflow. Reads the workflow script file via config-loader,
   * builds a Worker thread with injected globals, and returns a runId
   * for subsequent lifecycle operations.
   *
   * The optional `signal` is propagated to the AgentPool so that the
   * underlying pi subprocess can be killed when the caller aborts.
   * If the signal is already aborted, no work is started.
   */
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
    const runId = `wf-${Date.now()}-${Math.random().toString(RUNID_RADIX).slice(RUNID_SLICE_START, RUNID_SLICE_LENGTH)}`;

    const instance = createStateInstance({
      runId,
      name,
      worker: workflow.path,
      status: "running",
      budget: { maxTokens: budgetTokens, maxTimeMs: budgetTimeMs },
    });
    instance.startedAt = new Date().toISOString();

    // Create per-workflow AgentPool with soft-limit warning callback
    // Each workflow run gets its own pool so agent call counts are isolated per AC-4.5
    const pool = new AgentPool({
      maxConcurrency: 4,
      runName: instance.name,
      onSoftLimitReached: ({ runName, totalCalls, budget }) => {
        (this.pi as unknown as { sendUserMessage: (msg: string) => void }).sendUserMessage(
          `[workflow:${runName}] Reached ${totalCalls} agent calls. ` +
          `Budget: ${budget.usedTokens}/${budget.maxTokens ?? "unlimited"} tokens. ` +
          `Consider aborting if this is unintended.`,
        );
      },
    });
    pool.setBudget(instance.budget);
    this.runPools.set(runId, pool);

    this.runMetaMap.set(runId, { scriptSource, args, budgetTokens, budgetTimeMs, signal });
    this.instances.set(runId, instance);
    await this.persistState();

    // P1-2: Listen for abort — pause the workflow so it can be resumed
    if (signal) {
      const onAbort = () => {
        const inst = this.instances.get(runId);
        if (inst && inst.status === "running") {
          inst.pausedAt = new Date().toISOString();
          try {
            transitionStatus(inst, "paused");
          // eslint-disable-next-line taste/no-silent-catch
          } catch {
            // State machine refused — leave as-is
          }
          this.terminateWorker(runId);
          void this.persistState();
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

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
    this.terminateWorker(runId);
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
    this.terminateWorker(runId);
    this.cleanupAllTempFiles();
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
      this.startWorker(runId, instance, meta.scriptSource, meta.args);
    }

    await this.persistState();
  }

  /**
   * Skip a specific agent call. Injects a placeholder into the
   * callCache so that on resume/retry the call resolves immediately.
   * If the worker is actively running and a pending call exists for
   * this callId, sends the cached result directly.
   */
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
      catch (err) {
        // P1-8: Worker may have exited between has() and postMessage().
        // This is an expected race condition — no recovery needed.
        console.warn(`skipNode: failed to post message for ${runId}:`, err);
      }
    }

    await this.persistState();
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
      this.handleWorkerExit(runId, code, worker);
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
      worker.terminate().catch(() => { console.warn(`Failed to terminate worker for ${runId}`); });
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
  private async handleWorkerMessage(runId: string, raw: unknown): Promise<void> {
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
        // FR-1: Capture script return value
        instance.scriptResult = msg.result;
        instance.completedAt = new Date().toISOString();
        transitionStatus(instance, "completed");
        this.workers.delete(runId);
        await this.persistState();
        this.onTraceUpdate?.(runId);
        this.onCompletion?.(runId);
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
  private async handleAgentCall(
    runId: string,
    instance: WorkflowInstance,
    callId: number,
    opts: AgentCallOpts,
  ): Promise<void> {
    // Cache hit — respond immediately
    const cached = instance.callCache.get(callId);
    if (cached) {
      this.postMessage(runId, { type: "agent-result", callId, result: cached, cached: true });
      return;
    }

    // Agent resolution: resolve agent name to systemPrompt file
    let enrichedOpts = opts;
    if (opts.agent) {
      const discovered = this.agentRegistry.resolve(opts.agent);
      if (!discovered) {
        const errorResult: StateAgentResult = {
          content: "",
          error: `Agent not found: ${opts.agent}`,
        };
        instance.callCache.set(callId, errorResult);
        this.postMessage(runId, { type: "agent-result", callId, result: errorResult, cached: false });
        return;
      }

      let tmpFile: string;
      try {
        // Write systemPrompt to temp file
        const tmpDir = path.join(os.tmpdir(), "pi-workflow");
        fs.mkdirSync(tmpDir, { recursive: true });
        tmpFile = path.join(tmpDir, `agent-prompt-${randomUUID()}.md`);
        fs.writeFileSync(tmpFile, discovered.systemPrompt, "utf-8");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const errorResult: StateAgentResult = {
          content: "",
          error: `Temp file write error: ${msg}`,
        };
        instance.callCache.set(callId, errorResult);
        this.postMessage(runId, { type: "agent-result", callId, result: errorResult, cached: false });
        return;
      }
      this.activeTempFiles.add(tmpFile);

      // Merge: opts.model overrides discovered.model
      const agentModel = opts.model || discovered.model;
      enrichedOpts = { ...opts, model: agentModel, systemPromptFile: tmpFile };
    }

    // Resolve model from scene if needed
    const resolvedModel = resolveModel(enrichedOpts);
    if (resolvedModel) {
      enrichedOpts = { ...enrichedOpts, model: resolvedModel };
    }

    // Record pending trace node
    const now = new Date().toISOString();
    const node: ExecutionTraceNode = {
      stepIndex: callId,
      agent: opts.description ?? "unknown",
      task: opts.prompt.slice(0, PROMPT_PREVIEW_LENGTH),
      model: enrichedOpts.model ?? "default",
      status: "running",
      startedAt: now,
    };
    instance.trace.push(node);
    appendTraceNode(this.pi, runId, node);
    this.onTraceUpdate?.(runId);

    // Enqueue via per-run AgentPool with retry
    this.executeWithRetry(runId, callId, enrichedOpts, instance, node);
  }

  /**
   * Execute an agent call with retry logic. Retries up to MAX_AGENT_RETRIES
   * on failure with exponential backoff (1s, 2s, 4s).
   */
  private async executeWithRetry(
    runId: string,
    callId: number,
    opts: AgentCallOpts,
    instance: WorkflowInstance,
    node: ExecutionTraceNode,
    attempt = 1,
  ): Promise<void> {
    const pool = this.runPools.get(runId);
    if (!pool) {
      // Pool already cleaned up (workflow terminated) — skip
      return;
    }
    // P1-2: Propagate abort signal to AgentPool so the pi subprocess can be killed
    const meta = this.runMetaMap.get(runId);
    pool.enqueue(opts, meta?.signal).then(async (poolResult) => {
      // P0-2: Stale state check — instance may have been paused/aborted during agent call
      if (instance.status !== "running") return;

      // P1-5: Stale context detection — do not retry when pi's session context
      // is stale (e.g. after compact). Retrying the same call would just fail again.
      if (!poolResult.success && isStaleContextErrorMsg(poolResult.error)) {
        // Mark trace node as failed and surface to worker
        const traceNode = instance.trace.find((n) => n.stepIndex === callId);
        if (traceNode) {
          traceNode.status = "failed";
          traceNode.result = {
            content: poolResult.output,
            parsedOutput: poolResult.parsedOutput,
            usage: poolResult.usage,
            durationMs: poolResult.durationMs,
            error: poolResult.error,
          };
          traceNode.completedAt = new Date().toISOString();
          appendTraceNode(this.pi, runId, traceNode);
        }
        this.postMessage(runId, {
          type: "agent-result",
          callId,
          result: {
            content: poolResult.output,
            usage: poolResult.usage,
            error: poolResult.error,
          },
          cached: false,
        });
        await this.persistState();
        this.onTraceUpdate?.(runId);

        // Cleanup temp file on stale context early return
        if (opts.systemPromptFile) {
          this.cleanupTempFile(opts.systemPromptFile);
        }
        return;
      }

      const result: StateAgentResult = {
        content: poolResult.output,
        parsedOutput: poolResult.parsedOutput,
        usage: poolResult.usage,
        durationMs: poolResult.durationMs,
        error: poolResult.success ? undefined : poolResult.error,
      };

      // Retry on failure with exponential backoff
      if (!poolResult.success && attempt < MAX_AGENT_RETRIES) {
        const delay = RETRY_BACKOFF_MS * Math.pow(EXPONENTIAL_BACKOFF_BASE, attempt - 1);
        setTimeout(() => {
          // P0-2: Stale state check before retry
          if (instance.status !== "running") return;
          // P1-2: Skip retry if caller aborted
          if (meta?.signal?.aborted) return;
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
      await this.checkBudget(runId);

      await this.persistState();
      this.onTraceUpdate?.(runId);

      // Cleanup temp file if it was created for agent system prompt
      if (opts.systemPromptFile) {
        this.cleanupTempFile(opts.systemPromptFile);
      }
    });
  }

  /**
   * Handle a Worker thread uncaught error.
   */
  private async handleWorkerError(runId: string, err: Error): Promise<void> {
    const instance = this.instances.get(runId);
    if (!instance || isTerminal(instance.status)) return;

    this.workers.delete(runId);
    instance.error = err.message;
    // P1-5: Mark failed — error event may not be followed by exit event
    instance.completedAt = new Date().toISOString();
    transitionStatus(instance, "failed");
    this.cleanupAllTempFiles();
    await this.persistState();
    this.onCompletion?.(runId);
  }

  /**
   * Handle Worker thread exit.
   */
  private async handleWorkerExit(runId: string, code: number, exitedWorker: Worker): Promise<void> {
    const instance = this.instances.get(runId);
    if (!instance) return;

    // Guard: only process exit if the exited worker is still the current one.
    // Prevents race: terminateWorker(old) → startWorker(new) → old exit fires →
    // would delete new worker and incorrectly mark instance as failed.
    const currentWorker = this.workers.get(runId);
    if (currentWorker !== exitedWorker) return;
    this.workers.delete(runId);

    // Paused/terminal exits are intentional — skip failure marking
    if (instance.status === "paused" || isTerminal(instance.status)) return;

    // Non-zero exit without explicit error message → mark as failed
    if (code !== 0 && !instance.error) {
      instance.error = `Worker exited with code ${code}`;
      instance.completedAt = new Date().toISOString();
      transitionStatus(instance, "failed");
      await this.persistState();
      this.onCompletion?.(runId);
    }
  }

  /**
   * Handle a workflow script-level error (type: "error" from worker).
   * Retries with exponential backoff up to MAX_WORKER_RETRIES.
   */
  private async handleScriptError(runId: string, errorMsg: string): Promise<void> {
    const instance = this.instances.get(runId);
    if (!instance || isTerminal(instance.status)) return;

    const attempt = (this.retryCounts.get(runId) ?? 0) + 1;
    this.retryCounts.set(runId, attempt);

    if (attempt <= MAX_WORKER_RETRIES) {
      this.terminateWorker(runId);

      const delay = RETRY_BACKOFF_MS * Math.pow(EXPONENTIAL_BACKOFF_BASE, attempt - 1);
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
      await this.persistState();
      this.onCompletion?.(runId);
    }
  }

  // ── Budget enforcement ──────────────────────────────────────

  /**
   * Check token and cost budgets. If exceeded, send a budget-warning
   * to the Worker, terminate it, and mark the instance as
   * budget_limited (terminal).
   */
  private async checkBudget(runId: string): Promise<void> {
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
    if (!exceeded && !b._budgetWarningSent && b.maxTokens !== undefined && b.usedTokens >= b.maxTokens * BUDGET_WARNING_THRESHOLD) {
      b._budgetWarningSent = true;
      this.postMessage(runId, {
        type: "budget-warning",
        budget: b,
        reason: `Token budget warning: ${b.usedTokens} >= ${Math.floor(b.maxTokens * BUDGET_WARNING_THRESHOLD)} (90%)`,
      });
    }

    if (exceeded) {
      this.postMessage(runId, { type: "budget-warning", budget: b, reason });
      this.terminateWorker(runId);

      instance.error = reason;
      instance.completedAt = new Date().toISOString();
      transitionStatus(instance, "budget_limited");
      await this.persistState();
      this.onCompletion?.(runId);
    }
  }

  /**
   * Schedule a one-shot time budget check. Fires after maxTimeMs
   * and marks the instance as time_limited if still running.
   */
  private scheduleTimeBudgetCheck(runId: string, maxTimeMs: number): void {
    const timer = setTimeout(async () => {
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
        await this.persistState();
        this.onCompletion?.(runId);
      }
    }, maxTimeMs);
    timer.unref();
  }

  // ── Persistence ─────────────────────────────────────────────

  /**
   * Flush the current state to external JSONL files + pointer entries.
   *
   * For each instance: writes a JSONL file under <sessionDir>/workflow-state/<runId>.jsonl
   * and appends a workflow-state-link pointer entry via pi.appendEntry.
   */
  async persistState(): Promise<void> {
    for (const instance of this.instances.values()) {
      const filePath = path.join(this.sessionDir, "workflow-state", `${instance.runId}.jsonl`);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.appendFile(
        filePath,
        JSON.stringify(serializeInstance(instance)) + "\n",
        "utf8",
      );
      this.pi.appendEntry("workflow-state-link", {
        runId: instance.runId,
        path: filePath,
        updatedAt: new Date().toISOString(),
      });
    }
  }
}
