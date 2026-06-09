// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach）
// 运行命令：npx vitest run tests/agent-pool.test.ts
/* eslint-disable @typescript-eslint/no-explicit-any, taste/prefer-allsettled */

import { type ChildProcess,spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { beforeEach,describe, expect, it, vi } from "vitest";

import { AgentPool, SOFT_MAX_AGENTS_WARNING } from "../src/agent-pool";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// ── Helpers ─────────────────────────────────────────────────

function createMockProcess() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
}

type MockProc = ReturnType<typeof createMockProcess>;

/** Build a JSONL message_end event line. */
function messageEndJsonl(
  text: string,
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost?: number; totalTokens?: number },
  model = "test-model",
): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        cost: usage.cost ?? 0,
        totalTokens: usage.totalTokens ?? (usage.input + usage.output),
      },
      model,
      stopReason: "end_turn",
    },
  });
}

/** Emit a successful JSONL response + close on a mock process. */
function completeSuccess(proc: MockProc, text: string): void {
  proc.stdout.emit("data", Buffer.from(messageEndJsonl(text, { input: 1, output: 1 }) + "\n"));
  proc.emit("close", 0);
}

/** Let microtasks drain, then resolve on the next macrotask. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

const mockSpawn = vi.mocked(spawn);

// ═══════════════════════════════════════════════════════════════

describe("AgentPool", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  // ── Constructor & getters ──────────────────────────────────

  describe("constructor + getters", () => {
    it("defaults to concurrency 4 with empty state", () => {
      const pool = new AgentPool();
      expect(pool.activeCount).toBe(0);
      expect(pool.queueLength).toBe(0);
    });

    it("accepts custom concurrency", () => {
      const pool = new AgentPool(2);
      expect(pool.activeCount).toBe(0);
      expect(pool.queueLength).toBe(0);
    });
  });

  // ── enqueue — success path ─────────────────────────────────

  describe("enqueue — success path", () => {
    it("resolves with output and usage on happy path", async () => {
      const pool = new AgentPool(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as unknown as ChildProcess);

      const jsonl = messageEndJsonl("hello world", {
        input: 100, output: 50, cost: 0.05, totalTokens: 150,
      });

      const resultPromise = pool.enqueue({ prompt: "say hello" });
      proc.stdout.emit("data", Buffer.from(jsonl + "\n"));
      proc.emit("close", 0);

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.output).toBe("hello world");
      expect(result.error).toBeUndefined();
      expect(result.usage).toBeDefined();
      expect(result.usage!.input).toBe(100);
      expect(result.usage!.output).toBe(50);
      expect(result.usage!.cost).toBe(0.05);
      expect(result.usage!.turns).toBe(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("accumulates output and usage across multiple message_end events", async () => {
      const pool = new AgentPool(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as unknown as ChildProcess);

      const line1 = messageEndJsonl("hello", { input: 10, output: 5, cost: 0.01, totalTokens: 15 });
      const line2 = messageEndJsonl(" world", { input: 20, output: 8, cost: 0.02, totalTokens: 28 });

      const resultPromise = pool.enqueue({ prompt: "multi-turn" });
      proc.stdout.emit("data", Buffer.from(line1 + "\n" + line2 + "\n"));
      proc.emit("close", 0);

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.output).toBe("hello world");
      expect(result.usage!.input).toBe(30);
      expect(result.usage!.output).toBe(13);
      expect(result.usage!.turns).toBe(2);
    });

    it("parses structured output when schema is provided and tool call succeeds", async () => {
      const pool = new AgentPool(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as unknown as ChildProcess);

      const schema = { type: "object", properties: { name: { type: "string" } } };
      const toolStartJsonl = JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tc-1",
        toolName: "structured-output",
        args: { name: "Alice" },
      });
      const toolEndJsonl = JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "tc-1",
        toolName: "structured-output",
        isError: false,
      });
      const msgEndJsonl = messageEndJsonl("", { input: 10, output: 5 });

      const resultPromise = pool.enqueue({ prompt: "give me a name", schema });
      proc.stdout.emit("data", Buffer.from(toolStartJsonl + "\n" + toolEndJsonl + "\n" + msgEndJsonl + "\n"));
      proc.emit("close", 0);

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.parsedOutput).toEqual({ name: "Alice" });
    });

    it("returns failure when schema present but no structured-output tool call", async () => {
      const pool = new AgentPool(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as unknown as ChildProcess);

      const schema = { type: "object" };
      const jsonl = messageEndJsonl("not valid json {", { input: 10, output: 5 });

      const resultPromise = pool.enqueue({ prompt: "broken json", schema });
      proc.stdout.emit("data", Buffer.from(jsonl + "\n"));
      proc.emit("close", 0);

      const result = await resultPromise;
      // Without structured-output tool call, schema presence triggers failure
      expect(result.success).toBe(false);
      expect(result.error).toContain("structured output");
    });

    it("extracts parsedOutput after successful tool_execution_end", async () => {
      const pool = new AgentPool(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as unknown as ChildProcess);

      const schema = { type: "object", properties: { mustFix: { type: "boolean" } } };
      const toolStartJsonl = JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tc-1",
        toolName: "structured-output",
        args: { mustFix: true, issues: ["bug"] },
      });
      const toolEndJsonl = JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "tc-1",
        toolName: "structured-output",
        isError: false,
      });
      const msgEndJsonl = messageEndJsonl("", { input: 10, output: 5 });

      const resultPromise = pool.enqueue({ prompt: "check issues", schema });
      proc.stdout.emit("data", Buffer.from(toolStartJsonl + "\n" + toolEndJsonl + "\n" + msgEndJsonl + "\n"));
      proc.emit("close", 0);

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.parsedOutput).toEqual({ mustFix: true, issues: ["bug"] });
    });

    it("does not capture parsedOutput when tool_execution_end has error", async () => {
      const pool = new AgentPool(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as unknown as ChildProcess);

      const schema = { type: "object", properties: { mustFix: { type: "boolean" } } };
      const toolStartJsonl = JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tc-1",
        toolName: "structured-output",
        args: { mustFix: true, issues: ["bug"] },
      });
      const toolEndJsonl = JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "tc-1",
        toolName: "structured-output",
        isError: true,
      });
      const msgEndJsonl = messageEndJsonl("", { input: 10, output: 5 });

      const resultPromise = pool.enqueue({ prompt: "check issues", schema });
      proc.stdout.emit("data", Buffer.from(toolStartJsonl + "\n" + toolEndJsonl + "\n" + msgEndJsonl + "\n"));
      proc.emit("close", 0);

      const result = await resultPromise;
      // Validation failed — parsedOutput should NOT be captured
      expect(result.parsedOutput).toBeUndefined();
    });

    it("ignores tool_execution_start for other tools", async () => {
      const pool = new AgentPool(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as unknown as ChildProcess);

      const schema = { type: "object" };
      const toolStartJsonl = JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tc-1",
        toolName: "some-other-tool",
        args: { foo: "bar" },
      });
      const msgEndJsonl = messageEndJsonl("text output", { input: 10, output: 5 });

      const resultPromise = pool.enqueue({ prompt: "test", schema });
      proc.stdout.emit("data", Buffer.from(toolStartJsonl + "\n" + msgEndJsonl + "\n"));
      proc.emit("close", 0);

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.parsedOutput).toBeUndefined();
    });

    it("injects --append-system-prompt when systemPromptFile is set", async () => {
      const pool = new AgentPool(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as unknown as ChildProcess);

      const jsonl = messageEndJsonl("ok", { input: 1, output: 1 });
      const resultPromise = pool.enqueue({
        prompt: "use this prompt",
        systemPromptFile: "/tmp/agent-prompt-abc.md",
      });
      proc.stdout.emit("data", Buffer.from(jsonl + "\n"));
      proc.emit("close", 0);

      await resultPromise;

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const spawnArgs = mockSpawn.mock.calls[0]![1] as string[];
      const promptIdx = spawnArgs.indexOf("--append-system-prompt");
      expect(promptIdx).toBeGreaterThanOrEqual(0);
      expect(spawnArgs[promptIdx + 1]).toBe("/tmp/agent-prompt-abc.md");
      expect(spawnArgs[spawnArgs.length - 1]).toBe("use this prompt");
    });

    it("omits --append-system-prompt when systemPromptFile is not set", async () => {
      const pool = new AgentPool(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as unknown as ChildProcess);

      const jsonl = messageEndJsonl("ok", { input: 1, output: 1 });
      const resultPromise = pool.enqueue({ prompt: "no system prompt" });
      proc.stdout.emit("data", Buffer.from(jsonl + "\n"));
      proc.emit("close", 0);

      await resultPromise;

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const spawnArgs = mockSpawn.mock.calls[0]![1] as string[];
      expect(spawnArgs).not.toContain("--append-system-prompt");
    });

    it("passes --model before --append-system-prompt when both are set", async () => {
      const pool = new AgentPool(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as unknown as ChildProcess);

      const jsonl = messageEndJsonl("ok", { input: 1, output: 1 });
      const resultPromise = pool.enqueue({
        prompt: "task",
        model: "ds-flash",
        systemPromptFile: "/tmp/p.md",
      });
      proc.stdout.emit("data", Buffer.from(jsonl + "\n"));
      proc.emit("close", 0);

      await resultPromise;

      const spawnArgs = mockSpawn.mock.calls[0]![1] as string[];
      const modelIdx = spawnArgs.indexOf("--model");
      const promptIdx = spawnArgs.indexOf("--append-system-prompt");
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect(spawnArgs[modelIdx + 1]).toBe("ds-flash");
      expect(promptIdx).toBeGreaterThanOrEqual(0);
      expect(spawnArgs[promptIdx + 1]).toBe("/tmp/p.md");
    });

    it("returns failure when schema present but no structured-output tool call", async () => {
      const pool = new AgentPool(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as unknown as ChildProcess);

      const schema = { type: "object", properties: { answer: { type: "string" } } };
      const msgEndJsonl = messageEndJsonl("I think the answer is 42", { input: 10, output: 5 });

      const resultPromise = pool.enqueue({ prompt: "what is the answer", schema });
      proc.stdout.emit("data", Buffer.from(msgEndJsonl + "\n"));
      proc.emit("close", 0);

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain("structured output");
    });
  });

  // ── enqueue — failure path ─────────────────────────────────

  describe("enqueue — failure path", () => {
    it("resolves with success=false on spawn error", async () => {
      const pool = new AgentPool(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as unknown as ChildProcess);

      const resultPromise = pool.enqueue({ prompt: "fail" });
      proc.emit("error", new Error("spawn ENOENT"));

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.output).toBe("");
      expect(result.error).toContain("spawn ENOENT");
    });

    it("resolves with success=false and stderr on non-zero exit code", async () => {
      const pool = new AgentPool(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as unknown as ChildProcess);

      const resultPromise = pool.enqueue({ prompt: "fail" });
      proc.stderr.emit("data", Buffer.from("something went wrong"));
      proc.emit("close", 1);

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain("something went wrong");
    });

    it("never rejects — even spawn errors resolve with a result", async () => {
      const pool = new AgentPool(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as unknown as ChildProcess);

      const resultPromise = pool.enqueue({ prompt: "never reject" });
      proc.emit("error", new Error("catastrophic"));

      // Promise resolves (not rejects) with success=false
      const result = await resultPromise;
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });
  });

  // ── Concurrency control ────────────────────────────────────

  describe("concurrency control", () => {
    it("dispatches up to maxConcurrency tasks and queues the rest", async () => {
      const pool = new AgentPool(4);
      const processes: MockProc[] = [];

      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        processes.push(proc);
        return proc as unknown as ChildProcess;
      });

      // Enqueue 6 tasks — only 4 should spawn immediately
      const promises = Array.from({ length: 6 }, (_, i) =>
        pool.enqueue({ prompt: `task-${i}` }),
      );

      expect(pool.activeCount).toBe(4);
      expect(pool.queueLength).toBe(2);
      expect(processes).toHaveLength(4);

      // Complete task-0 → drain pulls task-4 from queue
      completeSuccess(processes[0], "done-0");
      await flush();

      expect(pool.activeCount).toBe(4);
      expect(pool.queueLength).toBe(1);
      expect(processes).toHaveLength(5);

      // Complete tasks 1-4 → drain pulls task-5
      for (let i = 1; i < 5; i++) {
        completeSuccess(processes[i], `done-${i}`);
      }
      await flush();

      expect(processes).toHaveLength(6);
      expect(pool.queueLength).toBe(0);

      // Complete final task
      completeSuccess(processes[5], "done-5");

      const results = await Promise.all(promises);
      expect(results).toHaveLength(6);
      expect(results.every((r) => r.success)).toBe(true);
      expect(pool.activeCount).toBe(0);
      expect(pool.queueLength).toBe(0);
    });

    it("with concurrency=1, runs tasks strictly sequentially", async () => {
      const pool = new AgentPool(1);
      const processes: MockProc[] = [];

      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        processes.push(proc);
        return proc as unknown as ChildProcess;
      });

      const p1 = pool.enqueue({ prompt: "first" });
      const p2 = pool.enqueue({ prompt: "second" });

      // Only first task dispatched
      expect(pool.activeCount).toBe(1);
      expect(pool.queueLength).toBe(1);
      expect(processes).toHaveLength(1);

      // Complete first → second starts
      completeSuccess(processes[0], "first-done");
      await flush();

      expect(pool.activeCount).toBe(1);
      expect(pool.queueLength).toBe(0);
      expect(processes).toHaveLength(2);

      // Complete second
      completeSuccess(processes[1], "second-done");

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.success).toBe(true);
      expect(r1.output).toBe("first-done");
      expect(r2.success).toBe(true);
      expect(r2.output).toBe("second-done");
    });
  });

  // ── JSONL parsing (indirect via enqueue) ───────────────────

  describe("JSONL parsing (via enqueue)", () => {
    it("ignores non-message_end events", async () => {
      const pool = new AgentPool(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as unknown as ChildProcess);

      const ignoredLine = JSON.stringify({ type: "tool_call", tool: "read", args: {} });
      const goodLine = messageEndJsonl("final", { input: 5, output: 3 });

      const resultPromise = pool.enqueue({ prompt: "test" });
      proc.stdout.emit("data", Buffer.from(ignoredLine + "\n" + goodLine + "\n"));
      proc.emit("close", 0);

      const result = await resultPromise;
      expect(result.output).toBe("final");
      expect(result.usage!.turns).toBe(1);
    });

    it("parses data flushed from buffer on close (no trailing newline)", async () => {
      const pool = new AgentPool(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as unknown as ChildProcess);

      const line = messageEndJsonl("flushed", { input: 5, output: 3 });

      const resultPromise = pool.enqueue({ prompt: "test" });
      // No trailing newline — stays in buffer until close flushes it
      proc.stdout.emit("data", Buffer.from(line));
      proc.emit("close", 0);

      const result = await resultPromise;
      expect(result.output).toBe("flushed");
    });

    it("skips malformed JSON lines without failing", async () => {
      const pool = new AgentPool(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as unknown as ChildProcess);

      const resultPromise = pool.enqueue({ prompt: "test" });
      proc.stdout.emit("data", Buffer.from("not json at all\n" + messageEndJsonl("ok", { input: 5, output: 3 }) + "\n"));
      proc.emit("close", 0);

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.output).toBe("ok");
    });

    it("returns undefined usage when no message_end events arrive", async () => {
      const pool = new AgentPool(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as unknown as ChildProcess);

      const resultPromise = pool.enqueue({ prompt: "empty" });
      proc.emit("close", 0);

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.output).toBe("");
      expect(result.usage).toBeUndefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Soft warning infrastructure tests
// ═══════════════════════════════════════════════════════════════

describe("AgentPool — soft warning infrastructure", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it("initial totalCallCount is zero", () => {
    const pool = new AgentPool();
    expect((pool as any).totalCallCount).toBe(0);
  });

  it("soft_warning_fires_once_at_501", () => {
    const callback = vi.fn();
    const count = SOFT_MAX_AGENTS_WARNING + 1; // 501
    const pool = new AgentPool({
      maxConcurrency: count,
      onSoftLimitReached: callback,
    });
    pool.setBudget({ usedTokens: 0, usedCost: 0, maxTokens: 100000 });
    const anyPool = pool as any;

    // With concurrency >= 501, drain() starts all calls synchronously.
    // Each run() increments totalCallCount before its first await.
    for (let i = 0; i < count; i++) {
      const proc = createMockProcess();
      mockSpawn.mockReturnValueOnce(proc as unknown as ChildProcess);
      pool.enqueue({ prompt: `call-${i}` });
      completeSuccess(proc, `result-${i}`);
    }

    // After 501 calls, totalCallCount should be 501
    expect(anyPool.totalCallCount).toBe(count);
    // Callback should have been called exactly once
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        totalCalls: count,
        runName: expect.any(String),
      }),
    );
  });

  it("soft_warning_does_not_fire_under_500", () => {
    const callback = vi.fn();
    const pool = new AgentPool({
      maxConcurrency: SOFT_MAX_AGENTS_WARNING,
      onSoftLimitReached: callback,
    });
    const anyPool = pool as any;

    // Simulate exactly 500 real spawns — 500 is NOT > 500
    for (let i = 0; i < SOFT_MAX_AGENTS_WARNING; i++) {
      const proc = createMockProcess();
      mockSpawn.mockReturnValueOnce(proc as unknown as ChildProcess);
      pool.enqueue({ prompt: `call-${i}` });
      completeSuccess(proc, `result-${i}`);
    }

    expect(anyPool.totalCallCount).toBe(SOFT_MAX_AGENTS_WARNING);
    expect(callback).not.toHaveBeenCalled();
  });

  it("soft_warning_does_not_fire_twice", () => {
    const callback = vi.fn();
    const pool = new AgentPool({
      maxConcurrency: 600,
      onSoftLimitReached: callback,
    });
    pool.setBudget({ usedTokens: 0, usedCost: 0 });
    const anyPool = pool as any;

    // Simulate 600 real spawns — callback should fire exactly once
    for (let i = 0; i < 600; i++) {
      const proc = createMockProcess();
      mockSpawn.mockReturnValueOnce(proc as unknown as ChildProcess);
      pool.enqueue({ prompt: `call-${i}` });
      completeSuccess(proc, `result-${i}`);
    }

    expect(anyPool.totalCallCount).toBe(600);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("cache_hit_does_not_increment", async () => {
    // After _callCache removal, every call is a real spawn.
    // This test now verifies that each enqueue() increments totalCallCount.
    const pool = new AgentPool({ maxConcurrency: 2 });
    const anyPool = pool as any;

    expect(anyPool.totalCallCount).toBe(0);

    // First call
    const proc1 = createMockProcess();
    mockSpawn.mockReturnValueOnce(proc1 as unknown as ChildProcess);
    pool.enqueue({ prompt: "call-1" });
    completeSuccess(proc1, "result-1");

    // Second call
    const proc2 = createMockProcess();
    mockSpawn.mockReturnValueOnce(proc2 as unknown as ChildProcess);
    pool.enqueue({ prompt: "call-2" });
    completeSuccess(proc2, "result-2");

    expect(anyPool.totalCallCount).toBe(2);
  });

  it("per_instance_counter_is_independent", () => {
    const callback1 = vi.fn();
    const callback2 = vi.fn();

    const pool1 = new AgentPool({
      maxConcurrency: 501,
      onSoftLimitReached: callback1,
    });
    pool1.setBudget({ usedTokens: 0, usedCost: 0 });
    const pool2 = new AgentPool({
      maxConcurrency: 100,
      onSoftLimitReached: callback2,
    });
    pool2.setBudget({ usedTokens: 0, usedCost: 0 });

    // pool1: 501 calls -> should fire
    for (let i = 0; i < SOFT_MAX_AGENTS_WARNING + 1; i++) {
      const proc = createMockProcess();
      mockSpawn.mockReturnValueOnce(proc as unknown as ChildProcess);
      pool1.enqueue({ prompt: `p1-${i}` });
      completeSuccess(proc, `done-${i}`);
    }

    // pool2: 100 calls -> should NOT fire
    for (let i = 0; i < 100; i++) {
      const proc = createMockProcess();
      mockSpawn.mockReturnValueOnce(proc as unknown as ChildProcess);
      pool2.enqueue({ prompt: `p2-${i}` });
      completeSuccess(proc, `done-${i}`);
    }

    expect((pool1 as any).totalCallCount).toBe(SOFT_MAX_AGENTS_WARNING + 1);
    expect((pool2 as any).totalCallCount).toBe(100);
    expect(callback1).toHaveBeenCalledTimes(1);
    expect(callback2).not.toHaveBeenCalled();
  });

  it("callback_receives_runName_budget_and_totalCalls", () => {
    const callback = vi.fn();
    const count = SOFT_MAX_AGENTS_WARNING + 1;
    const pool = new AgentPool({
      maxConcurrency: count,
      runName: "test-workflow",
      onSoftLimitReached: callback,
    });
    pool.setBudget({ usedTokens: 5000, usedCost: 0.5, maxTokens: 100000 });

    // Fire 501 calls
    for (let i = 0; i < count; i++) {
      const proc = createMockProcess();
      mockSpawn.mockReturnValueOnce(proc as unknown as ChildProcess);
      pool.enqueue({ prompt: `call-${i}` });
      completeSuccess(proc, `result-${i}`);
    }

    expect(callback).toHaveBeenCalledTimes(1);
    const arg = callback.mock.calls[0][0];
    expect(arg).toHaveProperty("runName");
    expect(arg.runName).toBe("test-workflow");
    expect(arg).toHaveProperty("totalCalls");
    expect(arg.totalCalls).toBe(count);
    expect(arg).toHaveProperty("budget");
    expect(arg.budget).toEqual({ usedTokens: 5000, usedCost: 0.5, maxTokens: 100000 });
  });

  it("workflow_continues_after_callback_throws", async () => {
    const callback = vi.fn(() => {
      throw new Error("callback exploded");
    });
    const count = SOFT_MAX_AGENTS_WARNING + 2; // 502
    const pool = new AgentPool({
      maxConcurrency: count,
      onSoftLimitReached: callback,
    });
    pool.setBudget({ usedTokens: 0, usedCost: 0 });
    const _anyPool = pool as any;

    // Enqueue all 502 calls — with concurrency=502 all start immediately
    const promises: Promise<import("../src/agent-pool").AgentResult>[] = [];
    for (let i = 0; i < count; i++) {
      const proc = createMockProcess();
      mockSpawn.mockReturnValueOnce(proc as unknown as ChildProcess);
      const p = pool.enqueue({ prompt: `call-${i}` });
      promises.push(p);
      completeSuccess(proc, `result-${i}`);
    }

    const results = await Promise.all(promises);

    // Callback was called (and threw)
    expect(callback).toHaveBeenCalledTimes(1);
    // All results succeeded despite the throw
    expect(results).toHaveLength(count);
    expect(results.every((r) => r.success)).toBe(true);
  });
});
