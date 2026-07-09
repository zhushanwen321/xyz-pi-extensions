// 测试框架：vitest
// 运行命令：npx vitest run src/interface/__tests__/helpers.test.ts
//
// Interface helpers 直接单测（review round 1 must-fix #4）。
//
// notifyDone（C-4 完成通知回调，~100 行带分支）此前仅经 index.test.ts 间接覆盖，
// sendMessage 在各处均被 mock 但无 toHaveBeenCalledWith 针对 workflow-result/_render。
// 本文件直测其契约：去重早退、截断条件、statusToItemStatus 4 分支、_render 结构。

/* eslint-disable taste/no-unsafe-cast */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import { Budget } from "../../engine/models/budget.js";
import { Trace } from "../../engine/models/trace.js";
import type { DoneReason, ExecutionTraceNode } from "../../engine/models/types.js";
import { WorkflowRun } from "../../engine/models/workflow-run.js";
import { notifyDone } from "../helpers.js";

// ── Fixtures ─────────────────────────────────────────────────

type PiLike = { sendMessage: Mock; appendEntry: Mock };

function makePi(): PiLike {
  return { sendMessage: vi.fn(), appendEntry: vi.fn() } as unknown as PiLike;
}

function makeNode(
  stepIndex: number,
  status: ExecutionTraceNode["status"],
  overrides: Partial<ExecutionTraceNode> = {},
): ExecutionTraceNode {
  return {
    stepIndex,
    agent: `agent-${stepIndex}`,
    task: `task-${stepIndex}`,
    model: "default",
    status,
    startedAt: "2026-06-22T10:00:00.000Z",
    ...overrides,
  };
}

function makeDoneRun(overrides: {
  scriptResult?: unknown;
  reason?: DoneReason;
  traceNodes?: ExecutionTraceNode[];
  scriptName?: string;
} = {}): WorkflowRun {
  const trace = Trace.fromArray(overrides.traceNodes ?? []);
  return new WorkflowRun(
    "wf-test-1",
    {
      scriptSource: 'agent({ prompt: "hi" });',
      args: {},
      scriptName: overrides.scriptName ?? "deploy-app",
      scriptPath: "/abs/deploy-app.js",
    },
    {
      status: "done",
      reason: overrides.reason ?? "completed",
      budget: new Budget(),
      calls: new Map(),
      trace,
      errorLogs: [],
      ...(overrides.scriptResult !== undefined ? { scriptResult: overrides.scriptResult } : {}),
    },
    {
      startedAt: "2026-06-22T10:00:00.000Z",
      completedAt: "2026-06-22T10:05:00.000Z",
    },
  );
}

function lastCall(pi: PiLike): [message: Record<string, unknown>, options: unknown] {
  return pi.sendMessage.mock.calls.at(-1) as [Record<string, unknown>, unknown];
}

// ── notifyDone ───────────────────────────────────────────────

describe("notifyDone", () => {
  it("(1) 首次调用：sendMessage 收到 customType=workflow-result + triggerTurn + steer", () => {
    const pi = makePi();
    const run = makeDoneRun({
      traceNodes: [makeNode(0, "completed"), makeNode(1, "failed")],
    });
    const notified = new Set<string>();

    notifyDone(pi as unknown as ExtensionAPI, run.runId, run, notified);

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [message, options] = lastCall(pi);
    expect(message.customType).toBe("workflow-result");
    expect(message.display).toBe(true);
    expect(options).toEqual({ triggerTurn: true, deliverAs: "steer" });
  });

  it("(2) 同 runId 二次调用被去重：sendMessage 只调一次", () => {
    const pi = makePi();
    const run = makeDoneRun({ traceNodes: [makeNode(0, "completed")] });
    const notified = new Set<string>();

    notifyDone(pi as unknown as ExtensionAPI, run.runId, run, notified);
    notifyDone(pi as unknown as ExtensionAPI, run.runId, run, notified);

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(notified.has(run.runId)).toBe(true);
  });

  it("(3a) scriptResult 超 8000 字符触发截断后缀", () => {
    const pi = makePi();
    // JSON.stringify("x".repeat(8000)) = 8002 chars (含引号) > MAX_RESULT_LENGTH(8000)
    const run = makeDoneRun({
      scriptResult: "x".repeat(8000),
      traceNodes: [makeNode(0, "completed")],
    });

    notifyDone(pi as unknown as ExtensionAPI, run.runId, run, new Set());

    const [message] = lastCall(pi);
    expect(typeof message.content).toBe("string");
    expect(message.content as string).toContain("--- Script Result ---");
    expect(message.content as string).toContain("... (truncated)");
  });

  it("(3b) scriptResult 未超阈值：无截断后缀，原样包含", () => {
    const pi = makePi();
    const run = makeDoneRun({
      scriptResult: { ok: true },
      traceNodes: [makeNode(0, "completed")],
    });

    notifyDone(pi as unknown as ExtensionAPI, run.runId, run, new Set());

    const [message] = lastCall(pi);
    expect(message.content as string).not.toContain("... (truncated)");
    expect(message.content as string).toContain('"ok": true');
  });

  it("(3c) 无 scriptResult：不含 Script Result 段", () => {
    const pi = makePi();
    const run = makeDoneRun({ traceNodes: [makeNode(0, "completed")] });

    notifyDone(pi as unknown as ExtensionAPI, run.runId, run, new Set());

    const [message] = lastCall(pi);
    expect(message.content as string).not.toContain("--- Script Result ---");
  });

  it("(4) statusToItemStatus 4 分支映射：completed/failed/running/pending→其它", () => {
    const pi = makePi();
    const run = makeDoneRun({
      traceNodes: [
        makeNode(0, "completed"),
        makeNode(1, "failed"),
        makeNode(2, "running"),
        makeNode(3, "pending"),
      ],
    });

    notifyDone(pi as unknown as ExtensionAPI, run.runId, run, new Set());

    const [message] = lastCall(pi);
    const items = (message.details as Record<string, { data: { items: { status: string }[] } }>)
      ._render.data.items;
    expect(items.map((i) => i.status)).toEqual([
      "completed",
      "failed",
      "in_progress",
      "pending",
    ]);
  });

  it("(5) details._render.data.items 结构 + 顶层 details 字段", () => {
    const pi = makePi();
    const run = makeDoneRun({
      reason: "failed",
      scriptName: "deploy-app",
      traceNodes: [
        makeNode(0, "completed", { task: "build the thing", result: { content: "done" } }),
      ],
    });

    notifyDone(pi as unknown as ExtensionAPI, run.runId, run, new Set());

    const [message] = lastCall(pi);
    const details = message.details as Record<string, unknown>;
    expect(details.runId).toBe(run.runId);
    expect(details.name).toBe("deploy-app");
    expect(details.status).toBe("done");
    expect(details.reason).toBe("failed");
    expect(details.traceLength).toBe(1);

    const render = details._render as { type: string; data: Record<string, unknown> };
    expect(render.type).toBe("task-list");
    expect(typeof render.data.title).toBe("string");
    expect(render.data.title as string).toContain("deploy-app");
    expect(typeof render.data.summary).toBe("string");

    const items = render.data.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].label as string).toContain("[0]");
    expect(items[0].label as string).toContain("agent-0");
    expect(items[0].status).toBe("completed");
    expect(items[0].detail).toBe("done"); // result.content slice
  });
});
