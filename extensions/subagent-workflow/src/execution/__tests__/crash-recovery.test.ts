// src/execution/__tests__/crash-recovery.test.ts
//
// MF-5: session_start crash recovery 路径测试。
//
// 覆盖 store.loadAll 的 4 个分支：
//   1. loadAll 成功 + running run → 重建（transition done,failed + emit pending:unregister failed）
//   2. loadAll 成功 + 已终态 run → 直接 set 到 runs Map，不 transition
//   3. loadAll 失败 → storeHealthy=false，pi.__workflowRun 返回失败（fail-fast）
//   4. loadAll 失败后 subagent 域不受影响（subagent tool 注册仍被调用）
//
// 通过 vi.mock("../../orchestration/jsonl-run-store.ts") 注入可控的 loadAll 行为。
// 路径说明：index.ts 从 ./orchestration/jsonl-run-store.ts 导入 JsonlRunStore，
// 该文件绝对路径 src/orchestration/jsonl-run-store.ts，从本测试文件
// （src/execution/__tests/）相对路径为 ../../orchestration/jsonl-run-store.ts。

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mock modules（在 import 前声明）──

vi.mock("@mariozechner/pi-coding-agent", () => ({
  getAgentDir: () => "/home/user/.pi/agent",
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/home/user/.pi/agent",
}));
vi.mock("@mariozechner/pi-ai", () => ({
  StringEnum: (values: string[]) => ({ type: "string", enum: values }),
}));
vi.mock("@earendil-works/pi-ai", () => ({
  StringEnum: (values: string[]) => ({ type: "string", enum: values }),
}));
vi.mock("@sinclair/typebox", () => ({
  Type: {
    Object: (props: Record<string, unknown>) => ({ type: "object", properties: props }),
    Optional: (schema: unknown) => ({ ...(schema as object), optional: true }),
    String: () => ({ type: "string" }),
    Boolean: () => ({ type: "boolean" }),
    Number: () => ({ type: "number" }),
    Array: (items: unknown) => ({ type: "array", items }),
    Record: (key: unknown, value: unknown) => ({ type: "object", additionalProperties: value, key }),
    Unknown: () => ({ type: "unknown" }),
    Union: (members: unknown[]) => ({ type: "union", members }),
    Literal: (value: unknown) => ({ type: "literal", value }),
  },
}));

// ── hoisted mock 实例：store loadAll 可控 + 工具注册可观察 ──

const { mockLoadAll, mockRegisterSubagentTool, mockScan } = vi.hoisted(() => ({
  mockLoadAll: vi.fn(async () => []),
  mockScan: vi.fn(),
  mockRegisterSubagentTool: vi.fn(),
}));

// JsonlRunStore mock：loadAll 由各 test 配置。构造参数忽略（sessionDir/pi/ctx 都 mock 掉）
vi.mock("../../orchestration/jsonl-run-store.ts", () => ({
  JsonlRunStore: class {
    loadAll = mockLoadAll;
    save = vi.fn(async () => {});
  },
}));

vi.mock("../worktree-manager.ts", () => ({
  WorktreeManager: class {
    constructor(_agentDir: string) {
      /* mock */
    }
    scan = mockScan;
    cleanup = vi.fn();
    create = vi.fn();
    collectPatch = vi.fn();
    registerPid = vi.fn();
  },
}));

vi.mock("../session-file-gc.ts", () => ({
  maybeCleanupExpiredSessionFiles: vi.fn(),
}));

vi.mock("../model-config-service.ts", () => ({
  ModelConfigService: class {
    initModel = vi.fn();
    getAgentRegistry = () => ({ get: () => undefined, list: () => [] });
  },
  getModelConfigService: () => null,
  setModelConfigService: vi.fn(),
}));

vi.mock("../subagent-service.ts", () => ({
  SubagentService: class {
    initSession = vi.fn();
    // W3: index.ts session_start 注入 UI handler 时调用
    setUiRequestHandler = vi.fn();
  },
  getSubagentService: () => null,
  setSubagentService: vi.fn(),
}));

// interface 层模块：mock 掉，避免触发真实 pi.registerTool（pi 是 Proxy，真实模块访问 pi
// 属性时仍可能抛错）。路径相对 src/execution/__tests/ → ../../interface/...
vi.mock("../../interface/subagent-tool.ts", () => ({
  registerSubagentTool: mockRegisterSubagentTool,
}));
vi.mock("../../interface/subagents.ts", () => ({
  registerSubagentsCommand: vi.fn(),
}));
vi.mock("../../interface/bg-notify-render.ts", () => ({
  renderBgNotifyMessage: vi.fn(),
}));
vi.mock("../../interface/tool-workflow.ts", () => ({
  registerWorkflowTool: vi.fn(),
}));
vi.mock("../../interface/tool-workflow-script.ts", () => ({
  registerWorkflowScriptTool: vi.fn(),
}));
vi.mock("../../interface/commands.ts", () => ({
  registerWorkflowsCommand: vi.fn(),
}));

// ── import 被测工厂 ──
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import subagentsExtension from "../../index.ts";
import { Budget } from "../../orchestration/models/budget.ts";
import { Trace } from "../../orchestration/models/trace.ts";
import type { WorkflowRun as WorkflowRunType } from "../../orchestration/models/workflow-run.ts";
import { WorkflowRun } from "../../orchestration/models/workflow-run.ts";

// ── helpers ──

/** 构造一个可重水合的 WorkflowRun（用 WorkflowRun.reconstruct 跳过 I1 校验）。 */
function makeRun(
  runId: string,
  status: "running" | "paused" | "done",
  reason?: "completed" | "failed" | "aborted" | "budget_limited" | "time_limited",
): WorkflowRunType {
  return WorkflowRun.reconstruct(
    runId,
    {
      scriptSource: "execute() {}",
      args: {},
      scriptName: "test",
      scriptPath: "/fake/test.js",
    },
    {
      status,
      reason,
      budget: new Budget({ maxTokens: 1000 }),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: new Date().toISOString() },
  );
}

/** 创建可观察 eventBus.emit 的 mock ExtensionAPI，捕获 session_start handler。 */
function createMockPi(overrides: Record<string, unknown> = {}): {
  pi: ExtensionAPI;
  emits: Array<{ channel: string; data: unknown }>;
  getSessionStartHandler: () => ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
} {
  let sessionStartHandler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const emits: Array<{ channel: string; data: unknown }> = [];
  const events = {
    emit(channel: string, data: unknown): void {
      emits.push({ channel, data });
    },
  };
  const noop = (): void => {
    /* mock */
  };
  const pi = new Proxy<ExtensionAPI>(overrides as ExtensionAPI, {
    get(target, prop: string | symbol): unknown {
      if (prop === "on") {
        return (event: string, handler: (...args: unknown[]) => unknown) => {
          if (event === "session_start") {
            sessionStartHandler = handler as (event: unknown, ctx: unknown) => Promise<void>;
          }
        };
      }
      if (prop === "events") return events;
      if (prop === "appendEntry") return noop;
      if (prop === "registerMessageRenderer") return noop;
      if (prop in target) return target[prop as keyof ExtensionAPI];
      return noop;
    },
  });
  return {
    pi,
    emits,
    getSessionStartHandler: () => sessionStartHandler,
  };
}

/** 最小 ExtensionContext mock。 */
function createMockCtx(): Record<string, unknown> {
  return {
    cwd: "/home/user/project",
    // [Wave1 #21] mode 必填（与 SDK ExtensionContext 契约一致）；默认 tui。
    mode: "tui",
    modelRegistry: {
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    },
    model: undefined,
    sessionManager: {
      getSessionId: () => "session-crash",
      getSessionFile: () => "/home/user/.pi/agent/sessions/session-crash.jsonl",
      getSessionDir: () => "/home/user/.pi/agent/sessions",
      getCwd: () => "/home/user/project",
      getEntries: () => [],
      getBranch: () => [],
      getLeafId: () => null,
      getLeafEntry: () => undefined,
      getEntry: () => undefined,
      getHeader: () => null,
      getTree: () => [],
      getSessionName: () => undefined,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadAll.mockResolvedValue([]);
});

// ── tests ──

describe("session_start crash recovery（store.loadAll 路径）", () => {
  it("loadAll 成功 + running run：transition done,failed + emit pending:unregister failed", async () => {
    const runningRun = makeRun("wf-crash-1", "running");
    mockLoadAll.mockResolvedValue([runningRun]);

    const { pi, emits, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);

    const handler = getSessionStartHandler();
    expect(handler).toBeDefined();
    await handler!({ type: "session_start" }, createMockCtx());

    // run 被转为 done,failed（crash recovery）
    expect(runningRun.state.status).toBe("done");
    expect(runningRun.state.reason).toBe("failed");
    expect(runningRun.state.error).toContain("Process killed");

    // emit pending:unregister（reason=failed）
    const unregister = emits.find((e) => e.channel === "pending:unregister");
    expect(unregister).toBeDefined();
    expect(unregister!.data).toEqual({ id: "wf-crash-1", reason: "failed" });
  });

  it("loadAll 成功 + 已终态 run：直接 set 到 runs Map，不 transition", async () => {
    const doneRun = makeRun("wf-done-1", "done", "completed");
    const originalCompletedAt = doneRun.meta.completedAt;
    mockLoadAll.mockResolvedValue([doneRun]);

    const { pi, emits, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);

    const handler = getSessionStartHandler();
    await handler!({ type: "session_start" }, createMockCtx());

    // 状态不变（仍 done/completed），不重新 transition（completedAt 不变）
    expect(doneRun.state.status).toBe("done");
    expect(doneRun.state.reason).toBe("completed");
    expect(doneRun.meta.completedAt).toBe(originalCompletedAt);

    // 终态 run 不触发 pending:unregister（恢复路径只处理 status==="running"）
    const unregister = emits.filter((e) => e.channel === "pending:unregister");
    expect(unregister).toHaveLength(0);

    // run 已被 set 到 runs Map —— pi.__workflowRun 在 storeHealthy=true 时
    // 不会因 store unavailable 提前返回
    const result = (await (pi as unknown as {
      __workflowRun: (n: string, a: Record<string, unknown>) => Promise<unknown>;
    }).__workflowRun("any", {})) as { error?: string };
    expect(result.error).not.toContain("store unavailable");
  });

  it("loadAll 失败 → storeHealthy=false：pi.__workflowRun 返回 store unavailable 失败", async () => {
    mockLoadAll.mockRejectedValue(new Error("disk corruption"));

    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);

    const handler = getSessionStartHandler();
    await handler!({ type: "session_start" }, createMockCtx());

    // pi.__workflowRun 在 store 不健康时 fail-fast
    const result = (await (pi as unknown as {
      __workflowRun: (n: string, a: Record<string, unknown>) => Promise<unknown>;
    }).__workflowRun("any", {})) as { status: string; reason: string; error: string };

    expect(result.status).toBe("done");
    expect(result.reason).toBe("failed");
    expect(result.error).toContain("store unavailable");
    expect(result.error).toContain("loadAll failed");
  });

  it("loadAll 失败后 subagent 域不受影响：registerSubagentTool 仍被调用", async () => {
    mockLoadAll.mockRejectedValue(new Error("disk corruption"));

    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);

    const handler = getSessionStartHandler();
    await handler!({ type: "session_start" }, createMockCtx());

    // subagent tool 注册在 factory 入口（session_start 之外），与 store 健康无关
    expect(mockRegisterSubagentTool).toHaveBeenCalledTimes(1);
  });
});
