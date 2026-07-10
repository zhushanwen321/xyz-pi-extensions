// 测试框架：vitest
// 运行命令：npx vitest run src/engine/models/__tests__/run-state.test.ts

import { describe, expect, it } from "vitest";

import { AgentCall } from "../agent-call.js";
import { Budget } from "../budget.js";
import type { RunSpec } from "../run-spec.js";
import type { RunState } from "../run-state.js";
import { Trace } from "../trace.js";
import type { AgentCallOpts, DoneReason, ExecutionTraceNode, RunStatus } from "../types.js";

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    status: "running",
    budget: new Budget(),
    calls: new Map<number, AgentCall>(),
    trace: new Trace(),
    errorLogs: [],
    ...overrides,
  };
}

function makeOpts(overrides: Partial<AgentCallOpts> = {}): AgentCallOpts {
  return { prompt: "do", ...overrides };
}

function makeTraceNode(stepIndex: number): ExecutionTraceNode {
  return { stepIndex, agent: "w", task: "t", model: "d", status: "pending" };
}

// ── RunSpec（不可变值对象） ──────────────────────────────────

describe("RunSpec 形状", () => {
  it("全字段可构造", () => {
    const spec: RunSpec = {
      scriptSource: "const meta = {}; agent('x');",
      args: { _runId: "r1", key: "v" },
      budgetTokens: 5000,
      budgetTimeMs: 60000,
      scriptName: "test-wf",
      scriptPath: "/abs/.pi/workflows/test-wf.js",
      description: "a test workflow",
    };
    expect(spec.scriptName).toBe("test-wf");
    expect(spec.budgetTokens).toBe(5000);
  });

  it("budget 字段可选（不限制）", () => {
    const spec: RunSpec = {
      scriptSource: "x",
      args: {},
      scriptName: "n",
      scriptPath: "p",
    };
    expect(spec.budgetTokens).toBeUndefined();
    expect(spec.budgetTimeMs).toBeUndefined();
  });

  it("RunSpec 字段全 readonly（编译期不可变契约）", () => {
    const spec: RunSpec = {
      scriptSource: "x",
      args: {},
      scriptName: "n",
      scriptPath: "p",
    };
 // readonly 修饰符在 TS 层阻止赋值；这里只验证运行时可读
    expect(spec.scriptSource).toBe("x");
  });
});

// ── RunState 构造 ───────────────────────────────────────────

describe("RunState 构造", () => {
  it("默认字段齐全", () => {
    const state = makeRunState();
    expect(state.status).toBe("running");
    expect(state.reason).toBeUndefined();
    expect(state.budget).toBeInstanceOf(Budget);
    expect(state.calls).toBeInstanceOf(Map);
    expect(state.calls.size).toBe(0);
    expect(state.trace).toBeInstanceOf(Trace);
    expect(state.errorLogs).toEqual([]);
    expect(state.error).toBeUndefined();
    expect(state.scriptResult).toBeUndefined();
  });

  it("status 可为 paused/done", () => {
    const paused = makeRunState({ status: "paused" });
    expect(paused.status).toBe("paused");
    const done: RunState = makeRunState({
      status: "done",
      reason: "completed",
      scriptResult: { ok: true },
    });
    expect(done.status).toBe("done");
    expect(done.reason).toBe("completed");
    expect(done.scriptResult).toEqual({ ok: true });
  });
});

// ── RunState 字段可读写 ─────────────────────────────────────

describe("RunState 字段可读写", () => {
  it("calls Map 可增删 AgentCall", () => {
    const state = makeRunState();
    const call = new AgentCall(0, makeOpts(), makeTraceNode(0));
    state.calls.set(0, call);
    expect(state.calls.get(0)?.id).toBe(0);
    expect(state.calls.size).toBe(1);
    state.calls.delete(0);
    expect(state.calls.size).toBe(0);
  });

  it("budget 可累积", () => {
    const state = makeRunState();
    state.budget.consume({
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.1,
      contextTokens: 150,
      turns: 1,
    });
    // 加权：input(100)*1 + output(50)*2 = 200
    expect(state.budget.usedTokens).toBe(200);
  });

  it("trace 可 append", () => {
    const state = makeRunState();
    state.trace.append(makeTraceNode(0));
    expect(state.trace.length).toBe(1);
  });

  it("errorLogs 可累积", () => {
    const state = makeRunState();
    state.errorLogs.push({ level: "warn", message: "hello" });
    expect(state.errorLogs).toHaveLength(1);
  });

  it("done 时 error 可设置（reason !== completed）", () => {
    const state = makeRunState({
      status: "done",
      reason: "failed",
      error: "boom",
    });
    expect(state.error).toBe("boom");
  });

  it("scriptResult 与 reason 联动（completed → scriptResult）", () => {
    const reason: DoneReason = "completed";
    const status: RunStatus = "done";
    const state = makeRunState({ status, reason, scriptResult: 42 });
    expect(state.reason).toBe("completed");
    expect(state.scriptResult).toBe(42);
    expect(state.error).toBeUndefined();
  });
});

// ── 跨模型协作（RunState 持 Budget/Trace/AgentCall） ──────────

describe("RunState 跨模型协作", () => {
  it("AgentCall 在 calls Map 内可走完整生命周期", () => {
    const state = makeRunState();
    const node = makeTraceNode(0);
    const call = new AgentCall(0, makeOpts(), node);
    state.calls.set(0, call);
    state.trace.append(node);

    call.markRunning();
    state.trace.update(0, { status: "running" });

    call.markDone({ content: "result" });
    state.trace.update(0, { status: "completed", result: { content: "result" } });

    expect(state.calls.get(0)?.status).toBe("done");
    expect(state.trace.find(0)?.status).toBe("completed");
  });

  it("budget 超限可被 RunState 观测", () => {
    const state = makeRunState({ budget: new Budget({ maxTokens: 100 }) });
    state.budget.consume({
      input: 100,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 100,
      turns: 1,
    });
    expect(state.budget.isExceeded()).toBe(true);
  });
});
