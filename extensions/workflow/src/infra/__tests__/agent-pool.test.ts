// 测试框架：vitest
// 运行命令：npx vitest run src/infra/__tests__/agent-pool.test.ts
//
// 验证 AgentPool.enqueue 的 mapResult 行为：
//   1. toolCalls.input 优先取 args（调用参数），而非 result.details（返回值）
//   2. args 缺失时回退到 result.details（向后兼容）
//   3. usage.contextTokens = input + output + cacheRead + cacheWrite（不再硬编码 0）
//   4. runtime 未初始化时返回 error 结果

import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.hoisted：在 vi.mock 工厂执行前已就绪的可变状态。
// vi.mock 被 hoist 到文件顶部，工厂内只能引用 hoisted 变量。
const mockState = vi.hoisted(() => ({
  runtime: undefined as
    | { runAgent: (opts: unknown) => Promise<unknown> }
    | undefined,
}));

vi.mock("@zhushanwen/pi-subagents", () => ({
  getRuntime: () => mockState.runtime,
}));

import { AgentPool } from "../agent-pool.js";

// ── 测试用 AgentResult 构造器 ─────────────────────────────────

interface SubAgentResult {
  text: string;
  parsedOutput?: unknown;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  turns: number;
  durationMs: number;
  success: boolean;
  error?: string;
  sessionId: string;
  toolCalls: Array<{
    toolName: string;
    args?: unknown;
    result?: { details?: unknown };
    isError: boolean;
  }>;
}

function makeResult(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
  return {
    text: "ok",
    turns: 1,
    durationMs: 10,
    success: true,
    sessionId: "sess-1",
    toolCalls: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockState.runtime = undefined;
});

describe("AgentPool.enqueue — mapResult", () => {
  it("toolCalls.input 优先使用 args（调用参数）而非 result.details", async () => {
    const args = { path: "/some/file.ts", limit: 100 };
    mockState.runtime = {
      runAgent: vi.fn().mockResolvedValue(
        makeResult({
          toolCalls: [
            {
              toolName: "read",
              args,
              result: { details: { shouldNotBeUsed: true } },
              isError: false,
            },
          ],
        }),
      ),
    };

    const pool = new AgentPool({ maxConcurrency: 1 });
    const result = await pool.enqueue({ prompt: "do something" });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("read");
    // args 被序列化为 input，截断到 200 字符以内
    expect(result.toolCalls[0].input).toBe(JSON.stringify(args).slice(0, 200));
    // 确保 result.details 没有泄漏到 input
    expect(result.toolCalls[0].input).not.toContain("shouldNotBeUsed");
  });

  it("args 缺失时 fallback 到 result.details（向后兼容）", async () => {
    const details = { output: 42, summary: "done" };
    mockState.runtime = {
      runAgent: vi.fn().mockResolvedValue(
        makeResult({
          toolCalls: [
            {
              toolName: "structured-output",
              // 故意不提供 args
              result: { details },
              isError: false,
            },
          ],
        }),
      ),
    };

    const pool = new AgentPool({ maxConcurrency: 1 });
    const result = await pool.enqueue({ prompt: "do something" });

    expect(result.toolCalls[0].name).toBe("structured-output");
    expect(result.toolCalls[0].input).toBe(JSON.stringify(details).slice(0, 200));
  });

  it("args 和 result.details 都缺失时 input 为空串", async () => {
    mockState.runtime = {
      runAgent: vi.fn().mockResolvedValue(
        makeResult({
          toolCalls: [{ toolName: "bash", isError: false }],
        }),
      ),
    };

    const pool = new AgentPool({ maxConcurrency: 1 });
    const result = await pool.enqueue({ prompt: "do something" });

    expect(result.toolCalls[0].input).toBe("");
  });

  it("usage.contextTokens = input + output + cacheRead + cacheWrite", async () => {
    const usage = { input: 100, output: 200, cacheRead: 10, cacheWrite: 5, cost: 3.15 };
    mockState.runtime = {
      runAgent: vi.fn().mockResolvedValue(makeResult({ usage, turns: 3 })),
    };

    const pool = new AgentPool({ maxConcurrency: 1 });
    const result = await pool.enqueue({ prompt: "do something" });

    expect(result.usage).toBeDefined();
    expect(result.usage!.contextTokens).toBe(100 + 200 + 10 + 5);
    expect(result.usage!.contextTokens).toBe(315);
    expect(result.usage!.turns).toBe(3);
    // 其他 usage 字段直传
    expect(result.usage!.input).toBe(100);
    expect(result.usage!.output).toBe(200);
    expect(result.usage!.cost).toBe(3.15);
  });

  it("usage 缺失时 result.usage 为 undefined（不报错）", async () => {
    mockState.runtime = {
      runAgent: vi.fn().mockResolvedValue(makeResult({ usage: undefined })),
    };

    const pool = new AgentPool({ maxConcurrency: 1 });
    const result = await pool.enqueue({ prompt: "do something" });

    expect(result.usage).toBeUndefined();
  });

  it("runtime 未初始化时返回 error 结果", async () => {
    // mockState.runtime 已在 beforeEach 置为 undefined
    const pool = new AgentPool({ maxConcurrency: 1 });
    const result = await pool.enqueue({ prompt: "do something" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("SubagentRuntime not initialized");
    expect(result.toolCalls).toEqual([]);
    expect(result.output).toBe("");
  });

  it("runAgent 抛错时封装为 error 结果（不 reject）", async () => {
    mockState.runtime = {
      runAgent: vi.fn().mockRejectedValue(new Error("boom")),
    };

    const pool = new AgentPool({ maxConcurrency: 1 });
    const result = await pool.enqueue({ prompt: "do something" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("boom");
  });

  it("signal 已 aborted 时立即返回 error", async () => {
    const controller = new AbortController();
    controller.abort();

    const pool = new AgentPool({ maxConcurrency: 1 });
    const result = await pool.enqueue({ prompt: "do something" }, controller.signal);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Operation aborted before start");
  });
});
