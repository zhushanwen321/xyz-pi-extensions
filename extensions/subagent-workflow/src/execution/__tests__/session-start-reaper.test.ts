// src/__tests__/session-start-reaper.test.ts
//
// 验证 session_start 的两个新行为：
//   1. WTM.scan reaper 被调用（best-effort）
//   2. mainSessionFile 被缓存
//   3. scan 抛错不阻断启动

import { beforeEach,describe, expect, it, vi } from "vitest";

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
    Optional: (schema: unknown) => ({ ...schema as object, optional: true }),
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

// hoisted mock 实例
const { mockScan, mockCleanup } = vi.hoisted(() => ({
  mockScan: vi.fn(),
  mockCleanup: vi.fn(),
}));

vi.mock("../worktree-manager.ts", () => ({
  WorktreeManager: class {
    constructor(_agentDir: string) { /* mock */ }
    scan = mockScan;
    cleanup = mockCleanup;
    create = vi.fn();
    collectPatch = vi.fn();
    registerPid = vi.fn();
  },
}));

vi.mock("../session-file-gc.ts", () => ({
  maybeCleanupExpiredSessionFiles: vi.fn(),
}));

// mock subagent-service：避免真正构造 SubagentService（它依赖 ModelConfigService 等）
const { mockInitModel, mockInitSession, mockSetUiRequestHandler, mockSetModelConfigService, mockSetSubagentService, capturedConstructorArg } =
  vi.hoisted(() => ({
    mockInitModel: vi.fn(),
    mockInitSession: vi.fn(),
    // W3: index.ts session_start 注入 UI handler 时调用
    mockSetUiRequestHandler: vi.fn(),
    mockSetModelConfigService: vi.fn(),
    mockSetSubagentService: vi.fn(),
    capturedConstructorArg: { current: undefined as unknown },
  }));

vi.mock("../model-config-service.ts", () => ({
  ModelConfigService: class {
    initModel = mockInitModel;
    // F-4/D-003: index.ts 复用 modelService.getAgentRegistry()，stub 返回最小结构
    getAgentRegistry = () => ({ get: () => undefined, list: () => [] });
  },
  getModelConfigService: () => null,
  setModelConfigService: mockSetModelConfigService,
}));

vi.mock("../subagent-service.ts", () => ({
  SubagentService: class {
    initSession = mockInitSession;
    // W3: index.ts session_start 注入 UI handler 时调用
    setUiRequestHandler = mockSetUiRequestHandler;
    constructor(init: unknown) {
      capturedConstructorArg.current = init;
    }
  },
  getSubagentService: () => null,
  setSubagentService: mockSetSubagentService,
}));

// mock commands/tools（避免触发真实注册）
vi.mock("../commands/subagents.ts", () => ({
  registerSubagentsCommand: vi.fn(),
}));
vi.mock("../tools/subagent-tool.ts", () => ({
  registerSubagentTool: vi.fn(),
}));
vi.mock("../tui/bg-notify-render.ts", () => ({
  renderBgNotifyMessage: vi.fn(),
}));

// ── import 被测工厂 ──
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import subagentsExtension from "../../index.ts";

// ── helpers ──

/** 创建最小 mock ExtensionAPI，捕获 session_start handler。 */
function createMockPi(overrides: Record<string, unknown> = {}): {
  pi: ExtensionAPI;
  getSessionStartHandler: () => ((event: unknown, ctx: unknown) => void) | undefined;
} {
  let sessionStartHandler: ((event: unknown, ctx: unknown) => void) | undefined;
  const noop = (): void => { /* mock */ };
  const pi = new Proxy<ExtensionAPI>(overrides as ExtensionAPI, {
    get(target, prop: string | symbol): unknown {
      if (prop === "on") {
        return (event: string, handler: (...args: unknown[]) => unknown) => {
          if (event === "session_start") {
            sessionStartHandler = handler as (event: unknown, ctx: unknown) => void;
          }
        };
      }
      if (prop in target) return target[prop as keyof ExtensionAPI];
      return noop;
    },
  });
  return {
    pi,
    getSessionStartHandler: () => sessionStartHandler,
  };
}

/** 最小 ExtensionContext mock。 */
function createMockCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cwd: "/home/user/project",
    // [Wave1 #21] mode 必填（与 SDK ExtensionContext 契约一致）；默认 tui。
    mode: "tui",
    modelRegistry: { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
    model: undefined,
    sessionManager: {
      getSessionId: () => "session-123",
      getSessionFile: () => "/home/user/.pi/agent/sessions/session-123.jsonl",
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
    ...overrides,
  };
}

// ── tests ──

describe("session_start worktree reaper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("session_start 触发 WTM.scan 调用", () => {
    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);

    const handler = getSessionStartHandler();
    expect(handler).toBeDefined();

    handler!(
      { type: "session_start", reason: "startup" },
      createMockCtx(),
    );

    expect(mockScan).toHaveBeenCalledTimes(1);
    // scan 无参（全局注册表，不依赖 cwd）
    expect(mockScan).toHaveBeenCalledWith();
  });

  it("scan 抛错不阻断 session_start", () => {
    mockScan.mockImplementation(() => {
      throw new Error("git not found");
    });

    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);

    const handler = getSessionStartHandler();
    expect(handler).toBeDefined();

    // 不应抛错
    expect(() => {
      handler!(
        { type: "session_start", reason: "startup" },
        createMockCtx(),
      );
    }).not.toThrow();

    // service 仍然被注册（启动未被阻断）
    expect(mockSetSubagentService).toHaveBeenCalled();
  });

  it("mainSessionFile 被缓存并传给 SubagentService", () => {
    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);

    const handler = getSessionStartHandler();
    handler!(
      { type: "session_start", reason: "startup" },
      createMockCtx(),
    );

    // SubagentService 构造参数含 getMainSessionFile getter
    const init = capturedConstructorArg.current as {
      getMainSessionFile?: () => string | undefined;
    } | undefined;
    expect(init).toBeDefined();
    expect(init?.getMainSessionFile).toBeDefined();
    // 返回 session_start 时缓存的 sessionFile
    expect(init?.getMainSessionFile?.()).toBe(
      "/home/user/.pi/agent/sessions/session-123.jsonl",
    );
  });
});
