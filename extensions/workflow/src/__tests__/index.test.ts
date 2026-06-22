// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach）
// 运行命令：npx vitest run src/__tests__/index.test.ts
 

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { beforeEach,describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────

const mockRun = vi.hoisted(() => vi.fn().mockResolvedValue("run-id-123"));
const mockList = vi.hoisted(() => vi.fn().mockReturnValue([]));

const TEST_SAVED_WORKFLOW = {
  name: "deploy-app",
  description: "Deploy the app to staging",
  phases: ["build", "deploy"],
  path: "/project/.pi/workflows/deploy-app.js",
  available: true,
  source: "saved",
};

const TEST_TMP_WORKFLOW = {
  name: "tmp-cleanup",
  description: "Temporary cleanup workflow",
  phases: ["cleanup"],
  path: "/project/.pi/workflows/.tmp/tmp-cleanup.js",
  available: true,
  source: "tmp",
};

vi.mock("../infra/config-loader.js", () => ({
  loadWorkflows: vi.fn().mockResolvedValue([TEST_SAVED_WORKFLOW, TEST_TMP_WORKFLOW]),
  getWorkflow: vi.fn(),
  invalidateCache: vi.fn(),
}));

vi.mock("../orchestrator.js", () => ({
  WorkflowOrchestrator: vi.fn().mockImplementation(function () {
    this.run = mockRun;
    this.list = mockList;
    this.getInstance = vi.fn().mockReturnValue(undefined);
    this.restoreInstances = vi.fn();
    this.reconstructAndRestore = vi.fn();
    this.getAgentCount = vi.fn().mockReturnValue(0);
    this.getAgents = vi.fn().mockReturnValue([]);
    this.pause = vi.fn();
    this.resume = vi.fn();
    this.abort = vi.fn();
    this.persistState = vi.fn();
    this.onTraceUpdate = null;
    this.onCompletion = null;
  }),
}));

vi.mock("../interface/commands.js", () => ({
  registerWorkflowCommands: vi.fn(),
  sendCompletionNotification: vi.fn(),
}));

vi.mock("../interface/tool-generate.js", () => ({
  registerGenerateTool: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn().mockImplementation(() => {
      throw new Error("not found");
    }),
  };
});

// ── Import AFTER mocks ────────────────────────────────────────

import workflowExtension from "../index.js";

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
  // Mock ExtensionContext——createMockCtx 只实现 ui/sessionManager 子集。
  // eslint-disable-next-line taste/no-unsafe-cast
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

/**
 * Bootstrap: create a mock Pi, call the factory, trigger session_start
 * to set up the orchestrator in the session map, and return the pi + tools.
 */
function bootstrap(overrides: {
  sessionId?: string;
  existingEntries?: any[];
} = {}) {
  const pi = createMockPi();
  const sessionId = overrides.sessionId ?? "test-session-1";

  // Call the factory to register tools and events
  // Mock ExtensionAPI——createMockPi 只实现测试所需子集。
  // eslint-disable-next-line taste/no-unsafe-cast
  workflowExtension(pi as unknown as ExtensionAPI);

  // Trigger session_start to create and register the orchestrator
  const sessionStartCall = pi.on.mock.calls.find(
    (call: any[]) => call[0] === "session_start",
  );
  if (!sessionStartCall) throw new Error("session_start handler not registered");

  const sessionStartHandler = sessionStartCall[1];
  const sessionCtx = createMockCtx({
    sessionId,
    existingEntries: overrides.existingEntries ?? [],
  });

  // session_start is async
  sessionStartHandler({}, sessionCtx);

  // Find the workflow-run tool
  const workflowRun = pi.registerTool.mock.calls.find(
    (call: any[]) => call[0].name === "workflow-run",
  )?.[0];
  if (!workflowRun) throw new Error("workflow-run tool not registered");

  return { pi, workflowRun, sessionId };
}

// ── Tests ─────────────────────────────────────────────────────
// W4 过渡期：T25 重写 tool-workflow（合并 workflow-run），旧 index.ts 不再注册
// workflow-run tool。这些测试在 W5 T30 重写（新 factory + 新 tool 签名）。
// 暂时 skip，T30 恢复。

describe.skip("workflow-run approval gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRun.mockResolvedValue("run-id-123");
    mockList.mockReturnValue([]);
  });

  it("auto_confirm_user_yes_runs_workflow", async () => {
    const { workflowRun } = bootstrap();

    const ctx = createMockCtx({ hasUI: true, confirmResult: true });
    const result = await workflowRun.execute(
      "tc1",
      { name: "deploy-app", mode: "auto" },
      undefined,
      undefined,
      ctx,
    );

    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(result.details.status).toBe("running");
    expect(result.details.runId).toBe("run-id-123");
  });

  it("auto_confirm_user_no_declines", async () => {
    const { workflowRun } = bootstrap();

    const ctx = createMockCtx({ hasUI: true, confirmResult: false });
    const result = await workflowRun.execute(
      "tc2",
      { name: "deploy-app", mode: "auto" },
      undefined,
      undefined,
      ctx,
    );

    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
    expect(mockRun).not.toHaveBeenCalled();
    expect(result.details.status).toBe("declined");
  });

  it("auto_session_memory_skips_confirm", async () => {
    // Use same session so sessionApprovals Set is shared
    const { pi, workflowRun } = bootstrap({ sessionId: "s-mem" });

    // First call: confirm = true → stores approval
    const ctx1 = createMockCtx({ hasUI: true, confirmResult: true, sessionId: "s-mem" });
    const result1 = await workflowRun.execute(
      // toolCallId "tc3" 为测试占位，execute 不校验格式。
      // eslint-disable-next-line taste/no-unsafe-cast
      "tc3" as any,
      { name: "deploy-app", mode: "auto" },
      undefined,
      undefined,
      ctx1,
    );
    void result1;

    expect(ctx1.ui.confirm).toHaveBeenCalledTimes(1);
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "workflow-approval-memory",
      expect.objectContaining({ workflowName: "deploy-app" }),
    );

    mockRun.mockClear();

    // Second call: sessionApprovals has "deploy-app" → confirm skipped
    const ctx2 = createMockCtx({ hasUI: true, confirmResult: true, sessionId: "s-mem" });
    const result2 = await workflowRun.execute(
      "tc4",
      { name: "deploy-app", mode: "auto" },
      undefined,
      undefined,
      ctx2,
    );

    expect(ctx2.ui.confirm).not.toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(result2.details.status).toBe("running");
  });

  it("session_start_rehydrates_approvals", async () => {
    // Bootstrap with pre-existing approval entries
    const { workflowRun } = bootstrap({
      sessionId: "s-rehydrate",
      existingEntries: [
        { customType: "workflow-approval-memory", data: { workflowName: "deploy-app" } },
        { customType: "workflow-approval-memory", data: { workflowName: "another-wf" } },
      ],
    });

    // Run workflow-run: "deploy-app" was rehydrated → no confirm needed
    const runCtx = createMockCtx({ hasUI: true, confirmResult: true, sessionId: "s-rehydrate" });
    const result = await workflowRun.execute(
      "tc5",
      { name: "deploy-app", mode: "auto" },
      undefined,
      undefined,
      runCtx,
    );

    expect(runCtx.ui.confirm).not.toHaveBeenCalled();
    expect(result.details.status).toBe("running");
  });

  it("auto_hasUI_false_falls_back_to_sendUserMessage", async () => {
    const { pi, workflowRun } = bootstrap();

    const ctx = createMockCtx({ hasUI: false });
    const result = await workflowRun.execute(
      "tc6",
      { name: "deploy-app", mode: "auto" },
      undefined,
      undefined,
      ctx,
    );

    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("RPC mode"),
      { deliverAs: "steer" },
    );
    // hasUI=false still runs the workflow (no interactive gate)
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(result.details.status).toBe("running");
  });

  it("force_skips_confirm_and_sets_confirmSkipped", async () => {
    const { workflowRun } = bootstrap();

    const ctx = createMockCtx({ hasUI: true });
    const result = await workflowRun.execute(
      "tc7",
      { name: "deploy-app", mode: "force" },
      undefined,
      undefined,
      ctx,
    );

    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(result.details.confirmSkipped).toBe(true);
  });

  it("tmp_workflow_always_confirms", async () => {
    const { pi, workflowRun } = bootstrap({ sessionId: "s-tmp" });

    // First call for tmp workflow → should confirm
    const ctx1 = createMockCtx({ hasUI: true, confirmResult: true, sessionId: "s-tmp" });
    const result1 = await workflowRun.execute(
      "tc8a",
      { name: "tmp-cleanup", mode: "auto" },
      undefined,
      undefined,
      ctx1,
    );

    expect(ctx1.ui.confirm).toHaveBeenCalledTimes(1);
    expect(result1.details.status).toBe("running");
    // tmp workflows should NOT be persisted to sessionApprovals
    expect(pi.appendEntry).not.toHaveBeenCalled();

    mockRun.mockClear();

    // Second call for same tmp workflow → should STILL confirm
    const ctx2 = createMockCtx({ hasUI: true, confirmResult: true, sessionId: "s-tmp" });
    const result2 = await workflowRun.execute(
      "tc8b",
      { name: "tmp-cleanup", mode: "auto" },
      undefined,
      undefined,
      ctx2,
    );

    // Confirm IS called again because tmp workflows are never added to sessionApprovals
    expect(ctx2.ui.confirm).toHaveBeenCalledTimes(1);
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(result2.details.status).toBe("running");
  });

  it("session_memory_persists_across_sessionStart", async () => {
    // Bootstrap with pre-existing entries — session_start rehydrates them
    const { workflowRun } = bootstrap({
      sessionId: "s-persist",
      existingEntries: [
        { customType: "workflow-approval-memory", data: { workflowName: "deploy-app" } },
      ],
    });

    // The session_start was already called during bootstrap,
    // which rehydrated sessionApprovals with "deploy-app"

    const runCtx = createMockCtx({ hasUI: true, confirmResult: true, sessionId: "s-persist" });
    const result = await workflowRun.execute(
      "tc9",
      { name: "deploy-app", mode: "auto" },
      undefined,
      undefined,
      runCtx,
    );

    expect(runCtx.ui.confirm).not.toHaveBeenCalled();
    expect(result.details.status).toBe("running");
  });
});
