// src/__tests__/background.test.ts
//
// Background fire-and-forget 测试。通过 mock runAgent（runtime.runAgent）
// 验证：startBackground 立即返回 handle、getBackground 查询、cancelBackground
// 触发 abort、完成时触发 onComplete + emit + appendEntry。

import { beforeEach, describe, expect, it, vi } from "vitest";

import { SubagentRuntime } from "../runtime.ts";
import type { AgentResult, BackgroundStatus } from "../types.ts";

/** 构造一个隔离的 SubagentRuntime（绕过 session_start / modelRegistry 注入） */
function makeRuntime(overrides: { runAgentImpl?: () => Promise<AgentResult> } = {}): SubagentRuntime & {
  pi: { appendEntry: ReturnType<typeof vi.fn>; events: { emit: ReturnType<typeof vi.fn> } };
} {
  // SubagentRuntime 构造会调 loadGlobalConfig（读 ~/.pi/.../config.json）；
  // 用一个不存在的 homeDir 避免读到真实配置
  const rt = new SubagentRuntime({
    cwd: "/tmp/subagent-test-cwd",
    homeDir: "/tmp/subagent-test-home-nonexistent",
    agentDir: "/tmp/subagent-test-agent",
  });
  // 注入 mock pi
  const pi = {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
  };
  rt.injectPi(pi as never);
  // mock runAgent（绕过 modelRegistry 校验）
  (rt as unknown as { runAgent: ReturnType<typeof vi.fn> }).runAgent = vi.fn(
    overrides.runAgentImpl ??
      (async () => ({
        text: "bg result",
        parsedOutput: { artifacts: ["a", "b"] },
        turns: 1,
        durationMs: 10,
        success: true,
        sessionId: "sess-bg-1",
        toolCalls: [],
      } as AgentResult)),
  );
  return rt as never;
}

describe("startBackground / getBackground / cancelBackground", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("startBackground returns a running handle immediately", () => {
    const rt = makeRuntime();
    const handle = rt.startBackground({ task: "do work" });
    expect(handle.id).toMatch(/^bg-1-/);
    expect(handle.status).toBe("running");
  });

  it("getBackground returns running status before completion", () => {
    const rt = makeRuntime({
      // 永不 resolve 的 runAgent —— 保持 running
      runAgentImpl: () => new Promise<AgentResult>(() => {}),
    });
    const handle = rt.startBackground({ task: "long task" });
    const status = rt.getBackground(handle.id);
    expect(status?.status).toBe("running");
    expect(status?.startedAt).toBeTypeOf("number");
  });

  it("on completion: status=done, onComplete fired, events.emit + appendEntry called", async () => {
    const onComplete = vi.fn();
    const rt = makeRuntime();
    const handle = rt.startBackground({ task: "x", onComplete });

    // 等待 detached promise 链完成
    await new Promise((r) => setTimeout(r, 20));

    const status = rt.getBackground(handle.id);
    expect(status?.status).toBe("done");
    expect(status?.result?.text).toBe("bg result");
    expect(status?.result?.parsedOutput).toEqual({ artifacts: ["a", "b"] });

    expect(onComplete).toHaveBeenCalledOnce();
    const completedArg = onComplete.mock.calls[0][0] as BackgroundStatus;
    expect(completedArg.status).toBe("done");

    // emit 'subagents:bg:done'
    const pi = (rt as unknown as { pi: { events: { emit: ReturnType<typeof vi.fn> } } }).pi;
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:bg:done", expect.objectContaining({ id: handle.id }));

    // appendEntry 'subagent-bg-record'
    const piFull = (rt as unknown as { pi: { appendEntry: ReturnType<typeof vi.fn> } }).pi;
    expect(piFull.appendEntry).toHaveBeenCalledWith(
      "subagent-bg-record",
      expect.objectContaining({ id: handle.id, status: "done" }),
    );
  });

  it("failed runAgent → status=failed, error recorded", async () => {
    const rt = makeRuntime({
      runAgentImpl: async () => ({
        text: "",
        turns: 0,
        durationMs: 5,
        success: false,
        error: "model unavailable",
        sessionId: "",
        toolCalls: [],
      }),
    });
    const handle = rt.startBackground({ task: "fail" });
    await new Promise((r) => setTimeout(r, 20));
    const status = rt.getBackground(handle.id);
    expect(status?.status).toBe("failed");
    expect(status?.result?.success).toBe(false);
  });

  it("cancelBackground sets status=cancelled and aborts controller", () => {
    const rt = makeRuntime({
      runAgentImpl: () => new Promise<AgentResult>(() => {}),
    });
    const handle = rt.startBackground({ task: "cancellable" });
    const cancelled = rt.cancelBackground(handle.id);
    expect(cancelled).toBe(true);
    const status = rt.getBackground(handle.id);
    expect(status?.status).toBe("cancelled");
    expect(status?.endedAt).toBeTypeOf("number");
  });

  it("cancelBackground returns false for unknown or already-finished id", async () => {
    const rt = makeRuntime();
    expect(rt.cancelBackground("nope")).toBe(false);
    const handle = rt.startBackground({ task: "done quick" });
    await new Promise((r) => setTimeout(r, 20));
    expect(rt.cancelBackground(handle.id)).toBe(false); // 已 done
  });

  it("getBackground returns undefined for unknown id", () => {
    const rt = makeRuntime();
    expect(rt.getBackground("unknown")).toBeUndefined();
  });

  it("listBackground returns all records", () => {
    const rt = makeRuntime({
      runAgentImpl: () => new Promise<AgentResult>(() => {}),
    });
    rt.startBackground({ task: "a" });
    rt.startBackground({ task: "b" });
    const list = rt.listBackground();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.id)).toHaveLength(2);
  });

  it("status records do not leak controller field", async () => {
    const rt = makeRuntime();
    const handle = rt.startBackground({ task: "x" });
    await new Promise((r) => setTimeout(r, 20));
    const status = rt.getBackground(handle.id);
    expect(status).not.toHaveProperty("controller");
  });
});
