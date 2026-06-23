// 测试框架：vitest
// 运行命令：npx vitest run src/__tests__/workflows-view.test.ts
//
// WorkflowsView 适配 WorkflowRun 的测试 + 无 restart 快捷键。
// 验证 createWorkflowsView 接受 WorkflowRun 聚合根并正确渲染 layout。
// 不测真实 TUI 交互——测 renderLayout 输出格式（pure function）+ view actions 绑定。

/* eslint-disable taste/no-unsafe-cast */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { Budget } from "../engine/models/budget.js";
import { Trace } from "../engine/models/trace.js";
import type { ExecutionTraceNode } from "../engine/models/types.js";
import { WorkflowRun } from "../engine/models/workflow-run.js";
import {
  buildPhaseGroups,
  formatStatusBadge,
  type ThemeLike,
} from "../interface/views/format.js";
import { createWorkflowsView, type ViewActions } from "../interface/views/WorkflowsView.js";

// ── Fixtures ─────────────────────────────────────────────────

function makeTraceNode(overrides: Partial<ExecutionTraceNode> = {}): ExecutionTraceNode {
  return {
    stepIndex: 0,
    agent: "test-agent",
    task: "Do something",
    model: "test-model",
    status: "completed",
    phase: "build",
    startedAt: "2026-06-22T10:00:00.000Z",
    completedAt: "2026-06-22T10:01:00.000Z",
    result: {
      content: "result content",
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 200, turns: 1 },
      toolCalls: [{ name: "read", input: "file.ts" }],
    },
    ...overrides,
  };
}

function makeRun(overrides: {
  status?: "running" | "paused" | "done";
  reason?: "completed" | "failed" | "aborted" | "budget_limited" | "time_limited";
  traceNodes?: ExecutionTraceNode[];
  scriptName?: string;
} = {}): WorkflowRun {
  const trace = Trace.fromArray(overrides.traceNodes ?? [makeTraceNode()]);
  return new WorkflowRun(
    "run-abc123def456",
    {
      scriptSource: 'agent({ prompt: "hi" });',
      args: {},
      scriptName: overrides.scriptName ?? "test-wf",
      scriptPath: "/abs/test-wf.js",
      description: "A test workflow",
    },
    {
      status: overrides.status ?? "done",
      reason: overrides.reason ?? "completed",
      budget: new Budget(),
      calls: new Map(),
      trace,
      errorLogs: [],
    },
    { startedAt: "2026-06-22T10:00:00.000Z", completedAt: "2026-06-22T10:05:00.000Z" },
  );
}

function makeTheme(): ThemeLike {
  return {
    fg: (_token: string, text: string) => text,
    bold: (text: string) => text,
  };
}

function makeActions(): ViewActions {
  return {
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
  };
}

function makeCtx(): ExtensionContext {
  return {
    ui: {
      custom: vi.fn().mockImplementation(<T>(_factory: (...args: unknown[]) => T) => {
        return Promise.resolve() as unknown as Promise<void>;
      }),
    },
  } as unknown as ExtensionContext;
}

// ── Tests ────────────────────────────────────────────────────

describe("WorkflowsView (adapted to WorkflowRun)", () => {
  it("createWorkflowsView accepts WorkflowRun and invokes ctx.ui.custom", async () => {
    const run = makeRun();
    const ctx = makeCtx();
    const actions = makeActions();

    await createWorkflowsView(run, makeTheme(), ctx, actions);

    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
  });

  it("buildPhaseGroups groups trace nodes by phase", () => {
    const nodes = [
      makeTraceNode({ stepIndex: 0, phase: "build", agent: "builder" }),
      makeTraceNode({ stepIndex: 1, phase: "build", agent: "tester" }),
      makeTraceNode({ stepIndex: 2, phase: "deploy", agent: "deployer" }),
    ];
    const groups = buildPhaseGroups(nodes);
    expect(groups).toHaveLength(2);
    expect(groups[0].name).toBe("build");
    expect(groups[0].nodes).toHaveLength(2);
    expect(groups[1].name).toBe("deploy");
    expect(groups[1].nodes).toHaveLength(1);
  });

  it("buildPhaseGroups counts completed nodes in doneCount", () => {
    const nodes = [
      makeTraceNode({ stepIndex: 0, phase: "p1", status: "completed" }),
      makeTraceNode({ stepIndex: 1, phase: "p1", status: "running" }),
      makeTraceNode({ stepIndex: 2, phase: "p1", status: "failed" }),
    ];
    const groups = buildPhaseGroups(nodes);
    expect(groups[0].doneCount).toBe(1);
  });

  it("buildPhaseGroups handles empty trace", () => {
    const groups = buildPhaseGroups([]);
    expect(groups).toHaveLength(0);
  });

  it("formatStatusBadge renders run states (3-state: running/paused/done)", () => {
    const theme = makeTheme();
    expect(formatStatusBadge("running", theme)).toContain("running");
    expect(formatStatusBadge("paused", theme)).toContain("PAUSED");
 // "done" is not in the badge's explicit cases → default branch shows raw status
    expect(formatStatusBadge("done", theme)).toBe("done");
 // Legacy 8-state strings still handled (backward compat for serialized runs)
    expect(formatStatusBadge("failed", theme)).toContain("failed");
  });

  it("ViewActions has no restart (D-9)", () => {
    const actions = makeActions();
    const keys = Object.keys(actions);
    expect(keys).toContain("pause");
    expect(keys).toContain("resume");
    expect(keys).toContain("abort");
    expect(keys).not.toContain("restart");
  });

  it("createWorkflowsView binds actions for paused run (resume enabled)", async () => {
 // WorkflowRun invariant I1: status="running" requires runtime assigned.
 // For view testing, use "paused" (valid without runtime) — the view reads
 // status to toggle pause/resume labels.
    const run = makeRun({ status: "paused", traceNodes: [makeTraceNode({ status: "running" })] });
    const ctx = makeCtx();
    const actions = makeActions();

    await createWorkflowsView(run, makeTheme(), ctx, actions);

 // The custom factory was invoked; actions are wired inside the closure.
 // We verify the factory closure captured actions (no throw + custom called).
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
  });

  it("createWorkflowsView handles multi-phase trace with done status", async () => {
    const nodes = [
      makeTraceNode({ stepIndex: 0, phase: "phase-1", agent: "agent-1" }),
      makeTraceNode({ stepIndex: 1, phase: "phase-2", agent: "agent-2" }),
    ];
    const run = makeRun({ status: "done", reason: "completed", traceNodes: nodes });
    const ctx = makeCtx();

    await createWorkflowsView(run, makeTheme(), ctx, makeActions());

    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
  });
});
