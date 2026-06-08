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

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

import type { WorkflowBudget } from "./state.js";

// ── Public types ──────────────────────────────────────────────

export interface AgentCallOpts {
  /** The task prompt to send to the agent. */
  prompt: string;
  /**
   * Optional JSON schema for structured output.
   * When provided, the schema is appended to the prompt as an instruction
   * and the resulting output is parsed as JSON (via `JSON.parse`) into
   * `parsedOutput` on the result.
   */
  schema?: Record<string, unknown>;
  /** Model to use (e.g. "router-openai/glm-5.1").
   *   When omitted, pi's default model is used.
   */
  model?: string;
  /** Scene name for model-switch advisor recommendation. */
  scene?: string;
  /** Human-readable description for logging and debugging. */
  description?: string;
  /** Agent name to resolve from AgentRegistry. When set, the resolved
   *  agent's systemPrompt is injected via --append-system-prompt. */
  agent?: string;
  /** Absolute path to a temp file containing the agent's systemPrompt.
   *  Set by the orchestrator after resolving the agent name. Used by
   *  buildArgs() to inject --append-system-prompt. */
  systemPromptFile?: string;
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

interface ParsedPipelineEvent {
  output: string;
  usage: AgentUsage;
  model?: string;
  stopReason?: string;
  /** Structured output extracted from tool_execution_start event. */
  parsedOutput?: unknown;
  /** Whether any tool_execution_start event was seen (for schema failure detection). */
  hasToolCall?: boolean;
}

// ── Constants ─────────────────────────────────────────────────

export const SOFT_MAX_AGENTS_WARNING = 500;
const DEFAULT_CONCURRENCY = 4;
// 24-hour safety net — prevents zombie pi subprocesses if all other
// cleanup paths (abort signal, budget enforcement) fail.
// Business-level timeouts are handled by orchestrator's budget enforcement.
const ONE_DAY_MS = 86_400_000;
const PROCESS_TIMEOUT_MS = ONE_DAY_MS;
const UUID_SLICE_LENGTH = 8;
const JSON_INDENT = 2;
const TIMEOUT_DISPLAY_DIVISOR = 1000;

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
   *
   * The optional `signal` (P1-2) is propagated to the pi subprocess:
   *   - Pre-aborted signal: rejected synchronously with success=false.
   *   - Abort during queue: removed from queue, returns aborted result.
   *   - Abort during run: subprocess receives SIGKILL via runPiProcess.
   */
  enqueue(opts: AgentCallOpts, signal?: AbortSignal): Promise<AgentResult> {
    return new Promise<AgentResult>((resolve) => {
      const callId = `agent-${randomUUID().slice(0, UUID_SLICE_LENGTH)}`;
      const entry: QueueEntry = { opts, resolve, callId, startedAt: Date.now(), signal };
      this.queue.push(entry);

      // P1-2: If a signal is provided, honor pre-abort and register abort listener
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
          });
          return;
        }
        const onAbort = () => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            // Still queued — remove and resolve with abort
            this.queue.splice(idx, 1);
            resolve({
              callId,
              output: "",
              durationMs: Date.now() - entry.startedAt,
              success: false,
              error: "Operation aborted while queued",
            });
          }
          // If already running, runPiProcess owns the abort handling
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
      // Real spawn — increment counter and check soft limit
      this.totalCallCount++;
      if (this.budgetRef) this.maybeEmitSoftWarning(this.budgetRef);

      const result = await this.spawnAndParse(opts, callId, startedAt, signal);
      resolve(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        callId,
        output: "",
        durationMs: Date.now() - startedAt,
        success: false,
        error: message,
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

  /**
   * Build pi CLI arguments from call options.
   * Always uses --mode json --print --no-session for one-shot execution.
   */
  private buildArgs(opts: AgentCallOpts): string[] {
    const args: string[] = ["--mode", "json", "-p", "--no-session"];

    if (opts.model) {
      args.push("--model", opts.model);
    }

    // Inject agent system prompt if resolved
    if (opts.systemPromptFile) {
      args.push("--append-system-prompt", opts.systemPromptFile);
    }

    // Build the prompt: if schema is provided, instruct the model to
    // output valid JSON matching the schema, then append the prompt.
    let prompt = opts.prompt;
    if (opts.schema) {
      const schemaJson = JSON.stringify(opts.schema, null, JSON_INDENT);
      prompt = [
        `You MUST respond with ONLY a valid JSON object conforming to this JSON schema:`,
        ``,
        schemaJson,
        ``,
        `Do not include any text before or after the JSON object.`,
        `---`,
        prompt,
      ].join("\n");
    }

    args.push(prompt);
    return args;
  }

  /**
   * Resolve the pi binary invocation.
   * Prefers the current Node.js process + argv[1] (running as an extension),
   * falling back to "pi" on PATH.
   */
  private resolveInvocation(extraArgs: string[]): { command: string; args: string[] } {
    const currentScript = process.argv[1];
    if (currentScript && fs.existsSync(currentScript)) {
      return { command: process.execPath, args: [currentScript, ...extraArgs] };
    }
    return { command: "pi", args: extraArgs };
  }

  /**
   * Spawn a pi --mode json process, stream-parse JSONL lines from stdout,
   * accumulate usage and output, and return an AgentResult.
   *
   * Never throws — errors are captured in the AgentResult fields.
   */
  private async spawnAndParse(
    opts: AgentCallOpts,
    callId: string,
    startedAt: number,
    signal?: AbortSignal,
  ): Promise<AgentResult> {
    const args = this.buildArgs(opts);
    const { command, args: cmdArgs } = this.resolveInvocation(args);

    const pipeline = makeEmptyPipeline();
    let stderr = "";
    let exitCode: number;

    // Inject schema via environment variable for structured-output extension
    const env: Record<string, string | undefined> = { ...process.env };
    if (opts.schema) {
      env.STRUCTURED_OUTPUT_SCHEMA = JSON.stringify(opts.schema);
    }

    try {
      const result = await runPiProcess(command, cmdArgs, pipeline, signal, env);
      exitCode = result.exitCode;
      stderr = result.stderr;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        callId,
        output: "",
        durationMs: Date.now() - startedAt,
        success: false,
        error: message,
      };
    }

    const durationMs = Date.now() - startedAt;

    // Schema requested but no structured-output tool call AND no other tool call.
    // If the agent called any other tool (read/bash/etc), we skip this block —
    // the agent is doing useful work and will likely call structured-output in a
    // subsequent turn (enforced by the extension's turn_end hook).
    if (opts.schema && pipeline.parsedOutput === undefined && !pipeline.hasToolCall) {
      // Transitional fallback: if structured-output extension is not installed
      // (e.g. older agent images), try parsing text output as JSON.
      // TODO: remove this fallback once structured-output is universally adopted.
      const trimmed = pipeline.output.trim();
      if (trimmed) {
        try {
          pipeline.parsedOutput = JSON.parse(trimmed);
        } catch {
          // Not valid JSON — return failure
          return {
            callId,
            output: pipeline.output,
            durationMs,
            success: false,
            error: "Agent did not produce structured output (tool call missing or failed)",
          };
        }
      } else {
        return {
          callId,
          output: pipeline.output,
          durationMs,
          success: false,
          error: "Agent did not produce structured output (tool call missing or failed)",
        };
      }
    }

    return {
      callId,
      output: pipeline.output,
      parsedOutput: pipeline.parsedOutput,
      usage: pipeline.usage.turns > 0 ? pipeline.usage : undefined,
      durationMs,
      success: exitCode === 0,
      error: exitCode === 0 ? undefined : (stderr || `Exit code ${exitCode}`),
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────



function makeEmptyPipeline(): ParsedPipelineEvent {
  return {
    output: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };
}

/**
 * Spawn a pi --mode json process and stream-parse JSONL from stdout.
 * Returns the exit code and any stderr output.
 * The `pipeline` accumulator is mutated in place as lines arrive.
 *
 * P1-2: When `signal` is provided, the subprocess receives SIGKILL on
 * abort. The exit code 1 is returned with an explanatory stderr message.
 */
async function runPiProcess(
  command: string,
  cmdArgs: string[],
  pipeline: ParsedPipelineEvent,
  signal?: AbortSignal,
  env?: Record<string, string | undefined>,
): Promise<{ exitCode: number; stderr: string }> {
  let stderr = "";
  const exitCode = await new Promise<number>((resolve, reject) => {
    const proc = spawn(command, cmdArgs, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: env ?? process.env,
    });
    let buffer = "";
    let settled = false;
    let aborted = false;

    function processChunk(chunk: string): void {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          processJsonlEvent(event, pipeline);
        // eslint-disable-next-line taste/no-silent-catch
        } catch {
          // Skip malformed JSON lines
        }
      }
    }

    function settle(code: number): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortHandler) signal?.removeEventListener("abort", abortHandler);
      resolve(code);
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stderr += `Process timed out after ${PROCESS_TIMEOUT_MS / TIMEOUT_DISPLAY_DIVISOR}s, sending SIGKILL`;
      proc.kill("SIGKILL");
      resolve(1);
    }, PROCESS_TIMEOUT_MS);
    timer.unref();

    // P1-2: Wire abort signal to SIGKILL the subprocess
    const abortHandler = signal
      ? () => {
          if (settled) return;
          aborted = true;
          stderr += "Operation aborted, sending SIGKILL";
          proc.kill("SIGKILL");
        }
      : undefined;
    if (abortHandler && !signal?.aborted) {
      signal!.addEventListener("abort", abortHandler, { once: true });
    } else if (signal?.aborted) {
      // Already aborted — resolve quickly without spawning
      settled = true;
      clearTimeout(timer);
      stderr += "Operation aborted before start";
      resolve(1);
      proc.kill("SIGKILL");
      return;
    }

    proc.stdout.on("data", (data: Buffer) => {
      processChunk(data.toString());
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      // Flush remaining buffer on EOF
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer) as Record<string, unknown>;
          processJsonlEvent(event, pipeline);
        // eslint-disable-next-line taste/no-silent-catch
        } catch {
          // Ignore trailing garbage
        }
      }
      // P1-2: Normalize exit code for abort so caller can detect it
      settle(aborted ? 1 : (code ?? 0));
    });

    proc.on("error", (err: Error) => {
      stderr += err.message;
      clearTimeout(timer);
      if (abortHandler) signal?.removeEventListener("abort", abortHandler);
      reject(err);
    });
  });

  return { exitCode, stderr };
}

// ── JSONL line processor ──────────────────────────────────────

/**
 * Process a single JSONL event from pi --mode json stdout.
 * Mutates `pipeline` in place with O(1) memory overhead per event.
 */
function processJsonlEvent(event: Record<string, unknown>, pipeline: ParsedPipelineEvent): void {
  if (event.type === "tool_execution_start") {
    if (event.toolName === "structured-output") {
      pipeline.parsedOutput = event.args;
    }
    pipeline.hasToolCall = true;
    return;
  }

  if (event.type === "message_end" && event.message) {
    const msg = event.message as Record<string, unknown>;
    if (msg.role === "assistant") {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "text") {
            const text = (part as Record<string, unknown>).text;
            if (typeof text === "string") {
              pipeline.output += text;
            }
          }
        }
      }

      const u = msg.usage as Record<string, number> | undefined;
      if (u) {
        pipeline.usage.input += u.input ?? 0;
        pipeline.usage.output += u.output ?? 0;
        pipeline.usage.cacheRead += u.cacheRead ?? 0;
        pipeline.usage.cacheWrite += u.cacheWrite ?? 0;
        pipeline.usage.cost += Number(u.cost) || 0;
        pipeline.usage.contextTokens = u.totalTokens ?? u.contextTokens ?? 0;
        pipeline.usage.turns++;
      }

      if (typeof msg.model === "string") pipeline.model = msg.model;
      if (typeof msg.stopReason === "string") pipeline.stopReason = msg.stopReason;
    }
  }
}
