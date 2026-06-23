// 测试框架：vitest
// 运行命令：npx vitest run src/infra/__tests__/concurrency-gate.test.ts
// Structural field-probe casts (as unknown as { field?: T }) verify legacy
// fields are absent from AgentResult — intentional double-casts for tests.
/* eslint-disable taste/no-unsafe-cast */

import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConcurrencyGate, DEFAULT_CONCURRENCY } from "../concurrency-gate.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// ── Helpers ─────────────────────────────────────────────────

interface MockProc extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (sig?: string) => boolean;
}

function createMockProcess(): MockProc {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
  });
}

/**
 * Mock ChildProcess——createMockProcess 故意只实现 stdout/stderr/EventEmitter/kill，
 * 不完整实现 ChildProcess 接口（pid/stdin 等缺省）。集中此处双重断言。
 */
function asChildProcess(proc: MockProc): ChildProcess {
  return proc as unknown as ChildProcess;
}

/** Build a JSONL message_end event line. */
function messageEndJsonl(
  text: string,
  usage: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: number;
    totalTokens?: number;
  },
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
        totalTokens: usage.totalTokens ?? usage.input + usage.output,
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

/** Let microtasks drain. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const mockSpawn = vi.mocked(spawn);

// ═══════════════════════════════════════════════════════════════

describe("ConcurrencyGate", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

 // ── Constructor & constants ────────────────────────────────

  describe("constructor + defaults (D-13)", () => {
    it("DEFAULT_CONCURRENCY constant is 4", () => {
      expect(DEFAULT_CONCURRENCY).toBe(4);
    });

    it("starts with empty active/queue state", () => {
      const gate = new ConcurrencyGate();
      expect(gate.activeCount).toBe(0);
      expect(gate.queueLength).toBe(0);
    });

    it("accepts number shorthand for maxConcurrency", () => {
      const gate = new ConcurrencyGate(2);
      expect(gate.activeCount).toBe(0);
      expect(gate.queueLength).toBe(0);
    });

    it("accepts options object form", () => {
      const gate = new ConcurrencyGate({ maxConcurrency: 8 });
      expect(gate.activeCount).toBe(0);
      expect(gate.queueLength).toBe(0);
    });
  });

 // ── enqueue — success path ─────────────────────────────────

  describe("enqueue — success path", () => {
    it("resolves with content and usage on happy path (unified AgentResult)", async () => {
      const gate = new ConcurrencyGate(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const jsonl = messageEndJsonl("hello world", {
        input: 100,
        output: 50,
        cost: 0.05,
        totalTokens: 150,
      });

      const resultPromise = gate.enqueue({ prompt: "say hello" });
      proc.stdout.emit("data", Buffer.from(jsonl + "\n"));
      proc.emit("close", 0);

      const result = await resultPromise;
      expect(result.content).toBe("hello world");
      expect(result.error).toBeUndefined();
      expect(result.usage).toBeDefined();
      expect(result.usage!.input).toBe(100);
      expect(result.usage!.output).toBe(50);
      expect(result.usage!.cost).toBe(0.05);
      expect(result.usage!.turns).toBe(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
 // AgentResult has no `success` boolean (removed in unification)
      expect((result as unknown as { success?: boolean }).success).toBeUndefined();
 // AgentResult has no `output` field
      expect((result as unknown as { output?: string }).output).toBeUndefined();
    });

    it("accumulates content and usage across multiple message_end events", async () => {
      const gate = new ConcurrencyGate(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const line1 = messageEndJsonl("hello", { input: 10, output: 5, cost: 0.01, totalTokens: 15 });
      const line2 = messageEndJsonl(" world", { input: 20, output: 8, cost: 0.02, totalTokens: 28 });

      const resultPromise = gate.enqueue({ prompt: "multi-turn" });
      proc.stdout.emit("data", Buffer.from(line1 + "\n" + line2 + "\n"));
      proc.emit("close", 0);

      const result = await resultPromise;
      expect(result.content).toBe("hello world");
      expect(result.usage!.input).toBe(30);
      expect(result.usage!.output).toBe(13);
      expect(result.usage!.turns).toBe(2);
    });

    it("parses structured output when schema is provided and tool call succeeds", async () => {
      const gate = new ConcurrencyGate(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

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

      const resultPromise = gate.enqueue({ prompt: "give me a name", schema });
      proc.stdout.emit(
        "data",
        Buffer.from(toolStartJsonl + "\n" + toolEndJsonl + "\n" + msgEndJsonl + "\n"),
      );
      proc.emit("close", 0);

      const result = await resultPromise;
      expect(result.error).toBeUndefined();
      expect(result.parsedOutput).toEqual({ name: "Alice" });
    });

    it("fails immediately when schema present but no structured-output tool call", async () => {
      const gate = new ConcurrencyGate(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const schema = { type: "object" };
      const jsonl = messageEndJsonl("not valid json {", { input: 10, output: 5 });

      const resultPromise = gate.enqueue({ prompt: "broken json", schema });
      proc.stdout.emit("data", Buffer.from(jsonl + "\n"));
      proc.emit("close", 0);

      const result = await resultPromise;
      expect(result.error).toContain("structured-output");
    });

    it("returns failure when other tools called but no structured-output on exit", async () => {
      const gate = new ConcurrencyGate(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const schema = { type: "object" };
      const toolStartJsonl = JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tc-1",
        toolName: "some-other-tool",
        args: { foo: "bar" },
      });
      const msgEndJsonl = messageEndJsonl("text output", { input: 10, output: 5 });

      const resultPromise = gate.enqueue({ prompt: "test", schema });
      proc.stdout.emit("data", Buffer.from(toolStartJsonl + "\n" + msgEndJsonl + "\n"));
      proc.emit("close", 0);

      const result = await resultPromise;
 // FR-1.4: hasToolCall=true + exit=0 + no SO → fail (blind-spot fix)
      expect(result.error).toContain("structured-output");
      expect(result.parsedOutput).toBeUndefined();
    });
  });

 // ── enqueue — error path ───────────────────────────────────

  describe("enqueue — error path", () => {
    it("non-zero exit code populates error field", async () => {
      const gate = new ConcurrencyGate(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const resultPromise = gate.enqueue({ prompt: "fail me" });
      proc.stderr.emit("data", Buffer.from("some error\n"));
      proc.emit("close", 1);

      const result = await resultPromise;
      expect(result.error).toContain("some error");
    });

    it("spawn rejection resolves with error (never rejects)", async () => {
      const gate = new ConcurrencyGate(2);
      mockSpawn.mockImplementation(() => {
        throw new Error("spawn failed");
      });

      const result = await gate.enqueue({ prompt: "x" });
      expect(result.error).toContain("spawn failed");
      expect(result.content).toBe("");
    });

    it("does not reject — error always carried in result field", async () => {
      const gate = new ConcurrencyGate(2);
      mockSpawn.mockImplementation(() => {
        throw new Error("always-fail-spawn");
      });

 // Never throws despite internal spawn error
      await expect(gate.enqueue({ prompt: "x" })).resolves.toHaveProperty("error");
    });
  });

 // ── Concurrency — FIFO ─────────────────────────────────────

  describe("FIFO queue under concurrency limit", () => {
    it("dispatches in arrival order when slot frees up", async () => {
      const gate = new ConcurrencyGate(1); // serialize
      const proc1 = createMockProcess();
      const proc2 = createMockProcess();
      mockSpawn.mockReturnValueOnce(asChildProcess(proc1));
      mockSpawn.mockReturnValueOnce(asChildProcess(proc2));

      const p1 = gate.enqueue({ prompt: "first" });
      const p2 = gate.enqueue({ prompt: "second" });

 // Only first dispatches (limit 1)
      expect(gate.activeCount).toBe(1);
      expect(gate.queueLength).toBe(1);

      completeSuccess(proc1, "first");
      const r1 = await p1;
      expect(r1.content).toBe("first");

 // After first completes, second dispatches
      await flush();
      expect(gate.activeCount).toBe(1);
      expect(gate.queueLength).toBe(0);

      completeSuccess(proc2, "second");
      const r2 = await p2;
      expect(r2.content).toBe("second");
    });

    it("respects maxConcurrency=2 by queuing the third call", async () => {
      const gate = new ConcurrencyGate(2);
      const proc1 = createMockProcess();
      const proc2 = createMockProcess();
      const proc3 = createMockProcess();
      mockSpawn.mockReturnValueOnce(asChildProcess(proc1));
      mockSpawn.mockReturnValueOnce(asChildProcess(proc2));
      mockSpawn.mockReturnValueOnce(asChildProcess(proc3));

      const p1 = gate.enqueue({ prompt: "a" });
      const p2 = gate.enqueue({ prompt: "b" });
      const p3 = gate.enqueue({ prompt: "c" });

      expect(gate.activeCount).toBe(2);
      expect(gate.queueLength).toBe(1);

      completeSuccess(proc1, "a");
      await p1;
      await flush();
 // After first frees, third dispatches
      expect(gate.activeCount).toBe(2);
      expect(gate.queueLength).toBe(0);

      completeSuccess(proc2, "b");
      await p2;
      completeSuccess(proc3, "c");
      await p3;
    });
  });

 // ── Abort propagation ──────────────────────────────────────

  describe("abort propagation", () => {
    it("resolves with error when signal already aborted before start", async () => {
      const gate = new ConcurrencyGate();
      const ac = new AbortController();
      ac.abort();
      const r = await gate.enqueue({ prompt: "x" }, ac.signal);
      expect(r.content).toBe("");
      expect(r.error).toContain("aborted before start");
      expect(gate.queueLength).toBe(0);
      expect(gate.activeCount).toBe(0);
    });

    it("resolves with error when aborted while queued", async () => {
      const gate = new ConcurrencyGate(1); // serialize
      const blockingProc = createMockProcess();
      mockSpawn.mockReturnValueOnce(asChildProcess(blockingProc));
      const blockingPromise = gate.enqueue({ prompt: "block" });

 // Queue second
      const ac = new AbortController();
      const queuedPromise = gate.enqueue({ prompt: "queued" }, ac.signal);

      expect(gate.queueLength).toBe(1);

      ac.abort();
      const r = await queuedPromise;
      expect(r.error).toContain("aborted while queued");
      expect(gate.queueLength).toBe(0);

 // Cleanup blocker
      completeSuccess(blockingProc, "block");
      await blockingPromise;
    });

    it("SIGKILLs the subprocess when external signal aborts mid-flight", async () => {
      const gate = new ConcurrencyGate();
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const ac = new AbortController();
      const p = gate.enqueue({ prompt: "x" }, ac.signal);

      expect(gate.activeCount).toBe(1);

      ac.abort();
 // runPiProcess wires abort -> proc.kill("SIGKILL")
      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");

 // close after kill settles the result
      proc.emit("close", 1);
      const r = await p;
      expect(r.error).toBeDefined();
    });

    it("honors per-call timeoutMs by aborting the subprocess", async () => {
      const gate = new ConcurrencyGate();
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const p = gate.enqueue({ prompt: "x", timeoutMs: 5 });
 // Wait beyond timeoutMs
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");

      proc.emit("close", 1);
      const r = await p;
      expect(r.error).toBeDefined();
    });
  });

 // ── Arg / env wiring ───────────────────────────────────────

  describe("arg & env wiring", () => {
    it("injects PI_WORKFLOW_SCHEMA env when schemaEnv provided", async () => {
      const gate = new ConcurrencyGate(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const p = gate.enqueue({ prompt: "x", schemaEnv: '{"type":"object"}' });
      completeSuccess(proc, "ok");
      await p;

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const spawnOpts = mockSpawn.mock.calls[0]![2];
      const env = (spawnOpts?.env ?? {}) as Record<string, string | undefined>;
      expect(env.PI_WORKFLOW_SCHEMA).toBe('{"type":"object"}');
    });

    it("injects --append-system-prompt when systemPromptFiles is set", async () => {
      const gate = new ConcurrencyGate(2);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const p = gate.enqueue({
        prompt: "use this prompt",
        systemPromptFiles: ["/tmp/agent-prompt-abc.md"],
      });
      completeSuccess(proc, "ok");
      await p;

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const spawnArgs = mockSpawn.mock.calls[0]![1] as string[];
      expect(spawnArgs).toContain("--append-system-prompt");
      expect(spawnArgs).toContain("/tmp/agent-prompt-abc.md");
    });
  });

 // ── D-12: budget removal ───────────────────────────────────

  describe("soft-limit / budget removed (D-12)", () => {
    it("has no setBudget / onSoftLimitReached / totalCallCount (moved to Budget)", () => {
      const gate = new ConcurrencyGate();
 // soft-limit handling removed entirely
      expect((gate as unknown as { setBudget?: unknown }).setBudget).toBeUndefined();
      expect(
        (gate as unknown as { maybeEmitSoftWarning?: unknown }).maybeEmitSoftWarning,
      ).toBeUndefined();
      expect((gate as unknown as { totalCallCount?: unknown }).totalCallCount).toBeUndefined();
      expect((gate as unknown as { budgetRef?: unknown }).budgetRef).toBeUndefined();
      expect((gate as unknown as { softWarningSent?: unknown }).softWarningSent).toBeUndefined();
    });

    it("does not import SOFT_MAX_AGENTS_WARNING constant (moved to Budget)", async () => {
 // SOFT_MAX_AGENTS_WARNING no longer exported from this module
      const mod = await import("../concurrency-gate.js");
      expect((mod as unknown as { SOFT_MAX_AGENTS_WARNING?: unknown }).SOFT_MAX_AGENTS_WARNING)
        .toBeUndefined();
    });
  });
});

// ── T-4: withSlot (C-3 并发槽位入口) ─────────────────────────
//
// withSlot 是 dispatchAgentCall 实际调用的入口（不走 enqueue 的 spawn 路径）。
// 覆盖 3 条独有分支：pre-abort throw、queued-abort rejection、FIFO drain。

describe("ConcurrencyGate.withSlot (T-4)", () => {
  it("槽位可用 → 直接执行 fn 并返回其结果", async () => {
    const gate = new ConcurrencyGate({ maxConcurrency: 2 });
    const fn = vi.fn(async () => "result");
    const result = await gate.withSlot(fn);
    expect(result).toBe("result");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("pre-aborted signal → 立即 throw AbortError（不调 fn）", async () => {
    const gate = new ConcurrencyGate({ maxConcurrency: 2 });
    const fn = vi.fn(async () => "result");
    const controller = new AbortController();
    controller.abort();
    await expect(gate.withSlot(fn, controller.signal)).rejects.toThrow(/aborted before start/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("maxConcurrency=1 串行化：第 2 个 fn 等第 1 个完成", async () => {
    const gate = new ConcurrencyGate({ maxConcurrency: 1 });
    const order: string[] = [];
    let resolveFirst: () => void = () => {};
    const firstPromise = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const fn1 = vi.fn(async () => {
      order.push("fn1-start");
      await firstPromise;
      order.push("fn1-end");
      return 1;
    });
    const fn2 = vi.fn(async () => {
      order.push("fn2-start");
      return 2;
    });

    const p1 = gate.withSlot(fn1);
 // p2 进入排队（maxConcurrency=1，fn1 占槽）
    const p2 = gate.withSlot(fn2);

 // fn2 尚未执行（fn1 占槽）
    expect(fn2).not.toHaveBeenCalled();

    resolveFirst();
 // 语义就是全 resolve（串行链必须都成功）——非独立数据源，禁 allSettled 建议
    const [r1, r2] = await Promise.all([p1, p2]); // eslint-disable-line taste/prefer-allsettled
    expect(r1).toBe(1);
    expect(r2).toBe(2);
 // fn1 完成后 fn2 才开始（串行）
    expect(order).toEqual(["fn1-start", "fn1-end", "fn2-start"]);
  });

  it("queued 中 signal abort → reject AbortError + 从队列移除", async () => {
    const gate = new ConcurrencyGate({ maxConcurrency: 1 });
    let resolveFirst: () => void = () => {};
    const firstPromise = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const fn1 = vi.fn(async () => {
      await firstPromise;
      return 1;
    });
    const fn2 = vi.fn(async () => 2);

    const controller2 = new AbortController();
    const p1 = gate.withSlot(fn1);
    const p2 = gate.withSlot(fn2, controller2.signal);

 // fn2 在排队中——abort
    controller2.abort();
    await expect(p2).rejects.toThrow(/aborted while queued/);

 // 释放 fn1，确认 fn2 没被执行（已从队列移除）
    resolveFirst();
    await p1;
    expect(fn2).not.toHaveBeenCalled();
  });

  it("FIFO 顺序：maxConcurrency=1，3 个 fn 按入队顺序执行", async () => {
    const gate = new ConcurrencyGate({ maxConcurrency: 1 });
    const order: number[] = [];

    const makeFn = (n: number) =>
      async (): Promise<number> => {
        order.push(n);
 // 让出微任务，确保下一个能进入
        await Promise.resolve();
        return n;
      };

 // FIFO 顺序断言需全部 resolve——非独立数据源，禁 allSettled 建议
    const ps = await Promise.all([ // eslint-disable-line taste/prefer-allsettled
      gate.withSlot(makeFn(1)),
      gate.withSlot(makeFn(2)),
      gate.withSlot(makeFn(3)),
    ]);
    expect(ps).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("槽位释放后 drain：fn 完成即递减 active 并唤醒队列", async () => {
    const gate = new ConcurrencyGate({ maxConcurrency: 1 });
    const results: string[] = [];

    const fn = async (id: string): Promise<string> => {
      results.push(id);
      return id;
    };

 // 并发提交 3 个，maxConcurrency=1 → 串行
    const ps = [gate.withSlot(() => fn("a")), gate.withSlot(() => fn("b")), gate.withSlot(() => fn("c"))];
 // 串行链全部 resolve 才算通过——非独立数据源，禁 allSettled 建议
    const settled = await Promise.all(ps); // eslint-disable-line taste/prefer-allsettled
    expect(settled).toEqual(["a", "b", "c"]);
    expect(results).toEqual(["a", "b", "c"]);
  });
});
