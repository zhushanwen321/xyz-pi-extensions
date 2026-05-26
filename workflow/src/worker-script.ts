/**
 * Workflow Extension — Worker Script Builder
 *
 * Generates the source text for a Worker thread that runs a workflow script
 * with injected global functions: agent(), parallel(), pipeline(), phase(), log().
 *
 * Compatible with Claude Code Workflow script format:
 *   - agent(promptString)
 *   - agent(promptString, { label?, schema?, model? })
 *   - agent({ prompt, schema?, model?, description? })
 *   - parallel([agent(...), ...]) or parallel([{ task, agent }, ...])
 *   - pipeline([stageFn, ...])
 *   - phase(name), log(msg)
 *   - $ARGS, $WORKSPACE, $BUDGET
 *   - module.exports = { meta, execute } auto-invocation
 *
 * The generated source is passed to new Worker(code, { eval: true, workerData })
 * and runs in an isolated Worker thread context.
 *
 * Communication Protocol:
 *   Worker → Main (postMessage):
 *     { type: "agent-call", callId: number, opts: AgentCallOpts }
 *     { type: "return", runId: string, result: unknown }
 *     { type: "error", runId: string, error: string }
 *     { type: "log", phase: string, message: string }
 *
 *   Main → Worker (parentPort.on("message")):
 *     { type: "agent-result", callId: number, result: AgentResult, cached: boolean }
 *     { type: "budget-warning", budget: unknown }
 *     { type: "abort", reason: string }
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
 * with infrastructure code and injected global functions.
 */
export function buildWorkerScript(userScript: string): string {
  return [
    '"use strict";',
    '(async () => {',
    '  const { parentPort, workerData } = require("node:worker_threads");',
    '',
    '  if (!parentPort) {',
    '    throw new Error("Workflow worker: parentPort is null — not running in a Worker thread");',
    '  }',
    '',
    '  // ── Intercept console.log to avoid TUI status line overlap ──',
    '  const _origLog = console.log;',
    '  console.log = function (...args) {',
    '    _origLog(...args);',
    '    _origLog("");',
    '    _origLog("");',
    '  };',
    '',
    '  // ── Internal state ──',
    '  let _callIdCounter = 0;',
    '  let _agentCallCount = 0;',
    '  const _pendingCalls = new Map();',
    '  const _callCache = workerData.callCache instanceof Map',
    '    ? workerData.callCache',
    '    : new Map(Object.entries(workerData.callCache || {}).map(([k, v]) => [Number(k), v]));',
    '',
    '  // ── Injected globals ──',
    '  const $ARGS = (workerData.args && typeof workerData.args === "object") ? workerData.args : {};',
    '  const $WORKSPACE = typeof workerData.workspace === "string" ? workerData.workspace : "";',
    '  const $BUDGET = (workerData.budget && typeof workerData.budget === "object") ? workerData.budget : {};',
    '',
    '  // ── WorkflowAbortedError ──',
    '  class WorkflowAbortedError extends Error {',
    '    constructor(reason) {',
    '      super("Workflow aborted: " + (reason || "No reason"));',
    '      this.name = "WorkflowAbortedError";',
    '      this.reason = reason || "";',
    '    }',
    '  }',
    '',
    '  // ── Message handler (main thread → worker) ──',
    '  parentPort.on("message", (msg) => {',
    '    if (msg.type === "agent-result") {',
    '      const pending = _pendingCalls.get(msg.callId);',
    '      if (pending) {',
    '        _pendingCalls.delete(msg.callId);',
    '        if (typeof msg.result !== "undefined") {',
    '          _callCache.set(msg.callId, msg.result);',
    '        }',
    '        if (msg.result && msg.result.error) {',
    '          pending.reject(new Error(msg.result.error));',
    '        } else if (msg.result && typeof msg.result === "object") {',
    '          pending.resolve(msg.result.parsedOutput ?? msg.result.content);',
    '        } else {',
    '          pending.resolve(msg.result);',
    '        }',
    '      }',
    '    } else if (msg.type === "abort") {',
    '      const err = new WorkflowAbortedError(msg.reason);',
    '      _pendingCalls.forEach((p) => { p.reject(err); });',
    '      _pendingCalls.clear();',
    '    }',
    '    // "budget-warning" is informational; no required handling',
    '  });',
    '',
    // ── phase() global ──
    '  let _currentPhase = "";',
    '  function phase(name) { _currentPhase = String(name); }',
    '',
    // ── log() global ──
    '  function log(msg) {',
    '    try { parentPort.postMessage({ type: "log", phase: _currentPhase, message: String(msg) }); } catch(e) { /* swallow */ }',
    '  }',
    '',
    // ── agent() global — CC-compatible multi-signature ──
    '  async function agent(firstArg, secondArg) {',
    '    let opts;',
    '    if (typeof firstArg === "string") {',
    '      opts = {',
    '        prompt: firstArg,',
    '        description: (secondArg && typeof secondArg === "object" && secondArg.label) || undefined,',
    '        schema: (secondArg && typeof secondArg === "object" && secondArg.schema) || undefined,',
    '        model: (secondArg && typeof secondArg === "object" && secondArg.model) || undefined,',
    '      };',
    '    } else if (typeof firstArg === "object" && firstArg !== null) {',
    '      if (firstArg.prompt) {',
    '        opts = firstArg;',
    '      } else if (firstArg.task || firstArg.agent) {',
    '        opts = {',
    '          prompt: firstArg.task || firstArg.prompt || "",',
    '          description: firstArg.label || firstArg.description || firstArg.agent,',
    '          schema: firstArg.schema,',
    '          model: firstArg.model,',
    '        };',
    '      } else {',
    '        opts = firstArg;',
    '      }',
    '    } else {',
    '      throw new Error("agent() requires a prompt string or options object as first argument");',
    '    }',
    '',
    '    _callIdCounter++;',
    '    _agentCallCount++;',
    '    const callId = _callIdCounter;',
    '',
    '    if (_callCache.has(callId)) {',
    '      const cached = _callCache.get(callId);',
    '      if (cached && cached.error) { throw new Error(cached.error); }',
    '      return cached.parsedOutput ?? cached.content;',
    '    }',
    '',
    '    parentPort.postMessage({ type: "agent-call", callId, opts });',
    '    return new Promise((resolve, reject) => {',
    '      _pendingCalls.set(callId, { resolve, reject });',
    '    });',
    '  }',
    '',
    // ── parallel() global — CC-compatible ──
    '  async function parallel(calls) {',
    '    if (typeof calls === "function") { return calls(); }',
    '    return Promise.all(calls.map((c) => agent(c)));',
    '  }',
    '',
    // ── pipeline() global ──
    '  async function pipeline(stages) {',
    '    let result;',
    '    for (let i = 0; i < stages.length; i++) {',
    '      result = await stages[i](result);',
    '    }',
    '    return result;',
    '  }',
    '',
    '  // ── User workflow script ──',
    '  ' + userScript,
    '',
    '  // ── Auto-invoke execute() for module.exports pattern ──',
    '  if (typeof module !== "undefined" && module.exports && typeof module.exports.execute === "function") {',
    '    return await module.exports.execute({ agent, parallel, pipeline, phase, log, $ARGS, $WORKSPACE, $BUDGET });',
    '  }',
    '})().then((result) => {',
    '  const { parentPort, workerData } = require("node:worker_threads");',
    '  const runId = (workerData.args && typeof workerData.args === "object" && workerData.args._runId) || "";',
    '  parentPort.postMessage({ type: "return", runId, result });',
    '}).catch((err) => {',
    '  const { parentPort, workerData } = require("node:worker_threads");',
    '  const runId = (workerData.args && typeof workerData.args === "object" && workerData.args._runId) || "";',
    '  parentPort.postMessage({ type: "error", runId, error: err.message || String(err) });',
    '});',
  ].join('\n');
}
