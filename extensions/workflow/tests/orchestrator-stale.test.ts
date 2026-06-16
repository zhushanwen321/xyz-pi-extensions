// 测试框架：vitest
// 运行命令：npx vitest run tests/orchestrator-stale.test.ts
//
// Round 4 MF6: executeWithRetry / restart / runAndWait / isStaleContextErrorMsg 零测试。
// 本文件覆盖：
//   1. isStaleContextErrorMsg 纯函数（不依赖 runtime）
//   2. executeWithRetry 的 stale-context 早返回路径（mock pool 返回 stale 错误，验证不重试）
//   3. executeWithRetry 的 budget 累加（Round 5 MF#4 验证：retry 失败的 token 也应计入 budget）
//   4. executeWithRetry 的 MAX_AGENT_RETRIES 重试上限

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock fs.promises before importing the module under test
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn(),
    },
  };
});

// 避免加载 @zhushanwen/pi-subagents 真实包（其 node_modules 没有 @mariozechner/pi-ai）
vi.mock("@zhushanwen/pi-subagents", () => ({
  getRuntime: () => ({
    agentRegistry: {
      discoverAll: vi.fn(),
      list: vi.fn(() => []),
      get: vi.fn((name: string) => ({ name, systemPrompt: "You are " + name, source: "builtin" })),
    },
    builtinRegistry: {
      get: vi.fn(),
    },
  }),
}));

// Mock AgentPool：让 executeWithRetry 的 pool.enqueue 行为可控
// 必须用 vi.fn() 才能跟踪调用计数（class 字段初始化器只在 new 之后才生效）。
vi.mock("../src/infra/agent-pool.js", () => ({
  AgentPool: class MockAgentPool {
    enqueue: ReturnType<typeof vi.fn>;
    setBudget: ReturnType<typeof vi.fn>;
    constructor(_opts?: unknown) {
      this.enqueue = vi.fn();
      this.setBudget = vi.fn();
    }
  },
}));

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { AgentPool } from "../src/infra/agent-pool.js";
import { WorkflowOrchestrator } from "../src/orchestrator";
import { isStaleContextErrorMsg, STALE_CONTEXT_PATTERNS } from "../src/orchestrator";
import { executeWithRetry, type AgentCallContext } from "../src/engine/agent-call-handler";
import { createInstance, type WorkflowStatus } from "../src/domain/state";

// ── isStaleContextErrorMsg 纯函数测试 ────────────────────────

describe("isStaleContextErrorMsg", () => {
  it("undefined 返回 false", () => {
    expect(isStaleContextErrorMsg(undefined)).toBe(false);
  });

  it("空字符串返回 false", () => {
    expect(isStaleContextErrorMsg("")).toBe(false);
  });

  it("stale context（小写）匹配", () => {
    expect(isStaleContextErrorMsg("error: stale context detected")).toBe(true);
  });

  it("StaleContext 驼峰匹配", () => {
    expect(isStaleContextErrorMsg("StaleContextException thrown")).toBe(true);
  });

  it("context canceled 匹配", () => {
    expect(isStaleContextErrorMsg("Agent failed: context canceled by user")).toBe(true);
  });

  it("aborted 匹配", () => {
    expect(isStaleContextErrorMsg("Operation aborted")).toBe(true);
  });

  it("大小写不敏感：STALE CONTEXT", () => {
    expect(isStaleContextErrorMsg("STALE CONTEXT error")).toBe(true);
  });

  it("不相关的错误不匹配", () => {
    expect(isStaleContextErrorMsg("rate limit exceeded")).toBe(false);
    expect(isStaleContextErrorMsg("network timeout")).toBe(false);
    expect(isStaleContextErrorMsg("invalid api key")).toBe(false);
  });

  it("匹配优先级：patterns 数组至少覆盖上述 4 种场景", () => {
    // Sanity check 模式列表完整性
    expect(STALE_CONTEXT_PATTERNS).toContain("stale context");
    expect(STALE_CONTEXT_PATTERNS).toContain("stalecontext");
    expect(STALE_CONTEXT_PATTERNS).toContain("context canceled");
    expect(STALE_CONTEXT_PATTERNS).toContain("aborted");
  });
});

// ── pauseOnSignal signal→pause 转换路径测试 ──────────────────────────────

describe("signal-triggered pause", () => {
  it("abort signal triggers pauseOnSignal which transitions to paused", () => {
    const mockPi = makeMockPi();
    const mockCtx = makeMockCtx();
    const orch = new WorkflowOrchestrator(mockPi, mockCtx);
    const inst = makeRunningInstance("wf-signal-1");
    orch.restoreInstances(new Map([[inst.runId, inst]]));

    // Access private pauseOnSignal via type cast
    const pauseOnSignal = (orch as unknown as {
      pauseOnSignal: (runId: string) => void;
    }).pauseOnSignal;

    // Verify pre-condition
    expect(inst.status).toBe("running");
    expect(inst.pausedAt).toBeUndefined();

    // Trigger pauseOnSignal
    pauseOnSignal.call(orch, inst.runId);

    // Verify: status transitioned to paused
    expect(inst.status).toBe("paused");
    expect(inst.pausedAt).toBeDefined();
  });

  it("pauseOnSignal is a no-op for non-running instances", () => {
    const mockPi = makeMockPi();
    const mockCtx = makeMockCtx();
    const orch = new WorkflowOrchestrator(mockPi, mockCtx);
    const inst = makeRunningInstance("wf-signal-2");
    inst.status = "paused" as WorkflowStatus;
    orch.restoreInstances(new Map([[inst.runId, inst]]));

    const pauseOnSignal = (orch as unknown as {
      pauseOnSignal: (runId: string) => void;
    }).pauseOnSignal;

    pauseOnSignal.call(orch, inst.runId);

    // Should remain paused, not throw or crash
    expect(inst.status).toBe("paused");
  });
});

// ── executeWithRetry 集成测试 ───────────────────────────────────────────

function makeMockPi(): ExtensionAPI {
  return {
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
  } as unknown as ExtensionAPI;
}

function makeMockCtx(): ExtensionContext {
  return {
    sessionManager: {
      getSessionId: vi.fn().mockReturnValue("test-session"),
      getEntries: vi.fn().mockReturnValue([]),
      getBranch: vi.fn().mockReturnValue([]),
    },
    ui: { notify: vi.fn() },
  } as unknown as ExtensionContext;
}

function makeRunningInstance(runId: string) {
  const inst = createInstance({
    runId,
    name: `workflow-${runId}`,
    worker: "agent-test",
    budget: { maxTokens: 100_000, maxTimeMs: undefined },
  });
  inst.status = "running";
  inst.startedAt = new Date().toISOString();
  return inst;
}

describe("executeWithRetry", () => {
  let mockPi: ExtensionAPI;
  let mockCtx: ExtensionContext;

  beforeEach(() => {
    mockPi = makeMockPi();
    mockCtx = makeMockCtx();
    vi.clearAllMocks();
  });

  it("stale context: 失败时早返回，不重试", async () => {
    // Setup：注册一个 running instance + pool
    const inst = makeRunningInstance("wf-stale-1");
    const orch2 = new WorkflowOrchestrator(mockPi, mockCtx);
    const poolInstance = new AgentPool({ maxConcurrency: 1, runName: inst.name });
    // 把 pool 注入到 orchestrator 私有 runPools map
    (orch2 as unknown as { runPools: Map<string, AgentPool> }).runPools.set(inst.runId, poolInstance);
    (orch2 as unknown as { runAbortControllers: Map<string, AbortController> }).runAbortControllers.set(
      inst.runId,
      new AbortController(),
    );
    // mock enqueue 返回 stale context 错误
    (poolInstance.enqueue as ReturnType<typeof vi.fn>).mockResolvedValue({
      callId: "agent-1",
      output: "",
      success: false,
      error: "stale context detected",
      toolCalls: [],
    });
    orch2.restoreInstances(new Map([[inst.runId, inst]]));

    // executeWithRetry 已抽为模块函数，通过 agentCallContext() 注入 orchestrator 依赖
    const ctx = (orch2 as unknown as { agentCallContext: () => AgentCallContext }).agentCallContext();
    const node = {
      stepIndex: 0,
      agent: "test-agent",
      task: "do work",
      model: "default",
      status: "running",
      startedAt: new Date().toISOString(),
    };
    await executeWithRetry(ctx, inst.runId, 0, { prompt: "x", agent: "test-agent" }, inst, node);

    // enqueue 只调一次（stale context 不重试）
    expect(poolInstance.enqueue).toHaveBeenCalledTimes(1);
    // budget 未被累加（poolResult.usage 缺失）
    expect(inst.budget.usedTokens).toBe(0);
  });

  it("Round 5 MF#4: 普通失败的 retry 仍计入 budget", async () => {
    const inst = makeRunningInstance("wf-budget-1");
    const orch2 = new WorkflowOrchestrator(mockPi, mockCtx);
    const poolInstance = new AgentPool({ maxConcurrency: 1, runName: inst.name });
    (orch2 as unknown as { runPools: Map<string, AgentPool> }).runPools.set(inst.runId, poolInstance);
    // 注入 runAbortController（executeWithRetry 的 setTimeout 回调会检查 has(runId)）
    (orch2 as unknown as { runAbortControllers: Map<string, AbortController> }).runAbortControllers.set(
      inst.runId,
      new AbortController(),
    );
    // mock enqueue 始终返回失败（达到 MAX_AGENT_RETRIES 上限）
    (poolInstance.enqueue as ReturnType<typeof vi.fn>).mockResolvedValue({
      callId: "agent-budget",
      output: "",
      success: false,
      error: "rate limit exceeded", // 非 stale context，触发 retry
      usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 100, turns: 0 },
      toolCalls: [],
    });
    orch2.restoreInstances(new Map([[inst.runId, inst]]));

    const ctx = (orch2 as unknown as { agentCallContext: () => AgentCallContext }).agentCallContext();
    const node = {
      stepIndex: 0,
      agent: "test-agent",
      task: "do work",
      model: "default",
      status: "running",
      startedAt: new Date().toISOString(),
    };
    // Round 5 MF#4 验证：原代码 token 累加在 retry 之后，retry 失败的 token 永不计入。
    // 修复后累加在 retry 之前，每次 poolResult 返回都 +100 input。
    // MAX_AGENT_RETRIES=3 → 最多 3 次 enqueue（initial + 2 retries），但累加的是 budget。
    // 使用 fake timers + runAllTimersAsync 推进 setTimeout 链路（retry 用 1s/2s 指数退避）。
    vi.useFakeTimers();
    try {
      const promise = executeWithRetry(ctx, inst.runId, 0, { prompt: "x", agent: "test-agent" }, inst, node);
      // 推进所有 pending timers 多次（每次 runAllTimersAsync 推进一轮微任务）
      for (let i = 0; i < 5; i++) {
        await vi.runAllTimersAsync();
      }
      await promise;
    } finally {
      vi.useRealTimers();
    }

    // 初始调用 + 2 次重试 = 3 次 enqueue
    expect(poolInstance.enqueue).toHaveBeenCalledTimes(3);
    // Round 5 MF#4 验证：3 次调用都累加 budget（修复前 0，修复后 3*100=300）
    expect(inst.budget.usedTokens).toBe(300);
  });
});

