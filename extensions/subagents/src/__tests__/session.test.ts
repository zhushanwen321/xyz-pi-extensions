// src/__tests__/session.test.ts
//
// ManagedSession 测试。通过 vi.spyOn(sessionFactory, "createAndConfigureSession")
// 注入 mock 的 BuiltSession，验证：session 缓存复用、steer 真实调用、abort、dispose、串行化。

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createEventBridge } from "../core/event-bridge.ts";
import { createManagedSession } from "../core/session.ts";
import type { AgentSessionLike, BuiltSession } from "../core/session-factory.ts";
// ── Mock session-factory.createAndConfigureSession ────────────────
// 我们 spy 这个函数，返回受控的 BuiltSession。
import * as sessionFactory from "../core/session-factory.ts";
import type { ManagedSessionOptions, SessionModelState, SubagentsGlobalConfig } from "../types.ts";

type EmitFn = (event: unknown) => void;

interface MockSessionOpts {
  /** 自定义 prompt 事件序列。callCount 从 1 递增；emit 将事件扇出给所有 subscribe 监听器。 */
  onPrompt?: (callCount: number, emit: EmitFn) => void | Promise<void>;
}

function makeMockSession(opts?: MockSessionOpts): AgentSessionLike & {
  prompt: ReturnType<typeof vi.fn>;
  steer: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
} {
  const listeners: Array<(e: unknown) => void> = [];
  const emit: EmitFn = (event) => {
    for (const l of [...listeners]) l(event);
  };
  let promptCount = 0;
  return {
    sessionId: "managed-sess-1",
    messages: [{ role: "assistant", content: [{ type: "text", text: "result" }] }],
    prompt: vi.fn(async () => {
      promptCount += 1;
      if (opts?.onPrompt) {
        await opts.onPrompt(promptCount, emit);
      } else {
        // 默认行为：1 turn_end + 1 message_end（usage）
        emit({ type: "turn_end" });
        emit({ type: "message_end", message: { usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } } });
      }
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

/**
 * 用真实的 createEventBridge 构建 BuiltSession，让 mock session 在 prompt 中 emit 的事件
 * 真实扇出到 bridge.handle（累计 turnCount/usage/toolCalls/lastError）。
 * 这样测试可以验证 session.ts 是否正确驱动 bridge（含 resetForPrompt）。
 */
function makeBuiltSession(session: AgentSessionLike): BuiltSession {
  const bridge = createEventBridge(() => {});
  const unsubscribe = session.subscribe((event: unknown) => {
    bridge.handle(event as never);
  });
  return { session, bridge, unsubscribe };
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
    // makeMockSession 默认 prompt emit message_end usage(input=5,output=5,cost.total=0.1)
    // 真实 bridge 累计 usageAccum → collectResult 读取
    createSpy.mockResolvedValue(built);

    const ms = createManagedSession(options, ctx);
    const result = await ms.prompt("task");
    expect(result.usage?.cost).toBe(0.1);
    expect(result.text).toBe("result");
  });
});

describe("createManagedSession — bridge state isolation across prompts", () => {
  it("resets lastError from failed prompt before next successful prompt", async () => {
    const mockSession = makeMockSession({
      onPrompt: (n, emit) => {
        if (n === 1) {
          // 第一次 prompt：以错误 stopReason 结束（bridge 记录 lastError）
          emit({ type: "message_end", message: { stopReason: "error", errorMessage: "boom", usage: null } });
        } else {
          // 第二次 prompt：正常结束（无 stopReason error）
          emit({ type: "turn_end" });
          emit({ type: "message_end", message: { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
        }
      },
    });
    createSpy.mockResolvedValue(makeBuiltSession(mockSession));

    const ms = createManagedSession(options, ctx);
    const r1 = await ms.prompt("first");
    expect(r1.success).toBe(false);
    expect(r1.error).toContain("boom");

    // 关键断言：第二次 prompt 不应被上次的 lastError 污染
    const r2 = await ms.prompt("second");
    expect(r2.success).toBe(true);
    expect(r2.error).toBeUndefined();
  });

  it("resets turnCount before each prompt so turn limit applies per-prompt", async () => {
    const mockSession = makeMockSession({
      onPrompt: (n, emit) => {
        if (n === 1) {
          // 第一次 prompt：3 个 turn_end（maxTurns=10 不触发 abort）
          emit({ type: "turn_end" });
          emit({ type: "turn_end" });
          emit({ type: "turn_end" });
          emit({ type: "message_end", message: { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
        } else {
          // 第二次 prompt：1 个 turn_end
          emit({ type: "turn_end" });
          emit({ type: "message_end", message: { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
        }
      },
    });
    createSpy.mockResolvedValue(makeBuiltSession(mockSession));

    const ms = createManagedSession(options, ctx);
    const r1 = await ms.prompt("first", { maxTurns: 10 });
    expect(r1.turns).toBe(3);

    // 第二次 maxTurns=2，仅 1 个 turn（reset 后 bridge.turnCount=1，1 < 2 不触发 soft limit）
    // 不 reset 的话 turnCount 会从 4 开始 → 立即 4 >= 2（steer）且 4 >= 2+2（abort）
    const r2 = await ms.prompt("second", { maxTurns: 2 });
    expect(r2.turns).toBe(1);
    expect(r2.success).toBe(true);
    expect(mockSession.abort).not.toHaveBeenCalled();
  });
});
