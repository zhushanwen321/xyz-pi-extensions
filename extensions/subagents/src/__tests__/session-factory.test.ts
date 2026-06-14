// src/__tests__/session-factory.test.ts
import { describe, expect, it, vi } from "vitest";

import {
  type AgentSessionLike,
  collectResult,
  createAndConfigureSession,
  formatSchemaInstruction,
  type SdkLike,
} from "../core/session-factory.ts";
import type { AgentEvent } from "../types.ts";

/** 构造 mock Pi session（duck-typed AgentSessionLike） */
function makeMockSession(overrides: Partial<AgentSessionLike> = {}): AgentSessionLike & {
  setActiveToolsByName: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  steer: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
} {
  const listeners: Array<(e: unknown) => void> = [];
  return {
    sessionId: "sess-123",
    messages: [{ role: "assistant", content: [{ type: "text", text: "hello" }] }],
    prompt: vi.fn(async () => {
      // 模拟一轮 turn_end + message_end 事件
      for (const l of listeners) l({ type: "turn_end" });
      for (const l of listeners) l({ type: "message_end", message: { usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } } } });
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
    getAllTools: vi.fn(() => [
      { name: "read" },
      { name: "bash" },
      { name: "@zhushanwen/workflow_run" }, // 应被 EXCLUDED 排除
    ]),
    setActiveToolsByName: vi.fn(() => {}),
    ...overrides,
  } as never;
}

function makeMockSdk(session: AgentSessionLike): SdkLike {
  return {
    DefaultResourceLoader: function (this: { reload: () => Promise<void> }, _opts: Record<string, unknown>) {
      this.reload = async () => {};
    } as never,
    SessionManager: { inMemory: (_cwd?: string) => ({}) } as never,
    createAgentSession: vi.fn(async (_opts: Record<string, unknown>) => ({ session })),
  } as never;
}

describe("createAndConfigureSession", () => {
  it("creates session, filters tools, subscribes bridge", async () => {
    const session = makeMockSession();
    const sdk = makeMockSdk(session);
    const events: AgentEvent[] = [];

    const built = await createAndConfigureSession(
      {
        resolved: {
          model: { id: "m", name: "m", provider: "p", reasoning: true },
          thinkingLevel: "high",
        },
        agentConfig: {
          name: "worker", systemPrompt: "", source: "builtin",
          builtinTools: ["read"], extensions: false, // 只允许 read
        },
        onEvent: (e) => events.push(e),
      },
      { modelRegistry: {} as never, resolveAgent: () => undefined, cwd: "/tmp", agentDir: "/tmp/.pi" },
      sdk,
    );

    expect(built.session).toBe(session);
    expect(built.unsubscribe).toBeTypeOf("function");
    // createAgentSession 被调用，含 model + thinkingLevel + sessionManager
    expect(sdk.createAgentSession).toHaveBeenCalledOnce();
    // setActiveToolsByName 被调用，且 workflow_run（EXCLUDED）被排除，bash 被白名单排除
    expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read"]);
  });

  it("does not call setActiveToolsByName when no filtering needed (all allowed)", async () => {
    const session = makeMockSession({
      getAllTools: () => [{ name: "read" }],
    });
    const sdk = makeMockSdk(session);
    await createAndConfigureSession(
      {
        resolved: { model: { id: "m", name: "m", provider: "p", reasoning: true } },
        // 无 agentConfig → 不过滤
      },
      { modelRegistry: {} as never, resolveAgent: () => undefined, cwd: "/tmp", agentDir: "/tmp/.pi" },
      sdk,
    );
    // 全部工具通过（无 EXCLUDED 命中、无白名单）→ allowedTools 长度 == allTools → 不调用 setActiveToolsByName
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
  });

  it("bridge accumulates events emitted via subscribe", async () => {
    const session = makeMockSession();
    const sdk = makeMockSdk(session);
    const built = await createAndConfigureSession(
      { resolved: { model: { id: "m", name: "m", provider: "p", reasoning: true } } },
      { modelRegistry: {} as never, resolveAgent: () => undefined, cwd: "/tmp", agentDir: "/tmp/.pi" },
      sdk,
    );
    // 取 subscribe 的第一个 listener，模拟事件
    const listener = (session.subscribe as ReturnType<typeof vi.fn>).mock.calls[0][0] as (e: unknown) => void;
    listener({ type: "turn_end" });
    listener({ type: "turn_end" });
    expect(built.bridge.turnCount).toBe(2);
  });
});

describe("collectResult", () => {
  it("extracts text, parsedOutput (structured-output), usage, turns", () => {
    const session = makeMockSession({
      messages: [{ role: "assistant", content: [{ type: "text", text: "final answer" }] }],
    });
    // 模拟 bridge 状态
    const bridge = {
      turnCount: 3,
      toolCalls: [
        { toolName: "read", result: undefined, isError: false },
        { toolName: "structured-output", result: { details: { issues: ["x"] } }, isError: false },
      ],
      usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, cost: 1.5 },
      lastError: undefined,
    } as never;
    const start = Date.now() - 500;
    const result = collectResult(session, bridge, start, true, undefined);
    expect(result.text).toBe("final answer");
    expect(result.parsedOutput).toEqual({ issues: ["x"] });
    expect(result.usage?.cost).toBe(1.5);
    expect(result.turns).toBe(3);
    expect(result.success).toBe(true);
    expect(result.sessionId).toBe("sess-123");
    expect(result.durationMs).toBeGreaterThanOrEqual(500);
  });

  it("returns undefined usage when no tokens consumed", () => {
    const session = makeMockSession();
    const bridge = {
      turnCount: 0, toolCalls: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      lastError: undefined,
    } as never;
    const result = collectResult(session, bridge, Date.now(), true, undefined);
    expect(result.usage).toBeUndefined();
  });

  it("propagates error from failed run", () => {
    const session = makeMockSession();
    const bridge = { turnCount: 1, toolCalls: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, lastError: undefined } as never;
    const result = collectResult(session, bridge, Date.now(), false, "rate limited");
    expect(result.success).toBe(false);
    expect(result.error).toBe("rate limited");
  });
});

describe("formatSchemaInstruction", () => {
  it("includes MANDATORY marker and JSON schema", () => {
    const out = formatSchemaInstruction({ type: "object", properties: { ok: { type: "boolean" } } });
    expect(out).toContain("MANDATORY: Structured Output Requirement");
    expect(out).toContain('"type": "object"');
    expect(out).toContain("structured-output");
  });
});
