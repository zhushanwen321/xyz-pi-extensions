/**
 * Workflow Extension — Agent Pool
 *
 * Concurrent agent call orchestrator. Manages a pool of pi --mode json
 * subprocesses with bounded concurrency. Each call spawns an isolated pi
 * process, reads structured JSONL responses from stdout, and returns the
 * aggregated result.
 *
 * Pool lifecycle:
 *   1. enqueue() adds a call to the FIFO queue
 *   2. drain() pulls from queue when active < concurrency limit
 *   3. run() spawns pi, collects JSONL, settles promise
 *   4. On completion, drain() fires again for any waiting calls
 *
 * Session isolation: each AgentPool instance is scoped to its creator.
 * Create one instance per session to avoid cross-session state leakage.
 */

import { randomUUID } from "node:crypto";

import { buildArgs, resolveInvocation, runPiProcess } from "./pi-runner.js";
import { makeEmptyPipeline } from "./jsonl-parser.js";

import type { WorkflowBudget, ToolCallEntry } from "../domain/state.js";

// ── Public types ──────────────────────────────────────────────

export interface AgentCallOpts {
  /** The task prompt to send to the agent. */
  prompt: string;
  /**
   * Optional JSON schema for structured output.
   * When provided, the schema is passed via PI_WORKFLOW_SCHEMA env to the subprocess,
   * which activates the structured-output tool + turn_end hook.
   * The tool's execute() validates model output against the schema.
   * On success, `parsedOutput` on the result is set to `tool_execution_end.result.details`
   * (the validated, parsed data object — not the raw tool call args).
   */
  schema?: Record<string, unknown>;
  /** Model to use (e.g. "router-openai/glm-5.1").
   *   When omitted, pi's default model is used.
   */
  model?: string;
  /** Scene name for model-switch advisor recommendation. */
  scene?: string;
  /** Wall-clock timeout in milliseconds. When > 0, aborts the subprocess
   *   if it runs longer than this, regardless of external signal. */
  timeoutMs?: number;
  /** Skill name to load (e.g. "code-review"). Resolved to SKILL.md path
   *  and injected via --skill flag in the subprocess. */
  skill?: string;
  /** Resolved absolute path to the skill directory or SKILL.md file.
   *  Set by agent-opts-resolver when opts.skill is present. */
  skillPath?: string;
  /** Human-readable description for logging and debugging. */
  description?: string;
  /** Agent name to resolve from AgentRegistry. When set, the resolved
   *  agent's systemPrompt is injected via --append-system-prompt. */
  agent?: string;
  /** Absolute paths to temp files containing system prompt injections.
   *  Set by the orchestrator: agent systemPrompt + schema injection files.
   *  buildArgs() injects each via --append-system-prompt. */
  systemPromptFiles?: string[];
  /** Schema JSON for PI_WORKFLOW_SCHEMA env var.
   *  Set by agent-opts-resolver when opts.schema is present.
   *  agent-pool passes it as env var to activate structured-output tool + hook. */
  schemaEnv?: string;
}

export interface AgentResult {
  /** Unique identifier for this call. */
  callId: string;
  /** Raw text output from the agent. */
  output: string;
  /**
   * Parsed structured output.
   * Present when `schema` was provided and the output was valid JSON.
   */
  parsedOutput?: unknown;
  /** Token and cost usage accumulated across all assistant turns. */
  usage?: AgentUsage;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** True when the pi process exited with code 0. */
  success: boolean;
  /** Error description on failure. Undefined on success. */
  error?: string;
  /**
   * Pi session ID for the subagent process (uuidv7).
   * Present when pi emits a session header (default in --mode json).
   * Can be used to locate the session JSONL file for post-run inspection.
   */
  sessionId?: string;
  /** All tool calls collected from JSONL stream (FR-7). */
  toolCalls: ToolCallEntry[];
}

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

// ── Private types ─────────────────────────────────────────────

interface QueueEntry {
  opts: AgentCallOpts;
  resolve: (result: AgentResult) => void;
  callId: string;
  startedAt: number;
  /** P1-2: Abort signal — propagates to the pi subprocess so it can be killed. */
  signal?: AbortSignal;
}

// ── Constants ─────────────────────────────────────────────────

export const SOFT_MAX_AGENTS_WARNING = 500;
const DEFAULT_CONCURRENCY = 4;
const UUID_SLICE_LENGTH = 8;

export interface AgentPoolOptions {
  maxConcurrency?: number;
  /** Workflow name for soft-limit warning context */
  runName?: string;
  /** Called once when totalCallCount first exceeds SOFT_MAX_AGENTS_WARNING */
  onSoftLimitReached?: (info: {
    runName: string;
    totalCalls: number;
    budget: WorkflowBudget;
  }) => void;
}

// ── AgentPool ─────────────────────────────────────────────────

export class AgentPool {
  private readonly maxConcurrency: number;
  private readonly queue: QueueEntry[] = [];
  private readonly onSoftLimitReached?: (
    info: { runName: string; totalCalls: number; budget: WorkflowBudget },
  ) => void;
  private readonly runName: string;
  private active = 0;
  private totalCallCount = 0;
  private softWarningSent = false;
  private budgetRef?: WorkflowBudget;

  constructor(opts: AgentPoolOptions | number = {}) {
    if (typeof opts === "number") {
      this.maxConcurrency = opts;
      this.onSoftLimitReached = undefined;
      this.runName = "unknown";
    } else {
      this.maxConcurrency = opts.maxConcurrency ?? DEFAULT_CONCURRENCY;
      this.onSoftLimitReached = opts.onSoftLimitReached;
      this.runName = opts.runName ?? "unknown";
    }
  }

  /** Bind a budget object for soft-limit warning reporting. */
  setBudget(budget: WorkflowBudget): void {
    this.budgetRef = budget;
  }

  /** Number of currently in-flight agent calls. */
  get activeCount(): number {
    return this.active;
  }

  /** Number of pending calls waiting to be dispatched. */
  get queueLength(): number {
    return this.queue.length;
  }

  /**
   * Enqueue an agent call. The call is dispatched when a pool slot
   * becomes available (active < concurrency limit).
   *
   * The returned promise resolves with the AgentResult on both success
   * and failure — never rejects. Error details are carried in the
   * `error` and `success` fields of the result.
   */
  enqueue(opts: AgentCallOpts, signal?: AbortSignal): Promise<AgentResult> {
    return new Promise<AgentResult>((resolve) => {
      const callId = `agent-${randomUUID().slice(0, UUID_SLICE_LENGTH)}`;
      const entry: QueueEntry = { opts, resolve, callId, startedAt: Date.now(), signal };
      this.queue.push(entry);

      if (signal) {
        if (signal.aborted) {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) this.queue.splice(idx, 1);
          resolve({
            callId,
            output: "",
            durationMs: Date.now() - entry.startedAt,
            success: false,
            error: "Operation aborted before start",
            toolCalls: [],
          });
          return;
        }
        const onAbort = () => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
            resolve({
              callId,
              output: "",
              durationMs: Date.now() - entry.startedAt,
              success: false,
              error: "Operation aborted while queued",
              toolCalls: [],
            });
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.drain();
    });
  }

  /** Dispatch pending calls up to the concurrency limit. */
  private drain(): void {
    while (this.active < this.maxConcurrency && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      this.active++;
      this.run(entry).finally(() => {
        this.active--;
        this.drain();
      });
    }
  }

  /** Run a single agent call and settle the promise with the result. */
  private async run(entry: QueueEntry): Promise<void> {
    const { opts, resolve, callId, startedAt, signal } = entry;

    try {
      this.totalCallCount++;
      if (this.budgetRef) this.maybeEmitSoftWarning(this.budgetRef);

      const args = buildArgs(opts);
      const { command, args: cmdArgs } = resolveInvocation(args);

      const rawEnv: Record<string, string | undefined> = { ...process.env };
      if (opts.schemaEnv) {
        rawEnv.PI_WORKFLOW_SCHEMA = opts.schemaEnv;
      }
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawEnv)) {
        if (v !== undefined) env[k] = v;
      }

      const pipeline = makeEmptyPipeline();
      let stderr = "";
      let exitCode: number;

      // Rebuild a combined AbortController so wall-clock timeoutMs
      // (per-call) and the external pool/orchestrator signal are both
      // honored. Without this, agent({timeoutMs:5000}) silently does
      // nothing — see review round 1 must-fix #2.
      const controller = new AbortController();
      const onExternalAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) {
          controller.abort();
        } else {
          signal.addEventListener("abort", onExternalAbort, { once: true });
        }
      }
      const timeoutTimer =
        opts.timeoutMs && opts.timeoutMs > 0
          ? setTimeout(() => controller.abort(), opts.timeoutMs)
          : undefined;
      if (timeoutTimer) timeoutTimer.unref();

      try {
        const result = await runPiProcess(
          command,
          cmdArgs,
          pipeline,
          controller.signal,
          env,
        );
        exitCode = result.exitCode;
        stderr = result.stderr;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        resolve({
          callId,
          output: "",
          durationMs: Date.now() - startedAt,
          success: false,
          error: message,
          toolCalls: [],
        });
        return;
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        // 正常完成时必须摘除外部 signal 的 abort listener，否则随 agent 调用数线性泄漏
        // （signal 生命周期长于单次 run，持久的 listener 引用会阻止 controller GC）。
        // abort 路径因 { once: true } 已自动移除，这里覆盖正常完成路径。
        if (signal && !signal.aborted) {
          signal.removeEventListener("abort", onExternalAbort);
        }
      }

      const durationMs = Date.now() - startedAt;

      if (opts.schema && pipeline.parsedOutput === undefined) {
        if (!pipeline.hasToolCall) {
          resolve({
            callId,
            output: pipeline.output,
            durationMs: Date.now() - startedAt,
            success: false,
            error: "Agent did not call structured-output tool",
            toolCalls: pipeline.toolCalls,
          });
          return;
        }
        if (exitCode === 0) {
          resolve({
            callId,
            output: pipeline.output,
            durationMs,
            success: false,
            error: "Agent completed without calling structured-output tool",
            toolCalls: pipeline.toolCalls,
          });
          return;
        }
      }

      resolve({
        callId,
        output: pipeline.output,
        parsedOutput: pipeline.parsedOutput,
        usage: pipeline.usage.turns > 0 ? pipeline.usage : undefined,
        durationMs,
        success: exitCode === 0,
        error: exitCode === 0 ? undefined : (stderr || `Exit code ${exitCode}`),
        sessionId: pipeline.sessionId,
        toolCalls: pipeline.toolCalls,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        callId,
        output: "",
        durationMs: Date.now() - startedAt,
        success: false,
        error: message,
        toolCalls: [],
      });
    }
  }

  /**
   * Emit the soft-limit warning once when totalCallCount exceeds
   * SOFT_MAX_AGENTS_WARNING. Errors in the callback are swallowed.
   */
  private maybeEmitSoftWarning(budget: WorkflowBudget): void {
    if (
      this.totalCallCount > SOFT_MAX_AGENTS_WARNING &&
      !this.softWarningSent
    ) {
      this.softWarningSent = true;
      try {
        this.onSoftLimitReached?.({
          runName: this.runName,
          totalCalls: this.totalCallCount,
          budget,
        });
      // eslint-disable-next-line taste/no-silent-catch
      } catch {
        // callback errors must not affect dispatch
      }
    }
  }
}
