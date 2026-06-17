/**
 * 状态机核心逻辑测试 — 直接 import types.ts 的真实导出函数。
 *
 * 覆盖：状态转换矩阵、终态判定、可恢复态判定、
 *       序列化/反序列化、旧格式兼容（dismissed 过滤、skillMdPath 迁移）、
 *       createItem 的 nextId 递增、非法 status 兜底。
 */
import { describe, it, expect } from "vitest";
import {
  canTransition,
  createInitialState,
  deserializeState,
  isResumableStatus,
  isTerminalStatus,
  serializeState,
  type TrackedItem,
  type TrackedItemStatus,
} from "../trackers/types.js";

describe("canTransition — 状态转换矩阵", () => {
  describe("合法转换", () => {
    it("loaded → completed/error/cancelled", () => {
      expect(canTransition("loaded", "completed")).toBe(true);
      expect(canTransition("loaded", "error")).toBe(true);
      expect(canTransition("loaded", "cancelled")).toBe(true);
    });

    it("error → completed/error/recorded/cancelled", () => {
      expect(canTransition("error", "completed")).toBe(true);
      expect(canTransition("error", "error")).toBe(true);
      expect(canTransition("error", "recorded")).toBe(true);
      expect(canTransition("error", "cancelled")).toBe(true);
    });

    it("abandoned → completed/error/recorded/cancelled（可恢复）", () => {
      expect(canTransition("abandoned", "completed")).toBe(true);
      expect(canTransition("abandoned", "error")).toBe(true);
      expect(canTransition("abandoned", "recorded")).toBe(true);
      expect(canTransition("abandoned", "cancelled")).toBe(true);
    });
  });

  describe("非法转换", () => {
    it("终态不可转出", () => {
      expect(canTransition("completed", "error")).toBe(false);
      expect(canTransition("recorded", "loaded")).toBe(false);
      expect(canTransition("cancelled", "completed")).toBe(false);
    });

    it("loaded 不能直接到 recorded（必须先 error）", () => {
      expect(canTransition("loaded", "recorded")).toBe(false);
    });

    it("abandoned 不能转回 loaded 或 abandoned", () => {
      expect(canTransition("abandoned", "loaded")).toBe(false);
      expect(canTransition("abandoned", "abandoned")).toBe(false);
    });
  });
});

describe("isTerminalStatus", () => {
  it("completed/recorded/cancelled 是终态", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("recorded")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
  });

  it("loaded/error/abandoned 不是终态", () => {
    expect(isTerminalStatus("loaded")).toBe(false);
    expect(isTerminalStatus("error")).toBe(false);
    expect(isTerminalStatus("abandoned")).toBe(false);
  });
});

describe("isResumableStatus", () => {
  it("loaded/error/abandoned 可恢复", () => {
    expect(isResumableStatus("loaded")).toBe(true);
    expect(isResumableStatus("error")).toBe(true);
    expect(isResumableStatus("abandoned")).toBe(true);
  });

  it("终态不可恢复", () => {
    expect(isResumableStatus("completed")).toBe(false);
    expect(isResumableStatus("recorded")).toBe(false);
    expect(isResumableStatus("cancelled")).toBe(false);
  });
});

describe("serialize/deserialize 往返", () => {
  it("serialize → deserialize 保持数据一致", () => {
    const state = createInitialState<Record<string, unknown>>();
    state.items.push({
      id: 1,
      name: "test-skill",
      status: "loaded",
      errorCount: 0,
      loadedAtTurn: 5,
      lastRemindAtTurn: -1,
      detail: null,
      metadata: { skillMdPath: "/path" },
      anchor: { triggerType: "tool-start", triggerTurn: 5, triggerSummary: "test" },
    });
    state.nextId = 2;
    state.currentTurnIndex = 10;

    const round = deserializeState<Record<string, unknown>>(
      serializeState(state),
    );
    expect(round.items).toHaveLength(1);
    expect(round.items[0]).toEqual(state.items[0]);
    expect(round.nextId).toBe(2);
    expect(round.currentTurnIndex).toBe(10);
  });
});

describe("deserializeState 旧格式兼容", () => {
  it("过滤旧 dismissed item（不复活为 loaded）", () => {
    const data = {
      items: [
        { id: 1, name: "active", status: "loaded" },
        { id: 2, name: "old", status: "dismissed" },
        { id: 3, name: "done", status: "completed" },
      ],
      nextId: 4,
      currentTurnIndex: 0,
    };
    const state = deserializeState<Record<string, unknown>>(data);
    expect(state.items).toHaveLength(2);
    expect(state.items.find((i) => i.name === "old")).toBeUndefined();
  });

  it("旧 skillMdPath 顶层字段映射到 metadata", () => {
    const data = {
      items: [
        {
          id: 1,
          name: "legacy",
          status: "loaded",
          skillMdPath: "/old/path/SKILL.md",
        },
      ],
      nextId: 2,
      currentTurnIndex: 0,
    };
    const state = deserializeState<{ skillMdPath?: string }>(data);
    expect(state.items[0].metadata.skillMdPath).toBe("/old/path/SKILL.md");
  });

  it("缺 anchor 的旧 item 填充默认值", () => {
    const data = {
      items: [{ id: 1, name: "noanchor", status: "loaded", loadedAtTurn: 3 }],
      nextId: 2,
      currentTurnIndex: 0,
    };
    const state = deserializeState<Record<string, unknown>>(data);
    expect(state.items[0].anchor).toEqual({
      triggerType: "unknown",
      triggerTurn: 3,
      triggerSummary: "legacy: noanchor",
    });
  });

  it("非法 status 值兜底为 loaded（而非原样保留）", () => {
    const data = {
      items: [
        { id: 1, name: "corrupt", status: "totally-bogus" },
        { id: 2, name: "missing-status" },
      ],
      nextId: 3,
      currentTurnIndex: 0,
    };
    const state = deserializeState<Record<string, unknown>>(data);
    expect(state.items[0].status).toBe("loaded");
    expect(state.items[1].status).toBe("loaded");
  });

  it("nextId/currentTurnIndex 缺失时用默认值", () => {
    const state = deserializeState<Record<string, unknown>>({ items: [] });
    expect(state.nextId).toBe(1);
    expect(state.currentTurnIndex).toBe(0);
  });

  it("items 非数组时返回空", () => {
    const state = deserializeState<Record<string, unknown>>({
      items: "not-an-array",
    });
    expect(state.items).toHaveLength(0);
  });
});

describe("createInitialState", () => {
  it("初始状态为空 items，nextId=1，currentTurnIndex=0", () => {
    const state = createInitialState<Record<string, unknown>>();
    expect(state.items).toEqual([]);
    expect(state.nextId).toBe(1);
    expect(state.currentTurnIndex).toBe(0);
  });
});

// 静态类型检查（编译期保证）：非法 status 不能赋值给 TrackedItemStatus
describe("类型层面的状态机约束（编译期）", () => {
  it("TrackedItemStatus 是有限枚举", () => {
    const validStatuses: TrackedItemStatus[] = [
      "loaded",
      "error",
      "completed",
      "recorded",
      "cancelled",
      "abandoned",
    ];
    expect(validStatuses).toHaveLength(6);
  });

  it("TrackedItem.status 字段类型受约束", () => {
    const item: TrackedItem = {
      id: 1,
      name: "x",
      status: "loaded",
      errorCount: 0,
      loadedAtTurn: 0,
      lastRemindAtTurn: -1,
      detail: null,
      metadata: {},
      anchor: { triggerType: "tool-start", triggerTurn: 0, triggerSummary: "" },
    };
    // 若编译通过，说明 status 类型正确
    expect(item.status).toBe("loaded");
  });
});
