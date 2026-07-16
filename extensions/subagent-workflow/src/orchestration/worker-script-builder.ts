/**
 * Workflow Extension — Worker Script Builder
 *
 * 生成运行 workflow 脚本的 Worker 线程源码字符串：注入全局函数
 * agent/parallel/pipeline/phase/log，并在 worker 内部处理
 * parentPort 消息循环（agent-call / agent-result / abort / budget-update）。
 *
 * 层归属：Infra（源码字符串生成，纯文本拼接，无 Pi 依赖）。
 *
 * 设计：
 * - WorkerLogEntry 类型来源 engine/models/types.js（不在本文件重复声明）。
 * - **AC-4 不变式**：buildWorkerScript 生成的脚本格式逐字保留——
 * 用户资产（workflow 脚本依赖 agent/parallel/pipeline/$ARGS/$BUDGET 等契约）。
 *
 * 兼容 Claude Code Workflow 脚本格式：
 * - agent(promptString) / agent(promptString, { label?, schema?, model?, scene? }) /
 * agent({ prompt, schema?, model?, scene?, description? })
 * - parallel([agent(...), ...]) 或 parallel([{ task, agent }, ...])
 * - pipeline([stageFn, ...])
 * - phase(name), log(msg)
 * - $ARGS, $WORKSPACE, $BUDGET
 * - module.exports = { meta, execute } 自动调用
 *
 * 生成的源码通过 `new Worker(code, { eval: true, workerData })` 在隔离的 Worker 线程运行。
 *
 * 通信协议（AC-4 契约，逐字保留）：
 * Worker → Main (postMessage):
 * { type: "agent-call", callId: number, opts: AgentCallOpts }
 * { type: "workflow-call", callId: number, name: string, args: Record<string, unknown> }
 * { type: "return", runId: string, result: unknown }
 * { type: "error", runId: string, error: string }
 * { type: "log", phase: string, message: string }
 *
 * Main → Worker (parentPort.on("message")):
 * { type: "agent-result", callId: number, result: AgentResult, cached: boolean }
 * { type: "workflow-result", callId: number, result: unknown }
 * { type: "budget-update", budget: unknown }
 * { type: "abort", reason: string }
 */

// ── Build worker source ─────────────────────────────────────

/**
 * Build the complete worker source text by wrapping the user's workflow script
 * with infrastructure code and injected global functions.
 *
 * AC-4：脚本格式不变（用户资产）。逐字保留旧 buildWorkerScript 的拼接逻辑。
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
    '        // 失败不传播到 agent 外部：resolve 而非 reject。',
    '        // 旧实现在 result.error 时 reject，单 agent 失败会冒到 worker 顶层 .catch()',
    '        // → 发 type:"error" → handleScriptError → rebuildRuntime → SIGKILL 同伴进程，',
    '        // 把单点失败放大成整批崩溃。改为始终 resolve（错误时回退到 content 文本），',
    '        // 让 parallel() 下的脚本容错循环（parseResult → null → skip）自然接管。',
    '        // 错误原因已由主线程 executeAgentCall → trace.update(result.error) 保留在 trace/TUI，',
    '        // 不丢失。skipNode 的 SKIP_PLACEHOLDER（无 error，resolve 为 ""）已确立此先例。',
    '        // parsedOutput: validated data object from structured-output execute().',
    '        // Fallback to content (raw text) when no schema was requested or on error.',
    '        pending.resolve(msg.result.parsedOutput ?? msg.result.content);',
    '      }',
    '    } else if (msg.type === "workflow-result") {',
    '      const pending = _pendingCalls.get(msg.callId);',
    '      if (pending) {',
    '        _pendingCalls.delete(msg.callId);',
    '        pending.resolve(msg.result);',
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
 // ── phase global ──
    '  let _currentPhase = "";',
    '  function phase(name) { _currentPhase = String(name); }',
    '',
 // ── log global ──
    '  function log(msg) {',
    '    try { parentPort.postMessage({ type: "log", phase: _currentPhase, message: String(msg) }); } catch(e) { /* swallow */ }',
    '  }',
    '',
 // ── agent global — CC-compatible multi-signature ──
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
    '          skill: firstArg.skill,',
    '          timeoutMs: firstArg.timeoutMs,',
    '          cwd: firstArg.cwd,',
    '        };',
    '      } else {',
    '        opts = firstArg;',
    '      }',
    '    } else {',
    '      throw new Error("agent() requires a prompt string or options object as first argument");',
    '    }',
    '',
    '    // Validate known agent() fields to catch API misuse early',
    '    const _knownFields = new Set(["prompt", "description", "schema", "model", "scene", "label", "task", "agent", "phase", "skill", "timeoutMs", "cwd"]);',
    '    const _unknownFields = Object.keys(opts).filter((k) => !_knownFields.has(k));',
    '    if (_unknownFields.length > 0) {',
    '      _pushWorkerLog("warn", ["[workflow] agent() received unknown fields: " + _unknownFields.join(", ") + ". Known fields: prompt, description, schema, model, scene, label, task, agent, phase, skill, timeoutMs, cwd"]);',
    '    }',
    '',
    '    const callId = _callIdCounter;',
    '    _callIdCounter++;',
    '    _agentCallCount++;',
    '    if (_callCache.has(callId)) {',
    '      const cached = _callCache.get(callId);',
    '      // 与 live handler 对齐：失败也 resolve（回退 content），不 throw。',
    '      // 见 agent-result 消息处理的注释：拒绝传播失败到 agent 外部。',
    '      return cached ? (cached.parsedOutput ?? cached.content) : undefined;',
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
 // ── parallel global — CC-compatible ──
    // allSettled 语义：单个 agent 的意外 reject（postMessage 失败等基础设施异常、abort）
    // 不拖垮整批。rejected 结果降级为错误消息字符串（与 agent() 的 error→content 回退一致，
    // parseResult(string) → null → 脚本 soft-fail）。B1 之后 agent() 不再因 agent 失败 reject，
    // 这里作为纵深防御保留。
    '  async function parallel(calls) {',
    '    if (typeof calls === "function") { return calls(); }',
    '    const settled = await Promise.allSettled(calls.map((c) => {',
    '      if (typeof c === "function") { return c(); }',
    '      if (typeof c === "object" && c !== null && (c.task || c.agent)) { return agent(c); }',
    '      return agent(c);',
    '    }));',
    '    return settled.map((r) => r.status === "fulfilled" ? r.value : (r.reason instanceof Error ? r.reason.message : String(r.reason)));',
    '  }',
    '',
 // ── pipeline global ──
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
    '  // ── workflow global — nested workflow invocation ──',
    '  async function workflow(name, args) {',
    '    if (typeof name !== "string" || name.length === 0) {',
    '      throw new Error("workflow() requires a workflow name string as first argument");',
    '    }',
    '    const workflowArgs = (typeof args === "object" && args !== null) ? args : {};',
    '    const callId = _callIdCounter;',
    '    _callIdCounter++;',
    '    parentPort.postMessage({ type: "workflow-call", callId, name, args: workflowArgs });',
    '    return new Promise((resolve, reject) => {',
    '      _pendingCalls.set(callId, { resolve, reject });',
    '    });',
    '  }',
    '',
    '  // ── User workflow script ──',
    '  ' + userScript,
    '',
    '  // ── Auto-invoke execute() for module.exports pattern ──',
    '  if (typeof module !== "undefined" && module.exports && typeof module.exports.execute === "function") {',
    '    return await module.exports.execute({ agent, parallel, pipeline, phase, log, workflow, $ARGS, $WORKSPACE, $BUDGET });',
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
  ].join("\n");
}
