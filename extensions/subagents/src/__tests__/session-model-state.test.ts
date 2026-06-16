// src/__tests__/session-model-state.test.ts
import { describe, expect,it } from "vitest";

import { createSessionModelState, restoreState,serializeState, setAgentModel, setCategoryModel } from "../state/session-model-state.ts";

describe("SessionModelState", () => {
  it("creates with defaults", () => {
    const state = createSessionModelState(false);
    expect(state.yoloMode).toBe(false);
    expect(state.perAgent).toEqual({});
    expect(state.perCategory).toEqual({});
  });

  it("setAgentModel stores per-agent override", () => {
    const state = createSessionModelState(false);
    setAgentModel(state, "worker", "deepseek-router/ds-flash", "high");
    expect(state.perAgent.worker).toEqual({ model: "deepseek-router/ds-flash", thinkingLevel: "high" });
  });

  it("setCategoryModel stores per-category override", () => {
    const state = createSessionModelState(false);
    setCategoryModel(state, "coding", "mimo-router/mimo-v2.5", "medium");
    expect(state.perCategory.coding).toEqual({ model: "mimo-router/mimo-v2.5", thinkingLevel: "medium" });
  });

  it("serialize/restore round-trips correctly", () => {
    const state = createSessionModelState(true);
    setAgentModel(state, "worker", "m/m");
    setCategoryModel(state, "coding", "c/c", "low");
    const serialized = serializeState(state);
    // serializeState 返回 object snapshot（与 restoreState 对称，供 appendEntry 直接存储）
    expect(typeof serialized).toBe("object");
    expect(serialized).not.toBe(state); // 必须是快照，不能是原引用
    const restored = restoreState(serialized, false);
    expect(restored.yoloMode).toBe(true);
    expect(restored.perAgent.worker.model).toBe("m/m");
    expect(restored.perCategory.coding.model).toBe("c/c");
  });

  it("restore handles missing fields with defaults", () => {
    const restored = restoreState({}, false);
    expect(restored.yoloMode).toBe(false);
    expect(restored.perAgent).toEqual({});
  });

  it("createSessionModelState defaults categoryConfirmed to false", () => {
    const state = createSessionModelState(false);
    expect(state.categoryConfirmed).toBe(false);
  });

  it("serialize/restore round-trips categoryConfirmed", () => {
    const state = createSessionModelState(false);
    state.categoryConfirmed = true;
    const restored = restoreState(serializeState(state), false);
    expect(restored.categoryConfirmed).toBe(true);
  });

  it("restore defaults categoryConfirmed to false when missing", () => {
    const restored = restoreState({}, false);
    expect(restored.categoryConfirmed).toBe(false);
  });
});
