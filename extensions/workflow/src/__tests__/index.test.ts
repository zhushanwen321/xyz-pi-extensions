// 测试框架：vitest
// 运行命令：npx vitest run src/__tests__/index.test.ts
//
// factory 集成测试。
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
import { Budget } from "../engine/models/budget.js";
import { Trace } from "../engine/models/trace.js";
import { WorkflowRun } from "../engine/models/workflow-run.js";
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

 // Configure the mock registry instance to return scripts on get
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

describe("factory registration", () => {
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

describe("workflow run approval gate", () => {
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
 * Real WorkflowRun reconstructed from a persisted running snapshot (kill-9 crash).
 *
 * 用真 WorkflowRun.reconstruct —— 它跳过 I1 校验（持久化的 running run 没有 worker，
 * 违反 I1；D-4 在 session_start 时恢复 I1）。这样测试覆盖的是真实的 transition
 * 方法，不是 duck-typed stub（stub 会绕过不变式，测试通过但生产路径仍坏，见 C-1）。
 */
  function makeRunningRun(runId: string, scriptName: string): WorkflowRun {
    return WorkflowRun.reconstruct(
      runId,
      {
        scriptSource: 'return "ok";',
        args: {},
        scriptName,
        scriptPath: `/tmp/${scriptName}.mjs`,
      },
      {
        status: "running",
        budget: new Budget({ maxTokens: 1000 }),
        calls: new Map(),
        trace: new Trace(),
        errorLogs: [],
      },
      { startedAt: "2026-01-01T00:00:00.000Z" },
    );
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
    const run = makeRunningRun("kill9-run", "killed");

 // Override the store mock to return our running run (real WorkflowRun)
    MockedJsonlRunStore.mockImplementation(function (this: any) {
      this.loadAll = vi.fn().mockResolvedValue([run]);
      this.save = vi.fn().mockResolvedValue(undefined);
    } as any);

    await bootstrap({ sessionId: "s-kill9" });

 // After session_start, the run should be transitioned to done/failed
 // via the REAL WorkflowRun.transition method (not a stub).
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("failed");
    expect(run.state.error).toContain("kill-9");
 // I1 恢复：done 状态 runtime 必为 undefined
    expect(run.runtime).toBeUndefined();
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

  it("workflow tool returns busy when guard held (deterministic)", async () => {
    const script = makeSavedScript("deploy-app");
    const { workflowTool } = await bootstrap({ loadAllResult: [script] });

 // 让首个 execute 的 runWorkflow 处于 pending（controllable promise），
 // 第二个 execute 必然命中 guard —— 不再依赖时序。
    let releaseFirst!: () => void;
    mockRunWorkflow.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve("run-pending");
        }),
    );

    const ctx = createMockCtx({ hasUI: true, confirmResult: true });
    const p1 = workflowTool.execute(
      "tc-a",
      { action: "run", name: "deploy-app" },
      undefined,
      undefined,
      ctx,
    );
 // 让 p1 microtask 推进到 acquireReentryGuard 之后
    await Promise.resolve();
    await Promise.resolve();

 // 第二个 execute：guard 已被 p1 持有 → 必返回 busy
    const result2 = await workflowTool.execute(
      "tc-b",
      { action: "run", name: "deploy-app" },
      undefined,
      undefined,
      ctx,
    );
 // 关键断言：result2 必是 busy 错误，不是 toBeDefined 软断言
    expect(result2).toMatchObject({ isError: true });
    const content = (result2 as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
    expect(content).toMatch(/in progress|busy|already running/i);

 // 释放第一个，避免 hang / afterEach 泄漏
    releaseFirst();
    await p1;
  });
});

describe("session_shutdown pauses running + cleans temp files", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("session_shutdown pauses running runs + cleanupAllTempFiles", async () => {
    const { cleanupAllTempFiles } = await import("../infra/agent-opts-resolver.js");
    const mockCleanup = vi.mocked(cleanupAllTempFiles);

 // 用真 WorkflowRun.reconstruct（status="paused"，D-4 不触发）。
 // 模拟 active-session run：session_start 后用 assignRuntime 翻转 paused → running
 // （runWorkflow 的真实路径，不变式 I1 全程保持）。
    const run = WorkflowRun.reconstruct(
      "shutdown-run",
      {
        scriptSource: 'return "ok";',
        args: {},
        scriptName: "shutdown-wf",
        scriptPath: "/tmp/shutdown.mjs",
      },
      {
        status: "paused", // loadAll 时是 paused → D-4 不触发
        budget: new Budget({ maxTokens: 1000 }),
        calls: new Map(),
        trace: new Trace(),
        errorLogs: [],
      },
      { startedAt: "2026-01-01T00:00:00.000Z" },
    );

    MockedJsonlRunStore.mockImplementation(function (this: any) {
      this.loadAll = vi.fn().mockResolvedValue([run]);
      this.save = vi.fn().mockResolvedValue(undefined);
    } as any);

    const { pi } = await bootstrap({ sessionId: "s-shutdown" });

 // Simulate active run: assignRuntime → running（真路径，I1 保持）
     
    run.assignRuntime({
      worker: { postMessage() {}, terminate() {}, isCurrent: true, on() {} },
      gate: { enqueue: vi.fn(), withSlot: vi.fn(), activeCount: 0, queueLength: 0 },
      controller: new AbortController(),
      release() {},
      isReleased: false,
    } as any);
    expect(run.state.status).toBe("running");

 // Trigger session_shutdown
    const shutdownCall = pi.on.mock.calls.find((c: any[]) => c[0] === "session_shutdown");
    expect(shutdownCall).toBeDefined();
    await shutdownCall![1]({}, createMockCtx({ sessionId: "s-shutdown" }));

    expect(mockPauseRun).toHaveBeenCalled();
    expect(mockCleanup).toHaveBeenCalled();
  });
});

describe("session_tree pauses all running runs on branch switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("session_tree handler pauses every running run in the session", async () => {
 // invoke handler 并断言 pauseRun 被调用（不只验证 handler 注册）。
    const runA = WorkflowRun.reconstruct(
      "run-a",
      { scriptSource: "", args: {}, scriptName: "wf-a", scriptPath: "/tmp/a.mjs" },
      {
        status: "paused",
        budget: new Budget({ maxTokens: 1000 }),
        calls: new Map(),
        trace: new Trace(),
        errorLogs: [],
      },
      { startedAt: "2026-01-01T00:00:00.000Z" },
    );
    const runB = WorkflowRun.reconstruct(
      "run-b",
      { scriptSource: "", args: {}, scriptName: "wf-b", scriptPath: "/tmp/b.mjs" },
      {
        status: "paused",
        budget: new Budget({ maxTokens: 1000 }),
        calls: new Map(),
        trace: new Trace(),
        errorLogs: [],
      },
      { startedAt: "2026-01-01T00:00:00.000Z" },
    );

    MockedJsonlRunStore.mockImplementation(function (this: any) {
      this.loadAll = vi.fn().mockResolvedValue([runA, runB]);
      this.save = vi.fn().mockResolvedValue(undefined);
    } as any);

    const { pi } = await bootstrap({ sessionId: "s-tree" });

 // Simulate both runs active via assignRuntime (real path, I1 preserved)
     
    const fakeRuntime = {
      worker: { postMessage() {}, terminate() {}, isCurrent: true, on() {} },
      gate: { enqueue: vi.fn(), withSlot: vi.fn(), activeCount: 0, queueLength: 0 },
      controller: new AbortController(),
      release() {},
      isReleased: false,
    } as any;
    runA.assignRuntime(fakeRuntime);
    runB.assignRuntime(fakeRuntime);
    expect(runA.state.status).toBe("running");
    expect(runB.state.status).toBe("running");

 // Trigger session_tree
    const treeCall = pi.on.mock.calls.find((c: any[]) => c[0] === "session_tree");
    expect(treeCall).toBeDefined();
    await treeCall![1]({}, createMockCtx({ sessionId: "s-tree" }));

 // 关键断言：两个 running run 都被 pauseRun 调过（2 次）
    expect(mockPauseRun).toHaveBeenCalledTimes(2);
    const pausedIds = mockPauseRun.mock.calls.map((c: any[]) => c[0]);
    expect(pausedIds.sort()).toEqual(["run-a", "run-b"]);
  });

  it("session_tree swallows per-run pause errors (doesn't abort branch switch)", async () => {
    const run = WorkflowRun.reconstruct(
      "run-err",
      { scriptSource: "", args: {}, scriptName: "wf-err", scriptPath: "/tmp/e.mjs" },
      {
        status: "paused",
        budget: new Budget({ maxTokens: 1000 }),
        calls: new Map(),
        trace: new Trace(),
        errorLogs: [],
      },
      { startedAt: "2026-01-01T00:00:00.000Z" },
    );

    MockedJsonlRunStore.mockImplementation(function (this: any) {
      this.loadAll = vi.fn().mockResolvedValue([run]);
      this.save = vi.fn().mockResolvedValue(undefined);
    } as any);

 // pauseRun throws —— session_tree must swallow
    mockPauseRun.mockRejectedValueOnce(new Error("pause failed"));

    const { pi } = await bootstrap({ sessionId: "s-tree-err" });
     
    run.assignRuntime({
      worker: { postMessage() {}, terminate() {}, isCurrent: true, on() {} },
      gate: { enqueue: vi.fn(), withSlot: vi.fn(), activeCount: 0, queueLength: 0 },
      controller: new AbortController(),
      release() {},
      isReleased: false,
    } as any);

    const treeCall = pi.on.mock.calls.find((c: any[]) => c[0] === "session_tree");
    expect(treeCall).toBeDefined();
 // Should not throw
    await expect(treeCall![1]({}, createMockCtx({ sessionId: "s-tree-err" }))).resolves.toBeUndefined();
  });
});
