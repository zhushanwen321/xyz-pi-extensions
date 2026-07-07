/**
 * createTracker 集成测试 — 验证 session 事件 handler 的行为。
 *
 * 覆盖 PR #79 的三处核心改动（回归测试）：
 *   1. reconstructState 用 getBranch()（不含其他分支的 skill start）
 *   2. handleSessionRestore 只恢复 state，不调 sendUserMessage（fork 时不注入）
 *   3. before_agent_start 只提示 loaded/error，不提示 abandoned
 *
 * 方法：mock pi（捕获 on 注册的 handler + 记录 sendUserMessage 调用），
 * 手动触发 session_start/session_tree/before_agent_start 事件。
 */
import { describe, expect, it, vi } from "vitest";

import { createTracker } from "../trackers/core.js";
import type { TrackerConfig } from "../trackers/core.js";
import type { TrackedItem } from "../trackers/types.js";

// ── 测试用的 config 构造 ──────────────────────────────

function makeConfig(): TrackerConfig<Record<string, unknown>> {
  return {
    name: "test-tracker",
    toolName: "use_skill",
    label: "Test Tracker",
    description: "test",
    promptSnippet: "",
    promptGuidelines: [],
    triggerTool: {
      extractMeta: (p: Record<string, unknown>) => ({
        name: String(p.name ?? ""),
        metadata: {},
        summary: "",
      }),
    },
    steering: {
      onCreate: () => "onCreate",
      onRemind: () => "onRemind",
      onError: () => "onError",
      onContextRestore: (items) =>
        `tracked: ${items.map((i) => `${i.name}=${i.status}`).join(", ")}`,
    },
    entryType: "test-entry",
    messageTypes: ["test-entry-context", "test-entry-remind"],
    remindInterval: 10,
    errorThreshold: 3,
    abandonThreshold: 20,
  };
}

// ── mock pi ──────────────────────────────────────────

type EventHandler = (event: unknown, ctx: unknown) => unknown;

interface MockPi {
  on: ReturnType<typeof vi.fn>;
  registerTool: ReturnType<typeof vi.fn>;
  registerMessageRenderer: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
  appendEntry: ReturnType<typeof vi.fn>;
  _handlers: Map<string, EventHandler[]>;
}

function createMockPi(): MockPi {
  const handlers = new Map<string, EventHandler[]>();
  return {
    on: vi.fn((event: string, handler: EventHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendUserMessage: vi.fn().mockResolvedValue(undefined),
    appendEntry: vi.fn(),
    _handlers: handlers,
  };
}

/** 构造 mock ExtensionContext（sessionManager.getBranch 返回指定 entries）。 */
function createCtx(entries: unknown[] = []) {
  return {
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
    },
  };
}

/** 构造一个 custom entry（模拟持久化的 tracker state 快照）。 */
function makeStateEntry(state: unknown): unknown {
  return { type: "custom", customType: "test-entry", data: state };
}

/** 构造一个 message entry（模拟对话 turn）。 */
function makeMessageEntry(): unknown {
  return { type: "message" };
}

/** 构造一个含 loaded item 的 state 快照。 */
function makeStateWithLoaded(loadedAtTurn = 0) {
  return {
    items: [
      {
        id: 1,
        name: "test-skill",
        status: "loaded",
        errorCount: 0,
        loadedAtTurn,
        lastRemindAtTurn: -1,
        detail: null,
        metadata: {},
        anchor: { triggerType: "tool-start", triggerTurn: loadedAtTurn, triggerSummary: "" },
      } satisfies TrackedItem<Record<string, unknown>>,
    ],
    nextId: 2,
    currentTurnIndex: 0,
  };
}

// ── 测试 ─────────────────────────────────────────────

describe("createTracker session handler 集成", () => {
  it("session_tree 事件触发后不调 sendUserMessage（fork 时不注入）", async () => {
    const pi = createMockPi();
    createTracker(pi as unknown as Parameters<typeof createTracker>[0], makeConfig());

    // session_tree handler 注册了吗
    expect(pi._handlers.get("session_tree")).toBeDefined();

    // entries 含一个 loaded item 的 state 快照
    const ctx = createCtx([makeStateEntry(makeStateWithLoaded())]);
    const handler = pi._handlers.get("session_tree")![0]!;
    await handler({}, ctx);

    // 核心断言：session_tree 不再主动注入提示（PR #79 改动 2）
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("session_start 事件同样不调 sendUserMessage", async () => {
    const pi = createMockPi();
    createTracker(pi as unknown as Parameters<typeof createTracker>[0], makeConfig());

    const ctx = createCtx([makeStateEntry(makeStateWithLoaded())]);
    const handler = pi._handlers.get("session_start")![0]!;
    await handler({ reason: "fork" }, ctx);

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("before_agent_start 返回 context-restore message（loaded item 存在时）", async () => {
    const pi = createMockPi();
    createTracker(pi as unknown as Parameters<typeof createTracker>[0], makeConfig());

    // 先通过 session_start 恢复 state（让内存 state 含 loaded item）
    const ctx = createCtx([makeStateEntry(makeStateWithLoaded())]);
    const sessionStartHandler = pi._handlers.get("session_start")![0]!;
    await sessionStartHandler({ reason: "resume" }, ctx);

    // 触发 before_agent_start
    const basHandler = pi._handlers.get("before_agent_start")![0]!;
    const result = await basHandler({}, ctx);

    // 应返回含 customMessage 的结果
    expect(result).toBeDefined();
    expect(result.message).toBeDefined();
    expect(result.message.customType).toBe("test-entry-context");
    expect(result.message.display).toBe(false);
    // 内容含 loaded item
    expect(result.message.content).toContain("test-skill=loaded");
  });

  it("before_agent_start 不提示 abandoned item（PR #79 改动 3）", async () => {
    const pi = createMockPi();
    createTracker(pi as unknown as Parameters<typeof createTracker>[0], makeConfig());

    // state 含 abandoned item
    const abandonedState = {
      items: [
        {
          id: 1,
          name: "stale-skill",
          status: "abandoned",
          errorCount: 0,
          loadedAtTurn: 0,
          lastRemindAtTurn: -1,
          detail: null,
          metadata: {},
          anchor: { triggerType: "tool-start", triggerTurn: 0, triggerSummary: "" },
        },
      ],
      nextId: 2,
      currentTurnIndex: 25,
    };
    const ctx = createCtx([makeStateEntry(abandonedState)]);
    const sessionStartHandler = pi._handlers.get("session_start")![0]!;
    await sessionStartHandler({ reason: "resume" }, ctx);

    const basHandler = pi._handlers.get("before_agent_start")![0]!;
    const result = await basHandler({}, ctx);

    // abandoned item 不在提示中 → 无 promptable item → 返回 undefined
    expect(result).toBeUndefined();
  });

  it("reconstructState 用 getBranch：不含 skill start 的分支不恢复 item", async () => {
    const pi = createMockPi();
    createTracker(pi as unknown as Parameters<typeof createTracker>[0], makeConfig());

    // getBranch 返回空（fork 到不含 skill start 的分支）
    const ctx = createCtx([]);
    const sessionStartHandler = pi._handlers.get("session_start")![0]!;
    await sessionStartHandler({ reason: "fork" }, ctx);

    const basHandler = pi._handlers.get("before_agent_start")![0]!;
    const result = await basHandler({}, ctx);

    // 无 item → before_agent_start 不注入
    expect(result).toBeUndefined();
  });

  it("reconstructState 用 getBranch：含 skill start 的分支正常恢复", async () => {
    const pi = createMockPi();
    createTracker(pi as unknown as Parameters<typeof createTracker>[0], makeConfig());

    // getBranch 返回含 state 快照的 entries（模拟 fork 点在 skill start 之后）
    const ctx = createCtx([
      makeMessageEntry(),
      makeMessageEntry(),
      makeStateEntry(makeStateWithLoaded(0)),
      makeMessageEntry(),
    ]);
    const sessionStartHandler = pi._handlers.get("session_start")![0]!;
    await sessionStartHandler({ reason: "fork" }, ctx);

    const basHandler = pi._handlers.get("before_agent_start")![0]!;
    const result = await basHandler({}, ctx);

    expect(result).toBeDefined();
    expect(result.message.content).toContain("test-skill=loaded");
  });
});
