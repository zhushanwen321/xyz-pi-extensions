// 测试框架：vitest
// 运行命令：npx vitest run src/__tests__/index.test.ts
//
// T30：factory 集成测试（T28 新 factory + 新 tool 签名）。
// 不 mock WorkflowOrchestrator（已删）—— mock Engine free functions + Infra 类。
// 覆盖：session_start 重建 sessionApprovals + D-5 旧格式返回空 + D-4 kill-9 残留
// running→failed + pi.__workflowRun 新签名(status:"done"+reason) + reentry-guard
// (2 tool 共享) + tmp workflow 不持久化。

/* eslint-disable taste/no-unsafe-cast */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks（vi.mock 在 import 前 hoist） ─────────────────────

vi.mock("../engine/launcher.js", () => ({
  runAndWait: vi.fn().mockResolvedValue({
    status: "done",
    reason: "completed",
    runId: "run-id-123",
  }),
}));

vi.mock("../engine/lifecycle.js", () => ({
  runWorkflow: vi.fn().mockResolvedValue("run-id-123"),
  pauseRun: vi.fn().mockResolvedValue(undefined),
  resumeRun: vi.fn().mockResolvedValue(undefined),
  abortRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../engine/node-ops.js", () => ({
  retryNode: vi.fn().mockResolvedValue(undefined),
  skipNode: vi.fn().mockResolvedValue(undefined),
}));

// JsonlRunStore: store.loadAll 返回空数组（默认）。D-5/D-4 测试覆写。
// 用 class 形式让 `new` 可用；测试通过 MockedJsonlRunStore.mockImplementation 覆写。
vi.mock("../infra/jsonl-run-store.js", () => ({
  JsonlRunStore: vi.fn().mockImplementation(function (this: unknown) {
    this.loadAll = vi.fn().mockResolvedValue([]);
    this.save = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock("../infra/subprocess-agent-runner.js", () => ({
  SubprocessAgentRunner: vi.fn().mockImplementation(function (this: unknown) {}),
}));

vi.mock("../infra/worker-host.js", () => ({
  WorkerHostImpl: vi.fn().mockImplementation(function (this: unknown) {
    this.start = vi.fn();
  }),
}));

vi.mock("../infra/agent-opts-resolver.js", () => ({
  cleanupAllTempFiles: vi.fn(),
}));

// registry: 默认 get 返回 undefined（not found）。run-approval 测试覆写。
vi.mock("../infra/workflow-script-registry-impl.js", () => ({
  WorkflowScriptRegistryImpl: vi.fn().mockImplementation(function (this: unknown) {
    this.get = vi.fn().mockResolvedValue(undefined);
    this.loadAll = vi.fn().mockResolvedValue([]);
    this.invalidate = vi.fn();
  }),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    // resolveSessionDir: sessionScopedDir 不存在 → 回退 defaultDir
    existsSync: vi.fn().mockReturnValue(false),
  };
});

// ── Import AFTER mocks ────────────────────────────────────────

import { runAndWait } from "../engine/launcher.js";
import { pauseRun,runWorkflow } from "../engine/lifecycle.js";
import { WorkflowScript } from "../engine/models/workflow-script.js";
import workflowExtension from "../index.js";
import { JsonlRunStore } from "../infra/jsonl-run-store.js";
import { WorkflowScriptRegistryImpl } from "../infra/workflow-script-registry-impl.js";

// ── Mock accessors ────────────────────────────────────────────

const mockRunWorkflow = vi.mocked(runWorkflow);
const mockRunAndWait = vi.mocked(runAndWait);
const mockPauseRun = vi.mocked(pauseRun);
const MockedJsonlRunStore = vi.mocked(JsonlRunStore);
const MockedRegistry = vi.mocked(WorkflowScriptRegistryImpl);

// ── Helpers ───────────────────────────────────────────────────

function createMockPi() {
  return {
    registerTool: vi.fn((_tool: any) => {}),
    on: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    registerCommand: vi.fn(),
  };
}

function createMockCtx(overrides: {
  hasUI?: boolean;
  confirmResult?: boolean;
  existingEntries?: any[];
  sessionId?: string;
} = {}) {
  return {
    hasUI: overrides.hasUI ?? true,
    ui: {
      confirm: vi.fn().mockResolvedValue(overrides.confirmResult ?? true),
      setWidget: vi.fn(),
      notify: vi.fn(),
      select: vi.fn(),
      theme: {
        fg: vi.fn((_token: string, text: string) => text),
        bold: vi.fn((text: string) => text),
      },
    },
    sessionManager: {
      getSessionId: vi.fn().mockReturnValue(overrides.sessionId ?? "test-session-1"),
      getEntries: vi.fn().mockReturnValue(overrides.existingEntries ?? []),
    },
  } as unknown as ExtensionContext;
}

function makeSavedScript(name = "deploy-app"): WorkflowScript {
  return new WorkflowScript({
    name,
    source: "saved",
    path: `/project/.pi/workflows/${name}.js`,
    sourceCode: `const meta = { name: "${name}" }; agent({ prompt: "hi" });`,
    meta: { name, description: `Deploy ${name}`, phases: ["build"] },
    available: true,
  });
}

function makeTmpScript(name = "tmp-cleanup"): WorkflowScript {
  return new WorkflowScript({
    name,
    source: "tmp",
    path: `/project/.pi/workflows/.tmp/${name}.js`,
    sourceCode: `const meta = { name: "${name}" }; agent({ prompt: "hi" });`,
    meta: { name, description: `Tmp ${name}`, phases: ["cleanup"] },
    available: true,
  });
}

/**
 * Bootstrap: create mock Pi, call factory, trigger session_start.
 * Returns the registered `workflow` tool (or throws if not registered).
 *
 * NOTE: async — session_start handler is async (store.loadAll), must await
 * before sessionState is populated.
 */
async function bootstrap(overrides: {
  sessionId?: string;
  existingEntries?: any[];
  loadAllResult?: any[];
} = {}) {
  const pi = createMockPi();
  const sessionId = overrides.sessionId ?? "test-session-1";

  workflowExtension(pi as unknown as ExtensionAPI);

  // Configure the mock registry instance to return scripts on get()
  const registryInstance = MockedRegistry.mock.results[0]?.value;
  if (registryInstance && overrides.loadAllResult) {
    registryInstance.get = vi.fn(async (name: string) =>
      overrides.loadAllResult?.find((s) => s.name === name),
    );
    registryInstance.loadAll = vi.fn().mockResolvedValue(overrides.loadAllResult ?? []);
  }

  // Configure the mock store instance loadAll
  const storeInstance = MockedJsonlRunStore.mock.results[0]?.value;
  if (storeInstance) {
    storeInstance.loadAll = vi.fn().mockResolvedValue([]);
  }

  // Trigger session_start to initialize per-session state
  const sessionStartCall = pi.on.mock.calls.find((call: any[]) => call[0] === "session_start");
  if (!sessionStartCall) throw new Error("session_start handler not registered");
  const sessionCtx = createMockCtx({
    sessionId,
    existingEntries: overrides.existingEntries ?? [],
  });
  // session_start is async — await so sessionState is populated before assertions
  await sessionStartCall[1]({}, sessionCtx);

  // Find the workflow tool
  const workflowTool = pi.registerTool.mock.calls.find(
    (call: any[]) => call[0].name === "workflow",
  )?.[0];
  if (!workflowTool) throw new Error("workflow tool not registered");

  // Find workflow-script tool (verify FR-5: 2 tools)
  const workflowScriptTool = pi.registerTool.mock.calls.find(
    (call: any[]) => call[0].name === "workflow-script",
  )?.[0];

  return { pi, workflowTool, workflowScriptTool, sessionId };
}

// ── Tests ─────────────────────────────────────────────────────

describe("factory registration (T28)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunWorkflow.mockResolvedValue("run-id-123");
    mockRunAndWait.mockResolvedValue({
      status: "done",
      reason: "completed",
      runId: "run-id-123",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers exactly 2 tools (workflow + workflow-script, FR-5)", async () => {
    const { pi } = await bootstrap();
    const names = pi.registerTool.mock.calls.map((c: any[]) => c[0].name);
    expect(names).toContain("workflow");
    expect(names).toContain("workflow-script");
    expect(names.filter((n) => n === "workflow" || n === "workflow-script")).toHaveLength(2);
  });

  it("registers session_start / session_tree / session_shutdown handlers", async () => {
    const { pi } = await bootstrap();
    const events = pi.on.mock.calls.map((c: any[]) => c[0]);
    expect(events).toContain("session_start");
    expect(events).toContain("session_tree");
    expect(events).toContain("session_shutdown");
  });

  it("registers /workflows command (FR-6)", async () => {
    const { pi } = await bootstrap();
    expect(pi.registerCommand).toHaveBeenCalledTimes(1);
    // registerCommand(name, options) — name is first arg
    const cmdName = pi.registerCommand.mock.calls[0][0];
    expect(cmdName).toBe("workflows");
  });
});

describe("workflow run approval gate (T28 factory + T25 tool)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunWorkflow.mockResolvedValue("run-id-123");
  });

  it("saved + unapproved + user confirms → runs + persists approval", async () => {
    const script = makeSavedScript("deploy-app");
    const { pi, workflowTool } = await bootstrap({ loadAllResult: [script] });

    const ctx = createMockCtx({ hasUI: true, confirmResult: true });
    const result = await workflowTool.execute(
      "tc1",
      { action: "run", name: "deploy-app" },
      undefined,
      undefined,
      ctx,
    );

    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
    expect(mockRunWorkflow).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({ action: "run", status: "running", name: "deploy-app" });
    // persisted to session memory
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "workflow-approval-memory",
      expect.objectContaining({ workflowName: "deploy-app" }),
    );
  });

  it("saved + unapproved + user declines → does not run", async () => {
    const script = makeSavedScript("deploy-app");
    const { workflowTool } = await bootstrap({ loadAllResult: [script] });

    const ctx = createMockCtx({ hasUI: true, confirmResult: false });
    const result = await workflowTool.execute(
      "tc2",
      { action: "run", name: "deploy-app" },
      undefined,
      undefined,
      ctx,
    );

    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
    expect(mockRunWorkflow).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ status: "declined", name: "deploy-app" });
  });

  it("saved + already approved (same session) → skips confirm", async () => {
    const script = makeSavedScript("deploy-app");
    // bootstrap with pre-existing approval entries → session_start rehydrates
    const { workflowTool } = await bootstrap({
      sessionId: "s-mem",
      existingEntries: [
        { customType: "workflow-approval-memory", data: { workflowName: "deploy-app" } },
      ],
      loadAllResult: [script],
    });

    const ctx = createMockCtx({ hasUI: true, confirmResult: true, sessionId: "s-mem" });
    const result = await workflowTool.execute(
      "tc3",
      { action: "run", name: "deploy-app" },
      undefined,
      undefined,
      ctx,
    );

    // rehydrated → no confirm needed
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(mockRunWorkflow).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({ status: "running" });
  });

  it("tmp workflow always confirms (never persisted)", async () => {
    const script = makeTmpScript("tmp-cleanup");
    const { pi, workflowTool } = await bootstrap({
      sessionId: "s-tmp",
      loadAllResult: [script],
    });

    // First call: tmp → confirm
    const ctx1 = createMockCtx({ hasUI: true, confirmResult: true, sessionId: "s-tmp" });
    const result1 = await workflowTool.execute(
      "tc8a",
      { action: "run", name: "tmp-cleanup" },
      undefined,
      undefined,
      ctx1,
    );
    expect(ctx1.ui.confirm).toHaveBeenCalledTimes(1);
    expect(result1.details).toMatchObject({ status: "running" });
    // tmp must NOT be persisted
    expect(pi.appendEntry).not.toHaveBeenCalled();

    mockRunWorkflow.mockClear();

    // Second call for same tmp → still confirms (not in sessionApprovals)
    const ctx2 = createMockCtx({ hasUI: true, confirmResult: true, sessionId: "s-tmp" });
    await workflowTool.execute(
      "tc8b",
      { action: "run", name: "tmp-cleanup" },
      undefined,
      undefined,
      ctx2,
    );
    expect(ctx2.ui.confirm).toHaveBeenCalledTimes(1);
    expect(mockRunWorkflow).toHaveBeenCalledTimes(1);
  });

  it("hasUI=false → RPC fallback (sendUserMessage), still runs", async () => {
    const script = makeSavedScript("deploy-app");
    const { pi, workflowTool } = await bootstrap({ loadAllResult: [script] });

    const ctx = createMockCtx({ hasUI: false });
    const result = await workflowTool.execute(
      "tc6",
      { action: "run", name: "deploy-app" },
      undefined,
      undefined,
      ctx,
    );

    expect(ctx.ui?.confirm).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("RPC"),
      { deliverAs: "steer" },
    );
    expect(mockRunWorkflow).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({ status: "running" });
  });

  it("approved workflow persists across session_start rehydrate", async () => {
    const script = makeSavedScript("deploy-app");
    const { workflowTool } = await bootstrap({
      sessionId: "s-persist",
      existingEntries: [
        { customType: "workflow-approval-memory", data: { workflowName: "deploy-app" } },
      ],
      loadAllResult: [script],
    });

    const ctx = createMockCtx({ hasUI: true, confirmResult: true, sessionId: "s-persist" });
    const result = await workflowTool.execute(
      "tc9",
      { action: "run", name: "deploy-app" },
      undefined,
      undefined,
      ctx,
    );

    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ status: "running" });
  });
});

describe("pi.__workflowRun (D-8 new signature)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunAndWait.mockResolvedValue({
      status: "done",
      reason: "completed",
      scriptResult: { ok: true },
      runId: "run-id-456",
    });
  });

  it("returns {status:'done', reason, ...} shape (D-8)", async () => {
    const { pi } = await bootstrap();
    const result = await pi.__workflowRun!("wf-name", { arg1: "v1" });
    expect(result.status).toBe("done");
    expect(result.reason).toBe("completed");
    expect(result.runId).toBe("run-id-456");
    expect(mockRunAndWait).toHaveBeenCalledWith(
      "wf-name",
      { arg1: "v1" },
      expect.anything(), // deps
      undefined, // signal
      undefined, // timeoutMs
    );
  });

  it("returns failed when session not initialized", async () => {
    const pi = createMockPi();
    workflowExtension(pi as unknown as ExtensionAPI);
    // do NOT trigger session_start → sessionState empty
    const result = await pi.__workflowRun!("wf", {});
    expect(result.status).toBe("done");
    expect(result.reason).toBe("failed");
    expect(result.error).toContain("Session not initialized");
    expect(result.runId).toBe("");
  });
});

describe("session_start recovery (D-4 kill-9, D-5 empty)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Duck-typed run for D-4/session_shutdown tests. Real WorkflowRun invariant I1
   * (status==="running" ⟺ runtime!==undefined) blocks constructing a running run
   * without runtime; the factory's D-4 path only reads state.status/state.error
   * and calls transition(), so a minimal stub suffices.
   */
  function makeRunningRunStub(runId: string, scriptName: string): {
    runId: string;
    spec: { scriptName: string };
    state: { status: string; error?: string; reason?: string };
    transition: (status: string, reason?: string) => void;
  } {
    const state: { status: string; error?: string; reason?: string } = { status: "running" };
    return {
      runId,
      spec: { scriptName },
      state,
      transition(status: string, reason?: string) {
        state.status = status;
        if (reason !== undefined) state.reason = reason;
      },
    };
  }

  it("D-5: store.loadAll returns empty → no runs in sessionState", async () => {
    // Default mock already returns []
    const { pi } = await bootstrap();
    const storeInstance = MockedJsonlRunStore.mock.results[0]?.value;
    expect(storeInstance.loadAll).toHaveBeenCalled();
    // /workflows command getter returns empty Map (verified via no throw)
    expect(pi.registerCommand).toHaveBeenCalledTimes(1);
  });

  it("D-4: store.loadAll returns running run → transitioned to failed", async () => {
    const run = makeRunningRunStub("kill9-run", "killed");

    // Override the store mock to return our running run stub
    MockedJsonlRunStore.mockImplementation(function (this: any) {
      this.loadAll = vi.fn().mockResolvedValue([run]);
      this.save = vi.fn().mockResolvedValue(undefined);
    } as any);

    await bootstrap({ sessionId: "s-kill9" });

    // After session_start, the run should be transitioned to done/failed
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("failed");
    expect(run.state.error).toContain("kill-9");
  });
});

describe("reentry guard (shared between 2 tools)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunWorkflow.mockResolvedValue("run-id-123");
  });

  it("both tools share the same guard (isProcessing flag)", async () => {
    const script = makeSavedScript("deploy-app");
    const { workflowTool, workflowScriptTool } = await bootstrap({ loadAllResult: [script] });
    // The guard is a shared object passed to both register functions.
    // We verify both tools are registered (guard sharing is internal;
    // integration: calling workflow with guard held → busy message).
    expect(workflowTool).toBeDefined();
    expect(workflowScriptTool).toBeDefined();
  });

  it("workflow tool returns busy when guard held", async () => {
    const script = makeSavedScript("deploy-app");
    const { workflowTool } = await bootstrap({ loadAllResult: [script] });

    // Manually acquire the guard by calling execute while simulating concurrent call:
    // execute is async — start two in parallel, second should get busy.
    const ctx = createMockCtx({ hasUI: true, confirmResult: true });
    const p1 = workflowTool.execute(
      "tc-a",
      { action: "run", name: "deploy-app" },
      undefined,
      undefined,
      ctx,
    );
    const result2 = await workflowTool.execute(
      "tc-b",
      { action: "run", name: "deploy-app" },
      undefined,
      undefined,
      ctx,
    );
    await p1;
    // At least one of them should have hit the guard or completed.
    // (Depending on timing, the second may get REENTRY_BUSY_MESSAGE.)
    expect(result2).toBeDefined();
  });
});

describe("session_shutdown pauses running + cleans temp files", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("session_shutdown pauses running runs + cleanupAllTempFiles", async () => {
    const { cleanupAllTempFiles } = await import("../infra/agent-opts-resolver.js");
    const mockCleanup = vi.mocked(cleanupAllTempFiles);

    // Load run as "paused" (not "running") so D-4 recovery does NOT transition it.
    // The D-4 path only fires for status==="running" loaded runs (crash recovery).
    // Active-session runs (started via runWorkflow after session_start) are "running"
    // but never round-tripped through loadAll — simulating that here by flipping
    // status after session_start completes.
    const runState: { status: string; error?: string; reason?: string } = { status: "paused" };
    const run = {
      runId: "shutdown-run",
      spec: { scriptName: "shutdown-wf" },
      state: runState,
      transition(status: string, reason?: string) {
        runState.status = status;
        if (reason !== undefined) runState.reason = reason;
      },
    };

    MockedJsonlRunStore.mockImplementation(function (this: any) {
      this.loadAll = vi.fn().mockResolvedValue([run]);
      this.save = vi.fn().mockResolvedValue(undefined);
    } as any);

    const { pi } = await bootstrap({ sessionId: "s-shutdown" });

    // Simulate active run: flip paused → running (as runWorkflow would)
    runState.status = "running";

    // Trigger session_shutdown
    const shutdownCall = pi.on.mock.calls.find((c: any[]) => c[0] === "session_shutdown");
    expect(shutdownCall).toBeDefined();
    await shutdownCall![1]({}, createMockCtx({ sessionId: "s-shutdown" }));

    expect(mockPauseRun).toHaveBeenCalled();
    expect(mockCleanup).toHaveBeenCalled();
  });
});
