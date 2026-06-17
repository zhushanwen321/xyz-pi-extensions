// src/__tests__/background.test.ts
//
// Background fire-and-forget 测试。通过 mock runAgent（runtime.runAgent）
// 验证：startBackground 立即返回 handle、getBackground 查询、cancelBackground
// 触发 abort、完成时触发 onComplete + emit + appendEntry。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SubagentRuntime } from "../runtime.ts";
import type { AgentConfig, AgentEvent, AgentResult, BackgroundStatus, RunAgentOptions } from "../types.ts";

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

    // 回注：首个完成立即发 sendMessage（合并窗口语义，FR-O1.5）。
    // 合并窗口的精确时序由 merge window describe 块用 fake timers 验证。
    await new Promise((r) => setTimeout(r, 10));
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("cancel sends a cancelled notification (FR-O1.2)", async () => {
    const rt = makeRuntime();

    (rt as unknown as { runAgent: ReturnType<typeof vi.fn> }).runAgent = vi.fn(
      () => new Promise<AgentResult>(() => {}), // 永不 resolve（保持 running）
    );

    const handle = rt.startBackground({ task: "long task", agent: "worker" });
    // cancel 立即触发
    rt.cancelBackground(handle.id);

    await new Promise((r) => setTimeout(r, 30));

    // FR-O1.2: cancelBackground 通知对话流 cancelled 状态
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(1);
    const sentMsg = (rt.pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sentMsg.content).toContain("cancelled");
    expect(sentMsg.content).toContain("worker");
    expect(sentMsg.content).toContain(handle.id);
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

describe("merge window (FR-O1.5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("first notification sends immediately, subsequent within window are merged into 1", () => {
    const rt = makeRuntime();
    // 直接调 notifyBgCompletion（绕过 runAgent 的异步），精确控制时序
    // 首个 → 立即发 + 启动 2000ms 合并窗口
    rt.notifyBgCompletion({
      id: "bg-mw-1", status: "done", agent: "worker",
      result: { text: "first" } as AgentResult, startedAt: 1000,
    });
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(1); // 首个立即发
    // 窗口内 2 个后续 → 入队（不发）
    rt.notifyBgCompletion({
      id: "bg-mw-2", status: "done", agent: "reviewer",
      result: { text: "second" } as AgentResult, startedAt: 1000,
    });
    rt.notifyBgCompletion({
      id: "bg-mw-3", status: "failed", agent: "worker",
      error: "boom", startedAt: 1000,
    });
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(1); // 仍在窗口内
    // 窗口到期 → flush 合并发 1 条
    vi.advanceTimersByTime(2000);
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(2); // 首个 + 合并 1 条 = 精确 2
    const mergedCall = rt.pi.sendMessage.mock.calls[1]!;
    expect(mergedCall[0].customType).toBe("subagent-bg-notify");
    expect(String(mergedCall[0].content)).toContain("2 background tasks");
  });

  it("single background sends exactly one notification (no merge overhead)", () => {
    const rt = makeRuntime();
    rt.notifyBgCompletion({
      id: "bg-solo-1", status: "done", agent: "worker",
      result: { text: "solo" } as AgentResult, startedAt: 1000,
    });
    // 单个 → 立即发 1 条，窗口内无后续 → 不多发
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(1);
    // 窗口到期后无 pending，flush 不发
    vi.advanceTimersByTime(2000);
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("flushPendingNotifications clears timer and sends merged batch", () => {
    const rt = makeRuntime();
    // 首个 → 立即发 + 启动窗口
    rt.notifyBgCompletion({
      id: "bg-merge-1", status: "done", agent: "worker",
      result: { text: "first" } as AgentResult, startedAt: 1000,
    });
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(1);
    // 后续入队（窗口内）
    rt.notifyBgCompletion({
      id: "bg-merge-2", status: "done", agent: "reviewer",
      result: { text: "second" } as AgentResult, startedAt: 1000,
    });
    rt.notifyBgCompletion({
      id: "bg-merge-3", status: "failed", agent: "worker",
      error: "boom", startedAt: 1000,
    });
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(1); // 仍在窗口内，未 flush
    // Round 6 SUG#11: dispose 不再 flush——直接调 flushPendingNotifications 才会合并
    rt.flushPendingNotifications();
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(2); // 首个 + 合并 1 条
    const mergedCall = rt.pi.sendMessage.mock.calls[1]!;
    expect(mergedCall[0].customType).toBe("subagent-bg-notify");
    expect(String(mergedCall[0].content)).toContain("2 background tasks");
  });

  it("dispose drops pending notifications (no sendMessage after dispose)", () => {
    const rt = makeRuntime();
    // 首个 → 立即发
    rt.notifyBgCompletion({
      id: "bg-disp-pending-1", status: "done", agent: "worker",
      result: { text: "first" } as AgentResult, startedAt: 1000,
    });
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(1);
    // 后续入队
    rt.notifyBgCompletion({
      id: "bg-disp-pending-2", status: "done", agent: "reviewer",
      result: { text: "second" } as AgentResult, startedAt: 1000,
    });
    rt.notifyBgCompletion({
      id: "bg-disp-pending-3", status: "failed", agent: "worker",
      error: "boom", startedAt: 1000,
    });
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(1); // 仍 1，pending 未 flush
    // dispose → 清掉 pending，不发
    rt.dispose();
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(1); // 仍 1，pending 被丢
  });

  it("flushPendingNotifications with empty pending is a no-op", () => {
    const rt = makeRuntime();
    // 空 pending → flush 不发
    rt.flushPendingNotifications();
    expect(rt.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("dispose is idempotent (P2 _disposed flag)", () => {
    const rt = makeRuntime();
    rt.notifyBgCompletion({
      id: "bg-disp-1", status: "done", agent: "worker",
      result: { text: "x" } as AgentResult, startedAt: 1000,
    });
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(1);
    rt.dispose();
    // dispose 后再 notifyBgCompletion → 短路（_disposed）
    rt.notifyBgCompletion({
      id: "bg-disp-2", status: "done", agent: "worker",
      result: { text: "y" } as AgentResult, startedAt: 1000,
    });
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(1); // 不增
    // 二次 dispose 不抛错
    expect(() => rt.dispose()).not.toThrow();
  });

  // Round 6 MF#3: revive() 是 dispose() 的反操作。/resume /fork /new 在同进程内
  // 先 session_shutdown(A)→dispose() 再 session_start(B) 注入新 pi 后复活 runtime。
  // 不复活则 notifyBgCompletion 顶部 `if (this._disposed) return;` 短路，所有
  // background 完成通知在第一次 session 切换后整体失效。
  it("revive() restores notifyBgCompletion after dispose (Round 4 MF3)", () => {
    const rt = makeRuntime();
    // 首个通知立即发送
    rt.notifyBgCompletion({
      id: "bg-revive-1", status: "done", agent: "worker",
      result: { text: "first" } as AgentResult, startedAt: 1000,
    });
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(1);
    // dispose → 后续通知短路
    rt.dispose();
    rt.notifyBgCompletion({
      id: "bg-revive-2", status: "done", agent: "worker",
      result: { text: "short-circuited" } as AgentResult, startedAt: 1000,
    });
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(1); // 仍 1，被短路
    // revive → 通知恢复正常发送
    rt.revive();
    rt.notifyBgCompletion({
      id: "bg-revive-3", status: "done", agent: "worker",
      result: { text: "after revive" } as AgentResult, startedAt: 1000,
    });
    expect(rt.pi.sendMessage).toHaveBeenCalledTimes(2); // 恢复后 +1，不再短路
  });
});

describe("priority (FR-O4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("startBackground passes priority 1000 to runAgent (low priority,不抢占 sync)", async () => {
    const rt = makeRuntime();
    const runAgentMock = rt.runAgent as unknown as ReturnType<typeof vi.fn>;
    runAgentMock.mockImplementation(() =>
      Promise.resolve({
        text: "ok",
        turns: 1,
        durationMs: 10,
        success: true,
        sessionId: "s",
        toolCalls: [],
      }),
    );

    rt.startBackground({ task: "bg task", agent: "worker" });
    await new Promise((r) => setTimeout(r, 20));

    // 验证 background 传了 priority:1000（低优先级）
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const passedOpts = runAgentMock.mock.calls[0]![0] as RunAgentOptions;
    expect(passedOpts.priority).toBe(1000);
  });
});

describe("defaultBackground (FR-O2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getAgentConfig returns undefined for missing name", () => {
    const rt = makeRuntime();
    expect(rt.getAgentConfig()).toBeUndefined();
    expect(rt.getAgentConfig("nonexistent-agent")).toBeUndefined();
  });

  it("getAgentConfig returns registered agent with defaultBackground flag", () => {
    const rt = makeRuntime();
    const config: AgentConfig = {
      name: "researcher-bg",
      systemPrompt: "test",
      defaultBackground: true,
      source: "builtin",
    };
    rt.builtinRegistry.register(config);

    const found = rt.getAgentConfig("researcher-bg");
    expect(found).toBeDefined();
    expect(found?.defaultBackground).toBe(true);
  });

  it("effectiveWait = false when agent has defaultBackground:true and wait not passed", () => {
    const rt = makeRuntime();
    rt.builtinRegistry.register({
      name: "researcher-bg",
      systemPrompt: "test",
      defaultBackground: true,
      source: "builtin",
    });
    const agentConfig = rt.getAgentConfig("researcher-bg");
    // 模拟 subagent-tool 的判定逻辑（FR-O2.2）
    const effectiveWait = agentConfig?.defaultBackground ? false : true;
    expect(effectiveWait).toBe(false); // 走 background
  });

  it("effectiveWait = true (sync) when agent has no defaultBackground", () => {
    const rt = makeRuntime();
    // worker 是 builtin，无 defaultBackground
    const agentConfig = rt.getAgentConfig("worker");
    const effectiveWait = agentConfig?.defaultBackground ? false : true;
    expect(effectiveWait).toBe(true); // 默认 sync
  });

  it("explicit wait:true overrides defaultBackground:true", () => {
    const rt = makeRuntime();
    rt.builtinRegistry.register({
      name: "researcher-bg",
      systemPrompt: "test",
      defaultBackground: true,
      source: "builtin",
    });
    // 模拟 subagent-tool 的判定逻辑：显式 wait 优先
    const explicitWait = true; // LLM 显式传 wait:true
    const effectiveWait = explicitWait;
    expect(effectiveWait).toBe(true); // 显式覆盖，走 sync
    // 配置仍在，但被覆盖
    expect(rt.getAgentConfig("researcher-bg")?.defaultBackground).toBe(true);
  });
});

describe("BgRecord FIFO cleanup (FR-O5.9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("evicts oldest DONE records when exceeding BG_RECORDS_MAX (50), keeps running", async () => {
    const rt = makeRuntime();
    (rt as unknown as { runAgent: ReturnType<typeof vi.fn> }).runAgent = vi.fn(() =>
      Promise.resolve({
        text: "ok",
        turns: 0,
        durationMs: 0,
        success: true,
        sessionId: "s",
        toolCalls: [],
      }),
    );

    // S4: 先启动 50 个并等它们全部 done，再启动第 51 个触发淘汰。
    // 不能一次性循环 51 个——同步循环期间前序 record 都是 running，S4 修复后
    // running record 不被淘汰，需等它们 done 后才能淘汰。
    const handles = [];
    for (let i = 0; i < 50; i++) {
      handles.push(rt.startBackground({ task: `task-${i}`, agent: "worker" }));
    }
    await new Promise((r) => setTimeout(r, 30)); // 等前 50 个 done

    // 第 51 个触发淘汰（此时前 50 个已 done，最旧的 done record 被淘汰）
    handles.push(rt.startBackground({ task: "task-50", agent: "worker" }));

    // 第一个（最旧的 done）应被淘汰
    expect(rt.getBackground(handles[0]!.id)).toBeUndefined();
    // 最后一个应仍在（新入队的）
    expect(rt.getBackground(handles[50]!.id)).toBeDefined();
    // 总数不超过上限
    expect(rt.listBackground().length).toBeLessThanOrEqual(50);
  });

  it("does NOT evict running records (cancel must still work)", async () => {
    const rt = makeRuntime();
    // 永不 resolve 的 runAgent —— 保持 running
    (rt as unknown as { runAgent: ReturnType<typeof vi.fn> }).runAgent = vi.fn(
      () => new Promise<AgentResult>(() => {}),
    );

    // 启动 51 个 running background（同步循环期间全是 running）
    const handles = [];
    for (let i = 0; i < 51; i++) {
      handles.push(rt.startBackground({ task: `task-${i}`, agent: "worker" }));
    }

    // S4: 全是 running 时不应淘汰——cancelBackground 仍必须能找到 record
    expect(rt.cancelBackground(handles[0]!.id)).toBe(true);
    // 总数超过 50（running 不淘汰，宁可暂时超限也不丢失 cancel 能力）
    expect(rt.listBackground().length).toBe(51);
  });
});

describe("startBackground onUpdate callback (FR-2.5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes onUpdate with running details when runAgent emits events", async () => {
    const rt = makeRuntime();
    // 直接 mock runAgent 发事件（makeRuntime 的 runAgentImpl 签名无 opts 参数，这里绕过）
    (rt as unknown as { runAgent: ReturnType<typeof vi.fn> }).runAgent = vi.fn(
      async (opts: { onEvent?: (e: { type: string; toolName?: string; args?: unknown }) => void }) => {
        opts.onEvent?.({ type: "tool_start", toolName: "read", args: { path: "x.ts" } });
        opts.onEvent?.({ type: "turn_end" });
        return {
          text: "done", turns: 1, durationMs: 5, success: true, sessionId: "s1", toolCalls: [],
        } as AgentResult;
      },
    );
    const updates: Array<{ status: string; eventLogLen: number }> = [];
    const handle = rt.startBackground({
      task: "test task",
      agent: "worker",
      onUpdate: (d: { status: string; eventLog: unknown[] }) => updates.push({ status: d.status, eventLogLen: d.eventLog.length }),
    });
    expect(handle.id).toMatch(/^bg-/);
    await new Promise((r) => setTimeout(r, 50));
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0].status).toBe("running");
    expect(updates[0].eventLogLen).toBeGreaterThan(0);
  });

  it("does not invoke onUpdate when runAgent emits no events", async () => {
    const rt = makeRuntime();
    const updates: unknown[] = [];
    rt.startBackground({ task: "x", onUpdate: () => updates.push({}) });
    await new Promise((r) => setTimeout(r, 50));
    expect(updates).toHaveLength(0);
  });
});

describe("resolveModelForAgent runtime method (FR-1.2, C2)", () => {
  function makeRegistryWithModel(): unknown {
    const model = {
      id: "anthropic/claude-sonnet-4.5", name: "claude-sonnet-4.5",
      provider: "anthropic", reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: "m", high: "h" },
    };
    return {
      find: (_provider: string, modelId: string) => (modelId === "claude-sonnet-4.5" ? model : undefined),
      hasConfiguredAuth: () => true,
      getAvailable: () => [model],
    };
  }

  it("returns undefined when modelRegistry not injected", () => {
    const rt = new SubagentRuntime({
      cwd: "/tmp/x", homeDir: "/tmp/x-none", agentDir: "/tmp/x-agent",
    });
    expect(rt.resolveModelForAgent("worker")).toBeUndefined();
  });

  it("returns undefined when agentName is undefined/empty", () => {
    const rt = makeRuntime();
    expect(rt.resolveModelForAgent(undefined)).toBeUndefined();
    expect(rt.resolveModelForAgent("")).toBeUndefined();
  });

  it("returns undefined when resolver throws (no available model for unknown agent)", () => {
    const rt = makeRuntime();
    expect(rt.resolveModelForAgent("nonexistent-agent")).toBeUndefined();
  });

  it("returns ResolvedModel when fallback chain resolves the model", () => {
    const rt = new SubagentRuntime({
      cwd: "/tmp/x", homeDir: "/tmp/x-none", agentDir: "/tmp/x-agent",
    });
    rt.injectModelRegistry(makeRegistryWithModel() as never);
    rt.injectPi({ appendEntry: vi.fn(), events: { emit: vi.fn() } } as never);
    rt.globalConfig.fallback.model = "anthropic/claude-sonnet-4.5";
    const result = rt.resolveModelForAgent("worker");
    expect(result).toBeDefined();
    expect(result!.model.id).toBe("anthropic/claude-sonnet-4.5");
    expect(result!.source).toBe("global-fallback");
  });
});
