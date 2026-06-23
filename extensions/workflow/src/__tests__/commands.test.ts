// 测试框架：vitest
// 运行命令：npx vitest run src/__tests__/commands.test.ts
//
// S4 (round-4 review): /workflows command handler 的直接单测。
// 之前 index.test.ts 只断言 registerCommand 被调用 + name === "workflows"，
// 从未 invoke handler —— handler 函数体零覆盖（2 个分支：empty / non-empty runs，
// 含 runId.slice(0, RUNID_SHORT) 截断 + reasonSuffix 拼接）。本文件补全。

/* eslint-disable taste/no-unsafe-cast */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { Budget } from "../engine/models/budget.js";
import { Trace } from "../engine/models/trace.js";
import type { DoneReason, RunStatus } from "../engine/models/types.js";
import { WorkflowRun } from "../engine/models/workflow-run.js";
import { registerWorkflowsCommand } from "../interface/commands.js";

// ── Fixtures ─────────────────────────────────────────────────

/**
 * Build a WorkflowRun with minimal valid state for command rendering.
 *
 * Uses `WorkflowRun.reconstruct()` (not `new WorkflowRun`) so we can construct
 * `status: "running"` snapshots without violating invariant I1
 * (running ⟹ runtime defined). The command handler is read-only on state
 * fields, so a reconstructed snapshot is a faithful fixture.
 *
 * `reason` defaults to undefined — done runs only get a reason suffix when the
 * caller explicitly sets one (matching how real persisted snapshots look when
 * reconstructed from incomplete fixtures).
 */
function makeRun(overrides: {
  runId?: string;
  scriptName?: string;
  status?: RunStatus;
  reason?: DoneReason;
} = {}): WorkflowRun {
  const state: ConstructorParameters<typeof WorkflowRun>[2] = {
    status: overrides.status ?? "done",
    budget: new Budget(),
    calls: new Map(),
    trace: Trace.fromArray([]),
    errorLogs: [],
  };
  if (overrides.reason !== undefined) state.reason = overrides.reason;
  return WorkflowRun.reconstruct(
    overrides.runId ?? "run-abc123def456",
    {
      scriptSource: 'agent({ prompt: "hi" });',
      args: {},
      scriptName: overrides.scriptName ?? "test-wf",
      scriptPath: "/abs/test-wf.js",
      description: "A test workflow",
    },
    state,
    { startedAt: "2026-06-22T10:00:00.000Z", completedAt: "2026-06-22T10:05:00.000Z" },
  );
}

/** Minimal mock Pi with registerCommand captured for later invocation. */
function makePi(): { pi: ExtensionAPI; getCommandOpts: () => { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } } {
  let captured: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } | undefined;
  const pi = {
    registerCommand: vi.fn((_name: string, opts: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
      captured = opts;
    }),
  } as unknown as ExtensionAPI;
  return {
    pi,
    getCommandOpts: () => {
      if (!captured) throw new Error("registerCommand was not called");
      return captured;
    },
  };
}

/** Mock ExtensionCommandContext with a notify spy. */
function makeCommandCtx(): { ctx: ExtensionCommandContext; notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn();
  const ctx = { ui: { notify } } as unknown as ExtensionCommandContext;
  return { ctx, notify };
}

// ── Tests ────────────────────────────────────────────────────

describe("registerWorkflowsCommand handler (S4)", () => {
  it("registers command named 'workflows'", () => {
    const { pi } = makePi();
    registerWorkflowsCommand(pi, () => new Map());
    expect(pi.registerCommand).toHaveBeenCalledTimes(1);
    expect((pi.registerCommand as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("workflows");
  });

  it("empty runs → notify 'No workflows in current session.' (info)", async () => {
    const { pi, getCommandOpts } = makePi();
    registerWorkflowsCommand(pi, () => new Map());
    const { ctx, notify } = makeCommandCtx();

    await getCommandOpts().handler("", ctx);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("No workflows in current session.", "info");
  });

  it("non-empty runs → notify formatted lines with [status (reason)] scriptName (runId前8位)", async () => {
    const { pi, getCommandOpts } = makePi();
    const runs = new Map<string, WorkflowRun>([
      // paused run → no reason (I2 only requires reason for done; paused has none) → no suffix
      ["run-abc123def456", makeRun({ runId: "run-abc123def456", scriptName: "deploy-app", status: "paused" })],
      // done with reason → " (failed)" suffix appended
      ["run-999888777666", makeRun({ runId: "run-999888777666", scriptName: "rollback", status: "done", reason: "failed" })],
    ]);
    registerWorkflowsCommand(pi, () => runs);
    const { ctx, notify } = makeCommandCtx();

    await getCommandOpts().handler("", ctx);

    expect(notify).toHaveBeenCalledTimes(1);
    const [message, level] = notify.mock.calls[0];
    expect(level).toBe("info");
    // Two lines, one per run
    const lines = message.split("\n");
    expect(lines).toHaveLength(2);
    // paused without reason → no suffix
    expect(lines[0]).toBe("[paused] deploy-app (run-abc1)");
    // done with reason → reasonSuffix " (failed)" appended
    expect(lines[1]).toBe("[done (failed)] rollback (run-9998)");
  });

  it("runId is truncated to 8 chars (RUNID_SHORT)", async () => {
    const { pi, getCommandOpts } = makePi();
    const longRunId = "run-abcdefghijklmnopqrstuvwxyz1234567890";
    const runs = new Map<string, WorkflowRun>([
      [longRunId, makeRun({ runId: longRunId, scriptName: "wf", status: "paused" })],
    ]);
    registerWorkflowsCommand(pi, () => runs);
    const { ctx, notify } = makeCommandCtx();

    await getCommandOpts().handler("", ctx);

    const [message] = notify.mock.calls[0];
    // paused run has no reason → no suffix; runId truncated to first 8 chars
    expect(message).toBe(`[paused] wf (${longRunId.slice(0, 8)})`);
    expect(message).not.toContain(longRunId.slice(8));
  });

  it("getRuns closure is evaluated at invocation time (reflects live state)", async () => {
    // Verify the handler reads the Map fresh each call — not captured at registration.
    const { pi, getCommandOpts } = makePi();
    const runs = new Map<string, WorkflowRun>();
    registerWorkflowsCommand(pi, () => runs);
    const { ctx, notify } = makeCommandCtx();

    // First call: empty
    await getCommandOpts().handler("", ctx);
    expect(notify.mock.calls[0][0]).toBe("No workflows in current session.");

    // Mutate the same Map between calls
    runs.set("run-111111111111", makeRun({ runId: "run-111111111111", scriptName: "late", status: "running" }));

    // Second call: now non-empty
    await getCommandOpts().handler("", ctx);
    const [message] = notify.mock.calls[1];
    expect(message).toBe("[running] late (run-1111)");
  });
});
