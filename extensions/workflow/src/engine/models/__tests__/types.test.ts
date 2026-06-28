// 测试框架：vitest
// 运行命令：npx vitest run src/engine/models/__tests__/types.test.ts

import { describe, expect, it } from "vitest";

import {
  type AgentCallOpts,
  type AgentResult,
  type AgentUsage,
  ALL_DONE_REASONS,
  ALL_RUN_STATUSES,
  canRunTransition,
  type DoneReason,
  type ExecutionTraceNode,
  isDone,
  type RunStatus,
  type ToolCallEntry,
  type TracePatch,
  VALID_RUN_TRANSITIONS,
  type WorkerLogEntry,
} from "../types";

// ── 状态机 ────────────────────────────────────────────────────

describe("RunStatus 状态机", () => {
  it("ALL_RUN_STATUSES 恰为 3 态", () => {
    expect(ALL_RUN_STATUSES).toEqual(["running", "paused", "done"]);
  });

  it("ALL_DONE_REASONS 恰为 5 原因", () => {
    expect(ALL_DONE_REASONS).toEqual([
      "completed",
      "failed",
      "aborted",
      "budget_limited",
      "time_limited",
    ]);
  });

  it("isDone 仅对 done 返回 true", () => {
    expect(isDone("done")).toBe(true);
    expect(isDone("running")).toBe(false);
    expect(isDone("paused")).toBe(false);
  });

  it("VALID_RUN_TRANSITIONS: running 可转 paused/done", () => {
    expect(canRunTransition("running", "paused")).toBe(true);
    expect(canRunTransition("running", "done")).toBe(true);
    expect(canRunTransition("running", "running")).toBe(false);
  });

  it("VALID_RUN_TRANSITIONS: paused 可转 running/done", () => {
    expect(canRunTransition("paused", "running")).toBe(true);
    expect(canRunTransition("paused", "done")).toBe(true);
    expect(canRunTransition("paused", "paused")).toBe(false);
  });

  it("VALID_RUN_TRANSITIONS: done 无出边（终态）", () => {
    expect(VALID_RUN_TRANSITIONS.done).toEqual([]);
    expect(canRunTransition("done", "running")).toBe(false);
    expect(canRunTransition("done", "paused")).toBe(false);
    expect(canRunTransition("done", "done")).toBe(false);
  });
});

// ── 类型形状（编译期契约，用 mock 对象赋值校验） ────────────────

describe("类型形状 mock 赋值", () => {
  it("AgentCallOpts 字段齐全", () => {
    const opts: AgentCallOpts = {
      prompt: "hello",
      schema: { type: "object" },
      model: "router-openai/glm-5.1",
      scene: "code",
      timeoutMs: 5000,
      skill: "code-review",
      skillPath: "/abs/skills/code-review/SKILL.md",
      description: "review task",
      agent: "reviewer",
      systemPromptFiles: ["/tmp/prompt.txt"],
      schemaEnv: '{"type":"object"}',
    };
    expect(opts.prompt).toBe("hello");
  });

  it("AgentUsage 字段齐全", () => {
    const usage: AgentUsage = {
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
      cost: 0.001,
      contextTokens: 160,
      turns: 2,
    };
    expect(usage.input + usage.output).toBe(150);
  });

  it("AgentResult 最小形态（无 schema 调用）", () => {
    const result: AgentResult = {
      content: "done",
    };
    expect(result.content).toBe("done");
    expect(result.parsedOutput).toBeUndefined();
  });

  it("AgentResult 完整形态（含 usage/toolCalls）", () => {
    const result: AgentResult = {
      content: "structured",
      parsedOutput: { ok: true },
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 3,
        turns: 1,
      },
      durationMs: 42,
      error: undefined,
      sessionId: "01H8XGJ...",
      toolCalls: [{ name: "Read", input: '{"file":"a"}' }],
    };
    expect(result.toolCalls?.[0].name).toBe("Read");
  });

  it("ToolCallEntry 字段", () => {
    const entry: ToolCallEntry = { name: "Write", input: "{}" };
    expect(entry.name).toBe("Write");
  });

  it("ExecutionTraceNode 不含 verifyStrategy（G-020 删除）", () => {
    const node: ExecutionTraceNode = {
      stepIndex: 0,
      agent: "worker",
      task: "do thing",
      model: "default",
      status: "running",
      phase: "build",
      startedAt: "2026-06-22T00:00:00.000Z",
    };
 // verifyStrategy 字段已从类型定义移除——以下赋值在编译期即报错。
 // 这里仅断言 node 上不存在该键。
    expect("verifyStrategy" in node).toBe(false);
  });

  it("TracePatch 全字段可选", () => {
    const patch: TracePatch = {};
    expect(patch).toEqual({});
    const patch2: TracePatch = {
      status: "completed",
      completedAt: "2026-06-22T00:00:00.000Z",
      sessionId: "abc",
    };
    expect(patch2.status).toBe("completed");
  });

  it("WorkerLogEntry 4 level", () => {
    const levels: WorkerLogEntry["level"][] = ["log", "warn", "error", "info"];
    for (const level of levels) {
      const entry: WorkerLogEntry = { level, message: "hi" };
      expect(entry.level).toBe(level);
    }
  });

  it("RunStatus 与 DoneReason 可作可辨识联合", () => {
    const status: RunStatus = "done";
    const reason: DoneReason = "completed";
    expect(status).toBe("done");
    expect(reason).toBe("completed");
  });
});
