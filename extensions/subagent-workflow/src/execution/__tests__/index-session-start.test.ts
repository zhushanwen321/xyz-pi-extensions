// src/execution/__tests__/index-session-start.test.ts
//
// C2 critical: index.ts session_start 的 UI handler 注入链路测试。
//
// 测试目标：验证 `subagentsWorkflowExtension(pi)` 的 session_start handler
// 是否正确注入 uiRequestHandler，特别是 **SR-3**：
//   无论 new 还是 existing SubagentService，session_start 都必须调
//   setUiRequestHandler——/resume /fork 复用 existingService 时旧 handler 可能失效。
//
// 4 个 case：
//   1. new 路径（existingService=null）：setUiRequestHandler 被调，参数是函数（tui mode）
//   2. existing 路径（existingService=mockService）：setUiRequestHandler 仍被调（SR-3 关键）
//   3. headless mode（json）：createUiRequestHandlerForMode 返回 undefined，
//      setUiRequestHandler(undefined) 被调（不注入但仍有调用，SR-3 形式不破）
//   4. rpc mode：setUiRequestHandler 被调，参数是函数
//
// 既有 crash-recovery.test.ts / session-start-reaper.test.ts mock 了 SubagentService
// 但**没有断言 setUiRequestHandler 被调用**——本测试补这个断言，且覆盖 existing 路径
// （既有测试 fixed getSubagentService() => null，只能走 new 分支）。

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mock modules（在 import 前声明；路径相对 src/execution/__tests/） ──
//
// [D15] 为何此处内联 vi.mock 与 vitest.config.ts 的 alias（包根 mocks/pi-coding-agent.ts）并存：
// 两套 mock 分工不同，不强制统一——
//   1. **config alias（包根 mocks/pi-coding-agent.ts）**：完整 stub，导出 ExtensionAPI/
//      ExtensionContext/ExtensionMode 等 *类型*（编译期擦除）+ getAgentDir 运行时值。服务于
//      全仓库绝大多数测试的类型解析与轻量 mock（不 import 真实重模块的测试直接吃 alias）。
//   2. **本文件内联 vi.mock（下方）**：vi.mock 在运行时覆盖 config alias，确保本文件 import
//      真实 index.ts（它 `import { getAgentDir } from "@mariozechner/pi-coding-agent"` +
//      一组 type-only import）时，运行时只暴露 getAgentDir，彻底隔离真实 SDK 的模块顶层
//      副作用（避免 jiti 加载真实 pi 包触发未 mock 的依赖链）。
//   3. 形状一致性：内联 mock 的运行时值形状（`{ getAgentDir }`）与 alias stub 的运行时值
//      形状完全一致（alias stub 运行时也只导出 getAgentDir 函数，类型导出在运行期擦除）。
//      差异仅在「覆盖时机」——vi.mock 比 alias 更早介入模块图解析，保证真实 index.ts 加载时
//      拿到的是纯函数桩而非 alias 的完整对象。
//   4. crash-recovery.test.ts / session-start-reaper.test.ts 同此模式（import 真实模块的
//      测试统一用内联 vi.mock 覆盖），三者保持一致。
// 结论：不抽共享 mocks 文件。alias 已承担类型解析，内联 vi.mock 承担运行时隔离，职责正交。

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

// ── hoisted mock 实例：捕获 setUiRequestHandler 调用 + 可控行为 ──

const {
  mockSetUiRequestHandler,
  mockInitSession,
  mockLoadAll,
  mockRecoverManifestTmpFiles,
  /** existing service 引用——测试可改写以模拟 /resume /fork 复用。 */
  existingServiceRef,
} = vi.hoisted(() => ({
  mockSetUiRequestHandler: vi.fn(),
  mockInitSession: vi.fn(),
  mockLoadAll: vi.fn(async () => []),
  // ADR-035 启动恢复接线守护：session_start 必须调 service.recoverManifestTmpFiles
  mockRecoverManifestTmpFiles: vi.fn(async () => ({ deleted: 0, recovered: 0 })),
  existingServiceRef: { current: null as unknown },
}));

// SubagentService mock：每次构造都返回同一组 spy，setUiRequestHandler 可观察。
// getSubagentService 返回 existingServiceRef.current（null=走 new；非 null=走 existing）。
vi.mock("../subagent-service.ts", () => ({
  SubagentService: class {
    initSession = mockInitSession;
    setUiRequestHandler = mockSetUiRequestHandler;
    recoverManifestTmpFiles = mockRecoverManifestTmpFiles;
    getStreamSink = () => null;
    dispose = vi.fn();
  },
  getSubagentService: () => existingServiceRef.current,
  setSubagentService: vi.fn(),
}));

vi.mock("../model-config-service.ts", () => ({
  ModelConfigService: class {
    initModel = vi.fn();
    getAgentRegistry = () => ({ get: () => undefined, list: () => [] });
    setCtxModel = vi.fn();
  },
  getModelConfigService: () => null,
  setModelConfigService: vi.fn(),
}));

vi.mock("../worktree-manager.ts", () => ({
  WorktreeManager: class {
    constructor(_agentDir: string) {
      /* mock */
    }
    scan = vi.fn();
    cleanup = vi.fn();
    create = vi.fn();
    collectPatch = vi.fn();
    registerPid = vi.fn();
  },
}));

vi.mock("../session-file-gc.ts", () => ({
  maybeCleanupExpiredSessionFiles: vi.fn(),
}));

// JsonlRunStore mock：loadAll 默认空数组（session_start 后段不抛即可）
vi.mock("../../orchestration/jsonl-run-store.ts", () => ({
  JsonlRunStore: class {
    loadAll = mockLoadAll;
    save = vi.fn(async () => {});
  },
}));

// interface 层 mock：避免触发真实 pi.registerTool（pi 是 Proxy，真实模块访问 pi
// 属性时可能抛错）。路径相对 src/execution/__tests/ → ../../interface/...
vi.mock("../../interface/subagent-tool.ts", () => ({
  registerSubagentTool: vi.fn(),
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

// ── helpers ──

/** 创建可观察的 mock ExtensionAPI，捕获 session_start handler。
 *  Proxy 兜底：未显式处理的 pi.xxx 返回 noop，避免抛错。 */
function createMockPi(): {
  pi: ExtensionAPI;
  getSessionStartHandler: () => ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
} {
  let sessionStartHandler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const events = { emit: vi.fn() };
  const noop = (): void => {
    /* mock */
  };
  const pi = new Proxy<ExtensionAPI>({} as ExtensionAPI, {
    get(_target, prop: string | symbol): unknown {
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
      return noop;
    },
  });
  return { pi, getSessionStartHandler: () => sessionStartHandler };
}

/** 最小 ExtensionContext mock。mode 由参数控制（决定 handler 注入行为）。 */
function createMockCtx(mode: "tui" | "rpc" | "json" | "print"): Record<string, unknown> {
  const sessionManager = {
    getSessionId: () => "session-inject-1",
    getSessionFile: () => "/home/user/.pi/agent/sessions/session-inject-1.jsonl",
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
  };
  const ui = mode === "rpc" ? { setWidget: vi.fn() } : undefined;
  return {
    cwd: "/home/user/project",
    mode,
    modelRegistry: {
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    },
    model: undefined,
    sessionManager,
    ui,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadAll.mockResolvedValue([]);
  existingServiceRef.current = null;
});

// ── tests ──

describe("session_start UI handler 注入链路（SR-3）", () => {
  it("new 路径（existingService=null）：setUiRequestHandler 被调，参数是函数（tui mode）", async () => {
    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);

    const handler = getSessionStartHandler();
    expect(handler).toBeDefined();
    await handler!({ type: "session_start" }, createMockCtx("tui"));

    // SR-3 核心：setUiRequestHandler 必须被调
    expect(mockSetUiRequestHandler).toHaveBeenCalledTimes(1);
    // 非 headless mode → 注入的是函数（UiRequestHandler），非 undefined
    const injected = mockSetUiRequestHandler.mock.calls[0]?.[0];
    expect(typeof injected).toBe("function");
  });

  it("existing 路径（existingService=mockService）：setUiRequestHandler 仍被调（SR-3 关键）", async () => {
    // 模拟 /resume /fork：getSubagentService() 返回已存在的 service
    //（同一 mock 类的实例——spy 仍是 mockSetUiRequestHandler，断言可观察到调用）
    existingServiceRef.current = {
      initSession: mockInitSession,
      setUiRequestHandler: mockSetUiRequestHandler,
      // ADR-035：与 SubagentService mock class 形状一致——session_start
      // 会调 service.recoverManifestTmpFiles()，缺方法会抛 TypeError 被吞为 console.warn
      recoverManifestTmpFiles: mockRecoverManifestTmpFiles,
      getStreamSink: () => null,
      dispose: vi.fn(),
    };

    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);

    const handler = getSessionStartHandler();
    expect(handler).toBeDefined();
    await handler!({ type: "session_start" }, createMockCtx("tui"));

    // SR-3 关键断言：existing 路径下 setUiRequestHandler 仍被调
    //（旧 handler 可能已失效，session_start 必须重新注入）
    expect(mockSetUiRequestHandler).toHaveBeenCalledTimes(1);
    const injected = mockSetUiRequestHandler.mock.calls[0]?.[0];
    expect(typeof injected).toBe("function");

    // ADR-035 existing 路径守护：/resume /fork 复用 service 时 session_start
    // 也必须调 recoverManifestTmpFiles。守护 case 走 new 路径抓不到 existing 误删，
    // 此处对称断言（与 setUiRequestHandler 在本 case 的独立断言同模式）。
    expect(mockRecoverManifestTmpFiles).toHaveBeenCalledTimes(1);
  });

  it("headless mode（json）：createUiRequestHandlerForMode 返回 undefined → setUiRequestHandler(undefined)", async () => {
    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);

    const handler = getSessionStartHandler();
    await handler!({ type: "session_start" }, createMockCtx("json"));

    // SR-3 形式不破：仍调 setUiRequestHandler（参数是 undefined，表示不注入）
    expect(mockSetUiRequestHandler).toHaveBeenCalledTimes(1);
    expect(mockSetUiRequestHandler.mock.calls[0]?.[0]).toBeUndefined();
  });

  it("rpc mode：setUiRequestHandler 被调，参数是函数", async () => {
    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);

    const handler = getSessionStartHandler();
    await handler!({ type: "session_start" }, createMockCtx("rpc"));

    expect(mockSetUiRequestHandler).toHaveBeenCalledTimes(1);
    const injected = mockSetUiRequestHandler.mock.calls[0]?.[0];
    expect(typeof injected).toBe("function");
  });

  it("initSession 不再收 uiRequestHandler（#24 单一注入入口：setUiRequestHandler 唯一通道）", async () => {
    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);

    const handler = getSessionStartHandler();
    await handler!({ type: "session_start" }, createMockCtx("tui"));

    // [#24] uiRequestHandler 单一注入入口：index.ts 只调 service.setUiRequestHandler(h)，
    // 不再重复传 initSession.uiRequestHandler——避免同一 handler 双路径注入造成
    // "哪一个是 source of truth" 歧义。此处断言该契约不被回退。
    expect(mockInitSession).toHaveBeenCalledTimes(1);
    const initArg = mockInitSession.mock.calls[0]?.[0] as {
      uiRequestHandler?: unknown;
      mode?: unknown;
      dialogQueue?: unknown;
    } | undefined;
    expect(initArg).toBeDefined();
    // uiRequestHandler 不再走 initSession（已被 #24 移除）
    expect(initArg?.uiRequestHandler).toBeUndefined();
    // mode 仍需 session 级注入（uiObservability.setMode 依赖它）
    expect(initArg?.mode).toBe("tui");
    // dialogQueue 仍注入（SR-4 清理路径接通）
    expect(initArg).toHaveProperty("dialogQueue");
    // handler 经 setUiRequestHandler 注入（单一入口）——前面 case 已断言，此处复断不再赘述。
    expect(mockSetUiRequestHandler).toHaveBeenCalledTimes(1);
  });

  it("session_start 调用 recoverManifestTmpFiles（接线守护，防 ADR-035 启动恢复再次断线）", async () => {
    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);

    const handler = getSessionStartHandler();
    expect(handler).toBeDefined();
    await handler!({ type: "session_start" }, createMockCtx("tui"));

    // ADR-035 接线断言：session_start 必须调 service.recoverManifestTmpFiles（防死代码回退）
    expect(mockRecoverManifestTmpFiles).toHaveBeenCalledTimes(1);
  });
});
