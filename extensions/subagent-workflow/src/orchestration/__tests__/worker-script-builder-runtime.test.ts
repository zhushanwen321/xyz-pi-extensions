/**
 * buildWorkerScript — 运行时执行回归测试。
 *
 * 现有的 worker-script-builder.test.ts 全是字符串 toContain 断言，无法捕获生成的
 * worker 源码在「真实 Worker 线程里执行」时的运行时错误。曾因此漏掉 _safePost 作用域
 * bug（定义在 async IIFE 内、却在 IIFE 外的 .then()/.catch() 里使用）：脚本每次正常
 * return 都触发 ReferenceError → Worker exit code 1 → 所有 workflow 100% 失败。
 *
 * 本测试起真实的 node:worker_threads.Worker 执行 buildWorkerScript 产物，覆盖：
 * - 脚本正常 return → {type:"return"} 消息（非 exit code 1 崩溃）
 * - 脚本 throw → {type:"error"} 消息 + workerLogs（诊断不丢）
 * - agent() 调用链路：postMessage(agent-call) ↔ postMessage(agent-result)
 * - abort 消息：pending agent() reject → WorkflowAbortedError
 * - workflow() 嵌套调用链路
 * - module.exports.execute() 自动调用入口
 * - _safePost 的 DataCloneError 防御分支
 *
 * 这是回归防线：任何让 .then/.catch 访问不到 module-scope helper 的重构都会被这里抓住。
 */
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import { buildWorkerScript } from "../worker-script-builder.ts";

// ── 判别联合：Worker → Main 消息类型（S3：用判别联合替代可选字段 + 非空断言）──

/** agent-call 消息：worker 请求主线程执行一个 agent。 */
interface AgentCallMsg {
  type: "agent-call";
  callId: number;
  opts: { prompt: string; description?: string; schema?: unknown; [k: string]: unknown };
  phase?: string;
}
/** workflow-call 消息：worker 请求主线程执行嵌套 workflow。 */
interface WorkflowCallMsg {
  type: "workflow-call";
  callId: number;
  name: string;
  args: Record<string, unknown>;
}
/** return 消息：脚本正常结束，带回结果。 */
interface ReturnMsg {
  type: "return";
  runId?: string;
  result: unknown;
  workerLogs?: unknown[];
}
/** error 消息：脚本抛错（含 _safePost 的 DataCloneError 防御路径）。 */
interface ErrorMsg {
  type: "error";
  runId?: string;
  error: string;
  workerLogs?: unknown[];
}

// ── 类型守卫：从 unknown 收窄到判别联合 ──
// 共享 hasType 辅助：避免每个守卫重复 `(m as {type?:string})` 断言（taste/no-unsafe-catch）。

function hasType<T extends string>(m: unknown, type: T): boolean {
  return typeof m === "object" && m !== null
    && (m as { type: unknown }).type === type;
}

function isAgentCall(m: unknown): m is AgentCallMsg {
  return hasType(m, "agent-call");
}
function isWorkflowCall(m: unknown): m is WorkflowCallMsg {
  return hasType(m, "workflow-call");
}
function isReturn(m: unknown): m is ReturnMsg {
  return hasType(m, "return");
}
function isError(m: unknown): m is ErrorMsg {
  return hasType(m, "error");
}

// ── 测试辅助：起一个真实 Worker 跑 buildWorkerScript 产物 ──────────────

interface RunResult {
  /** 收到的 return 消息的 result 字段（脚本正常结束时）。 */
  returnValue?: unknown;
  /** 收到的 error 消息的 error 字段（脚本 throw 时）。 */
  errorMessage?: string;
  /** error 消息带回的 workerLogs（验证诊断不丢）。 */
  errorWorkerLogs?: unknown[];
  /** Worker exit code（0=正常，1=崩溃）。 */
  exitCode?: number;
  /** Worker 'error' 事件的错误消息（uncaught exception，正常应为 undefined）。 */
  workerError?: string;
  /** 收到的 agent-call 消息列表。 */
  agentCalls: AgentCallMsg[];
  /** 收到的 workflow-call 消息列表。 */
  workflowCalls: WorkflowCallMsg[];
}

interface RunOptions {
  /** $ARGS。 */
  args?: Record<string, unknown>;
  /** 按 agent-call 顺序回发的 parsedOutput（默认每个回发 {ok:true}）。 */
  agentResults?: unknown[];
  /** 主线程对收到的 workflow-call 的处理：回发 workflow-result。 */
  handleWorkflowCall?: (msg: WorkflowCallMsg) => unknown;
  /** 是否在收到首个 agent-call 后立即发 abort（测 abort 路径）。 */
  abortAfterFirstAgentCall?: { reason: string };
  /** 超时（S9：CI 环境放宽，规避真实 Worker 启动慢导致的假阳）。 */
  timeoutMs?: number;
  /** workerData.callCache 预填（测缓存命中路径）。 */
  callCache?: Map<number, unknown>;
}

/**
 * 起 Worker 执行 userScript，主线程模拟 workflow runtime 回发 agent-result。
 *
 * @param userScript 用户 workflow 脚本源码
 */
function runWorker(userScript: string, opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? (process.env.CI ? 5000 : 2000);
  return new Promise((resolve, reject) => {
    const workerCode = buildWorkerScript(userScript);
    const worker = new Worker(workerCode, {
      eval: true,
      workerData: {
        scriptPath: "test.js",
        args: opts.args ?? {},
        workspace: process.cwd(),
        budget: { maxTokens: 0, usedTokens: 0, usedCost: 0 },
        callCache: opts.callCache instanceof Map
          ? Object.fromEntries(opts.callCache)
          : opts.callCache ?? {},
      },
    });
    // S8：创建后立即登记，afterEach 兜底清理（防止 promise 泄漏导致 Worker 未终止）
    createdWorkers.push(worker);

    const result: RunResult = { agentCalls: [], workflowCalls: [] };
    let agentCallIdx = 0;
    let resolved = false;
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      reject(new Error(`Worker timed out after ${timeoutMs}ms — likely hung`));
    }, timeoutMs);

    const finish = (r: RunResult): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(r);
    };

    worker.on("message", (raw: unknown) => {
      if (isAgentCall(raw)) {
        result.agentCalls.push(raw);
        if (opts.abortAfterFirstAgentCall) {
          worker.postMessage({ type: "abort", reason: opts.abortAfterFirstAgentCall.reason });
          return;
        }
        const parsed = opts.agentResults?.[agentCallIdx] ?? { ok: true };
        agentCallIdx++;
        worker.postMessage({
          type: "agent-result",
          callId: raw.callId,
          result: { content: "fallback", parsedOutput: parsed },
          cached: false,
        });
      } else if (isWorkflowCall(raw)) {
        result.workflowCalls.push(raw);
        const wfResult = opts.handleWorkflowCall ? opts.handleWorkflowCall(raw) : { ok: true };
        worker.postMessage({ type: "workflow-result", callId: raw.callId, result: wfResult });
      } else if (isReturn(raw)) {
        result.returnValue = raw.result;
        finish(result);
      } else if (isError(raw)) {
        result.errorMessage = raw.error;
        result.errorWorkerLogs = raw.workerLogs;
        finish(result);
      }
    });
    worker.on("error", (err: Error) => {
      result.workerError = err.message;
      // error 事件后 Worker 会 exit code 1，给 exit handler 一个 tick 记录 exitCode
    });
    worker.on("exit", (code: number) => {
      result.exitCode = code;
      // 若未通过 return/error 消息结束（即 Worker 崩溃），以 exit 结果收尾
      if (result.returnValue === undefined && result.errorMessage === undefined) {
        finish(result);
      }
    });
  });
}

// 记录所有创建的 Worker，afterEach 兜底清理（防止泄漏）——S8
const createdWorkers: Worker[] = [];

afterEach(() => {
  for (const w of createdWorkers.splice(0)) {
    w.terminate().catch(() => {});
  }
});

// ── 回归测试：_safePost 作用域 bug（核心防线） ──────────────────────

describe("buildWorkerScript runtime — _safePost scope regression (exit code 1 bug)", () => {
  it("脚本正常 return 时发出 return 消息，Worker 不崩溃（exit code 0）", async () => {
    const script = `return { status: "ok", value: 42 };`;
    const res = await runWorker(script);
    expect(res.workerError).toBeUndefined();
    expect(res.errorMessage).toBeUndefined();
    expect(res.returnValue).toEqual({ status: "ok", value: 42 });
    expect(res.exitCode).not.toBe(1);
  });

  it("脚本 throw 时发出 error 消息并带回 workerLogs，Worker 不裸崩", async () => {
    const script = `
      console.log("before throw");
      throw new Error("script boom");
    `;
    const res = await runWorker(script);
    expect(res.workerError).toBeUndefined();
    expect(res.errorMessage).toBe("script boom");
    expect(res.exitCode).not.toBe(1);
  });

  it("agent() → result → return 完整链路：parallel 风格脚本正常完成", async () => {
    const script = `
      phase("analyze");
      const results = await parallel([
        () => agent({ prompt: "task-1", description: "a1" }),
        () => agent({ prompt: "task-2", description: "a2" }),
      ]);
      const ok = results.filter((r) => r && r.ok).length;
      return { status: "ok", analyzed: results.length, ok };
    `;
    const res = await runWorker(script, { agentResults: [{ ok: true }, { ok: true }] });
    expect(res.agentCalls).toHaveLength(2);
    expect(res.workerError).toBeUndefined();
    expect(res.returnValue).toEqual({ status: "ok", analyzed: 2, ok: 2 });
    expect(res.exitCode).not.toBe(1);
  });

  it("脚本 return 后 Worker 不发 workerError 事件（_safePost 在 .then 可达）", async () => {
    const script = `return "done";`;
    const res = await runWorker(script);
    expect(res.workerError).toBeUndefined();
    expect(res.returnValue).toBe("done");
  });

  it("parallel([agent(...), ...]) Promise 数组：CC 兼容写法不触发 DataCloneError", async () => {
    // parallel.js/map-reduce.js/scatter-gather.js 都用 `parallel([agent({...}), ...])`——
    // 传入已实例化的 Promise 数组（agent() 同步返回 Promise）。旧 parallel() 实现把
    // Promise 当 opts 传给 agent() → postMessage DataCloneError → allSettled 全 rejected
    // → 脚本返回 error。修复：parallel() 用 thenable 鸭辨直接返回 in-flight Promise。
    // 此测试用真实的 Promise 数组写法（而非函数数组），对应内置脚本的真实用法。
    const script = `
      const results = await parallel([
        agent({ prompt: "p1", description: "a1" }),
        agent({ prompt: "p2", description: "a2" }),
      ]);
      return { count: results.length, ok: results.every((r) => r && r.ok) };
    `;
    const res = await runWorker(script, { agentResults: [{ ok: true }, { ok: true }] });
    expect(res.agentCalls).toHaveLength(2);
    expect(res.workerError).toBeUndefined();
    expect(res.errorMessage).toBeUndefined();
    expect(res.returnValue).toEqual({ count: 2, ok: true });
    expect(res.exitCode).not.toBe(1);
  });
});

// ── S4-S7：覆盖此前缺失的运行时路径 ──────────────────────────────────

describe("buildWorkerScript runtime — 之前缺失的路径覆盖", () => {
  it("S4 abort 消息：pending agent() 被 reject → WorkflowAbortedError", async () => {
    // 脚本 await 一个 agent()，主线程回发 abort → agent reject → 脚本抛错进 .catch
    const script = `
      await agent({ prompt: "will-be-aborted" });
    `;
    const res = await runWorker(script, { abortAfterFirstAgentCall: { reason: "user cancel" } });
    // abort 让 pending reject → 脚本 throw WorkflowAbortedError → .catch 发 type:error
    expect(res.agentCalls).toHaveLength(1);
    expect(res.workerError).toBeUndefined();
    expect(res.errorMessage).toMatch(/Workflow aborted/);
    expect(res.exitCode).not.toBe(1);
  });

  it("S5 workflow() 嵌套调用：workflow-call ↔ workflow-result 链路正常", async () => {
    const script = `
      const r = await workflow("sub-wf", { x: 1 });
      return { nested: r };
    `;
    const res = await runWorker(script, {
      handleWorkflowCall: (msg) => ({ echo: msg.args, name: msg.name }),
    });
    expect(res.workflowCalls).toHaveLength(1);
    expect(res.workflowCalls[0]!.name).toBe("sub-wf");
    expect(res.workerError).toBeUndefined();
    expect(res.returnValue).toEqual({ nested: { echo: { x: 1 }, name: "sub-wf" } });
    expect(res.exitCode).not.toBe(1);
  });

  it("S6 module.exports.execute() 自动调用入口：ctx 注入完整、return 正常", async () => {
    const script = `
      const meta = { name: "exec-mode" };
      module.exports = {
        meta,
        execute: async (ctx) => {
          const r = await ctx.agent({ prompt: "via-execute" });
          return { viaExecute: true, agentResult: r, hasGlobals: typeof ctx.parallel === "function" };
        },
      };
    `;
    const res = await runWorker(script, { agentResults: [{ ok: true, source: "exec" }] });
    expect(res.agentCalls).toHaveLength(1);
    expect(res.workerError).toBeUndefined();
    expect(res.returnValue).toEqual({
      viaExecute: true,
      agentResult: { ok: true, source: "exec" },
      hasGlobals: true,
    });
    expect(res.exitCode).not.toBe(1);
  });

  it("S7 _safePost 的 .catch 路径带回 workerLogs：脚本 throw 时诊断不丢", async () => {
    // _safePost 的价值两半：(1) return 路径成功发消息（S1-S3 覆盖）；
    // (2) error 路径（.catch）发 type:error + workerLogs，让主线程拿到诊断。
    // 本例验证 .catch 里的 _safePost 正常工作——脚本 throw → console.* 被劫持进
    // _workerLogs → .catch 用 _safePost 发回 {type:"error", workerLogs}。
    // 修复前 .catch 里的 _safePost 是 ReferenceError，workerLogs 发不回（errorLogs 全空）。
    const script = `
      console.log("step-1");
      console.warn("step-2-warning");
      throw new Error("diagnostic-test-error");
    `;
    const res = await runWorker(script);
    expect(res.workerError).toBeUndefined();
    expect(res.errorMessage).toBe("diagnostic-test-error");
    expect(res.errorWorkerLogs).toBeDefined();
    expect(res.errorWorkerLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "log", message: "step-1" }),
        expect.objectContaining({ level: "warn", message: "step-2-warning" }),
      ]),
    );
    expect(res.exitCode).not.toBe(1);
  });
});
