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
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";

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
  /**
   * Model to use (e.g. "router-openai/glm-5.1").
   * When omitted, pi's default model is used.
   */
  model?: string;
  /** Human-readable description for logging and debugging. */
  description?: string;
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
}

interface ParsedPipelineEvent {
  output: string;
  usage: AgentUsage;
  model?: string;
  stopReason?: string;
}

// ── Constants ─────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 4;

// ── AgentPool ─────────────────────────────────────────────────

export class AgentPool {
  private readonly maxConcurrency: number;
  private readonly queue: QueueEntry[] = [];
  private active = 0;

  constructor(maxConcurrency = DEFAULT_CONCURRENCY) {
    this.maxConcurrency = maxConcurrency;
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
  enqueue(opts: AgentCallOpts): Promise<AgentResult> {
    return new Promise<AgentResult>((resolve) => {
      const callId = `agent-${randomUUID().slice(0, 8)}`;
      const entry: QueueEntry = { opts, resolve, callId, startedAt: Date.now() };
      this.queue.push(entry);
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
    const { opts, resolve, callId, startedAt } = entry;

    try {
      const result = await this.spawnAndParse(opts, callId, startedAt);
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
   * Build pi CLI arguments from call options.
   * Always uses --mode json --print --no-session for one-shot execution.
   */
  private buildArgs(opts: AgentCallOpts): string[] {
    const args: string[] = ["--mode", "json", "-p", "--no-session"];

    if (opts.model) {
      args.push("--model", opts.model);
    }

    // Build the prompt: if schema is provided, instruct the model to
    // output valid JSON matching the schema, then append the prompt.
    let prompt = opts.prompt;
    if (opts.schema) {
      const schemaJson = JSON.stringify(opts.schema, null, 2);
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
  ): Promise<AgentResult> {
    const args = this.buildArgs(opts);
    const { command, args: cmdArgs } = this.resolveInvocation(args);

    const pipeline = makeEmptyPipeline();
    let stderr = "";
    let exitCode: number;

    try {
      const result = await runPiProcess(command, cmdArgs, pipeline);
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
    const success = exitCode === 0;

    let parsedOutput: unknown | undefined;
    if (pipeline.output.trim() && opts.schema) {
      try {
        parsedOutput = JSON.parse(pipeline.output);
      } catch {
        // Output is not valid JSON — leave parsedOutput undefined
      }
    }

    return {
      callId,
      output: pipeline.output,
      parsedOutput,
      usage: pipeline.usage.turns > 0 ? pipeline.usage : undefined,
      durationMs,
      success,
      error: success ? undefined : (stderr || `Exit code ${exitCode}`),
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
 */
async function runPiProcess(
  command: string,
  cmdArgs: string[],
  pipeline: ParsedPipelineEvent,
): Promise<{ exitCode: number; stderr: string }> {
  let stderr = "";
  const exitCode = await new Promise<number>((resolve, reject) => {
    const proc = spawn(command, cmdArgs, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";

    function processChunk(chunk: string): void {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          processJsonlEvent(event, pipeline);
        } catch {
          // Skip malformed JSON lines
        }
      }
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
        } catch {
          // Ignore trailing garbage
        }
      }
      resolve(code ?? 0);
    });

    proc.on("error", (err: Error) => {
      stderr += err.message;
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
        pipeline.usage.cost += u.cost ?? 0;
        pipeline.usage.contextTokens = u.totalTokens ?? u.contextTokens ?? 0;
        pipeline.usage.turns++;
      }

      if (typeof msg.model === "string") pipeline.model = msg.model;
      if (typeof msg.stopReason === "string") pipeline.stopReason = msg.stopReason;
    }
  }
}
