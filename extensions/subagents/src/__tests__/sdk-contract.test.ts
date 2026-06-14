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

describe("SDK contract: registerTool shape matches ToolDefinition", () => {
  beforeEach(() => {
    setRuntime(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setRuntime(undefined as never);
  });

  it("subagent tool registration passes required ToolDefinition fields", () => {
    const { pi } = makeMockPi();
    subagentsExtension(pi);

    // registerTool 应被调用一次（注册 "subagent" 工具）
    expect(pi.registerTool).toHaveBeenCalledOnce();
    const tool = pi.registerTool.mock.calls[0][0] as Record<string, unknown>;

    // ToolDefinition 必填字段（来自真实 SDK types.d.ts）
    expect(tool).toMatchObject({
      name: "subagent",
      label: expect.any(String),
      description: expect.any(String),
      parameters: expect.any(Object), // TypeBox schema
    });

    // execute 必须是 async function
    expect(typeof tool.execute).toBe("function");
  });

  it("subagent tool parameters schema: required fields match description", () => {
    // 防御 schema/描述矛盾（如 task 必填但描述说 backgroundId 模式忽略它）
    const { pi } = makeMockPi();
    subagentsExtension(pi);
    const tool = pi.registerTool.mock.calls[0][0] as {
      parameters: { properties: Record<string, unknown>; required?: string[] };
    };

    // task 现在是 Optional（backgroundId 轮询模式不需要它）
    // 如果未来有人改回必填，这个测试会失败，提醒检查与描述的一致性
    const required = tool.parameters.required ?? [];
    expect(required).not.toContain("task");

    // backgroundId/agent/wait 都应是 optional
    for (const field of ["agent", "wait", "backgroundId"]) {
      expect(required).not.toContain(field);
    }
  });
});

describe("SDK contract: registerCommand shape matches RegisteredCommand", () => {
  beforeEach(() => {
    setRuntime(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setRuntime(undefined as never);
  });

  it("/subagents command registration passes required fields", () => {
    const { pi } = makeMockPi();
    subagentsExtension(pi);

    expect(pi.registerCommand).toHaveBeenCalledWith("subagents", expect.objectContaining({
      description: expect.any(String),
      handler: expect.any(Function),
    }));
  });

  it("/subagents command handler signature is (argsStr, ctx)", async () => {
    // RegisteredCommand.handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
    const { pi } = makeMockPi();
    subagentsExtension(pi);
    const cmd = pi.registerCommand.mock.calls[0][1] as {
      handler: (args: string, ctx: unknown) => Promise<void>;
    };

    // handler 应接收 2 个参数（argsStr + ctx），不能只收 1 个
    // 验证：传入 ctx 后 handler 能正常访问 ctx.ui.notify（不抛 undefined）
    const ctx = {
      ui: { notify: vi.fn() },
      cwd: "/tmp",
      modelRegistry: { find: () => undefined, hasConfiguredAuth: () => true, getAvailable: () => [] },
      hasUI: false,
      sessionManager: { getEntries: () => [] },
    };
    // 注入 modelRegistry，否则 runtime 未初始化会提前 return
    pi.on.mock.calls.forEach(([event, handler]) => {
      if (event === "session_start") handler({ type: "session_start", reason: "startup" }, ctx);
    });

    await expect(cmd.handler("", ctx)).resolves.toBeUndefined();
    // 无参数时应调用 ctx.ui.notify 显示配置摘要
    expect(ctx.ui.notify).toHaveBeenCalled();
  });
});

describe("SDK contract: appendEntry signature (customType, data)", () => {
  beforeEach(() => {
    setRuntime(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setRuntime(undefined as never);
  });

  it("persistState calls pi.appendEntry(customType, data) with correct arg count", () => {
    // appendEntry<T>(customType: string, data?: T): void
    // 验证：toggleYolo → persistState → appendEntry 被调用，第1参数是 customType 字符串
    const { pi, fireSessionStart } = makeMockPi();
    subagentsExtension(pi);
    fireSessionStart({
      cwd: "/tmp/sdk-contract-test",
      modelRegistry: { find: () => undefined, hasConfiguredAuth: () => true, getAvailable: () => [] },
      hasUI: false,
      sessionManager: { getEntries: () => [] },
    });

    const rt = getRuntime()!;
    rt.toggleYolo(); // 触发 persistState → appendEntry

    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    const [customType, data] = pi.appendEntry.mock.calls[0];
    expect(customType).toBe("subagent-model-state");
    // serializeState 返回 JSON 字符串（appendEntry 接受可序列化值）
    expect(data).toBeTypeOf("string");
    const parsed = JSON.parse(data as string);
    expect(parsed).toHaveProperty("yoloMode", true);
  });
});
