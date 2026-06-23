// 测试框架：vitest
// 运行命令：npx vitest run src/__tests__/commands.test.ts
//
// /workflows command handler 测试（Bug #2 修复：TUI 恢复）。
//
// handler 行为：
//   - 无 UI（RPC 模式）→ notify error
//   - 0 runs → notify info "No workflows"
//   - 1 run → 直接打开 view（ctx.ui.custom 被调）
//   - 多 runs → ctx.ui.select 选 → 打开选中 run 的 view
//   - `/workflows <runId>` → 精确/前缀匹配 → 直开
//
// view 内部渲染（键盘导航等）由 workflows-view.test.ts 覆盖，本文件只测 command 路由。

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
 * Build a WorkflowRun with minimal valid state for view rendering.
 *
 * Uses `WorkflowRun.reconstruct()` (not `new WorkflowRun`) so we can construct
 * `status: "running"` snapshots without violating invariant I1
 * (running ⟹ runtime defined). The command handler is read-only on state
 * fields, so a reconstructed snapshot is a faithful fixture.
 *
 * Default status is "paused" — avoids I2 (done ⟹ reason) for tests that don't
 * care about status. Tests that need "done" must pass a reason.
 */
function makeRun(overrides: {
  runId?: string;
  scriptName?: string;
  status?: RunStatus;
  reason?: DoneReason;
  startedAt?: string;
} = {}): WorkflowRun {
  const state: ConstructorParameters<typeof WorkflowRun>[2] = {
    status: overrides.status ?? "paused",
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
    { startedAt: overrides.startedAt ?? "2026-06-22T10:00:00.000Z", completedAt: "2026-06-22T10:05:00.000Z" },
  );
}

/** Minimal mock LauncherDeps — command handler only invokes pause/resume/abort through it. */
function makeDeps(): unknown {
  // Handler only reads deps to pass into ViewActions; lifecycle functions are
  // not invoked in these tests (no key pressed inside the view). Cast via
  // unknown to avoid constructing the full LifecycleDeps surface.
  return {
    runs: new Map(),
    store: {},
    workerHost: {},
    runner: {},
    registry: {},
  };
}

/** Capture registerCommand + return its handler for invocation. */
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

/** Mock ExtensionCommandContext. hasUI defaults to true; select/custom/notify are spies. */
function makeCommandCtx(overrides: {
  hasUI?: boolean;
  selectResult?: string | undefined;
} = {}): { ctx: ExtensionCommandContext; notify: ReturnType<typeof vi.fn>; select: ReturnType<typeof vi.fn>; custom: ReturnType<typeof vi.fn> } {
  const notify = vi.fn();
  const select = vi.fn().mockResolvedValue(overrides.selectResult);
  const custom = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    hasUI: overrides.hasUI ?? true,
    ui: {
      notify,
      select,
      custom,
      theme: { fg: (_t: string, text: string) => text, bold: (t: string) => t },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notify, select, custom };
}

// ── Tests ────────────────────────────────────────────────────

describe("registerWorkflowsCommand handler (Bug #2: TUI restored)", () => {
  it("registers command named 'workflows'", () => {
    const { pi } = makePi();
    registerWorkflowsCommand(pi, () => new Map(), makeDeps() as never);
    expect(pi.registerCommand).toHaveBeenCalledTimes(1);
    expect((pi.registerCommand as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("workflows");
  });

  it("no UI (RPC mode) → notify error, view not opened", async () => {
    const { pi, getCommandOpts } = makePi();
    registerWorkflowsCommand(pi, () => new Map(), makeDeps() as never);
    const { ctx, notify, custom } = makeCommandCtx({ hasUI: false });

    await getCommandOpts().handler("", ctx);

    expect(notify).toHaveBeenCalledWith("/workflows requires interactive mode", "error");
    expect(custom).not.toHaveBeenCalled();
  });

  it("0 runs → notify 'No workflows in current session.'", async () => {
    const { pi, getCommandOpts } = makePi();
    registerWorkflowsCommand(pi, () => new Map(), makeDeps() as never);
    const { ctx, notify, custom } = makeCommandCtx();

    await getCommandOpts().handler("", ctx);

    expect(notify).toHaveBeenCalledWith("No workflows in current session.", "info");
    expect(custom).not.toHaveBeenCalled();
  });

  it("1 run → directly opens view (ctx.ui.custom invoked)", async () => {
    const { pi, getCommandOpts } = makePi();
    const runs = new Map<string, WorkflowRun>([
      ["run-abc123def456", makeRun({ runId: "run-abc123def456", scriptName: "deploy" })],
    ]);
    registerWorkflowsCommand(pi, () => runs, makeDeps() as never);
    const { ctx, notify, select, custom } = makeCommandCtx();

    await getCommandOpts().handler("", ctx);

    expect(custom).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("multiple runs → select invoked, then opens selected run's view", async () => {
    const { pi, getCommandOpts } = makePi();
    const runs = new Map<string, WorkflowRun>([
      ["run-abc123def456", makeRun({ runId: "run-abc123def456", scriptName: "deploy" })],
      ["run-999888777666", makeRun({ runId: "run-999888777666", scriptName: "rollback", status: "paused" })],
    ]);
    registerWorkflowsCommand(pi, () => runs, makeDeps() as never);
    // select returns the second entry
    const { ctx, select, custom } = makeCommandCtx({
      selectResult: "rollback [paused] (run-9998)",
    });

    await getCommandOpts().handler("", ctx);

    expect(select).toHaveBeenCalledTimes(1);
    const [, options] = select.mock.calls[0];
    expect(options).toHaveLength(2);
    expect(options[0]).toContain("deploy");
    expect(options[1]).toContain("rollback");
    expect(custom).toHaveBeenCalledTimes(1);
  });

  it("multiple runs + user cancels select → view not opened", async () => {
    const { pi, getCommandOpts } = makePi();
    const runs = new Map<string, WorkflowRun>([
      ["run-abc123def456", makeRun({ runId: "run-abc123def456", scriptName: "a" })],
      ["run-999888777666", makeRun({ runId: "run-999888777666", scriptName: "b" })],
    ]);
    registerWorkflowsCommand(pi, () => runs, makeDeps() as never);
    const { ctx, custom } = makeCommandCtx({ selectResult: undefined });

    await getCommandOpts().handler("", ctx);

    expect(custom).not.toHaveBeenCalled();
  });

  it("/workflows <runId> → exact match → opens view, no select", async () => {
    const { pi, getCommandOpts } = makePi();
    const runs = new Map<string, WorkflowRun>([
      ["run-abc123def456", makeRun({ runId: "run-abc123def456", scriptName: "deploy" })],
      ["run-999888777666", makeRun({ runId: "run-999888777666", scriptName: "rollback" })],
    ]);
    registerWorkflowsCommand(pi, () => runs, makeDeps() as never);
    const { ctx, select, custom } = makeCommandCtx();

    await getCommandOpts().handler("run-abc123def456", ctx);

    expect(custom).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
  });

  it("/workflows <prefix> → unique prefix match → opens view", async () => {
    const { pi, getCommandOpts } = makePi();
    const runs = new Map<string, WorkflowRun>([
      ["run-abc123def456", makeRun({ runId: "run-abc123def456", scriptName: "deploy" })],
      ["run-999888777666", makeRun({ runId: "run-999888777666", scriptName: "rollback" })],
    ]);
    registerWorkflowsCommand(pi, () => runs, makeDeps() as never);
    const { ctx, custom } = makeCommandCtx();

    await getCommandOpts().handler("run-abc", ctx);

    expect(custom).toHaveBeenCalledTimes(1);
  });

  it("/workflows <unknown runId> → notify 'not found'", async () => {
    const { pi, getCommandOpts } = makePi();
    const runs = new Map<string, WorkflowRun>([
      ["run-abc123def456", makeRun({ runId: "run-abc123def456", scriptName: "deploy" })],
    ]);
    registerWorkflowsCommand(pi, () => runs, makeDeps() as never);
    const { ctx, notify, custom } = makeCommandCtx();

    await getCommandOpts().handler("run-nonexistent", ctx);

    expect(notify).toHaveBeenCalledWith("Workflow 'run-nonexistent' not found", "error");
    expect(custom).not.toHaveBeenCalled();
  });

  it("runs sorted: running/paused before done, newer startedAt first", async () => {
    // Verify sort order via select options order.
    const { pi, getCommandOpts } = makePi();
    const runs = new Map<string, WorkflowRun>([
      // done, older
      ["run-old", makeRun({ runId: "run-old", scriptName: "old-done", status: "done", reason: "completed", startedAt: "2026-06-22T09:00:00.000Z" })],
      // paused, newer (should be first — paused sorts before done)
      ["run-new", makeRun({ runId: "run-new", scriptName: "new-paused", status: "paused", startedAt: "2026-06-22T11:00:00.000Z" })],
    ]);
    registerWorkflowsCommand(pi, () => runs, makeDeps() as never);
    const { ctx, select } = makeCommandCtx({ selectResult: "placeholder" });

    await getCommandOpts().handler("", ctx);

    const [, options] = select.mock.calls[0];
    // paused sorts before done → "new-paused" first
    expect(options[0]).toContain("new-paused");
    expect(options[1]).toContain("old-done");
  });
});
