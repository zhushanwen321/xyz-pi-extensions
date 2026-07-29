/**
 * buildWorkerScript — 运行时执行回归测试。
 *
 * 现有的 worker-script-builder.test.ts 全是字符串 toContain 断言，无法捕获生成的
 * worker 源码在「真实 Worker 线程里执行」时的运行时错误。曾因此漏掉 _safePost 作用域
 * bug（定义在 async IIFE 内、却在 IIFE 外的 .then()/.catch() 里使用）：脚本每次正常
 * return 都触发 ReferenceError → Worker exit code 1 → 所有 workflow 100% 失败。
 *
 * 本测试起真实的 node:worker_threads.Worker 执行 buildWorkerScript 产物，验证：
 * - 脚本正常 return → 收到 {type:"return"} 消息（非 exit code 1 崩溃）
 * - 脚本 throw → 收到 {type:"error"} 消息（workerLogs 随回，诊断不丢）
 * - agent() 调用链路：postMessage(agent-call) ↔ postMessage(agent-result) resolve 正常
 *
 * 这是回归防线：任何让 .then/.catch 访问不到 module-scope helper 的重构都会被这里抓住。
 */
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import { buildWorkerScript } from "../worker-script-builder.ts";

// ── 测试辅助：起一个真实 Worker 跑 buildWorkerScript 产物 ──────────────

interface RunResult {
  /** 收到的 return 消息的 result 字段（脚本正常结束时） */
  returnValue?: unknown;
  /** 收到的 error 消息的 error 字段（脚本 throw 时） */
  errorMessage?: string;
  /** Worker exit code（0=正常，1=崩溃） */
  exitCode?: number;
  /** Worker 'error' 事件的错误消息（uncaught exception，正常应为 undefined） */
  workerError?: string;
  /** 收到的 agent-call 消息列表 */
  agentCalls: Array<{ callId: number; opts: Record<string, unknown> }>;
}

/**
 * 起 Worker 执行 userScript，主线程模拟 workflow runtime 回发 agent-result。
 *
 * @param userScript 用户 workflow 脚本源码
 * @param args $ARGS
 * @param agentResults 按 callId 顺序回发的 agent-result.parsedOutput（默认每个回发固定对象）
 * @param timeoutMs 超时（默认 2s，Worker 卡死时失败而非挂起测试）
 */
function runWorker(
  userScript: string,
  args: Record<string, unknown> = {},
  agentResults: unknown[] = [],
  timeoutMs = 2000,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const workerCode = buildWorkerScript(userScript);
    const worker = new Worker(workerCode, {
      eval: true,
      workerData: {
        scriptPath: "test.js",
        args,
        workspace: process.cwd(),
        budget: { maxTokens: 0, usedTokens: 0, usedCost: 0 },
      },
    });

    const result: RunResult = { agentCalls: [] };
    let agentCallIdx = 0;
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      reject(new Error(`Worker timed out after ${timeoutMs}ms — likely hung (pending agent-result not resolved or uncaught exception)`));
    }, timeoutMs);

    const finish = (r: RunResult): void => {
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(r);
    };

    worker.on("message", (msg: { type: string; callId?: number; opts?: Record<string, unknown>; result?: unknown; error?: string }) => {
      if (msg.type === "agent-call") {
        result.agentCalls.push({ callId: msg.callId!, opts: msg.opts! });
        // 主线程回发 agent-result：parsedOutput 让 worker resolve（worker-script-builder: msg.result.parsedOutput ?? content）
        const parsed = agentResults[agentCallIdx] ?? { ok: true };
        agentCallIdx++;
        worker.postMessage({
          type: "agent-result",
          callId: msg.callId,
          result: { content: "fallback", parsedOutput: parsed },
          cached: false,
        });
      } else if (msg.type === "return") {
        result.returnValue = msg.result;
        finish(result);
      } else if (msg.type === "error") {
        result.errorMessage = msg.error;
        finish(result);
      }
    });
    worker.on("error", (err: Error) => {
      result.workerError = err.message;
      // error 事件后 Worker 会 exit code 1，但给 exit handler 一个 tick 记录 exitCode
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

// 记录所有创建的 Worker，afterEach 兜底清理（防止泄漏）
const createdWorkers: Worker[] = [];

afterEach(() => {
  for (const w of createdWorkers.splice(0)) {
    w.terminate().catch(() => {});
  }
});

// ── 回归测试：_safePost 作用域 bug（核心防线） ──────────────────────

describe("buildWorkerScript runtime — _safePost scope regression (exit code 1 bug)", () => {
  it("脚本正常 return 时发出 return 消息，Worker 不崩溃（exit code 0）", async () => {
    // 最小脚本：直接 return 一个对象。这条路径曾因 _safePost 作用域 bug 100% 崩溃。
    const script = `
      return { status: "ok", value: 42 };
    `;
    const res = await runWorker(script);
    expect(res.workerError).toBeUndefined();
    expect(res.errorMessage).toBeUndefined();
    expect(res.returnValue).toEqual({ status: "ok", value: 42 });
    // Worker 通过 return 消息正常结束；exitCode 由 terminate 触发（非 1 崩溃即可）
    expect(res.exitCode).not.toBe(1);
  });

  it("脚本 throw 时发出 error 消息并带回 workerLogs，Worker 不裸崩", async () => {
    const script = `
      console.log("before throw");
      throw new Error("script boom");
    `;
    const res = await runWorker(script);
    // 关键：throw 应被外层 .catch 捕获 → 发 type:error 消息（而非 Worker exit 1）
    expect(res.workerError).toBeUndefined();
    expect(res.errorMessage).toBe("script boom");
    expect(res.exitCode).not.toBe(1);
  });

  it("agent() → result → return 完整链路：真实 parallel 风格脚本正常完成", async () => {
    // 模拟 parallel.js 的核心模式：await parallel([agent(...)]) → 处理结果 → return
    const script = `
      phase("analyze");
      const results = await parallel([
        () => agent({ prompt: "task-1", description: "a1" }),
        () => agent({ prompt: "task-2", description: "a2" }),
      ]);
      const ok = results.filter((r) => r && r.ok).length;
      return { status: "ok", analyzed: results.length, ok };
    `;
    const res = await runWorker(script, {}, [{ ok: true }, { ok: true }]);
    expect(res.agentCalls).toHaveLength(2);
    expect(res.workerError).toBeUndefined();
    expect(res.returnValue).toEqual({ status: "ok", analyzed: 2, ok: 2 });
    expect(res.exitCode).not.toBe(1);
  });

  it("脚本 return 后 Worker 不发 workerError 事件（_safePost 在 .then 可达）", async () => {
    // 直接断言：回归前这条会 fail —— ReferenceError: _safePost is not defined
    const script = `return "done";`;
    const res = await runWorker(script);
    expect(res.workerError).toBeUndefined();
    expect(res.returnValue).toBe("done");
  });
});
