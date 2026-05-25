/**
 * Workflow Extension — Worker Script Builder
 *
 * Generates the source text for a Worker thread that runs a workflow script
 * with three injected global functions: agent(), parallel(), and pipeline().
 *
 * The generated source is passed to new Worker(code, { eval: true, workerData })
 * and runs in an isolated Worker thread context.
 *
 * Communication Protocol:
 *   Worker → Main (postMessage):
 *     { type: "agent-call", callId: number, opts: AgentCallOpts }
 *     { type: "return", runId: string, result: unknown }
 *     { type: "error", runId: string, error: string }
 *
 *   Main → Worker (parentPort.on("message")):
 *     { type: "agent-result", callId: number, result: AgentResult, cached: boolean }
 *     { type: "budget-warning", budget: unknown }
 *     { type: "abort", reason: string }
 *
 * Injected Globals:
 *   agent(opts)     — Send agent-call to main thread, await response; replays from callCache
 *   parallel(calls) — Run multiple agent() calls concurrently via Promise.all
 *   pipeline(stages) — Execute stages sequentially, passing previous result as input
 */

import type { AgentResult } from "./state.js";

// ── Worker data shape (for main-thread consumption) ──────────

export interface WorkerScriptData {
  /** Path to the workflow script file. */
  scriptPath: string;
  /** Arguments passed to the workflow via $ARGS. */
  args: Record<string, unknown>;
  /** Pre-populated callCache for pause/resume replay. */
  callCache: Map<number, AgentResult>;
  /** Token/time budget constraints. */
  budget?: { usedTokens: number; usedCost: number; maxTokens?: number; maxTimeMs?: number };
  /** Absolute path to the project workspace root. */
  workspace: string;
  /** Workflow meta (name, description, phases). */
  meta: Record<string, unknown>;
}

// ── WorkerInMsg type (for main-thread consumption) ──────────

export type WorkerInMsg =
  | { type: "agent-call"; callId: number; opts: { prompt: string; schema?: unknown; model?: string; description?: string } }
  | { type: "return"; runId: string; result: unknown }
  | { type: "error"; runId: string; error: string };

// ── Build worker source ─────────────────────────────────────

/**
 * Build the complete worker source text by wrapping the user's workflow script
 * with infrastructure code and three injected global functions.
 *
 * The generated script:
 *   1. Extracts parentPort and workerData from worker_threads
 *   2. Injects $ARGS / $WORKSPACE / $BUDGET globals
 *   3. Sets up a message listener for agent-result / abort messages
 *   4. Defines agent(), parallel(), pipeline() as top-level async functions
 *   5. Embeds the user's workflow script at the end
 *
 * @param userScript  - The user's workflow script source to evaluate in the worker
 * @returns           - Complete source text for new Worker(code, { eval: true })
 */
export function buildWorkerScript(userScript: string): string {
  return [
    '"use strict";',
    'const { parentPort, workerData } = require("node:worker_threads");',
    "",
    "if (!parentPort) {",
    '  throw new Error("Workflow worker: parentPort is null — not running in a Worker thread");',
    "}",
    "",
    "// ── Internal state ──",
    "let _callIdCounter = 0;",
    "const _pendingCalls = new Map();",
    "const _callCache = workerData.callCache instanceof Map",
    "  ? workerData.callCache",
    '  : new Map(Object.entries(workerData.callCache || {}).map(([k, v]) => [Number(k), v]));',
    "",
    "// ── Injected globals ──",
    "const $ARGS = (workerData.args && typeof workerData.args === 'object') ? workerData.args : {};",
    "const $WORKSPACE = typeof workerData.workspace === 'string' ? workerData.workspace : '';",
    "const $BUDGET = (workerData.budget && typeof workerData.budget === 'object') ? workerData.budget : {};",
    "",
    "// ── WorkflowAbortedError ──",
    "class WorkflowAbortedError extends Error {",
    "  constructor(reason) {",
    '    super("Workflow aborted: " + (reason || "No reason"));',
    '    this.name = "WorkflowAbortedError";',
    "    this.reason = reason || \"\";",
    "  }",
    "}",
    "",
    "// ── Message handler (main thread → worker) ──",
    "parentPort.on(\"message\", (msg) => {",
    '  if (msg.type === "agent-result") {',
    "    const pending = _pendingCalls.get(msg.callId);",
    "    if (pending) {",
    "      _pendingCalls.delete(msg.callId);",
    "      if (typeof msg.result !== \"undefined\") {",
    "        _callCache.set(msg.callId, msg.result);",
    "      }",
    "      if (msg.result && msg.result.error) {",
    "        pending.reject(new Error(msg.result.error));",
    "      } else if (msg.result && typeof msg.result === \"object\") {",
    "        pending.resolve(msg.result.parsedOutput ?? msg.result.content);",
    "      } else {",
    "        pending.resolve(msg.result);",
    "      }",
    "    }",
    '  } else if (msg.type === "abort") {',
    "    const err = new WorkflowAbortedError(msg.reason);",
    "    _pendingCalls.forEach((p) => { p.reject(err); });",
    "    _pendingCalls.clear();",
    "  }",
    '  // "budget-warning" is informational; no required handling',
    "});",
    "",
    "// ── Global: agent ──",
    "async function agent(opts) {",
    "  _callIdCounter++;",
    "  const callId = _callIdCounter;",
    "",
    "  // Replay from callCache if this callId was completed before",
    "  if (_callCache.has(callId)) {",
    "    const cached = _callCache.get(callId);",
    "    if (cached && cached.error) {",
    "      throw new Error(cached.error);",
    "    }",
    "    return cached.parsedOutput ?? cached.content;",
    "  }",
    "",
    "  parentPort.postMessage({ type: \"agent-call\", callId, opts });",
    "",
    "  return new Promise((resolve, reject) => {",
    "    _pendingCalls.set(callId, { resolve, reject });",
    "  });",
    "}",
    "",
    "// ── Global: parallel ──",
    "async function parallel(calls) {",
    "  return Promise.all(calls.map((c) => agent(c)));",
    "}",
    "",
    "// ── Global: pipeline ──",
    "async function pipeline(stages) {",
    "  let result;",
    "  for (let i = 0; i < stages.length; i++) {",
    "    result = await stages[i](result);",
    "  }",
    "  return result;",
    "}",
    "",
    "// ── User workflow script ──",
    userScript,
  ].join("\n");
}
