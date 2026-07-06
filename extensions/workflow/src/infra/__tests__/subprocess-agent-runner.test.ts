// 测试框架：vitest
// 运行命令：npx vitest run src/infra/__tests__/subprocess-agent-runner.test.ts

import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRunner } from "../../engine/models/ports.js";
import type { AgentResult } from "../../engine/models/types.js";
import { SubprocessAgentRunner } from "../subprocess-agent-runner.js";

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

/** Cast fake to ChildProcess for spawn mock. */
function asChildProcess(proc: MockProc): ChildProcess {
 // eslint-disable-next-line taste/no-unsafe-cast
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

/** Emit a successful JSONL response + close. */
function completeSuccess(proc: MockProc, text: string): void {
  proc.stdout.emit("data", Buffer.from(messageEndJsonl(text, { input: 1, output: 1 }) + "\n"));
  proc.emit("close", 0);
}

const mockSpawn = vi.mocked(spawn);

beforeEach(() => {
  mockSpawn.mockReset();
});

// ═══════════════════════════════════════════════════════════════

describe("SubprocessAgentRunner", () => {
  it("implements AgentRunner port", () => {
    const runner: AgentRunner = new SubprocessAgentRunner();
 // Type-level check: assigning to AgentRunner succeeds
    expect(typeof runner.run).toBe("function");
  });

 // ── Success path ───────────────────────────────────────────

  describe("run — success path", () => {
    it("returns content + usage on happy path (AgentResult shape)", async () => {
      const runner = new SubprocessAgentRunner();
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const jsonl = messageEndJsonl("hello world", {
        input: 100,
        output: 50,
        cost: 0.05,
        totalTokens: 150,
      });

      const ac = new AbortController();
      const p = runner.run({ prompt: "say hello" }, ac.signal);
      proc.stdout.emit("data", Buffer.from(jsonl + "\n"));
      proc.emit("close", 0);

      const result = await p;
      expect(result.content).toBe("hello world");
      expect(result.error).toBeUndefined();
      expect(result.usage?.input).toBe(100);
      expect(result.usage?.output).toBe(50);
      expect(result.usage?.cost).toBe(0.05);
      expect(result.usage?.turns).toBe(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
 // AgentResult has no `success` boolean / `output` field
 // eslint-disable-next-line taste/no-unsafe-cast
      expect((result as unknown as { success?: boolean }).success).toBeUndefined();
 // eslint-disable-next-line taste/no-unsafe-cast
      expect((result as unknown as { output?: string }).output).toBeUndefined();
    });

    it("accumulates content + usage across multiple message_end events", async () => {
      const runner = new SubprocessAgentRunner();
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const line1 = messageEndJsonl("hello", { input: 10, output: 5 });
      const line2 = messageEndJsonl(" world", { input: 20, output: 8 });

      const ac = new AbortController();
      const p = runner.run({ prompt: "multi-turn" }, ac.signal);
      proc.stdout.emit("data", Buffer.from(line1 + "\n" + line2 + "\n"));
      proc.emit("close", 0);

      const result = await p;
      expect(result.content).toBe("hello world");
      expect(result.usage?.input).toBe(30);
      expect(result.usage?.output).toBe(13);
      expect(result.usage?.turns).toBe(2);
    });

    it("parses structured output when schema present + tool call succeeds", async () => {
      const runner = new SubprocessAgentRunner();
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const schema = { type: "object", properties: { name: { type: "string" } } };
      const toolStart = JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tc-1",
        toolName: "structured-output",
        args: { name: "Alice" },
      });
      const toolEnd = JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "tc-1",
        toolName: "structured-output",
        isError: false,
      });
      const msgEnd = messageEndJsonl("", { input: 10, output: 5 });

      const ac = new AbortController();
      const p = runner.run({ prompt: "give a name", schema }, ac.signal);
      proc.stdout.emit("data", Buffer.from(toolStart + "\n" + toolEnd + "\n" + msgEnd + "\n"));
      proc.emit("close", 0);

      const result = await p;
      expect(result.error).toBeUndefined();
      expect(result.parsedOutput).toEqual({ name: "Alice" });
    });

    it("does NOT capture parsedOutput when tool_execution_end has error", async () => {
      const runner = new SubprocessAgentRunner();
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const schema = { type: "object" };
      const toolStart = JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tc-1",
        toolName: "structured-output",
        args: { mustFix: true },
      });
      const toolEnd = JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "tc-1",
        toolName: "structured-output",
        isError: true,
      });
      const msgEnd = messageEndJsonl("", { input: 10, output: 5 });

      const ac = new AbortController();
      const p = runner.run({ prompt: "check", schema }, ac.signal);
      proc.stdout.emit("data", Buffer.from(toolStart + "\n" + toolEnd + "\n" + msgEnd + "\n"));
      proc.emit("close", 0);

      const result = await p;
      expect(result.parsedOutput).toBeUndefined();
    });
  });

 // ── Error path ─────────────────────────────────────────────

  describe("run — error path", () => {
    it("non-zero exit populates error field (no reject)", async () => {
      const runner = new SubprocessAgentRunner();
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const ac = new AbortController();
      const p = runner.run({ prompt: "fail" }, ac.signal);
      proc.stderr.emit("data", Buffer.from("boom\n"));
      proc.emit("close", 1);

      const result = await p;
      expect(result.error).toContain("boom");
    });

    it("spawn rejection resolves with error (never rejects)", async () => {
      const runner = new SubprocessAgentRunner();
      mockSpawn.mockImplementation(() => {
        throw new Error("spawn failed");
      });

      const ac = new AbortController();
      const result = await runner.run({ prompt: "x" }, ac.signal);
      expect(result.error).toContain("spawn failed");
      expect(result.content).toBe("");
    });

    it("schema present + no tool call → error (blind-spot fix FR-1.4)", async () => {
      const runner = new SubprocessAgentRunner();
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const schema = { type: "object" };
      const jsonl = messageEndJsonl("not structured", { input: 10, output: 5 });

      const ac = new AbortController();
      const p = runner.run({ prompt: "broken", schema }, ac.signal);
      proc.stdout.emit("data", Buffer.from(jsonl + "\n"));
      proc.emit("close", 0);

      const result = await p;
      expect(result.error).toContain("structured-output");
    });

    it("schema present + other tool called + no SO + exit 0 → error", async () => {
      const runner = new SubprocessAgentRunner();
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const schema = { type: "object" };
      const toolStart = JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tc-1",
        toolName: "some-other-tool",
        args: { foo: "bar" },
      });
      const msgEnd = messageEndJsonl("text", { input: 10, output: 5 });

      const ac = new AbortController();
      const p = runner.run({ prompt: "test", schema }, ac.signal);
      proc.stdout.emit("data", Buffer.from(toolStart + "\n" + msgEnd + "\n"));
      proc.emit("close", 0);

      const result = await p;
      expect(result.error).toContain("structured-output");
      expect(result.parsedOutput).toBeUndefined();
    });

 // [HISTORICAL] schema-error 分支必须带上 exitCode + stderr，否则 abort/崩溃被
 // 误判为 "LLM 拒绝调 tool"。复现 daily-news-impact 三轮根因分析被误导的场景：
 // pi 子进程被 SIGKILL（abort 触发），pipeline 全空，schema 检查命中。
    it("schema-error error carries exitCode + stderr (abort/misleading-message fix)", async () => {
      const runner = new SubprocessAgentRunner();
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const schema = { type: "object" };
      const ac = new AbortController();
      const p = runner.run({ prompt: "x", schema }, ac.signal);
 // 模拟 runPiProcess abortHandler 写入 stderr 后 SIGKILL
      proc.stderr.emit("data", Buffer.from("Operation aborted, sending SIGKILL"));
      proc.emit("close", 1);

      const result = await p;
      expect(result.error).toContain("structured-output");
      expect(result.error).toContain("exitCode=1");
      expect(result.error).toContain("Operation aborted, sending SIGKILL");
    });

    it("schema-error on exit 0 + empty stderr keeps clean message (no ctx suffix)", async () => {
      const runner = new SubprocessAgentRunner();
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const schema = { type: "object" };
      const jsonl = messageEndJsonl("not structured", { input: 10, output: 5 });
      const ac = new AbortController();
      const p = runner.run({ prompt: "x", schema }, ac.signal);
      proc.stdout.emit("data", Buffer.from(jsonl + "\n"));
      proc.emit("close", 0);

      const result = await p;
      expect(result.error).toContain("structured-output");
      expect(result.error).not.toContain("exitCode");
      expect(result.error).not.toContain("stderr");
    });
  });

 // ── Abort / signal ─────────────────────────────────────────

  describe("run — abort propagation", () => {
    it("SIGKILLs subprocess when signal aborts mid-flight", async () => {
      const runner = new SubprocessAgentRunner();
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const ac = new AbortController();
      const p = runner.run({ prompt: "x" }, ac.signal);

      ac.abort();
 // runPiProcess wires abort -> proc.kill("SIGKILL")
      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");

      proc.emit("close", 1);
      const result = await p;
      expect(result.error).toBeDefined();
    });

    it("already-aborted signal resolves with error", async () => {
      const runner = new SubprocessAgentRunner();
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const ac = new AbortController();
      ac.abort();
      const p = runner.run({ prompt: "x" }, ac.signal);

      proc.emit("close", 1);
      const result = await p;
      expect(result.error).toBeDefined();
    });

    it("honors per-call timeoutMs by aborting subprocess (review round 1 #2)", async () => {
 // 生产链路 dispatchAgentCall → withSlot → executeAgentCall → runner.run 全程
 // 走 SubprocessAgentRunner（不经 gate.enqueue 的合并分支）。opts.timeoutMs 必须在此
 // 合并进 per-call AbortController，否则 agent({timeoutMs:5000}) 静默无效。
      const runner = new SubprocessAgentRunner();
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const ac = new AbortController();
      const p = runner.run({ prompt: "x", timeoutMs: 5 }, ac.signal);
 // Wait beyond timeoutMs
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");

      proc.emit("close", 1);
      const result = await p;
      expect(result.error).toBeDefined();
    });
  });

 // ── Env / args wiring ──────────────────────────────────────

  describe("run — env & args wiring", () => {
    it("injects PI_WORKFLOW_SCHEMA env when schemaEnv provided", async () => {
      const runner = new SubprocessAgentRunner();
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const ac = new AbortController();
      const p = runner.run({ prompt: "x", schemaEnv: '{"type":"object"}' }, ac.signal);
      completeSuccess(proc, "ok");
      await p;

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const spawnOpts = mockSpawn.mock.calls[0]![2];
      const env = (spawnOpts?.env ?? {}) as Record<string, string | undefined>;
      expect(env.PI_WORKFLOW_SCHEMA).toBe('{"type":"object"}');
    });

    it("injects --append-system-prompt when systemPromptFiles is set", async () => {
      const runner = new SubprocessAgentRunner();
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const ac = new AbortController();
      const p = runner.run(
        { prompt: "x", systemPromptFiles: ["/tmp/sys-prompt.md"] },
        ac.signal,
      );
      completeSuccess(proc, "ok");
      await p;

      const spawnArgs = mockSpawn.mock.calls[0]![1] as string[];
      expect(spawnArgs).toContain("--append-system-prompt");
      expect(spawnArgs).toContain("/tmp/sys-prompt.md");
    });

    it("injects --skill when skillPath is set", async () => {
      const runner = new SubprocessAgentRunner();
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const ac = new AbortController();
      const p = runner.run({ prompt: "x", skillPath: "/skills/code-review" }, ac.signal);
      completeSuccess(proc, "ok");
      await p;

      const spawnArgs = mockSpawn.mock.calls[0]![1] as string[];
      expect(spawnArgs).toContain("--skill");
      expect(spawnArgs).toContain("/skills/code-review");
    });

    it("passes --model when model is set", async () => {
      const runner = new SubprocessAgentRunner();
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(asChildProcess(proc));

      const ac = new AbortController();
      const p = runner.run({ prompt: "x", model: "router-openai/glm-5.1" }, ac.signal);
      completeSuccess(proc, "ok");
      await p;

      const spawnArgs = mockSpawn.mock.calls[0]![1] as string[];
      expect(spawnArgs).toContain("--model");
      expect(spawnArgs).toContain("router-openai/glm-5.1");
    });
  });

 // ── Process isolation ──────────────────────────────────────

  describe("run — process isolation (spec Constraints)", () => {
    it("spawns a fresh process each call (never reuses)", async () => {
      const runner = new SubprocessAgentRunner();

      const proc1 = createMockProcess();
      mockSpawn.mockReturnValueOnce(asChildProcess(proc1));
      const ac1 = new AbortController();
      const p1 = runner.run({ prompt: "first" }, ac1.signal);
      completeSuccess(proc1, "first");
      const r1: AgentResult = await p1;

      const proc2 = createMockProcess();
      mockSpawn.mockReturnValueOnce(asChildProcess(proc2));
      const ac2 = new AbortController();
      const p2 = runner.run({ prompt: "second" }, ac2.signal);
      completeSuccess(proc2, "second");
      const r2: AgentResult = await p2;

      expect(r1.content).toBe("first");
      expect(r2.content).toBe("second");
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });
  });
});
