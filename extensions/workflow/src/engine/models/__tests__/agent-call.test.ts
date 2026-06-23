// 测试框架：vitest
// 运行命令：npx vitest run src/engine/models/__tests__/agent-call.test.ts

import { describe, expect, it } from "vitest";

import { AgentCall } from "../agent-call.js";
import type { AgentCallOpts, ExecutionTraceNode } from "../types.js";

function makeOpts(overrides: Partial<AgentCallOpts> = {}): AgentCallOpts {
  return { prompt: "do thing", ...overrides };
}

function makeTraceNode(stepIndex: number): ExecutionTraceNode {
  return {
    stepIndex,
    agent: "worker",
    task: "do thing",
    model: "default",
    status: "pending",
  };
}

// ── 构造 ────────────────────────────────────────────────────

describe("AgentCall 构造", () => {
  it("初始 status=pending, attempts=0", () => {
    const call = new AgentCall(0, makeOpts(), makeTraceNode(0));
    expect(call.id).toBe(0);
    expect(call.status).toBe("pending");
    expect(call.attempts).toBe(0);
    expect(call.result).toBeUndefined();
    expect(call.sessionId).toBeUndefined();
  });

  it("持有 traceNode 引用（不改其字段）", () => {
    const node = makeTraceNode(0);
    const call = new AgentCall(0, makeOpts(), node);
    expect(call.traceNode).toBe(node); // 同一引用
  });
});

// ── markRunning ─────────────────────────────────────────────

describe("AgentCall.markRunning", () => {
  it("pending → running, attempts=1（首次）", () => {
    const call = new AgentCall(0, makeOpts(), makeTraceNode(0));
    call.markRunning();
    expect(call.status).toBe("running");
    expect(call.attempts).toBe(1);
  });

  it("running → running, attempts++（retry 场景）", () => {
    const call = new AgentCall(0, makeOpts(), makeTraceNode(0));
    call.markRunning();
    call.markRunning(); // retry
    expect(call.attempts).toBe(2);
    expect(call.status).toBe("running");
  });

  it("done 后 markRunning 抛错（不可重启）", () => {
    const call = new AgentCall(0, makeOpts(), makeTraceNode(0));
    call.markRunning();
    call.markDone({ content: "ok" });
    expect(() => call.markRunning()).toThrow(/already done/);
  });
});

// ── markDone ────────────────────────────────────────────────

describe("AgentCall.markDone", () => {
  it("running → done, result 记录（成功）", () => {
    const call = new AgentCall(0, makeOpts(), makeTraceNode(0));
    call.markRunning();
    call.markDone({ content: "output", sessionId: "01H" });
    expect(call.status).toBe("done");
    expect(call.result?.content).toBe("output");
    expect(call.result?.sessionId).toBe("01H");
  });

  it("失败结果也通过 markDone 记录（result.error 区分）", () => {
    const call = new AgentCall(0, makeOpts(), makeTraceNode(0));
    call.markRunning();
    call.markDone({ content: "", error: "boom" });
    expect(call.status).toBe("done");
    expect(call.result?.error).toBe("boom");
  });

  it("pending 直接 markDone 抛错（必须先 markRunning）", () => {
    const call = new AgentCall(0, makeOpts(), makeTraceNode(0));
    expect(() => call.markDone({ content: "x" })).toThrow(/must be running/);
  });

  it("done 后再 markDone 抛错（不可重复完成）", () => {
    const call = new AgentCall(0, makeOpts(), makeTraceNode(0));
    call.markRunning();
    call.markDone({ content: "first" });
    expect(() => call.markDone({ content: "second" })).toThrow(/must be running/);
  });
});

// ── setSessionId ────────────────────────────────────────────

describe("AgentCall.setSessionId", () => {
  it("记录 session ID", () => {
    const call = new AgentCall(0, makeOpts(), makeTraceNode(0));
    call.setSessionId("01H8XGJ...");
    expect(call.sessionId).toBe("01H8XGJ...");
  });

  it("可覆盖（retry 新 session）", () => {
    const call = new AgentCall(0, makeOpts(), makeTraceNode(0));
    call.setSessionId("session-1");
    call.setSessionId("session-2");
    expect(call.sessionId).toBe("session-2");
  });
});

// ── D-12 不变式：无 execute 上帝方法 ──────────────────────────

describe("D-12 不变式", () => {
  it("AgentCall.execute === undefined（执行编排由 executeAgentCall 承担）", () => {
    const call = new AgentCall(0, makeOpts(), makeTraceNode(0));
 // @ts-expect-error — execute 不应存在
    expect(call.execute).toBeUndefined();
 // @ts-expect-error — executeWithRetry 不应存在
    expect(call.executeWithRetry).toBeUndefined();
  });
});
