import { describe, expect,it } from "vitest";

import { createFrozenFreshState } from "../frozen-fresh";

describe("FrozenFreshState", () => {
  it("初始状态没有 frozen ID", () => {
    const state = createFrozenFreshState();
    expect(state.isFrozen("c1")).toBe(false);
    expect(state.getReplacement("c1")).toBeUndefined();
    expect(state.getAllFrozenIds().size).toBe(0);
  });

  it("markFrozen 后 isFrozen 返回 true，getReplacement 返回替换文本", () => {
    const state = createFrozenFreshState();
    state.markFrozen("c1", "[persisted output]");
    expect(state.isFrozen("c1")).toBe(true);
    expect(state.getReplacement("c1")).toBe("[persisted output]");
  });

  it("reset 清空所有 frozen 状态", () => {
    const state = createFrozenFreshState();
    state.markFrozen("c1", "[persisted]");
    state.markFrozen("c2", "[persisted]");
    expect(state.getAllFrozenIds().size).toBe(2);

    state.reset();

    expect(state.isFrozen("c1")).toBe(false);
    expect(state.isFrozen("c2")).toBe(false);
    expect(state.getAllFrozenIds().size).toBe(0);
  });

  it("getAllFrozenIds 返回所有 frozen ID", () => {
    const state = createFrozenFreshState();
    state.markFrozen("c1", "[a]");
    state.markFrozen("c2", "[b]");
    state.markFrozen("c3", "[c]");

    const ids = state.getAllFrozenIds();
    expect(ids.has("c1")).toBe(true);
    expect(ids.has("c2")).toBe(true);
    expect(ids.has("c3")).toBe(true);
    expect(ids.size).toBe(3);
  });
});
