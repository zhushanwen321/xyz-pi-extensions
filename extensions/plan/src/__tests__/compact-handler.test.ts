import { beforeEach,describe, expect, it, vi } from "vitest";

import type { PlanState } from "../state.js";

// Mock fs before importing compact.ts (ESM namespace is not configurable)
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

// Import after mock setup
import { handlePlanComplete, registerPlanEventHandlers } from "../compact.js";

const fsMock = vi.mocked(await import("node:fs"));

// --- Shared mock factories ---

function makePi() {
  return {
    on: vi.fn(),
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
  };
}

type CtxMock = ReturnType<typeof makeCtx>;
function makeCtx() {
  const onCompleteFns: Array<() => void> = [];
  const onErrorFns: Array<(e: Error) => void> = [];

  return {
    sessionManager: { getSessionId: () => "test-session", getEntries: () => [] as unknown[] },
    ui: { notify: vi.fn() },
    compact: vi.fn((opts: { onComplete?: () => void; onError?: (e: Error) => void }) => {
      if (opts.onComplete) onCompleteFns.push(opts.onComplete);
      if (opts.onError) onErrorFns.push(opts.onError);
    }),
    _onCompleteFns: onCompleteFns,
    _onErrorFns: onErrorFns,
  };
}

function makeActiveState(): PlanState {
  return {
    isActive: true,
    phase: "complete",
    planFilePath: "/tmp/plan.md",
    requirement: "Add login page",
    templateName: "default",
  };
}

function setupFsMock(content: string) {
  fsMock.readFileSync.mockReturnValue(content);
}

// --- handlePlanComplete tests ---

describe("handlePlanComplete", () => {
  let pi: ReturnType<typeof makePi>;
  let ctx: CtxMock;

  beforeEach(() => {
    vi.clearAllMocks();
    pi = makePi();
    ctx = makeCtx();
    setupFsMock("## 实现步骤\n1. Step one\n2. Step two");
  });

  it("compact isolation: calls compact, onComplete sends steer + tryGoalInit", () => {
    (pi as unknown as Record<string, unknown>).__goalInit = vi.fn().mockReturnValue(true);

    handlePlanComplete(pi as never, ctx as never, makeActiveState(), "compact");

    expect(ctx.compact).toHaveBeenCalledOnce();
    ctx._onCompleteFns[0]();
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.any(String), { deliverAs: "steer" });
    expect((pi as unknown as Record<string, unknown>).__goalInit).toHaveBeenCalled();
  });

  it("compact onError: falls back to notify + steer", () => {
    handlePlanComplete(pi as never, ctx as never, makeActiveState(), "compact");

    ctx._onErrorFns[0](new Error("compact failed"));
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "warning");
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.any(String), { deliverAs: "steer" });
  });

  it("tree isolation: only notify, no compact or steer", () => {
    handlePlanComplete(pi as never, ctx as never, makeActiveState(), "tree");

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/tmp/plan.md"), "info");
    expect(ctx.compact).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("direct isolation: directly sends steer", () => {
    handlePlanComplete(pi as never, ctx as never, makeActiveState(), "direct");

    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.any(String), { deliverAs: "steer" });
    expect(ctx.compact).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });
});

// --- registerPlanEventHandlers tests ---

describe("registerPlanEventHandlers", () => {
  let pi: ReturnType<typeof makePi>;

  beforeEach(() => {
    vi.clearAllMocks();
    pi = makePi();
    setupFsMock("Plan content here");
  });

  function captureHandlers(): Record<string, (...args: unknown[]) => Promise<unknown>> {
    const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const call of pi.on.mock.calls) {
      handlers[call[0] as string] = call[1];
    }
    return handlers;
  }

  it("session_before_compact (active): returns compaction summary with plan content", async () => {
    const sessions = new Map();
    sessions.set("test-session", makeActiveState());

    registerPlanEventHandlers(pi as never, sessions);
    const handlers = captureHandlers();

    const result = await handlers["session_before_compact"]({}, makeCtx() as never);
    const r = result as { compaction: { summary: string } };

    expect(r.compaction.summary).toContain("Plan content here");
    expect(r.compaction.summary).toContain("Add login page");
  });

  it("session_before_compact (inactive): returns empty object {}", async () => {
    registerPlanEventHandlers(pi as never, new Map());
    const handlers = captureHandlers();

    const result = await handlers["session_before_compact"]({}, makeCtx() as never);
    expect(result).toEqual({});
  });

  it("session_before_tree (active): returns summary with plan content", async () => {
    const sessions = new Map();
    sessions.set("test-session", makeActiveState());

    registerPlanEventHandlers(pi as never, sessions);
    const handlers = captureHandlers();

    const result = await handlers["session_before_tree"]({}, makeCtx() as never);
    const r = result as { summary: string };

    expect(r.summary).toContain("Plan content here");
    expect(r.summary).toContain("/tmp/plan.md");
  });

  it("session_before_tree (inactive): returns empty object {}", async () => {
    registerPlanEventHandlers(pi as never, new Map());
    const handlers = captureHandlers();

    const result = await handlers["session_before_tree"]({}, makeCtx() as never);
    expect(result).toEqual({});
  });
});
