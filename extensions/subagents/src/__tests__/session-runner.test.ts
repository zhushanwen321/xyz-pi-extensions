// src/__tests__/session-runner.test.ts
//
// 锁定 formatSchemaInstruction 契约 + fork 分流逻辑（D-018 两级降级链）。
//
// fork 测试策略：通过 run() 端到端测试，mock SDK 的 createBranchedSession/forkFrom。
// createAndConfigureSession 是私有函数，不可直接测——但 run() 的 fork 行为完全
// 由 SDK mock 驱动，测试足够精确。
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RunOptions, SessionRunnerContext } from "../core/session-runner.ts";
import { formatSchemaInstruction, run } from "../core/session-runner.ts";
import * as aliveStore from "../runtime/execution/alive-store.ts";
import type {
  AgentSessionLike,
  ExecutionRecord,
  ResolvedModel,
  SdkLike,
} from "../types.ts";

// ============================================================
// Mock 工具
// ============================================================

/** 创建最小 mock AgentSession。 */
function mockSession(overrides?: Partial<AgentSessionLike>): AgentSessionLike {
  return {
    prompt: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => {}),
    sessionId: "mock-session-id",
    sessionManager: {
      getSessionFile: vi.fn().mockReturnValue("/mock/session.jsonl"),
      getSessionId: vi.fn().mockReturnValue("mock-session-id"),
      appendCustomEntry: vi.fn().mockReturnValue("entry-id"),
    },
    messages: [],
    getAllTools: vi.fn().mockReturnValue([]),
    setActiveToolsByName: vi.fn(),
    ...overrides,
  };
}

/** 创建最小 mock SDK。 */
function mockSdk(overrides?: Partial<SdkLike>): SdkLike {
  return {
    DefaultResourceLoader: class MockResourceLoader {
      reload = vi.fn().mockResolvedValue(undefined);
    },
    SessionManager: {
      inMemory: vi.fn().mockReturnValue({}),
      create: vi.fn().mockReturnValue({}),
    },
    createAgentSession: vi.fn().mockResolvedValue({ session: mockSession() }),
    ...overrides,
  };
}

/** 创建最小 ExecutionRecord。 */
function mockRecord(): ExecutionRecord {
  return {
    id: "test-record-1",
    agent: "general-purpose",
    model: "test/model",
    thinkingLevel: undefined,
    mode: "sync",
    task: "test task",
    startedAt: Date.now(),
    status: "running",
    turns: [{ text: "", thinking: "", toolCalls: [], closed: false }],
    turnCount: 0,
    totalTokens: 0,
    lastError: undefined,
    endedAt: undefined,
    result: undefined,
    error: undefined,
    agentResult: undefined,
    controller: undefined,
  };
}

/** 创建最小 SessionRunnerContext。 */
function mockCtx(overrides?: Partial<SessionRunnerContext>): SessionRunnerContext {
  return {
    cwd: "/mock/cwd",
    agentDir: "/mock/agent",
    modelRegistry: {
      resolve: vi.fn().mockResolvedValue({ id: "test-model", provider: "test" }),
    } as unknown as SessionRunnerContext["modelRegistry"],
    resolveAgent: vi.fn().mockReturnValue(undefined),
    skillDirs: [],
    sdk: mockSdk(),
    mainCwd: "/mock/cwd",
    mainSessionFile: undefined,
    ...overrides,
  };
}

/** 创建最小 RunOptions。 */
function mockRunOpts(overrides?: Partial<RunOptions>): RunOptions {
  return {
    resolved: {
      model: { id: "test-model", provider: "test" },
      thinkingLevel: undefined,
    } as ResolvedModel,
    agentConfig: undefined,
    appendSystemPrompt: undefined,
    skillPath: undefined,
    schema: undefined,
    maxTurns: undefined,
    graceTurns: undefined,
    signal: undefined,
    onEvent: undefined,
    ...overrides,
  };
}

// ============================================================
// formatSchemaInstruction（原有测试）
// ============================================================

describe("formatSchemaInstruction", () => {
  it("contains the structured-output tool keyword", () => {
    const out = formatSchemaInstruction({ type: "object" });
    expect(out).toContain("structured-output");
  });

  it("instructs the agent to MUST call structured-output (not output JSON directly)", () => {
    const out = formatSchemaInstruction({ type: "object" });
    expect(out).toContain("MUST");
    expect(out).toContain("MUST call the `structured-output` tool");
    expect(out).toContain("Do NOT output the JSON directly");
  });

  it("embeds the schema as pretty-printed JSON (indent=2)", () => {
    const schema = { type: "object", properties: { name: { type: "string" } } };
    const out = formatSchemaInstruction(schema);
    expect(out).toContain(JSON.stringify(schema, null, 2));
    expect(out).toContain("```json");
    expect(out).toContain("```");
  });

  it("escapes double quotes inside schema string values", () => {
    const schema = { prompt: 'say "hi"' };
    const out = formatSchemaInstruction(schema);
    expect(out).toContain('say \\"hi\\"');
    expect(out).not.toContain('say "hi"');
  });

  it("escapes newlines inside schema string values", () => {
    const schema = { text: "line1\nline2" };
    const out = formatSchemaInstruction(schema);
    expect(out).toContain("line1\\nline2");
    expect(out).not.toContain("line1\nline2");
  });

  it("handles empty schema object", () => {
    const out = formatSchemaInstruction({});
    expect(out).toContain("structured-output");
    expect(out).toContain("{}");
  });

  it("is deterministic — same schema produces identical output", () => {
    const schema = { a: 1, b: [2, 3] };
    expect(formatSchemaInstruction(schema)).toBe(formatSchemaInstruction(schema));
  });
});

// ============================================================
// fork 分流逻辑（D-018 两级降级链）
// ============================================================

describe("createAndConfigureSession fork branching", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // mock writeAliveMarker 为 no-op（避免 fs 依赖）
    vi.spyOn(aliveStore, "writeAliveMarker").mockImplementation(() => {});
  });

  it("createBranchedSession 成功 → 使用 branched session", async () => {
    const branchedSession = mockSession({ sessionId: "branched-id" });
    const sdk = mockSdk({
      createBranchedSession: vi.fn().mockResolvedValue({ session: branchedSession }),
    });
    const ctx = mockCtx({
      sdk,
      mainCwd: "/mock/main",
      mainSessionFile: "/mock/main-session.jsonl",
    });

    const result = await run(
      mockRecord(),
      "test task",
      mockRunOpts({ fork: true, parentForkDepth: 0 }),
      ctx,
    );

    expect(sdk.createBranchedSession).toHaveBeenCalledOnce();
    expect(sdk.forkFrom).toBeUndefined();
    expect(result.sessionId).toBe("branched-id");
  });

  it("createBranchedSession 抛错 → 降级 forkFrom（两级降级）", async () => {
    const forkedSession = mockSession({ sessionId: "forked-id" });
    const sdk = mockSdk({
      createBranchedSession: vi.fn().mockRejectedValue(new Error("branched failed")),
      forkFrom: vi.fn().mockResolvedValue({ session: forkedSession }),
    });
    const ctx = mockCtx({
      sdk,
      mainCwd: "/mock/main",
      mainSessionFile: "/mock/main-session.jsonl",
    });

    const result = await run(
      mockRecord(),
      "test task",
      mockRunOpts({ fork: true, parentForkDepth: 0 }),
      ctx,
    );

    expect(sdk.createBranchedSession).toHaveBeenCalledOnce();
    expect(sdk.forkFrom).toHaveBeenCalledOnce();
    expect(result.sessionId).toBe("forked-id");
  });

  it("两级都失败 → 抛错（run 合成 failed result）", async () => {
    const sdk = mockSdk({
      createBranchedSession: vi.fn().mockRejectedValue(new Error("branched failed")),
      forkFrom: vi.fn().mockRejectedValue(new Error("fork failed")),
    });
    const ctx = mockCtx({
      sdk,
      mainCwd: "/mock/main",
      mainSessionFile: "/mock/main-session.jsonl",
    });

    // run() 创建期异常会抛出——由 runAndFinalize 合成 failed result
    await expect(
      run(
        mockRecord(),
        "test task",
        mockRunOpts({ fork: true, parentForkDepth: 0 }),
        ctx,
      ),
    ).rejects.toThrow(/fork session failed.*branched failed.*fork failed/);
  });

  it("fork 路径写 alive marker", async () => {
    const branchedSession = mockSession({ sessionId: "branched-id" });
    const sdk = mockSdk({
      createBranchedSession: vi.fn().mockResolvedValue({ session: branchedSession }),
    });
    const ctx = mockCtx({
      sdk,
      mainCwd: "/mock/main",
      mainSessionFile: "/mock/main-session.jsonl",
    });

    await run(
      mockRecord(),
      "test task",
      mockRunOpts({ fork: true, parentForkDepth: 0 }),
      ctx,
    );

    expect(aliveStore.writeAliveMarker).toHaveBeenCalledWith(
      "/mock/session.jsonl",
      expect.objectContaining({
        pid: process.pid,
        id: "branched-id",
      }),
    );
  });

  it("fork 后正常完成 done，result.success=true", async () => {
    const branchedSession = mockSession({ sessionId: "branched-id" });
    const sdk = mockSdk({
      createBranchedSession: vi.fn().mockResolvedValue({ session: branchedSession }),
    });
    const ctx = mockCtx({
      sdk,
      mainCwd: "/mock/main",
      mainSessionFile: "/mock/main-session.jsonl",
    });

    const result = await run(
      mockRecord(),
      "test task",
      mockRunOpts({ fork: true, parentForkDepth: 2 }),
      ctx,
    );

    // prompt 被调用（session 正常运行）
    expect(branchedSession.prompt).toHaveBeenCalled();
    // 无 error → success
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("identity custom entry 包含 forkDepth=parentForkDepth+1", async () => {
    const branchedSession = mockSession({ sessionId: "branched-id" });
    const sdk = mockSdk({
      createBranchedSession: vi.fn().mockResolvedValue({ session: branchedSession }),
    });
    const ctx = mockCtx({
      sdk,
      mainCwd: "/mock/main",
      mainSessionFile: "/mock/main-session.jsonl",
    });

    await run(
      mockRecord(),
      "test task",
      mockRunOpts({ fork: true, parentForkDepth: 3 }),
      ctx,
    );

    expect(branchedSession.sessionManager.appendCustomEntry).toHaveBeenCalledWith(
      "subagent-identity",
      expect.objectContaining({ forkDepth: 4 }),
    );
  });

  it("非 fork 路径 → createAgentSession（现有行为不变）", async () => {
    const normalSession = mockSession({ sessionId: "normal-id" });
    const sdk = mockSdk({
      createAgentSession: vi.fn().mockResolvedValue({ session: normalSession }),
    });
    const ctx = mockCtx({ sdk });

    const result = await run(
      mockRecord(),
      "test task",
      mockRunOpts(), // fork 未设置
      ctx,
    );

    expect(sdk.createAgentSession).toHaveBeenCalled();
    expect(sdk.createBranchedSession).toBeUndefined();
    expect(result.sessionId).toBe("normal-id");
  });

  it("两 fork 并发不互相 mutate（各自独立 session）", async () => {
    const session1 = mockSession({ sessionId: "fork-1" });
    const session2 = mockSession({ sessionId: "fork-2" });
    let callCount = 0;
    const sdk = mockSdk({
      createBranchedSession: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({ session: callCount === 1 ? session1 : session2 });
      }),
    });
    const ctx = mockCtx({
      sdk,
      mainCwd: "/mock/main",
      mainSessionFile: "/mock/main-session.jsonl",
    });

    const [result1, result2] = await Promise.all([
      run(mockRecord(), "task-1", mockRunOpts({ fork: true, parentForkDepth: 0 }), ctx),
      run(mockRecord(), "task-2", mockRunOpts({ fork: true, parentForkDepth: 0 }), ctx),
    ]);

    // 两次 createBranchedSession 各自返回独立 session
    expect(sdk.createBranchedSession).toHaveBeenCalledTimes(2);
    expect(result1.sessionId).toBe("fork-1");
    expect(result2.sessionId).toBe("fork-2");
    // 各自 prompt 各自的 session
    expect(session1.prompt).toHaveBeenCalledWith("task-1");
    expect(session2.prompt).toHaveBeenCalledWith("task-2");
  });

  it("fork depth 超限 → ForkDepthExceededError → 抛错", async () => {
    const sdk = mockSdk();
    const ctx = mockCtx({
      sdk,
      mainCwd: "/mock/main",
      mainSessionFile: "/mock/main-session.jsonl",
    });

    // ForkDepthExceededError 在 createAndConfigureSession 内抛出，run() 不吞
    await expect(
      run(
        mockRecord(),
        "test task",
        mockRunOpts({ fork: true, parentForkDepth: 10 }), // >= MAX_FORK_DEPTH
        ctx,
      ),
    ).rejects.toThrow(/fork depth.*10.*refusing to fork/);
  });
});
