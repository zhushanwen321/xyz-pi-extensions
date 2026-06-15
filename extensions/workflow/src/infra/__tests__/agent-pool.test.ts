// 测试框架：vitest
// 运行命令：npx vitest run src/infra/__tests__/agent-pool.test.ts
//
// 验证 AgentPool.enqueue 的 mapResult 行为：
//   1. toolCalls.input 优先取 args（调用参数），而非 result.details（返回值）
//   2. args 缺失时回退到 result.details（向后兼容）
//   3. usage.contextTokens = input + output + cacheRead + cacheWrite（不再硬编码 0）
//   4. runtime 未初始化时返回 error 结果

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// vi.hoisted：在 vi.mock 工厂执行前已就绪的可变状态。
// vi.mock 被 hoist 到文件顶部，工厂内只能引用 hoisted 变量。
const mockState = vi.hoisted(() => ({
  runtime: undefined as
    | { runAgent: (opts: unknown) => Promise<unknown> }
    | undefined,
}));

vi.mock("@zhushanwen/pi-subagents", () => ({
  getRuntime: () => mockState.runtime,
}));

import { AgentPool } from "../agent-pool.js";

// ── 测试用 AgentResult 构造器 ─────────────────────────────────

interface SubAgentResult {
  text: string;
  parsedOutput?: unknown;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  turns: number;
  durationMs: number;
  success: boolean;
  error?: string;
  sessionId: string;
  toolCalls: Array<{
    toolName: string;
    args?: unknown;
    result?: { details?: unknown };
    isError: boolean;
  }>;
}

function makeResult(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
  return {
    text: "ok",
    turns: 1,
    durationMs: 10,
    success: true,
    sessionId: "sess-1",
    toolCalls: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockState.runtime = undefined;
});

describe("AgentPool.enqueue — mapResult", () => {
  it("toolCalls.input 优先使用 args（调用参数）而非 result.details", async () => {
    const args = { path: "/some/file.ts", limit: 100 };
    mockState.runtime = {
      runAgent: vi.fn().mockResolvedValue(
        makeResult({
          toolCalls: [
            {
              toolName: "read",
              args,
              result: { details: { shouldNotBeUsed: true } },
              isError: false,
            },
          ],
        }),
      ),
    };

    const pool = new AgentPool({ maxConcurrency: 1 });
    const result = await pool.enqueue({ prompt: "do something" });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("read");
    // args 被序列化为 input，截断到 200 字符以内
    expect(result.toolCalls[0].input).toBe(JSON.stringify(args).slice(0, 200));
    // 确保 result.details 没有泄漏到 input
    expect(result.toolCalls[0].input).not.toContain("shouldNotBeUsed");
  });

  it("args 缺失时 fallback 到 result.details（向后兼容）", async () => {
    const details = { output: 42, summary: "done" };
    mockState.runtime = {
      runAgent: vi.fn().mockResolvedValue(
        makeResult({
          toolCalls: [
            {
              toolName: "structured-output",
              // 故意不提供 args
              result: { details },
              isError: false,
            },
          ],
        }),
      ),
    };

    const pool = new AgentPool({ maxConcurrency: 1 });
    const result = await pool.enqueue({ prompt: "do something" });

    expect(result.toolCalls[0].name).toBe("structured-output");
    expect(result.toolCalls[0].input).toBe(JSON.stringify(details).slice(0, 200));
  });

  it("args 和 result.details 都缺失时 input 为空串", async () => {
    mockState.runtime = {
      runAgent: vi.fn().mockResolvedValue(
        makeResult({
          toolCalls: [{ toolName: "bash", isError: false }],
        }),
      ),
    };

    const pool = new AgentPool({ maxConcurrency: 1 });
    const result = await pool.enqueue({ prompt: "do something" });

    expect(result.toolCalls[0].input).toBe("");
  });

  it("usage.contextTokens = input + output + cacheRead + cacheWrite", async () => {
    const usage = { input: 100, output: 200, cacheRead: 10, cacheWrite: 5, cost: 3.15 };
    mockState.runtime = {
      runAgent: vi.fn().mockResolvedValue(makeResult({ usage, turns: 3 })),
    };

    const pool = new AgentPool({ maxConcurrency: 1 });
    const result = await pool.enqueue({ prompt: "do something" });

    expect(result.usage).toBeDefined();
    expect(result.usage!.contextTokens).toBe(100 + 200 + 10 + 5);
    expect(result.usage!.contextTokens).toBe(315);
    expect(result.usage!.turns).toBe(3);
    // 其他 usage 字段直传
    expect(result.usage!.input).toBe(100);
    expect(result.usage!.output).toBe(200);
    expect(result.usage!.cost).toBe(3.15);
  });

  it("usage 缺失时 result.usage 为 undefined（不报错）", async () => {
    mockState.runtime = {
      runAgent: vi.fn().mockResolvedValue(makeResult({ usage: undefined })),
    };

    const pool = new AgentPool({ maxConcurrency: 1 });
    const result = await pool.enqueue({ prompt: "do something" });

    expect(result.usage).toBeUndefined();
  });

  it("runtime 未初始化时返回 error 结果", async () => {
    // mockState.runtime 已在 beforeEach 置为 undefined
    const pool = new AgentPool({ maxConcurrency: 1 });
    const result = await pool.enqueue({ prompt: "do something" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("SubagentRuntime not initialized");
    expect(result.toolCalls).toEqual([]);
    expect(result.output).toBe("");
  });

  it("runAgent 抛错时封装为 error 结果（不 reject）", async () => {
    mockState.runtime = {
      runAgent: vi.fn().mockRejectedValue(new Error("boom")),
    };

    const pool = new AgentPool({ maxConcurrency: 1 });
    const result = await pool.enqueue({ prompt: "do something" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("boom");
  });

  it("signal 已 aborted 时立即返回 error", async () => {
    const controller = new AbortController();
    controller.abort();

    const pool = new AgentPool({ maxConcurrency: 1 });
    const result = await pool.enqueue({ prompt: "do something" }, controller.signal);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Operation aborted before start");
  });
});

// ============================================================
// MF#8: 新增测试覆盖
//   - timeoutMs wall-clock 超时
//   - maxConcurrency 并发上限
//   - soft-limit 警告回调
//   - setBudget 行为
// ============================================================

describe("AgentPool — timeoutMs wall-clock 超时", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  // 每个 it 后恢复真实定时器，避免影响后续 describe
  // （vi.useFakeTimers 影响全局 setTimeout，setTimeout(r, 10) 永不 fire）
  afterEach(() => {
    vi.useRealTimers();
  });

  it("timeoutMs 超时后 controller.abort() 触发，runAgent 抛 aborted → 错误信息被覆盖为 timeout", async () => {
    let agentSignal: AbortSignal | undefined;
    mockState.runtime = {
      runAgent: vi.fn((opts: { signal?: AbortSignal }) => {
        agentSignal = opts.signal;
        return new Promise((_, reject) => {
          // 模拟 agent 监听 abort 信号：超时触发时抛 AbortError
          opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }),
    };

    const pool = new AgentPool({ maxConcurrency: 1 });
    const promise = pool.enqueue({ prompt: "x", timeoutMs: 1000 });
    // 推进 1s 触发 setTimeout
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(agentSignal).toBeDefined();
    expect(agentSignal!.aborted).toBe(true);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Agent timed out after 1000ms");
  });

  it("timeoutMs=0 时不设超时（agent 自然完成不被中断）", async () => {
    mockState.runtime = {
      runAgent: vi.fn().mockResolvedValue(makeResult({ text: "ok" })),
    };

    const pool = new AgentPool({ maxConcurrency: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pool.enqueue({ prompt: "x", timeoutMs: 0 });

    expect(result.success).toBe(true);
    expect(result.output).toBe("ok");
  });

  it("agent 在 timeoutMs 内完成时，结果正常返回", async () => {
    mockState.runtime = {
      runAgent: vi.fn().mockResolvedValue(makeResult({ text: "ok" })),
    };

    const pool = new AgentPool({ maxConcurrency: 1 });
    const result = await pool.enqueue({ prompt: "x", timeoutMs: 5000 });
    expect(result.success).toBe(true);
    expect(result.output).toBe("ok");
  });
});

describe("AgentPool — maxConcurrency 并发上限", () => {
  it("maxConcurrency=1 时多个 enqueue 串行执行", async () => {
    const startOrder: number[] = [];
    const endOrder: number[] = [];
    let n = 0;
    mockState.runtime = {
      runAgent: vi.fn().mockImplementation(async () => {
        const myId = ++n;
        startOrder.push(myId);
        await new Promise((r) => setTimeout(r, 10));
        endOrder.push(myId);
        return makeResult({ text: `r${myId}` });
      }),
    };

    const pool = new AgentPool({ maxConcurrency: 1 });
    const promises = [
      pool.enqueue({ prompt: "a" }),
      pool.enqueue({ prompt: "b" }),
      pool.enqueue({ prompt: "c" }),
    ];
    const results = await Promise.all(promises);

    // 串行：start 和 end 都按 1→2→3 顺序
    expect(startOrder).toEqual([1, 2, 3]);
    expect(endOrder).toEqual([1, 2, 3]);
    expect(results.map((r) => r.output)).toEqual(["r1", "r2", "r3"]);
  });

  it("maxConcurrency=2 时最多 2 个 enqueue 并发执行", async () => {
    let active = 0;
    let maxActive = 0;
    mockState.runtime = {
      runAgent: vi.fn().mockImplementation(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return makeResult();
      }),
    };

    const pool = new AgentPool({ maxConcurrency: 2 });
    await Promise.all([
      pool.enqueue({ prompt: "a" }),
      pool.enqueue({ prompt: "b" }),
      pool.enqueue({ prompt: "c" }),
      pool.enqueue({ prompt: "d" }),
    ]);

    expect(maxActive).toBeLessThanOrEqual(2);
    // 4 个任务 maxConcurrency=2 必然并发
    expect(maxActive).toBe(2);
  });
});

describe("AgentPool — soft limit 警告回调", () => {
  it("达到 soft limit（500 次）时 onSoftLimitReached 被调用一次", async () => {
    mockState.runtime = {
      runAgent: vi.fn().mockResolvedValue(makeResult()),
    };

    const onSoft = vi.fn();
    const pool = new AgentPool({ maxConcurrency: 1, runName: "test-run", onSoftLimitReached: onSoft });
    pool.setBudget({ maxTokens: 100_000, maxTimeMs: 60_000, usedTokens: 0, usedCost: 0 });

    // 触发 501 次（超过 500）
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 501; i++) {
      promises.push(pool.enqueue({ prompt: `call-${i}` }));
    }
    await Promise.all(promises);

    expect(onSoft).toHaveBeenCalledTimes(1);
    const call = onSoft.mock.calls[0]![0] as { runName: string; totalCalls: number };
    expect(call.runName).toBe("test-run");
    expect(call.totalCalls).toBeGreaterThan(500);
  });
});

// ============================================================
// Round 4 MF7: waiter abort 行为
// 场景：maxConcurrency=1，A 运行中；B/C 排队；abort B 的 signal；A 完成后 C 应直接执行
// （跳过 B 占用 slot 的机会），且 B 的 caller 必须 resolve（不能永久挂起）。
// ============================================================

describe("AgentPool — waiter abort (Round 4 MF1/MF7)", () => {
  it("maxConcurrency=1：被 abort 的 waiter 不再占 slot，下一个 waiter 立即执行", async () => {
    // A 正在跑（卡住），B/C 排队；B 被 abort，A 完成后 C 应直接执行。
    // round 4 MF1 修复后：aborted waiter 也会被 resolve（caller 跳出 await），但
    // 不占 slot——下一个 waiter (C) 立即执行。
    const releaseFns: Array<() => void> = [];
    mockState.runtime = {
      runAgent: vi.fn().mockImplementation((opts: { signal?: AbortSignal }) => {
        if (opts.signal?.aborted) {
          return Promise.resolve(makeResult({ success: false, error: "aborted" }));
        }
        return new Promise<SubAgentResult>((resolve) => {
          releaseFns.push(() => resolve(makeResult({ text: "ok" })));
        });
      }),
    };

    const pool = new AgentPool({ maxConcurrency: 1 });
    const controllerB = new AbortController();
    const promiseA = pool.enqueue({ prompt: "A" });
    const promiseB = pool.enqueue({ prompt: "B" }, controllerB.signal);
    const promiseC = pool.enqueue({ prompt: "C" });

    // 立即 abort B（B 还在 waiters 队列里）
    controllerB.abort();

    // 释放 A：A 完成 → finally 应 resolve B（让 caller 跳出 await）但跳过 B 占 slot 的机会，
    // 然后 resolve C → C 立即执行
    releaseFns[0]!();
    // 多次让出 microtask，让 A 的 finally 跑完、B/C 同步 await 恢复、C 进入 runAgent
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // 此时 C 应已发起 runAgent，释放它
    releaseFns[1]!();
    // 让 promise 全部 settle
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const [resultA, resultB, resultC] = await Promise.all([promiseA, promiseB, promiseC]);

    // A 正常完成
    expect(resultA.success).toBe(true);
    expect(resultA.output).toBe("ok");
    // B 被 abort → caller 跳出 await 后走到 abort 检查，返回 error 结果（不永久挂起）
    expect(resultB.success).toBe(false);
    expect(resultB.error).toBe("Operation aborted before start");
    // C 应直接执行（A 完成后没人占 slot）
    expect(resultC.success).toBe(true);
    expect(resultC.output).toBe("ok");
  });

  it("maxConcurrency=1：abort 在 enqueue 之前已 aborted 立即返回 error", async () => {
    mockState.runtime = {
      runAgent: vi.fn().mockResolvedValue(makeResult()),
    };
    const controller = new AbortController();
    controller.abort();

    const pool = new AgentPool({ maxConcurrency: 1 });
    const result = await pool.enqueue({ prompt: "x" }, controller.signal);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Operation aborted before start");
  });
});
