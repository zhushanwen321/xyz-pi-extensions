// src/__tests__/subagent-tool.test.ts
//
// subagent LLM 工具 execute() 单元测试。
//
// 策略：vi.mock 替换 runtime.ts 的 getRuntime，注入鸭子类型的 mock runtime
// （只暴露 execute 实际调用的 runAgent/startBackground/getBackground）。
// 通过一个最小 mock ExtensionAPI（registerTool 捕获 tool 对象），直接调用其
// execute() 验证三种模式（sync / background / polling）与错误分支。

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentResult, BackgroundHandle, BackgroundStatus } from "../types.ts";

// vi.mock 被 vitest 自动 hoist 到所有 import 之前。
// 路径 `../runtime.ts` 相对测试文件解析为 src/runtime.ts，
// 与 subagent-tool.ts 内 `import { getRuntime } from "../runtime.ts"`
// （相对 src/tools/ 也是 src/runtime.ts）解析到同一绝对路径，故能命中。
vi.mock("../runtime.ts", () => ({
  getRuntime: vi.fn(),
  setRuntime: vi.fn(),
}));

// 必须在 vi.mock 之后 import 被测模块（此时 runtime.ts 已被替换）
import { getRuntime } from "../runtime.ts";
import { registerSubagentTool } from "../tools/subagent-tool.ts";

const mockedGetRuntime = vi.mocked(getRuntime);

// ============================================================
// 类型辅助
// ============================================================

/** execute 的最小返回形状（content + details） */
interface ExecuteResult {
  content: Array<{ type: string; text?: string }>;
  details: Record<string, unknown>;
}

/** 捕获的 tool 对象（只关心 execute） */
interface CapturedTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (partial: ExecuteResult) => void,
  ) => Promise<ExecuteResult>;
}

/** mock runtime 的鸭子类型（execute 用到的方法） */
interface MockRuntime {
  runAgent: ReturnType<typeof vi.fn>;
  startBackground: ReturnType<typeof vi.fn>;
  getBackground: ReturnType<typeof vi.fn>;
  getAgentConfig: ReturnType<typeof vi.fn>;
}

// ============================================================
// 辅助构造
// ============================================================

/** 注册工具并捕获传给 pi.registerTool 的对象 */
function captureTool(): CapturedTool {
  let captured: CapturedTool | undefined;
  const pi = {
    registerTool: (tool: CapturedTool) => {
      captured = tool;
    },
  };
  registerSubagentTool(pi as never);
  if (!captured) throw new Error("registerSubagentTool did not call pi.registerTool");
  return captured;
}

/** 鸭子类型 mock runtime（不依赖 SubagentRuntime 真实实现） */
function makeMockRuntime(overrides: Partial<MockRuntime> = {}): MockRuntime {
  return {
    runAgent: overrides.runAgent ?? vi.fn(),
    startBackground: overrides.startBackground ?? vi.fn(),
    getBackground: overrides.getBackground ?? vi.fn(),
    // FR-O2.2: 默认返回 undefined（无 defaultBackground 配置 → 走 sync）
    getAgentConfig: overrides.getAgentConfig ?? vi.fn(() => undefined),
  };
}

/** 标准 success AgentResult */
function successResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    text: "task done",
    parsedOutput: { artifacts: ["a", "b"] },
    turns: 1,
    durationMs: 100,
    success: true,
    sessionId: "sess-1",
    toolCalls: [],
    ...overrides,
  };
}

// ============================================================
// 测试
// ============================================================

describe("subagent tool execute()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetRuntime.mockReset();
  });

  // ── 场景 1: 同步成功 ────────────────────────────────────
  it("sync mode: returns content text + details (status/turns/tokens/result) on success", async () => {
    const mockRt = makeMockRuntime({
      // 让 mock runAgent 同步触发一次 turn_end + message_end，
      // 以验证 execute 内部事件累加（turns / totalTokens / eventLog）
      runAgent: vi.fn(async (opts: { onEvent?: (e: unknown) => void }) => {
        opts.onEvent?.({ type: "turn_end" });
        opts.onEvent?.({
          type: "message_end",
          usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0 },
        });
        return successResult();
      }),
    });
    mockedGetRuntime.mockReturnValue(mockRt as never);

    const tool = captureTool();
    const result = await tool.execute("call-1", { task: "do X", agent: "worker" });

    // runAgent 被调用且收到 task/agent
    expect(mockRt.runAgent).toHaveBeenCalledOnce();
    const callOpts = mockRt.runAgent.mock.calls[0][0] as { task: string; agent: string };
    expect(callOpts.task).toBe("do X");
    expect(callOpts.agent).toBe("worker");

    // content[0].text === result.text
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe("task done");

    // details 关键字段
    const details = result.details;
    expect(details.status).toBe("done");
    expect(details.agent).toBe("worker");
    expect(details.turns).toBe(1); // 来自 turn_end 累加
    expect(details.totalTokens).toBe(30); // 10 + 20，来自 message_end
    expect(details.result).toBe("task done"); // === result.text
    expect(Array.isArray(details.eventLog)).toBe(true);
    expect(details.eventLog).toHaveLength(1); // turn_end push 一条
  });

  // ── 场景 2: 同步失败 ────────────────────────────────────
  it("sync mode: throws Error(result.error) when runAgent returns success=false", async () => {
    const mockRt = makeMockRuntime({
      runAgent: vi.fn(async () => ({
        text: "",
        turns: 0,
        durationMs: 5,
        success: false,
        error: "model unavailable",
        sessionId: "",
        toolCalls: [],
      })),
    });
    mockedGetRuntime.mockReturnValue(mockRt as never);

    const tool = captureTool();
    await expect(tool.execute("call-2", { task: "fail me" })).rejects.toThrow("model unavailable");
  });

  // ── 场景 3: background 模式 ──────────────────────────────
  it("background mode (wait:false): returns backgroundId immediately with status running", async () => {
    const handle: BackgroundHandle = { id: "bg-1", status: "running" };
    const mockRt = makeMockRuntime({
      startBackground: vi.fn(() => handle),
    });
    mockedGetRuntime.mockReturnValue(mockRt as never);

    const tool = captureTool();
    const result = await tool.execute("call-3", { task: "do X", wait: false });

    // startBackground 被调用，task 透传
    expect(mockRt.startBackground).toHaveBeenCalledOnce();
    expect(mockRt.runAgent).not.toHaveBeenCalled();
    const opts = mockRt.startBackground.mock.calls[0][0] as { task: string };
    expect(opts.task).toBe("do X");

    // content 文本含 backgroundId
    const text = result.content[0].text ?? "";
    expect(text).toContain("bg-1");

    // details
    const details = result.details;
    expect(details.status).toBe("running");
    expect(details.backgroundId).toBe("bg-1");
    expect(details.agent).toBe("default"); // 未传 agent → 默认
  });

  // ── 场景 4: 轮询 running ────────────────────────────────
  it("poll mode: running status returns 'still running' text + details.status=running", async () => {
    const status: BackgroundStatus = {
      id: "bg-1",
      status: "running",
      startedAt: Date.now() - 5000,
      agent: "worker",
      eventLog: [],
    };
    const mockRt = makeMockRuntime({
      getBackground: vi.fn(() => status),
    });
    mockedGetRuntime.mockReturnValue(mockRt as never);

    const tool = captureTool();
    const result = await tool.execute("call-4", { backgroundId: "bg-1" });

    // getBackground 被调用
    expect(mockRt.getBackground).toHaveBeenCalledWith("bg-1");

    // content 提示仍在运行
    const text = result.content[0].text ?? "";
    expect(text).toContain("bg-1");
    expect(text).toMatch(/running/i);

    // details
    const details = result.details;
    expect(details.status).toBe("running");
    expect(details.agent).toBe("worker");
    expect(details.turns).toBe(0);
    expect(details.totalTokens).toBe(0);
    expect(typeof details.elapsedSeconds).toBe("number");
  });

  // ── 场景 5: 轮询 done ───────────────────────────────────
  it("poll mode: done status returns result.text + details with result/turns", async () => {
    const status: BackgroundStatus = {
      id: "bg-1",
      status: "done",
      startedAt: Date.now() - 10000,
      endedAt: Date.now() - 1000,
      agent: "worker",
      result: successResult({ text: "bg done output" }),
      eventLog: [],
    };
    const mockRt = makeMockRuntime({
      getBackground: vi.fn(() => status),
    });
    mockedGetRuntime.mockReturnValue(mockRt as never);

    const tool = captureTool();
    const result = await tool.execute("call-5", { backgroundId: "bg-1" });

    // content text === result.text
    expect(result.content[0].text).toBe("bg done output");

    // details
    const details = result.details;
    expect(details.status).toBe("done");
    expect(details.result).toBe("bg done output");
    expect(details.turns).toBe(1); // 来自 status.result.turns
    expect(details.agent).toBe("worker");
    expect(details.totalTokens).toBe(0); // successResult 默认无 usage → 0
  });

  // ── 场景 6: 轮询 backgroundId 不存在 ────────────────────
  it("poll mode: unknown backgroundId throws 'not found'", async () => {
    const mockRt = makeMockRuntime({
      getBackground: vi.fn(() => undefined),
    });
    mockedGetRuntime.mockReturnValue(mockRt as never);

    const tool = captureTool();
    await expect(tool.execute("call-6", { backgroundId: "nope" })).rejects.toThrow(/not found/);
  });

  // ── 场景 7: 缺 task 且非轮询 ────────────────────────────
  it("missing task in non-poll mode throws 'task required'", async () => {
    const mockRt = makeMockRuntime();
    mockedGetRuntime.mockReturnValue(mockRt as never);

    const tool = captureTool();
    await expect(tool.execute("call-7", {})).rejects.toThrow(/task.*required|required.*task/i);
  });

  // ── 场景 8: runtime 未初始化 ────────────────────────────
  it("uninitialized runtime (getRuntime undefined) throws 'not initialized'", async () => {
    // 不 mockReturnValue → getRuntime 默认返回 undefined
    mockedGetRuntime.mockReturnValue(undefined as never);

    const tool = captureTool();
    await expect(tool.execute("call-8", { task: "x" })).rejects.toThrow(/not initialized/i);
  });

  // ── FR-O2.2: effectiveWait 三档判定（端到端，B1）──────────
  it("FR-O2: agent with defaultBackground:true + no wait → startBackground called, runAgent not", async () => {
    const mockRt = makeMockRuntime({
      runAgent: vi.fn(async () => successResult()),
      startBackground: vi.fn(() => ({ id: "bg-1", status: "running" as const })),
      getAgentConfig: vi.fn(() => ({ name: "researcher", systemPrompt: "", defaultBackground: true, source: "builtin" })),
    });
    mockedGetRuntime.mockReturnValue(mockRt as never);

    const tool = captureTool();
    await tool.execute("call-bg-1", { task: "research X", agent: "researcher" });

    expect(mockRt.startBackground).toHaveBeenCalledTimes(1);
    expect(mockRt.runAgent).not.toHaveBeenCalled();
  });

  it("FR-O2: agent with defaultBackground:true + explicit wait:true → runAgent called (sync)", async () => {
    const mockRt = makeMockRuntime({
      runAgent: vi.fn(async () => successResult()),
      startBackground: vi.fn(() => ({ id: "bg-2", status: "running" as const })),
      getAgentConfig: vi.fn(() => ({ name: "researcher", systemPrompt: "", defaultBackground: true, source: "builtin" })),
    });
    mockedGetRuntime.mockReturnValue(mockRt as never);

    const tool = captureTool();
    await tool.execute("call-sync-1", { task: "research X", agent: "researcher", wait: true });

    expect(mockRt.runAgent).toHaveBeenCalledTimes(1);
    expect(mockRt.startBackground).not.toHaveBeenCalled();
  });

  it("FR-O2: agent without defaultBackground + no wait → defaults to sync (runAgent)", async () => {
    const mockRt = makeMockRuntime({
      runAgent: vi.fn(async () => successResult()),
      startBackground: vi.fn(() => ({ id: "bg-3", status: "running" as const })),
      getAgentConfig: vi.fn(() => ({ name: "worker", systemPrompt: "", source: "builtin" })),
    });
    mockedGetRuntime.mockReturnValue(mockRt as never);

    const tool = captureTool();
    await tool.execute("call-sync-2", { task: "do work", agent: "worker" });

    expect(mockRt.runAgent).toHaveBeenCalledTimes(1);
    expect(mockRt.startBackground).not.toHaveBeenCalled();
  });

  it("FR-O4: sync mode passes priority:0 to runAgent", async () => {
    const runAgentMock = vi.fn(async () => successResult());
    const mockRt = makeMockRuntime({ runAgent: runAgentMock });
    mockedGetRuntime.mockReturnValue(mockRt as never);

    const tool = captureTool();
    await tool.execute("call-prio", { task: "do work" });

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const passedOpts = runAgentMock.mock.calls[0]![0] as { priority?: number };
    expect(passedOpts.priority).toBe(0);
  });
});
