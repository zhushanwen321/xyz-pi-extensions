/**
 * Workflow Extension — Pi Runner
 *
 * Manages pi --mode json subprocess lifecycle:
 * - buildArgs: construct CLI arguments from AgentCallOpts
 * - resolveInvocation: locate pi binary (current process or PATH)
 * - runPiProcess: spawn, stream-parse JSONL, return exit code
 *
 * Depends on jsonl-parser for JSONL event parsing.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";

import type { AgentCallOpts } from "../engine/models/types.js";
import type { ParsedPipelineEvent } from "./jsonl-parser.js";
import { processJsonlEvent } from "./jsonl-parser.js";

// ── Constants ─────────────────────────────────────────────────

// 24-hour safety net — prevents zombie pi subprocesses if all other
// cleanup paths (abort signal, budget enforcement) fail.
// Business-level timeouts are handled by Engine budget enforcement.
export const PROCESS_TIMEOUT_MS = 86_400_000;
export const TIMEOUT_DISPLAY_DIVISOR = 1000;

// ── Arg builder ───────────────────────────────────────────────

/**
 * Build pi CLI arguments from call options.
 * Always uses --mode json --print for one-shot execution.
 */
export function buildArgs(opts: AgentCallOpts): string[] {
  const args: string[] = ["--mode", "json", "-p"];

  if (opts.model) {
    args.push("--model", opts.model);
  }

 // Inject system prompt files (agent systemPrompt + schema injection)
  if (opts.systemPromptFiles) {
    for (const fp of opts.systemPromptFiles) {
      args.push("--append-system-prompt", fp);
    }
  }

 // Inject skill via --skill flag
  if (opts.skillPath) {
    args.push("--skill", opts.skillPath);
  }

  const prompt = opts.prompt;

  args.push(prompt);
  return args;
}

/**
 * Resolve the pi binary invocation.
 * Prefers the current Node.js process + argv[1] (running as an extension),
 * falling back to "pi" on PATH.
 */
export function resolveInvocation(extraArgs: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...extraArgs] };
  }
  return { command: "pi", args: extraArgs };
}

// ── Process runner ────────────────────────────────────────────

/**
 * Spawn a pi --mode json process and stream-parse JSONL from stdout.
 * Returns the exit code and any stderr output.
 * The `pipeline` accumulator is mutated in place as lines arrive.
 *
 * P1-2: When `signal` is provided, the subprocess receives SIGKILL on
 * abort. The exit code 1 is returned with an explanatory stderr message.
 */
export async function runPiProcess(
  command: string,
  cmdArgs: string[],
  pipeline: ParsedPipelineEvent,
  signal?: AbortSignal,
  env?: Record<string, string>,
  onEvent?: (raw: Record<string, unknown>) => void,
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
          // 实时回调：把原始 JSONL 事件（即 SDK session.subscribe 事件）吐给调用方，
          // 供其更新 live record 驱动 TUI 进度展示。与 processJsonlEvent 并行旁路（各取所需）。
          onEvent?.(event);
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
          onEvent?.(event);
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
