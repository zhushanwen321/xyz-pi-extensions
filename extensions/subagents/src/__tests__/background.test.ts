// src/__tests__/background.test.ts
//
// Background fire-and-forget 测试。通过 mock runAgent（runtime.runAgent）
// 验证：startBackground 立即返回 handle、getBackground 查询、cancelBackground
// 触发 abort、完成时触发 onComplete + emit + appendEntry。

import { beforeEach, describe, expect, it, vi } from "vitest";

import { SubagentRuntime } from "../runtime.ts";
import type { AgentEvent, AgentResult, BackgroundStatus, RunAgentOptions } from "../types.ts";

/** FR-O1: mock pi 的形状（含 sendMessage） */
interface MockPi {
  appendEntry: ReturnType<typeof vi.fn>;
  events: { emit: ReturnType<typeof vi.fn> };
  sendMessage: ReturnType<typeof vi.fn>;
}

/** 构造一个隔离的 SubagentRuntime（注入 mock pi + modelRegistry） */
function makeRuntime(overrides: { runAgentImpl?: () => Promise<AgentResult> } = {}): SubagentRuntime & {
  pi: MockPi;
} {
  // SubagentRuntime 构造会调 loadGlobalConfig（读 ~/.pi/.../config.json）；
  // 用一个不存在的 homeDir 避免读到真实配置
  const rt = new SubagentRuntime({
    cwd: "/tmp/subagent-test-cwd",
    homeDir: "/tmp/subagent-test-home-nonexistent",
    agentDir: "/tmp/subagent-test-agent",
  });
  // 注入 mock pi（FR-O1: 加 sendMessage）
  const pi: MockPi = {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  };
  rt.injectPi(pi as never);
  // 注入 mock modelRegistry（startBackground 入口预检 buildContext() 需要）
  rt.injectModelRegistry({
    find: () => undefined,
    hasConfiguredAuth: () => true,
    getAvailable: () => [],
  } as never);
  // mock runAgent（绕过真实 session 创建）
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

describe("PiLike sendMessage (FR-O1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("notifyBgCompletion passes sendMessage through to pi with triggerTurn", () => {
    const rt = makeRuntime();
    rt.notifyBgCompletion({
      id: "bg-1-test",
      status: "done",
      agent: "worker",
      result: { text: "done output" } as AgentResult,
      startedAt: Date.now(),
    });
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(1);
    const call = rt.pi.sendMessage.mock.calls[0]!;
    expect(call[0]).toMatchObject({ customType: "subagent-bg-notify", display: true });
    expect(call[1]).toMatchObject({ triggerTurn: true });
  });

  it("formatBgCompletionMessage includes status, agent, body and backgroundId", () => {
    const rt = makeRuntime();
    const msg = rt.formatBgCompletionMessage({
      id: "bg-9-xyz",
      status: "done",
      agent: "reviewer",
      result: { text: "all good" } as AgentResult,
      startedAt: Date.now(),
    });
    expect(msg).toContain("completed");
    expect(msg).toContain("reviewer");
    expect(msg).toContain("all good");
    expect(msg).toContain("bg-9-xyz");
  });

  it("notifyBgCompletion dedupes same id within TTL", () => {
    const rt = makeRuntime();
    const record = {
      id: "bg-dedupe-1",
      status: "done" as const,
      agent: "worker",
      result: { text: "ok" } as AgentResult,
      startedAt: Date.now(),
    };
    rt.notifyBgCompletion(record);
    rt.notifyBgCompletion(record); // 同 id → 去重
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("notifyBgCompletion falls back to appendEntry when sendMessage throws (stale runtime)", () => {
    const rt = makeRuntime();
    rt.pi.sendMessage.mockImplementation(() => {
      throw new Error("stale runtime");
    });
    rt.notifyBgCompletion({
      id: "bg-stale-1",
      status: "done",
      agent: "worker",
      result: { text: "ok" } as AgentResult,
      startedAt: Date.now(),
    });
    // sendMessage 抛错 → fallback appendEntry
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(rt.pi.appendEntry).toHaveBeenCalledWith(
      "subagent-bg-record",
      expect.objectContaining({ id: "bg-stale-1", status: "done" }),
    );
  });
});

describe("startBackground eventLog race fix (G-005) + 回注", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("each background gets its own eventLog, not the first run- widget", async () => {
    const rt = makeRuntime();

    // 模拟两个并发 background，各自有不同的 eventLog
    let callCount = 0;
    (rt as unknown as { runAgent: ReturnType<typeof vi.fn> }).runAgent = vi.fn((opts: RunAgentOptions) => {
      callCount++;
      const myEvents: AgentEvent[] = [
        { type: "tool_start", toolName: `tool-bg-${callCount}` } as AgentEvent,
        { type: "tool_end", toolName: `tool-bg-${callCount}`, isError: false } as AgentEvent,
      ];
      return new Promise<AgentResult>((resolve) => {
        // 模拟事件流
        setTimeout(() => {
          for (const e of myEvents) opts.onEvent?.(e as AgentEvent);
          resolve({
            text: `output-${callCount}`,
            turns: 1,
            durationMs: 100,
            success: true,
            sessionId: `session-${callCount}`,
            toolCalls: [],
          });
        }, 10);
      });
    });

    const handle1 = rt.startBackground({ task: "task-1", agent: "worker" });
    const handle2 = rt.startBackground({ task: "task-2", agent: "reviewer" });

    await new Promise((r) => setTimeout(r, 50)); // 等 detached 完成

    const bg1 = rt.getBackground(handle1.id);
    const bg2 = rt.getBackground(handle2.id);
    expect(bg1?.eventLog?.some((e) => e.label.includes("tool-bg-1"))).toBe(true);
    expect(bg1?.eventLog?.some((e) => e.label.includes("tool-bg-2"))).toBe(false);
    expect(bg2?.eventLog?.some((e) => e.label.includes("tool-bg-2"))).toBe(true);
    expect(bg2?.eventLog?.some((e) => e.label.includes("tool-bg-1"))).toBe(false);

    // 回注：每个 background 完成时发一次 sendMessage（去重 key 不同）
    await new Promise((r) => setTimeout(r, 10));
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("cancel does not double-send notification (runAgent never resolves)", async () => {
    const rt = makeRuntime();

    (rt as unknown as { runAgent: ReturnType<typeof vi.fn> }).runAgent = vi.fn(
      () => new Promise<AgentResult>(() => {}), // 永不 resolve（保持 running）
    );

    const handle = rt.startBackground({ task: "long task", agent: "worker" });
    // cancel 立即触发
    rt.cancelBackground(handle.id);

    await new Promise((r) => setTimeout(r, 30));

    // runAgent 永不完成 → 不会走 .then/.catch → notifyBgCompletion 不被调用
    // cancelBackground 本身也不调 notifyBgCompletion
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(0);
  });

  it("failed background sends a failed notification", async () => {
    const rt = makeRuntime();
    (rt as unknown as { runAgent: ReturnType<typeof vi.fn> }).runAgent = vi.fn(
      async () =>
        ({
          text: "",
          turns: 0,
          durationMs: 5,
          success: false,
          error: "model down",
          sessionId: "",
          toolCalls: [],
        }) as AgentResult,
    );

    const handle = rt.startBackground({ task: "will fail", agent: "worker" });
    await new Promise((r) => setTimeout(r, 20));

    const status = rt.getBackground(handle.id);
    expect(status?.status).toBe("failed");
    // 回注：发一条 failed 通知
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(1);
    const call = rt.pi.sendMessage.mock.calls[0]!;
    expect(call[0]).toMatchObject({ customType: "subagent-bg-notify" });
    expect(String(call[0].content)).toContain("failed");
  });
});
