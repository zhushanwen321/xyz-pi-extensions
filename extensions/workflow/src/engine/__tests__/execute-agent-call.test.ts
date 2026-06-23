// 测试框架：vitest
// 运行命令：npx vitest run src/engine/__tests__/execute-agent-call.test.ts
//
// executeAgentCall free function 测试。
// 覆盖：成功路径 / stale 不重试 / 预算超限不重试 / 3 次退避 / signal abort 不重试 /
// D.4 cacheWrite 合并 / markRunning+markDone 状态机 / trace.update。

import { describe, expect, it, vi } from "vitest";

import { executeAgentCall, isStaleContextErrorMsg, STALE_CONTEXT_PATTERNS } from "../execute-agent-call.js";
import { AgentCall } from "../models/agent-call.js";
import { Budget } from "../models/budget.js";
import type { AgentRunner } from "../models/ports.js";
import { Trace } from "../models/trace.js";
import type { AgentCallOpts, AgentResult, AgentUsage, ExecutionTraceNode } from "../models/types.js";

// ── 测试夹具 ─────────────────────────────────────────────────

function makeTraceNode(callId: number): ExecutionTraceNode {
  return {
    stepIndex: callId,
    agent: "test-agent",
    task: "do work",
    model: "default",
    status: "running",
    startedAt: new Date().toISOString(),
  };
}

function makeCall(opts?: Partial<AgentCallOpts>): AgentCall {
  return new AgentCall(0, { prompt: "test prompt", ...opts }, makeTraceNode(0));
}

function makeBudget(overrides?: { maxTokens?: number; maxCost?: number }): Budget {
  return new Budget({
    maxTokens: overrides?.maxTokens ?? 0,
    maxCost: overrides?.maxCost ?? 0,
  });
}

function makeUsage(overrides?: Partial<AgentUsage>): AgentUsage {
  return {
    input: 100,
    output: 50,
    cacheRead: 10,
    cacheWrite: 20,
    cost: 0.001,
    contextTokens: 180,
    turns: 1,
    ...overrides,
  };
}

/** 构造 mock AgentRunner：按顺序返回预设结果。 */
function makeRunner(results: AgentResult[]): AgentRunner & { calls: number } {
  let i = 0;
  const run = vi.fn(async (): Promise<AgentResult> => {
    const r = results[Math.min(i, results.length - 1)];
    i++;
    return r;
  });
 // vi.fn 返回的 Mock 含额外属性，TS 不认直接赋给 AgentRunner.run 方法签名，故断言。
 // 非 `as unknown as` 双重断言，结构兼容（safe cast）。
  return {
    run,
    get calls() {
      return i;
    },
  } as AgentRunner & { calls: number };
}

function successResult(overrides?: Partial<AgentResult>): AgentResult {
  return {
    content: "done",
    usage: makeUsage(),
    durationMs: 100,
    sessionId: "sess-1",
    toolCalls: [],
    ...overrides,
  };
}

function failureResult(error: string, overrides?: Partial<AgentResult>): AgentResult {
  return {
    content: "",
    error,
    durationMs: 100,
    toolCalls: [],
    ...overrides,
  };
}

// ── isStaleContextErrorMsg 纯函数 ────────────────────────────

describe("isStaleContextErrorMsg", () => {
  it("undefined → false", () => {
    expect(isStaleContextErrorMsg(undefined)).toBe(false);
  });

  it("空字符串 → false", () => {
    expect(isStaleContextErrorMsg("")).toBe(false);
  });

  it("stale context（小写）→ true", () => {
    expect(isStaleContextErrorMsg("error: stale context detected")).toBe(true);
  });

  it("StaleContext 驼峰 → true", () => {
    expect(isStaleContextErrorMsg("StaleContextException thrown")).toBe(true);
  });

  it("context canceled → true", () => {
    expect(isStaleContextErrorMsg("Agent failed: context canceled by user")).toBe(true);
  });

  it("aborted → true", () => {
    expect(isStaleContextErrorMsg("Operation aborted")).toBe(true);
  });

  it("大小写不敏感：STALE CONTEXT → true", () => {
    expect(isStaleContextErrorMsg("STALE CONTEXT error")).toBe(true);
  });

  it("无关错误 → false", () => {
    expect(isStaleContextErrorMsg("rate limit exceeded")).toBe(false);
    expect(isStaleContextErrorMsg("network timeout")).toBe(false);
    expect(isStaleContextErrorMsg("invalid api key")).toBe(false);
  });

  it("STALE_CONTEXT_PATTERNS 含 4 种模式", () => {
    expect(STALE_CONTEXT_PATTERNS).toContain("stale context");
    expect(STALE_CONTEXT_PATTERNS).toContain("stalecontext");
    expect(STALE_CONTEXT_PATTERNS).toContain("context canceled");
    expect(STALE_CONTEXT_PATTERNS).toContain("aborted");
  });
});

// ── executeAgentCall 成功路径 ────────────────────────────────

describe("executeAgentCall 成功路径", () => {
  it("首次成功 → call.status=done, trace=completed, attempts=1", async () => {
    const call = makeCall();
    const budget = makeBudget();
    const trace = new Trace();
    trace.append(makeTraceNode(0));
    const runner = makeRunner([successResult()]);
    const controller = new AbortController();

    await executeAgentCall(call, runner, budget, controller.signal, trace);

    expect(call.status).toBe("done");
    expect(call.attempts).toBe(1);
    expect(call.result?.error).toBeUndefined();
    expect(runner.calls).toBe(1);
    expect(budget.totalCallCount).toBe(1);
    const node = trace.find(0);
    expect(node?.status).toBe("completed");
    expect(node?.result?.content).toBe("done");
    expect(node?.sessionId).toBe("sess-1");
  });

  it("usage 累加到 budget（D.4：cacheWrite 合并到 input）", async () => {
    const call = makeCall();
    const budget = makeBudget();
    const trace = new Trace();
    trace.append(makeTraceNode(0));
    const usage = makeUsage({ input: 100, output: 50, cacheRead: 10, cacheWrite: 20 });
    const runner = makeRunner([successResult({ usage })]);
    const controller = new AbortController();

    await executeAgentCall(call, runner, budget, controller.signal, trace);

 // D.4: input(100) + cacheWrite(20) 合并 + output(50) + cacheRead(10) + cacheWrite(0)
 // = 100+20 + 50 + 10 + 0 = 180
    expect(budget.usedTokens).toBe(180);
    expect(budget.usedCost).toBe(0.001);
  });

  it("无 usage 时不累加 budget", async () => {
    const call = makeCall();
    const budget = makeBudget();
    const trace = new Trace();
    trace.append(makeTraceNode(0));
    const runner = makeRunner([successResult({ usage: undefined })]);
    const controller = new AbortController();

    await executeAgentCall(call, runner, budget, controller.signal, trace);

    expect(budget.usedTokens).toBe(0);
    expect(budget.usedCost).toBe(0);
 // 但 totalCallCount 仍 +1（dispatch 完成即计数）
    expect(budget.totalCallCount).toBe(1);
  });

  it("parsedOutput 透传到 result", async () => {
    const call = makeCall();
    const budget = makeBudget();
    const trace = new Trace();
    trace.append(makeTraceNode(0));
    const runner = makeRunner([
      successResult({ parsedOutput: { count: 42 } }),
    ]);
    const controller = new AbortController();

    await executeAgentCall(call, runner, budget, controller.signal, trace);

    expect(call.result?.parsedOutput).toEqual({ count: 42 });
    expect(trace.find(0)?.result?.parsedOutput).toEqual({ count: 42 });
  });
});

// ── executeAgentCall stale-context 不重试 ────────────────────

describe("executeAgentCall stale-context 不重试", () => {
  it("stale context 错误 → 直接 failed，enqueue 仅 1 次", async () => {
    const call = makeCall();
    const budget = makeBudget();
    const trace = new Trace();
    trace.append(makeTraceNode(0));
    const runner = makeRunner([
      failureResult("stale context detected"),
    ]);
    const controller = new AbortController();

    await executeAgentCall(call, runner, budget, controller.signal, trace);

    expect(call.status).toBe("done");
    expect(call.attempts).toBe(1);
    expect(call.result?.error).toBe("stale context detected");
    expect(runner.calls).toBe(1);
    expect(trace.find(0)?.status).toBe("failed");
  });

  it("stale context 即使有 attempts<MAX 也不重试", async () => {
    const call = makeCall();
    const budget = makeBudget();
    const trace = new Trace();
    trace.append(makeTraceNode(0));
    const runner = makeRunner([
      failureResult("Error: context canceled"),
    ]);
    const controller = new AbortController();

    await executeAgentCall(call, runner, budget, controller.signal, trace);

    expect(runner.calls).toBe(1);
    expect(call.attempts).toBe(1);
  });
});

// ── executeAgentCall 预算超限不重试 ──────────────────────────

describe("executeAgentCall 预算超限不重试", () => {
  it("失败 + 预算超限 → 直接 failed，不重试", async () => {
    const call = makeCall();
 // maxTokens=50，单次 usage input=100 已超
    const budget = makeBudget({ maxTokens: 50 });
    const trace = new Trace();
    trace.append(makeTraceNode(0));
    const runner = makeRunner([
      failureResult("rate limit exceeded", { usage: makeUsage({ input: 100 }) }),
    ]);
    const controller = new AbortController();

    await executeAgentCall(call, runner, budget, controller.signal, trace);

    expect(runner.calls).toBe(1);
    expect(call.status).toBe("done");
    expect(call.result?.error).toBe("rate limit exceeded");
 // 预算已累加（即使失败也累加 retry token，Round 5 MF#4）
    expect(budget.usedTokens).toBeGreaterThan(0);
  });

  it("成功 + 预算超限 → completed（成功不受预算超限影响）", async () => {
    const call = makeCall();
    const budget = makeBudget({ maxTokens: 50 });
    const trace = new Trace();
    trace.append(makeTraceNode(0));
    const runner = makeRunner([
      successResult({ usage: makeUsage({ input: 100 }) }),
    ]);
    const controller = new AbortController();

    await executeAgentCall(call, runner, budget, controller.signal, trace);

 // 成功不受 budget.isExceeded 影响（只在 result.error 时检查预算）
    expect(call.result?.error).toBeUndefined();
    expect(trace.find(0)?.status).toBe("completed");
  });
});

// ── executeAgentCall 重试 ────────────────────────────────────

describe("executeAgentCall 重试", () => {
  it("失败 + attempts<MAX → 重试，达 MAX 后 failed", async () => {
    const call = makeCall();
    const budget = makeBudget();
    const trace = new Trace();
    trace.append(makeTraceNode(0));
    const runner = makeRunner([
      failureResult("rate limit exceeded"),
      failureResult("rate limit exceeded"),
      failureResult("rate limit exceeded"),
    ]);
    const controller = new AbortController();

    vi.useFakeTimers();
    try {
      const p = executeAgentCall(call, runner, budget, controller.signal, trace);
 // 推进 2 轮退避 timer（1s + 2s）
      for (let i = 0; i < 5; i++) {
        await vi.runAllTimersAsync();
      }
      await p;
    } finally {
      vi.useRealTimers();
    }

    expect(runner.calls).toBe(3); // initial + 2 retries
    expect(call.attempts).toBe(3);
    expect(call.status).toBe("done");
    expect(call.result?.error).toBe("rate limit exceeded");
    expect(trace.find(0)?.status).toBe("failed");
  });

  it("首次失败 + 第 2 次成功 → completed", async () => {
    const call = makeCall();
    const budget = makeBudget();
    const trace = new Trace();
    trace.append(makeTraceNode(0));
    const runner = makeRunner([
      failureResult("transient error"),
      successResult({ content: "recovered" }),
    ]);
    const controller = new AbortController();

    vi.useFakeTimers();
    try {
      const p = executeAgentCall(call, runner, budget, controller.signal, trace);
      for (let i = 0; i < 3; i++) {
        await vi.runAllTimersAsync();
      }
      await p;
    } finally {
      vi.useRealTimers();
    }

    expect(runner.calls).toBe(2);
    expect(call.attempts).toBe(2);
    expect(call.result?.error).toBeUndefined();
    expect(call.result?.content).toBe("recovered");
    expect(trace.find(0)?.status).toBe("completed");
  });

  it("每次 retry 都 markRunning（attempts++）", async () => {
    const call = makeCall();
    const budget = makeBudget();
    const trace = new Trace();
    trace.append(makeTraceNode(0));
    const runner = makeRunner([
      failureResult("err"),
      failureResult("err"),
      failureResult("err"),
    ]);
    const controller = new AbortController();

    vi.useFakeTimers();
    try {
      const p = executeAgentCall(call, runner, budget, controller.signal, trace);
      for (let i = 0; i < 5; i++) {
        await vi.runAllTimersAsync();
      }
      await p;
    } finally {
      vi.useRealTimers();
    }

    expect(call.attempts).toBe(3); // markRunning 每次 attempt 都调用
  });

  it("每次失败都累加 budget（Round 5 MF#4）", async () => {
    const call = makeCall();
    const budget = makeBudget();
    const trace = new Trace();
    trace.append(makeTraceNode(0));
    const usage = makeUsage({ input: 100, output: 0, cacheRead: 0, cacheWrite: 0 });
    const runner = makeRunner([
      failureResult("err", { usage }),
      failureResult("err", { usage }),
      failureResult("err", { usage }),
    ]);
    const controller = new AbortController();

    vi.useFakeTimers();
    try {
      const p = executeAgentCall(call, runner, budget, controller.signal, trace);
      for (let i = 0; i < 5; i++) {
        await vi.runAllTimersAsync();
      }
      await p;
    } finally {
      vi.useRealTimers();
    }

 // 3 次 enqueue，每次 input=100，cacheWrite=0，总 300
    expect(budget.usedTokens).toBe(300);
    expect(budget.totalCallCount).toBe(1); // 终态化时 incrementCallCount 仅 1 次
  });
});

// ── executeAgentCall signal abort ────────────────────────────

describe("executeAgentCall signal abort", () => {
  it("首次失败后 signal abort → 不重试，failed", async () => {
    const call = makeCall();
    const budget = makeBudget();
    const trace = new Trace();
    trace.append(makeTraceNode(0));
    const runner = makeRunner([failureResult("err")]);
    const controller = new AbortController();

 // 在退避期间 abort
    vi.useFakeTimers();
    try {
      const p = executeAgentCall(call, runner, budget, controller.signal, trace);
      controller.abort();
      await vi.runAllTimersAsync();
      await p;
    } finally {
      vi.useRealTimers();
    }

    expect(runner.calls).toBe(1);
    expect(call.status).toBe("done");
    expect(call.result?.error).toBe("err");
  });
});

// ── executeAgentCall 状态机约束 ──────────────────────────────

describe("executeAgentCall AgentCall 状态机", () => {
  it("markRunning 在每次 run 前（attempts 含首次）", async () => {
    const call = makeCall();
    const budget = makeBudget();
    const trace = new Trace();
    trace.append(makeTraceNode(0));
    const runner = makeRunner([successResult()]);
    const controller = new AbortController();

    await executeAgentCall(call, runner, budget, controller.signal, trace);

    expect(call.attempts).toBe(1);
    expect(call.status).toBe("done");
  });

  it("trace 缺失节点时 update 为 no-op（不抛错）", async () => {
    const call = makeCall();
    const budget = makeBudget();
    const trace = new Trace(); // 空 trace，无节点
    const runner = makeRunner([successResult()]);
    const controller = new AbortController();

 // 不应抛错——trace.update 防御性 no-op（D-10）
    await expect(
      executeAgentCall(call, runner, budget, controller.signal, trace),
    ).resolves.toBeUndefined();
    expect(call.status).toBe("done");
    expect(trace.length).toBe(0);
  });
});
