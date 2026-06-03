// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach）
// 运行命令：npx vitest run tests/agent-pool.test.ts

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { AgentPool } from "../src/agent-pool";

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

    it("parses structured output when schema is provided and output is valid JSON", async () => {
      const pool = new AgentPool(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as unknown as ChildProcess);

      const schema = { type: "object", properties: { name: { type: "string" } } };
      const payload = JSON.stringify({ name: "Alice" });
      const jsonl = messageEndJsonl(payload, { input: 10, output: 5 });

      const resultPromise = pool.enqueue({ prompt: "give me a name", schema });
      proc.stdout.emit("data", Buffer.from(jsonl + "\n"));
      proc.emit("close", 0);

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.parsedOutput).toEqual({ name: "Alice" });
    });

    it("leaves parsedOutput undefined when schema is provided but output is not valid JSON", async () => {
      const pool = new AgentPool(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as unknown as ChildProcess);

      const schema = { type: "object" };
      const jsonl = messageEndJsonl("not valid json {", { input: 10, output: 5 });

      const resultPromise = pool.enqueue({ prompt: "broken json", schema });
      proc.stdout.emit("data", Buffer.from(jsonl + "\n"));
      proc.emit("close", 0);

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.parsedOutput).toBeUndefined();
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
