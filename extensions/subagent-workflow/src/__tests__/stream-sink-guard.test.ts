// src/__tests__/stream-sink-guard.test.ts
//
// streamSink ctx.mode guard — 运行时测试（FR-1/FR-2/AC-1/AC-2）。
//
// [B7] 从纯源码正则断言升级为运行时行为断言：
//   旧版读 index.ts 源码用正则匹配 `ctx.mode === "rpc"`——源码改了正则可能仍过，但运行时
//   行为可能已坏（如三元写反、字段名拼错）。现改为真正调 session_start handler，mock ctx.mode
//   为 tui/json，断言 initSession 收到的 streamSink === undefined；rpc mode 断言是函数对象。
//
// 复用 index-session-start.test.ts 的 mock 基础设施（Proxy pi 捕获 handler + 内联 vi.mock
// 隔离真实 SDK + vi.mock SubagentService 捕获 initSession 参数）。详见 index-session-start
// 顶部 [D15] 注释对两套 mock 分工的说明。
//
// 断言契约来源：index.ts session_start 内
//   streamSink: ctx.mode === "rpc" ? { setWidget: (key, lines) => ctx.ui.setWidget(...) } : undefined
// TUI/json/print 下 streamSink=undefined（无 widget 噪音）；rpc 下注入 ctx.ui.setWidget 包装。

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── 内联 vi.mock：覆盖 config alias，隔离真实 SDK（见 [D15] 分工说明） ──
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

// ── hoisted：捕获 initSession 的 streamSink 参数 ──
const { mockInitSession, mockSetUiRequestHandler, mockLoadAll, existingServiceRef } =
  vi.hoisted(() => ({
    mockInitSession: vi.fn(),
    mockSetUiRequestHandler: vi.fn(),
    mockLoadAll: vi.fn(async () => []),
    existingServiceRef: { current: null as unknown },
  }));

vi.mock("../execution/subagent-service.ts", () => ({
  SubagentService: class {
    initSession = mockInitSession;
    setUiRequestHandler = mockSetUiRequestHandler;
    getStreamSink = () => null;
    dispose = vi.fn();
  },
  getSubagentService: () => existingServiceRef.current,
  setSubagentService: vi.fn(),
}));

vi.mock("../execution/model-config-service.ts", () => ({
  ModelConfigService: class {
    initModel = vi.fn();
    getAgentRegistry = () => ({ get: () => undefined, list: () => [] });
    setCtxModel = vi.fn();
  },
  getModelConfigService: () => null,
  setModelConfigService: vi.fn(),
}));

vi.mock("../execution/worktree-manager.ts", () => ({
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

vi.mock("../execution/session-file-gc.ts", () => ({
  maybeCleanupExpiredSessionFiles: vi.fn(),
}));

vi.mock("../orchestration/jsonl-run-store.ts", () => ({
  JsonlRunStore: class {
    loadAll = mockLoadAll;
    save = vi.fn(async () => {});
  },
}));

// interface 层 mock：避免触发真实 pi.registerTool
vi.mock("../interface/subagent-tool.ts", () => ({ registerSubagentTool: vi.fn() }));
vi.mock("../interface/subagents.ts", () => ({ registerSubagentsCommand: vi.fn() }));
vi.mock("../interface/bg-notify-render.ts", () => ({ renderBgNotifyMessage: vi.fn() }));
vi.mock("../interface/tool-workflow.ts", () => ({ registerWorkflowTool: vi.fn() }));
vi.mock("../interface/tool-workflow-script.ts", () => ({ registerWorkflowScriptTool: vi.fn() }));
vi.mock("../interface/commands.ts", () => ({ registerWorkflowsCommand: vi.fn() }));

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import subagentsExtension from "../index.ts";

// ── helpers（与 index-session-start.test.ts 同构，聚焦 streamSink 断言） ──

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

/** mode 控制 streamSink 守卫分支。rpc 下 ui 必须有 setWidget。 */
function createMockCtx(mode: "tui" | "rpc" | "json" | "print"): Record<string, unknown> {
  const sessionManager = {
    getSessionId: () => "session-stream-1",
    getSessionFile: () => "/home/user/.pi/agent/sessions/session-stream-1.jsonl",
    getSessionDir: () => "/home/user/.pi/agent/sessions",
  };
  const ui = mode === "rpc" ? { setWidget: vi.fn() } : undefined;
  return {
    cwd: "/home/user/project",
    mode,
    modelRegistry: { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
    model: undefined,
    sessionManager,
    ui,
  };
}

/** initSession 参数的 streamSink 字段形状（断言 mock 调用参数）。
 *  必填 streamSink 字段（非全可选）以避免 taste/no-unsafe-cast 全可选断言 warn；
 *  streamSink 运行时可能为 undefined（tui/json/print 下守卫产 undefined）。 */
type InitSessionArg = { streamSink: unknown };

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadAll.mockResolvedValue([]);
  existingServiceRef.current = null;
});

// ── 运行时断言 ──

describe("streamSink ctx.mode guard — 运行时行为（FR-1/FR-2/AC-1/AC-2）", () => {
  it("tui mode：initSession 收到 streamSink === undefined（无 widget 噪音）", async () => {
    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);
    await getSessionStartHandler()!({ type: "session_start" }, createMockCtx("tui"));

    expect(mockInitSession).toHaveBeenCalledTimes(1);
    const initArg = mockInitSession.mock.calls[0]?.[0] as InitSessionArg;
    // [B7] 运行时断言：守卫在 tui 下真的产出 undefined（不是源码里有就够）
    expect(initArg.streamSink).toBeUndefined();
  });

  it("json mode（headless）：initSession 收到 streamSink === undefined", async () => {
    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);
    await getSessionStartHandler()!({ type: "session_start" }, createMockCtx("json"));

    const initArg = mockInitSession.mock.calls[0]?.[0] as InitSessionArg;
    expect(initArg.streamSink).toBeUndefined();
  });

  it("print mode：initSession 收到 streamSink === undefined", async () => {
    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);
    await getSessionStartHandler()!({ type: "session_start" }, createMockCtx("print"));

    const initArg = mockInitSession.mock.calls[0]?.[0] as InitSessionArg;
    expect(initArg.streamSink).toBeUndefined();
  });

  it("rpc mode（GUI/xyz-agent）：initSession 收到 streamSink 是 { setWidget } 对象（守卫放行）", async () => {
    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);
    const ctx = createMockCtx("rpc");
    await getSessionStartHandler()!({ type: "session_start" }, ctx);

    const initArg = mockInitSession.mock.calls[0]?.[0] as InitSessionArg;
    // rpc 守卫放行：streamSink 注入了包装 ctx.ui.setWidget 的 sink 对象
    expect(initArg.streamSink).toBeDefined();
    expect(typeof initArg.streamSink).toBe("object");
    expect(typeof (initArg.streamSink as { setWidget: unknown }).setWidget).toBe("function");
  });

  it("rpc mode：streamSink.setWidget 转发到 ctx.ui.setWidget（绑定真实方法）", async () => {
    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);
    const ctx = createMockCtx("rpc");
    await getSessionStartHandler()!({ type: "session_start" }, ctx);

    const initArg = mockInitSession.mock.calls[0]?.[0] as InitSessionArg;
    (initArg.streamSink as { setWidget: (key: string, lines: string[]) => void }).setWidget("key1", ["line-a"]);
    // 转发到注入时的 ctx.ui.setWidget
    const uiSetWidget = (ctx.ui as { setWidget: ReturnType<typeof vi.fn> }).setWidget;
    expect(uiSetWidget).toHaveBeenCalledWith("key1", ["line-a"]);
  });
});
