/**
 * Workflow Extension — Worker Script Builder
 *
 * Generates the source text for a Worker thread that runs a workflow script
 * with injected global functions: agent(), parallel(), pipeline(), phase(), log().
 *
 * Compatible with Claude Code Workflow script format:
 *   - agent(promptString)
 *   - agent(promptString, { label?, schema?, model?, scene? })
 *   - agent({ prompt, schema?, model?, scene?, description? })
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

import type { AgentResult } from "../domain/state.js";

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

export type WorkerLogEntry = { level: "log" | "warn" | "error" | "info"; message: string };

export type WorkerInMsg =
  | { type: "agent-call"; callId: number; opts: { prompt: string; schema?: unknown; model?: string; scene?: string; description?: string; agent?: string }; phase?: string }
  | { type: "return"; runId: string; result: unknown; workerLogs?: WorkerLogEntry[] }
  | { type: "error"; runId: string; error: string; workerLogs?: WorkerLogEntry[] };

// ── Build worker source ─────────────────────────────────────

/**
 * Build the complete worker source text by wrapping the user's workflow script
 * with infrastructure code and injected global functions.
 */
export function buildWorkerScript(userScript: string): string {
  return [
    '"use strict";',
    '// Module-scope: accessible to the outer .catch() for surfacing logs on errors.',
    'const _workerLogs = [];',
    'function _pushWorkerLog(level, args) {',
    '  try { _workerLogs.push({ level, message: args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ") }); } catch (e) { /* swallow */ }',
    '}',
    '(async () => {',
    '  const { parentPort, workerData } = require("node:worker_threads");',
    '',
    '  if (!parentPort) {',
    '    throw new Error("Workflow worker: parentPort is null — not running in a Worker thread");',
    '  }',
    '',
    '  // ── Intercept console.* to avoid leaking worker diagnostics into the input area ──',
    '  // _workerLogs + _pushWorkerLog are declared at module scope (above the IIFE)',
    '  // so the outer .catch() can include them on script errors.',
    '  console.log = function (...args) { _pushWorkerLog("log", args); };',
    '  console.warn = function (...args) { _pushWorkerLog("warn", args); };',
    '  console.error = function (...args) { _pushWorkerLog("error", args); };',
    '  console.info = function (...args) { _pushWorkerLog("info", args); };',
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
    '  const $ARGS = (workerData.args && typeof workerData.args === "object") ? workerData.args : {};\n' +
    '  const args = $ARGS;',
    '  const $WORKSPACE = typeof workerData.workspace === "string" ? workerData.workspace : "";',
    '  const _budgetData = {',
    '    total: (workerData.budget && workerData.budget.maxTokens) || 0,',
    '    _spentTokens: (workerData.budget && workerData.budget.usedTokens) ?? 0,',
    '    _spentCost: (workerData.budget && workerData.budget.usedCost) ?? 0,',
    '  };',
    '  const $BUDGET = {',
    '    get total() { return _budgetData.total; },',
    '    spent() { return _budgetData._spentTokens; },',
    '    remaining() { return Math.max(0, _budgetData.total - _budgetData._spentTokens); },',
    '  };',
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
    '        } else {',
    '          // parsedOutput: validated data object from structured-output execute().',
    '          // Fallback to content (raw text) when no schema was requested.',
    '          pending.resolve(msg.result.parsedOutput ?? msg.result.content);',
    '        }',
    '      }',
    '    } else if (msg.type === "abort") {',
    '      const err = new WorkflowAbortedError(msg.reason);',
    '      _pendingCalls.forEach((p) => { p.reject(err); });',
    '      _pendingCalls.clear();',
    '    } else if (msg.type === "budget-update" && msg.budget) {',
    '      _budgetData._spentTokens = msg.budget.usedTokens ?? _budgetData._spentTokens;',
    '      _budgetData._spentCost = msg.budget.usedCost ?? _budgetData._spentCost;',
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
    '        scene: (secondArg && typeof secondArg === "object" && secondArg.scene) || undefined,\n' +
    '        phase: (secondArg && typeof secondArg === "object" && secondArg.phase) || undefined,',
    '      };',
    '    } else if (typeof firstArg === "object" && firstArg !== null) {',
    '      if (firstArg.prompt) {',
    '        opts = firstArg;',
    '      } else if (firstArg.task || firstArg.agent) {',
    '        opts = {',
    '          prompt: firstArg.task || firstArg.prompt || "",',
    '          description: firstArg.label || firstArg.description,',
    '          agent: firstArg.agent,',
    '          schema: firstArg.schema,',
    '          model: firstArg.model,',
    '          scene: firstArg.scene,',
    '          timeoutMs: firstArg.timeoutMs,',
    '        };',
    '      } else {',
    '        opts = firstArg;',
    '      }',
    '    } else {',
    '      throw new Error("agent() requires a prompt string or options object as first argument");',
    '    }',
    '',
    '    // Validate known agent() fields to catch API misuse early',
    '    const _knownFields = new Set(["prompt", "description", "schema", "model", "scene", "label", "task", "agent", "phase", "skill", "timeoutMs"]);',
    '    const _unknownFields = Object.keys(opts).filter((k) => !_knownFields.has(k));',
    '    if (_unknownFields.length > 0) {',
    '      _pushWorkerLog("warn", ["[workflow] agent() received unknown fields: " + _unknownFields.join(", ") + ". Known fields: prompt, description, schema, model, scene, label, task, agent, phase, skill, timeoutMs"]);',
    '    }',
    '',
    '    const callId = _callIdCounter;',
    '    _callIdCounter++;',
    '    _agentCallCount++;',
    '    if (_callCache.has(callId)) {',
    '      const cached = _callCache.get(callId);',
    '      if (cached && cached.error) { throw new Error(cached.error); }',
    '      return cached.parsedOutput ?? cached.content;',
    '    }',
    '',
    '    const _effectivePhase = opts.phase || _currentPhase;\n' +
    '    delete opts.phase;\n' +
    '\n' +
    '    parentPort.postMessage({ type: "agent-call", callId, opts, phase: _effectivePhase });',
    '    return new Promise((resolve, reject) => {',
    '      _pendingCalls.set(callId, { resolve, reject });',
    '    });',
    '  }',
    '',
    // ── parallel() global — CC-compatible ──
    '  async function parallel(calls) {',
    '    if (typeof calls === "function") { return calls(); }',
    '    return Promise.all(calls.map((c) => {',
    '      if (typeof c === "function") { return c(); }',
    '      if (typeof c === "object" && c !== null && (c.task || c.agent)) { return agent(c); }',
    '      return agent(c);',
    '    }));',
    '  }',
    '',
    // ── pipeline() global ──
    '  async function pipeline(firstArg, ...restStages) {',
    '    // Single-arg mode: pipeline([stage1, stage2, ...])',
    '    if (Array.isArray(firstArg) && restStages.length === 0) {',
    '      let result;',
    '      for (const stage of firstArg) { result = await stage(result); }',
    '      return result;',
    '    }',
    '    // Cartesian product mode: pipeline([items], stage1, stage2, ...)',
    '    if (Array.isArray(firstArg) && restStages.length > 0 && typeof restStages[0] === "function") {',
    '      const results = [];',
    '      for (const item of firstArg) {',
    '        let val = item;',
    '        let failed = false;',
    '        for (const stage of restStages) {',
    '          if (failed) break;',
    '          try { val = await stage(val); }',
    '          catch (e) { val = null; failed = true; }',
    '        }',
    '        results.push(val);',
    '      }',
    '      return results;',
    '    }',
    '    throw new Error("pipeline() expects pipeline([stage1, ...]) or pipeline([items], stage1, ...)");',
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
    '  parentPort.postMessage({ type: "return", runId, result, workerLogs: _workerLogs });',
    '}).catch((err) => {',
    '  const { parentPort, workerData } = require("node:worker_threads");',
    '  const runId = (workerData.args && typeof workerData.args === "object" && workerData.args._runId) || "";',
    '  parentPort.postMessage({ type: "error", runId, error: err.message || String(err), workerLogs: _workerLogs });',
    '});',
  ].join('\n');
}
