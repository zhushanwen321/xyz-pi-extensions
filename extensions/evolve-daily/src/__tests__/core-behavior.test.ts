/**
 * core.ts 行为测试 — 直接调用真实导出函数（非模拟逻辑）。
 *
 * 覆盖：isStaleContextError、markStaleItemsAbandoned、createTrackedItem、
 *       validateUpdateParams、handleStart、applyUpdate、handleOnErrorThreshold。
 * 依赖 Pi 运行时的函数通过 mock pi（sendUserMessage）和 mock persistState 测试。
 */
import { describe, expect, it, vi } from "vitest";

import {
  applyUpdate,
  createTrackedItem,
  handleOnErrorThreshold,
  handleStart,
  isStaleContextError,
  markStaleItemsAbandoned,
  type TrackerActionContext,
  type TrackerConfig,
  validateUpdateParams,
} from "../trackers/core.js";
import {
  createInitialState,
  isTerminalStatus,
  type TrackedItem,
  type TrackerRuntimeState,
} from "../trackers/types.js";

// ── 测试用的状态构造 helper ──────────────────────────

function makeItem(
  overrides: Partial<TrackedItem<Record<string, unknown>>> = {},
): TrackedItem<Record<string, unknown>> {
  return {
    id: 1,
    name: "test-skill",
    status: "loaded",
    errorCount: 0,
    loadedAtTurn: 0,
    lastRemindAtTurn: -1,
    detail: null,
    metadata: {},
    anchor: { triggerType: "tool-start", triggerTurn: 0, triggerSummary: "" },
    ...overrides,
  };
}

function makeState(
  items: TrackedItem<Record<string, unknown>>[] = [],
  currentTurnIndex = 0,
): TrackerRuntimeState<Record<string, unknown>> {
  return { items, nextId: items.length + 1, currentTurnIndex };
}

function makeConfig(): TrackerConfig<Record<string, unknown>> {
  return {
    name: "test-tracker",
    toolName: "use_skill",
    label: "Test Tracker",
    description: "test tracker",
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
      onCreate: () => "onCreate steering",
      onRemind: () => "onRemind steering",
      onError: () => "onError steering",
      onContextRestore: () => "onContextRestore steering",
    },
    entryType: "test-entry",
    messageTypes: [],
    remindInterval: 5,
    errorThreshold: 3,
    abandonThreshold: 20,
  };
}

type MockDep = TrackerActionContext<Record<string, unknown>> & {
  persistState: ReturnType<typeof vi.fn>;
};

function makeDep(overrides: Partial<MockDep> = {}): MockDep {
  return {
    state: overrides.state ?? makeState(),
    config: overrides.config ?? makeConfig(),
    pi: overrides.pi ?? {
      sendUserMessage: vi.fn().mockResolvedValue(undefined),
    },
    createItem: overrides.createItem ?? vi.fn(),
    persistState: overrides.persistState ?? vi.fn(),
  };
}

const PROMPT_WITH_SKILLS = `<available_skills>
  <skill><name>real-skill</name><description>x</description></skill>
</available_skills>`;

// ── isStaleContextError ──────────────────────────────

describe("isStaleContextError", () => {
  it("匹配所有 stale context pattern", () => {
    for (const msg of [
      "Extension context no longer active",
      "Request aborted by user",
      "context canceled",
      "stale context detected",
      "stalecontext error",
    ]) {
      expect(isStaleContextError(new Error(msg))).toBe(true);
    }
  });

  it("大小写不敏感", () => {
    expect(isStaleContextError(new Error("ABORTED"))).toBe(true);
    expect(isStaleContextError(new Error("Context CANCELED"))).toBe(true);
  });

  it("非 stale 错误（含空 message）返回 false", () => {
    expect(isStaleContextError(new Error("some unrelated error"))).toBe(false);
    expect(isStaleContextError(new Error(""))).toBe(false);
  });

  it("非 Error 输入返回 false", () => {
    expect(isStaleContextError("aborted")).toBe(false);
    expect(isStaleContextError({ message: "aborted" })).toBe(false);
    expect(isStaleContextError(null)).toBe(false);
    expect(isStaleContextError(undefined)).toBe(false);
  });
});

// ── markStaleItemsAbandoned ──────────────────────────

describe("markStaleItemsAbandoned", () => {
  it("loaded/error 超时 item 被标记 abandoned，changed=true", () => {
    const state = makeState(
      [
        makeItem({ id: 1, status: "loaded", loadedAtTurn: 0 }),
        makeItem({ id: 2, status: "error", loadedAtTurn: 0 }),
      ],
      20,
    );
    const changed = markStaleItemsAbandoned(state, 20);
    expect(changed).toBe(true);
    expect(state.items[0]?.status).toBe("abandoned");
    expect(state.items[1]?.status).toBe("abandoned");
  });

  it("未超时（turn 19，abandonThreshold=20）不标记，changed=false", () => {
    const state = makeState(
      [makeItem({ status: "loaded", loadedAtTurn: 0 })],
      19,
    );
    const changed = markStaleItemsAbandoned(state, 20);
    expect(changed).toBe(false);
    expect(state.items[0]?.status).toBe("loaded");
  });

  it("终态 item（completed/recorded/cancelled）被跳过", () => {
    const state = makeState(
      [
        makeItem({ id: 1, status: "completed", loadedAtTurn: 0 }),
        makeItem({ id: 2, status: "recorded", loadedAtTurn: 0 }),
        makeItem({ id: 3, status: "cancelled", loadedAtTurn: 0 }),
      ],
      100,
    );
    const changed = markStaleItemsAbandoned(state, 20);
    expect(changed).toBe(false);
    expect(state.items.map((i) => i.status)).toEqual([
      "completed",
      "recorded",
      "cancelled",
    ]);
  });

  it("已 abandoned 的 item 不被重复标记，changed=false", () => {
    const state = makeState(
      [makeItem({ status: "abandoned", loadedAtTurn: 0 })],
      100,
    );
    const changed = markStaleItemsAbandoned(state, 20);
    expect(changed).toBe(false);
    expect(state.items[0]?.status).toBe("abandoned");
  });

  it("混合：只有非终态非 abandoned 的超时 item 被标记", () => {
    const state = makeState(
      [
        makeItem({ id: 1, status: "loaded", loadedAtTurn: 0 }),
        makeItem({ id: 2, status: "error", loadedAtTurn: 18 }),
        makeItem({ id: 3, status: "completed", loadedAtTurn: 0 }),
        makeItem({ id: 4, status: "abandoned", loadedAtTurn: 0 }),
      ],
      20,
    );
    const changed = markStaleItemsAbandoned(state, 20);
    expect(changed).toBe(true);
    expect(state.items[0]?.status).toBe("abandoned");
    expect(state.items[1]?.status).toBe("error");
    expect(state.items[2]?.status).toBe("completed");
    expect(state.items[3]?.status).toBe("abandoned");
  });
});

// ── createTrackedItem ────────────────────────────────

describe("createTrackedItem", () => {
  it("创建 item：nextId 递增、loadedAtTurn=currentTurnIndex、push 到 items、调 persistState", () => {
    const state = makeState([makeItem({ id: 1 })], 7);
    state.nextId = 5;
    const persistState = vi.fn();
    const ctx = { marker: "ctx" };
    const item = createTrackedItem(
      { name: "new-skill", metadata: { foo: 1 }, summary: "triggered" },
      ctx,
      { state, config: makeConfig(), persistState },
    );
    expect(item.id).toBe(5);
    expect(item.name).toBe("new-skill");
    expect(item.status).toBe("loaded");
    expect(item.loadedAtTurn).toBe(7);
    expect(item.metadata).toEqual({ foo: 1 });
    expect(state.nextId).toBe(6);
    expect(state.items).toHaveLength(2);
    expect(state.items[1]).toBe(item);
    expect(persistState).toHaveBeenCalledTimes(1);
    expect(persistState).toHaveBeenCalledWith(ctx);
  });

  it("连续创建两个 item，id 递增且不重复", () => {
    const state = createInitialState<Record<string, unknown>>();
    const dep = { state, config: makeConfig(), persistState: vi.fn() };
    const a = createTrackedItem(
      { name: "a", metadata: {}, summary: "" },
      {},
      dep,
    );
    const b = createTrackedItem(
      { name: "b", metadata: {}, summary: "" },
      {},
      dep,
    );
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(a.id).not.toBe(b.id);
    expect(state.items).toHaveLength(2);
  });
});

// ── validateUpdateParams ─────────────────────────────

describe("validateUpdateParams", () => {
  it("缺少 id 返回 error（isError=true, action=update）", () => {
    const dep = makeDep();
    const r = validateUpdateParams(
      { action: "update", status: "completed" },
      dep,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.result.isError).toBe(true);
      expect(r.result.details?.error).toMatch(/requires id/);
      expect(
        (r.result.details as Record<string, unknown> | undefined)?.action,
      ).toBe("update");
    }
  });

  it("缺少 status 返回 error", () => {
    const dep = makeDep();
    const r = validateUpdateParams({ action: "update", id: 1 }, dep);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.result.details?.error).toMatch(/requires status/);
    }
  });

  it("item 未找到返回 error", () => {
    const dep = makeDep();
    const r = validateUpdateParams(
      { action: "update", id: 999, status: "completed" },
      dep,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.result.details?.error).toMatch(/not found/);
    }
  });

  it("非法状态转换（loaded → recorded）返回 error", () => {
    const dep = makeDep({
      state: makeState([makeItem({ id: 1, status: "loaded" })]),
    });
    const r = validateUpdateParams(
      { action: "update", id: 1, status: "recorded" },
      dep,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.result.details?.error).toMatch(/Invalid transition/);
    }
  });

  it("合法转换返回 ok + 目标 item + updateStatus", () => {
    const dep = makeDep({
      state: makeState([makeItem({ id: 1, status: "loaded" })]),
    });
    const r = validateUpdateParams(
      { action: "update", id: 1, status: "completed" },
      dep,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.item.id).toBe(1);
      expect(r.updateStatus).toBe("completed");
    }
  });
});

// ── handleStart ──────────────────────────────────────

describe("handleStart", () => {
  it("triggerTool 未配置返回 error", async () => {
    const config = makeConfig();
    delete config.triggerTool;
    const dep = makeDep({ config });
    const r = await handleStart(
      { action: "start", name: "real-skill" },
      { getSystemPrompt: () => PROMPT_WITH_SKILLS },
      dep,
    );
    expect(r.isError).toBe(true);
    expect(r.details?.error).toMatch(/not supported/);
  });

  it("缺少 name 返回 error", async () => {
    const dep = makeDep();
    const r = await handleStart(
      { action: "start" },
      { getSystemPrompt: () => PROMPT_WITH_SKILLS },
      dep,
    );
    expect(r.isError).toBe(true);
    expect(r.details?.error).toMatch(/requires name/);
  });

  it("name 校验失败（不在 available_skills）返回 error 且不创建", async () => {
    const dep = makeDep();
    const r = await handleStart(
      { action: "start", name: "nonexistent" },
      { getSystemPrompt: () => PROMPT_WITH_SKILLS },
      dep,
    );
    expect(r.isError).toBe(true);
    expect(r.details?.error).toMatch(/not found/);
    expect(dep.createItem).not.toHaveBeenCalled();
  });

  it("去重：同名 active item 存在时不重复创建，返回 existing id", async () => {
    const existing = makeItem({ id: 7, name: "real-skill", status: "loaded" });
    const dep = makeDep({ state: makeState([existing]) });
    const r = await handleStart(
      { action: "start", name: "real-skill" },
      { getSystemPrompt: () => PROMPT_WITH_SKILLS },
      dep,
    );
    expect(dep.createItem).not.toHaveBeenCalled();
    expect(r.details?.createdId).toBe(7);
    expect(
      (r.details as Record<string, unknown> | undefined)?.action,
    ).toBe("start");
  });

  it("正常创建：调用 createItem + onCreate steering", async () => {
    const state = createInitialState<Record<string, unknown>>();
    const createItem = vi.fn((match) => {
      const it = makeItem({ id: state.nextId, name: match.name });
      state.items.push(it);
      state.nextId++;
      return it;
    });
    const dep = makeDep({ state, createItem });
    const r = await handleStart(
      { action: "start", name: "real-skill" },
      { getSystemPrompt: () => PROMPT_WITH_SKILLS },
      dep,
    );
    expect(createItem).toHaveBeenCalledTimes(1);
    expect(dep.pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(r.details?.createdId).toBe(1);
  });
});

// ── applyUpdate + handleOnErrorThreshold ─────────────

describe("applyUpdate", () => {
  it("loaded → completed：状态更新 + 持久化，无 onError steering", async () => {
    const item = makeItem({ id: 1, status: "loaded" });
    const dep = makeDep({ state: makeState([item]) });
    const r = await applyUpdate(item, "completed", "done", {}, dep);
    expect(item.status).toBe("completed");
    expect(item.detail).toBe("done");
    expect(dep.persistState).toHaveBeenCalledTimes(1);
    expect(dep.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(
      (r.details as Record<string, unknown> | undefined)?.action,
    ).toBe("update");
  });

  it("从 abandoned 恢复：重置 lastRemindAtTurn + errorCount", async () => {
    const item = makeItem({
      id: 1,
      status: "abandoned",
      lastRemindAtTurn: 5,
      errorCount: 3,
    });
    const dep = makeDep({ state: makeState([item], 30) });
    await applyUpdate(item, "completed", undefined, {}, dep);
    expect(item.lastRemindAtTurn).toBe(30);
    expect(item.errorCount).toBe(0);
  });

  it("error 状态递增 errorCount，达阈值触发 onError steering", async () => {
    const item = makeItem({ id: 1, status: "loaded", errorCount: 2 });
    const dep = makeDep({ state: makeState([item]) });
    await applyUpdate(item, "error", "boom", {}, dep);
    expect(item.errorCount).toBe(3);
    expect(dep.pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("error 未达阈值不触发 onError steering", async () => {
    const item = makeItem({ id: 1, status: "loaded", errorCount: 0 });
    const dep = makeDep({ state: makeState([item]) });
    await applyUpdate(item, "error", "boom", {}, dep);
    expect(item.errorCount).toBe(1);
    expect(dep.pi.sendUserMessage).not.toHaveBeenCalled();
  });
});

describe("handleOnErrorThreshold", () => {
  it("非 error 状态不递增 errorCount、不触发 steering", async () => {
    const item = makeItem({ status: "loaded", errorCount: 0 });
    const dep = makeDep();
    await handleOnErrorThreshold(item, "completed", dep);
    expect(item.errorCount).toBe(0);
    expect(dep.pi.sendUserMessage).not.toHaveBeenCalled();
  });
});

// ── isActive filter 规约（真实 isTerminalStatus）──────

describe("isActive filter 规约", () => {
  it("过滤终态 item，保留 loaded/error/abandoned", () => {
    const items = [
      makeItem({ id: 1, status: "loaded" }),
      makeItem({ id: 2, status: "error" }),
      makeItem({ id: 3, status: "completed" }),
      makeItem({ id: 4, status: "abandoned" }),
      makeItem({ id: 5, status: "recorded" }),
      makeItem({ id: 6, status: "cancelled" }),
    ];
    const active = items.filter((item) => !isTerminalStatus(item.status));
    expect(active.map((i) => i.id)).toEqual([1, 2, 4]);
  });
});
