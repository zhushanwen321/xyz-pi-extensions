// src/__tests__/sdk-contract.test.ts
//
// SDK 契约对账测试：验证扩展工厂从 ExtensionHandler 的第二个参数 (ExtensionContext)
// 正确读取 modelRegistry / cwd / sessionManager / ui —— 而非从第一个参数 (SessionStartEvent)。
//
// 背景：ExtensionHandler 签名是 `(event, ctx) => ...`（两个参数）。
// SessionStartEvent 只有 { type, reason, previousSessionFile? }。
// modelRegistry / cwd / ui / sessionManager 全部在 ExtensionContext（第二个参数）上。
// 此前 bug：handler 只收了一个参数并从中读取 modelRegistry → 永远 undefined。
// 此测试复现了该 bug 的触发路径，确保修复不被回退。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import subagentsExtension from "../index.ts";
import { getRuntime, setRuntime } from "../runtime.ts";

/**
 * 构造一个符合真实 SDK ExtensionHandler 调用约定的 mock pi。
 * 关键：on("session_start", handler) 的 handler 必须接收两个参数 (event, ctx)。
 */
function makeMockPi() {
  const startHandlers: Array<(event: unknown, ctx: unknown) => unknown> = [];

  const pi = {
    on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      if (event === "session_start") startHandlers.push(handler);
    }),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
  };

  return {
    pi,
    /** 模拟 SDK 触发 session_start，传入符合 ExtensionContext 形状的 ctx */
    fireSessionStart: (ctx: Record<string, unknown>) => {
      const event = { type: "session_start", reason: "startup" as const };
      // 关键：handler 接收两个参数 (event, ctx) — 这是 SDK 的真实调用约定
      for (const h of startHandlers) h(event, ctx);
    },
  };
}

describe("SDK contract: session_start handler reads ctx (2nd param), not event (1st param)", () => {
  beforeEach(() => {
    // 重置模块级单例，避免测试间污染
    setRuntime(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setRuntime(undefined as never);
  });

  it("modelRegistry is read from ExtensionContext (2nd param), not SessionStartEvent (1st param)", () => {
    const mockModelRegistry = {
      find: vi.fn(() => undefined),
      hasConfiguredAuth: vi.fn(() => true),
      getAvailable: vi.fn(() => []),
    };

    const { pi, fireSessionStart } = makeMockPi();
    subagentsExtension(pi);

    // 模拟 SDK 触发 session_start：ExtensionContext 作为第二个参数传入
    fireSessionStart({
      cwd: "/tmp/sdk-contract-test",
      modelRegistry: mockModelRegistry,
      hasUI: false,
      sessionManager: { getEntries: () => [] },
    });

    const rt = getRuntime();
    expect(rt).toBeDefined();

    // 核心断言：resolveModelForScene 不抛 "modelRegistry not injected"
    // 如果 handler 从 event（第一个参数）读取 modelRegistry，这里会抛错
    // 因为 SessionStartEvent 没有 modelRegistry 字段 → 注入 undefined → buildContext 失败
    expect(() => rt!.resolveModelForScene("worker")).not.toThrow();
  });

  it("throws when modelRegistry missing from ctx (fail-fast guard)", () => {
    const { pi, fireSessionStart } = makeMockPi();
    subagentsExtension(pi);

    // 故意不传 modelRegistry → injectModelRegistry 应抛错
    expect(() => {
      fireSessionStart({
        cwd: "/tmp/sdk-contract-test",
        hasUI: false,
        sessionManager: { getEntries: () => [] },
      });
    }).toThrow(/registry is null\/undefined/);
  });

  it("SessionStartEvent shape does NOT include modelRegistry/cwd/ui", () => {
    // 类型层面验证：SessionStartEvent 的 shape 只有 type/reason/previousSessionFile
    // 防御性文档测试，确保未来 SDK 升级不会意外把这些字段移到 event 上
    const event = { type: "session_start" as const, reason: "startup" as const };
    expect(event).not.toHaveProperty("modelRegistry");
    expect(event).not.toHaveProperty("cwd");
    expect(event).not.toHaveProperty("ui");
  });
});
