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
    '// Module-scope helpers: accessible to BOTH the IIFE body AND the outer',
    '// .then()/.catch() handlers (which run outside the IIFE). _workerLogs/',
    '// _pushWorkerLog/_safePost + the parentPort/workerData handles must all live',
    '// here — a previous version declared _safePost inside the IIFE, so the',
    '// .then()/.catch() return/error handlers threw ReferenceError: _safePost is',
    '// not defined, crashing the Worker on EVERY script return (exit code 1) and',
    '// losing all diagnostics. require() is cached, so destructuring once at module',
    '// load and reusing everywhere avoids the redundant require calls that used to',
    '// appear in the IIFE and the outer .then/.catch.',
    'const { parentPort: _parentPort, workerData: _workerData } = require("node:worker_threads");',
    'const _workerLogs = [];',
    'function _pushWorkerLog(level, args) {',
    '  try { _workerLogs.push({ level, message: args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ") }); } catch (e) { /* swallow */ }',
    '}',
    '// ── safePostMessage wrapper: 统一 postMessage 防御（DataCloneError 等）──',
    '// Module-scope so the outer .then/.catch return/error handlers can use it.',
    '// context 取值约定（诊断标识）：固定为消息类型字面量——',
    '// "agent-call" / "workflow-call" / "return" / "error"，调用方据此在日志里',
    '// 一眼定位是哪类 postMessage 失败。新增调用点必须传对应 context。',
    'function _safePost(msg, context) {',
    '  try { _parentPort.postMessage(msg); return true; }',
    '  catch (e) {',
    '    const errMsg = e && e.message ? e.message : String(e);',
    '    const stack = e && e.stack ? e.stack : "";',
    '    _pushWorkerLog("error", ["[postMessage failed:" + context + "]", errMsg, stack]);',
    '    return false;',
    '  }',
    '}',
    '(async () => {',
    '  const parentPort = _parentPort;',
    '  const workerData = _workerData;',
    '',
    '  if (!parentPort) {',
    '    throw new Error("Workflow worker: parentPort is null — not running in a Worker thread");',
    '  }',
    '',
    '  // ── Intercept console.* to avoid leaking worker diagnostics into the input area ──',
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
    '        // 不丢失。失败 resolve 为空字符串是既定容错策略。',
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
      '    if (!_safePost({ type: "agent-call", callId, opts, phase: _effectivePhase }, "agent-call")) {',
    '      return Promise.reject(new Error("postMessage failed for agent-call (callId=" + callId + "): see workerLogs"));',
    '    }',
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
    //
    // **Promise 项处理**：CC-compatible 写法 `parallel([agent({...}), ...])` 传入的是已实例化
    // 的 Promise 数组（agent() 同步返回 Promise）。Promise 是 object 但无 .then 鸭辨分支时
    // 会落到 `agent(c)` 把 Promise 当 opts 传 → postMessage DataCloneError。必须在函数/opts
    // 分支前用 thenable 鸭辨直接返回 in-flight Promise，让 allSettled 接管。
    '  async function parallel(calls) {',
    '    if (typeof calls === "function") { return calls(); }',
    '    const settled = await Promise.allSettled(calls.map((c) => {',
    '      if (c && typeof c.then === "function") { return c; }',
    '      if (typeof c === "function") { return c(); }',
    '      if (typeof c === "object" && c !== null && (c.task || c.agent)) { return agent(c); }',
    '      return agent(c);',
    '    }));',
    '    return settled.map((r) => {',
    '      if (r.status === "fulfilled") {',
    '        const v = r.value;',
    '        if (v !== null && typeof v === "object" && !Array.isArray(v)) {',
    '          // 主线程 fallback（postAgentResult/postResult serialization failed）回发的对象含 error 字段',
    '          // → 归一化为 failed 形状，与脚本侧 r.status === "failed" 检查统一',
    '          if (typeof v.error === "string" && v.error.length > 0) return { status: "failed", error: v.error };',
    '          return v;',
    '        }',
    '        return { status: "failed", error: "agent returned non-object result (type=" + typeof v + ")" };',
    '      }',
    '      const reason = r.reason;',
    '      const errMsg = reason instanceof Error ? reason.message : String(reason);',
    '      return { status: "failed", error: errMsg };',
    '    });',
    '  }',
    '',
 // ── pipeline global ──
    '  async function pipeline(firstArg, ...restStages) {',
    '    // Single-arg mode: pipeline([stage1, stage2, ...])',
    '    if (Array.isArray(firstArg) && restStages.length === 0) {',
    '      let result;',
    '      for (let i = 0; i < firstArg.length; i++) {',
    '        try { result = await firstArg[i](result); }',
    '        catch (e) {',
    '          const msg = e && e.message ? e.message : String(e);',
    '          _pushWorkerLog("error", ["[pipeline stage " + i + " failed]", msg]);',
    '          throw e;',
    '        }',
    '      }',
    '      return result;',
    '    }',
    '    // Cartesian product mode: pipeline([items], stage1, stage2, ...)',
    '    if (Array.isArray(firstArg) && restStages.length > 0 && typeof restStages[0] === "function") {',
    '      const results = [];',
    '      for (let idx = 0; idx < firstArg.length; idx++) {',
    '        const item = firstArg[idx];',
    '        let val = item;',
    '        let failed = false;',
    '        for (const stage of restStages) {',
    '          if (failed) break;',
    '          try { val = await stage(val); }',
    '          catch (e) {',
    '          const msg = e && e.message ? e.message : String(e);',
    '          _pushWorkerLog("error", ["[pipeline cartesian stage failed for item " + (idx + 1) + "]", msg]);',
    '          val = null; failed = true;',
    '          }',
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
    '    if (!_safePost({ type: "workflow-call", callId, name, args: workflowArgs }, "workflow-call")) {',
    '      return Promise.reject(new Error("postMessage failed for workflow-call (name=" + name + "): see workerLogs"));',
    '    }',
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
    '  const runId = (_workerData.args && typeof _workerData.args === "object" && _workerData.args._runId) || "";',
    '  _safePost({ type: "return", runId, result, workerLogs: _workerLogs }, "return");',
    '}).catch((err) => {',
    '  const runId = (_workerData.args && typeof _workerData.args === "object" && _workerData.args._runId) || "";',
    '  _safePost({ type: "error", runId, error: err.message || String(err), workerLogs: _workerLogs }, "error");',
    '});',
  ].join("\n");
}
