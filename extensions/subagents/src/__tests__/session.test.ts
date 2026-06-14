// src/__tests__/session.test.ts
//
// ManagedSession 测试。通过 vi.spyOn(sessionFactory, "createAndConfigureSession")
// 注入 mock 的 BuiltSession，验证：session 缓存复用、steer 真实调用、abort、dispose、串行化。

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createManagedSession } from "../core/session.ts";
import type { AgentSessionLike, BuiltSession } from "../core/session-factory.ts";
// ── Mock session-factory.createAndConfigureSession ────────────────
// 我们 spy 这个函数，返回受控的 BuiltSession。
import * as sessionFactory from "../core/session-factory.ts";
import type { ManagedSessionOptions, SessionModelState, SubagentsGlobalConfig } from "../types.ts";

function makeMockSession(): AgentSessionLike & {
  prompt: ReturnType<typeof vi.fn>;
  steer: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
} {
  const listeners: Array<(e: unknown) => void> = [];
  return {
    sessionId: "managed-sess-1",
    messages: [{ role: "assistant", content: [{ type: "text", text: "result" }] }],
    prompt: vi.fn(async () => {
      for (const l of [...listeners]) l({ type: "turn_end" });
      for (const l of [...listeners]) l({ type: "message_end", message: { usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } } });
    }),
    steer: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(() => {}),
    subscribe: vi.fn((fn: (e: unknown) => void) => {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    }),
    getAllTools: vi.fn(() => [{ name: "read" }]),
    setActiveToolsByName: vi.fn(() => {}),
  } as never;
}

function makeBuiltSession(session: AgentSessionLike): BuiltSession {
  return {
    session,
    bridge: {
      turnCount: 0,
      toolCalls: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      lastError: undefined,
      // handle 由 subscribe 调用——session.subscribe 不会真的触发 bridge.handle，
      // 测试里 bridge 是独立的桩。collectResult 读取 bridge 字段。
      handle: () => {},
    } as never,
    unsubscribe: () => {},
  };
}

const baseConfig: SubagentsGlobalConfig = {
  version: 1, yoloByDefault: false, maxConcurrent: 4,
  categories: {}, agentCategoryOverrides: {},
  fallback: { model: "p/m" },
};
const emptyState: SessionModelState = { yoloMode: false, perAgent: {}, perCategory: {} };

// mock modelRegistry：find 总返回一个可用模型
const mockRegistry = {
  find: vi.fn(() => ({ id: "m", name: "m", provider: "p", reasoning: true, thinkingLevelMap: { high: "high" } })),
  hasConfiguredAuth: vi.fn(() => true),
  getAvailable: vi.fn(() => []),
};

const ctx = {
  modelRegistry: mockRegistry as never,
  resolveAgent: ((_n: string) => undefined) as never,
  globalConfig: baseConfig,
  sessionState: emptyState,
  globalPool: { acquire: vi.fn(async () => {}), release: vi.fn(() => {}), activeCount: 0, queueLength: 0, maxConcurrent: 4 } as never,
  cwd: "/tmp",
  agentDir: "/tmp/.pi",
};

const options: ManagedSessionOptions = { agent: undefined, model: "p/m", thinkingLevel: "high" };

let createSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  // spy getSdk 返回桩（避免真实 import SDK）
  vi.spyOn(sessionFactory, "getSdk").mockResolvedValue({} as never);
  // 每个测试重新 spy，返回新的 mock session
  createSpy = vi.spyOn(sessionFactory, "createAndConfigureSession");
});

describe("createManagedSession — session caching & steer", () => {
  it("creates session on first prompt and reuses on second prompt", async () => {
    const mockSession = makeMockSession();
    createSpy.mockResolvedValue(makeBuiltSession(mockSession));

    const ms = createManagedSession(options, ctx);
    await ms.prompt("task 1");
    await ms.prompt("task 2");

    // createAndConfigureSession 只调用一次（复用）
    expect(createSpy).toHaveBeenCalledOnce();
    // session.prompt 调用两次
    expect(mockSession.prompt).toHaveBeenCalledTimes(2);
  });

  it("steer() calls session.steer() after session is created", async () => {
    const mockSession = makeMockSession();
    createSpy.mockResolvedValue(makeBuiltSession(mockSession));

    const ms = createManagedSession(options, ctx);
    await ms.prompt("task"); // 触发 session 创建
    ms.steer("change direction");

    expect(mockSession.steer).toHaveBeenCalledWith("change direction");
  });

  it("steer() before session creation is buffered and flushed on creation", async () => {
    const mockSession = makeMockSession();
    createSpy.mockResolvedValue(makeBuiltSession(mockSession));

    const ms = createManagedSession(options, ctx);
    ms.steer("early message"); // session 未创建 → 缓存
    await ms.prompt("task");    // 创建时 flush

    expect(mockSession.steer).toHaveBeenCalledWith("early message");
  });

  it("steer() before session creation does not throw", () => {
    const ms = createManagedSession(options, ctx);
    expect(() => ms.steer("hi")).not.toThrow();
  });

  it("abort() calls session.abort() after session is created", async () => {
    const mockSession = makeMockSession();
    createSpy.mockResolvedValue(makeBuiltSession(mockSession));

    const ms = createManagedSession(options, ctx);
    await ms.prompt("task");
    ms.abort();

    expect(mockSession.abort).toHaveBeenCalled();
  });

  it("dispose() disposes session and sets alive=false", async () => {
    const mockSession = makeMockSession();
    createSpy.mockResolvedValue(makeBuiltSession(mockSession));

    const ms = createManagedSession(options, ctx);
    await ms.prompt("task");
    expect(ms.alive).toBe(true);
    ms.dispose();
    expect(ms.alive).toBe(false);
    expect(mockSession.dispose).toHaveBeenCalled();
  });

  it("prompt() after dispose throws", async () => {
    createSpy.mockResolvedValue(makeBuiltSession(makeMockSession()));
    const ms = createManagedSession(options, ctx);
    ms.dispose();
    await expect(ms.prompt("x")).rejects.toThrow(/disposed/);
  });

  it("concurrent prompts are serialized (second returns first's result)", async () => {
    const mockSession = makeMockSession();
    createSpy.mockResolvedValue(makeBuiltSession(mockSession));

    const ms = createManagedSession(options, ctx);
    // 并发发起两个 prompt —— 此处两个 prompt 属于同一 session 的串行化场景，
    // 失败一个即整体失败，故用 Promise.all（非独立数据源）。
    // eslint-disable-next-line taste/prefer-allsettled
    const [r1, r2] = await Promise.all([ms.prompt("a"), ms.prompt("b")]);
    // 都返回结果（串行化：第二个复用第一个的 Promise 或在其后执行）
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
  });

  it("sessionId is empty before first prompt, real after", async () => {
    createSpy.mockResolvedValue(makeBuiltSession(makeMockSession()));
    const ms = createManagedSession(options, ctx);
    expect(ms.sessionId).toBe("");
    await ms.prompt("task");
    expect(ms.sessionId).toBe("managed-sess-1");
  });

  it("returns AgentResult with usage from bridge", async () => {
    const mockSession = makeMockSession();
    const built = makeBuiltSession(mockSession);
    // 预设 bridge.usage 非零（模拟 message_end 累计）
    (built.bridge as { usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } }).usage = { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.1 };
    createSpy.mockResolvedValue(built);

    const ms = createManagedSession(options, ctx);
    const result = await ms.prompt("task");
    expect(result.usage?.cost).toBe(0.1);
    expect(result.text).toBe("result");
  });
});
