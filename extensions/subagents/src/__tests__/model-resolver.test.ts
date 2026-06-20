// src/__tests__/model-resolver.test.ts
import { describe, expect, it } from "vitest";

import {
  availableThinkingLevels,
  inferCategory,
  resolveModelForAgent,
  type ModelInfo,
  type ModelRegistryLike,
} from "../core/model-resolver.ts";

// ============================================================
// helpers
// ============================================================

function makeModel(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: over.id ?? "sonnet-4-5",
    name: over.name ?? "Claude Sonnet 4.5",
    provider: over.provider ?? "anthropic",
    reasoning: over.reasoning ?? false,
    thinkingLevelMap: over.thinkingLevelMap,
    contextWindow: over.contextWindow,
  };
}

/** 构造 mock registry：registered 表 (provider/modelId) → ModelInfo；authed 集合控制鉴权。 */
function makeRegistry(models: ModelInfo[], authed: string[] = models.map((m) => `${m.provider}/${m.id}`)): ModelRegistryLike {
  const authSet = new Set(authed);
  return {
    getAvailable: () => models,
    find: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId),
    hasConfiguredAuth: (m) => {
      if (!m || typeof m !== "object") return false;
      const mm = m as ModelInfo;
      return authSet.has(`${mm.provider}/${mm.id}`);
    },
  };
}

const baseArgs = {
  agentName: "worker",
  agentConfig: undefined,
  category: "coding",
  globalConfig: { categories: {}, fallback: { model: "anthropic/claude-sonnet-4-5", thinkingLevel: undefined } },
  sessionState: { categoryModels: {}, agentModels: {} },
};

// ============================================================
// resolveModelForAgent — 5 级 fallback 优先级
// ============================================================

describe("resolveModelForAgent — candidate priority chain", () => {
  it("L1: paramOverride.model wins over all", () => {
    const m1 = makeModel({ id: "explicit", provider: "p1" });
    const m2 = makeModel({ id: "fallback-used", provider: "p2" });
    const reg = makeRegistry([m1, m2]);
    const r = resolveModelForAgent({
      ...baseArgs,
      modelRegistry: reg,
      paramOverride: { model: "p1/explicit" },
    });
    expect(r.model.id).toBe("explicit");
  });

  it("L2: agentConfig.model used when no param override", () => {
    const m = makeModel({ id: "agent-md-model", provider: "ap" });
    const reg = makeRegistry([m]);
    const r = resolveModelForAgent({
      ...baseArgs,
      agentConfig: { name: "worker", systemPrompt: "", model: "ap/agent-md-model" },
      modelRegistry: reg,
    });
    expect(r.model.id).toBe("agent-md-model");
  });

  it("L3: sessionState.agentModels[agentName] used when no agentConfig.model", () => {
    const m = makeModel({ id: "session-agent-model", provider: "sp" });
    const reg = makeRegistry([m]);
    const r = resolveModelForAgent({
      ...baseArgs,
      agentConfig: { name: "worker", systemPrompt: "" },
      sessionState: { categoryModels: {}, agentModels: { worker: { model: "sp/session-agent-model" } } },
      modelRegistry: reg,
    });
    expect(r.model.id).toBe("session-agent-model");
  });

  it("L4: sessionState.categoryModels wins over globalConfig.categories", () => {
    const mSession = makeModel({ id: "session-cat", provider: "sc" });
    const mGlobal = makeModel({ id: "global-cat", provider: "gc" });
    const reg = makeRegistry([mSession, mGlobal]);
    const r = resolveModelForAgent({
      ...baseArgs,
      category: "coding",
      globalConfig: { categories: { coding: { model: "gc/global-cat" } }, fallback: { model: "anthropic/x" } },
      sessionState: { categoryModels: { coding: { model: "sc/session-cat" } }, agentModels: {} },
      modelRegistry: reg,
    });
    expect(r.model.id).toBe("session-cat");
  });

  it("L4 falls back to globalConfig.categories when sessionState empty", () => {
    const m = makeModel({ id: "global-cat", provider: "gc" });
    const reg = makeRegistry([m]);
    const r = resolveModelForAgent({
      ...baseArgs,
      globalConfig: { categories: { coding: { model: "gc/global-cat" } }, fallback: { model: "anthropic/x" } },
      sessionState: { categoryModels: {}, agentModels: {} },
      modelRegistry: reg,
    });
    expect(r.model.id).toBe("global-cat");
  });

  it("L5: fallback.model used when all higher levels unavailable", () => {
    const m = makeModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
    const reg = makeRegistry([m]);
    const r = resolveModelForAgent({
      ...baseArgs,
      globalConfig: { categories: {}, fallback: { model: "anthropic/claude-sonnet-4-5" } },
      sessionState: { categoryModels: {}, agentModels: {} },
      modelRegistry: reg,
    });
    expect(r.model.id).toBe("claude-sonnet-4-5");
  });
});

// ============================================================
// 失败/降级行为
// ============================================================

describe("resolveModelForAgent — skip unavailable + throw on total miss", () => {
  it("skips candidate lacking auth and uses next available", () => {
    const mUnauthed = makeModel({ id: "unauthed", provider: "u" });
    const mAuthed = makeModel({ id: "authed", provider: "a" });
    const reg = makeRegistry([mUnauthed, mAuthed], ["a/authed"]); // unauthed 无鉴权
    const r = resolveModelForAgent({
      ...baseArgs,
      paramOverride: { model: "u/unauthed" },
      globalConfig: { categories: {}, fallback: { model: "a/authed" } },
      modelRegistry: reg,
    });
    expect(r.model.id).toBe("authed");
  });

  it("skips empty/invalid modelStr (no slash) and continues chain", () => {
    // 历史 bug 关联：fallback.model="" 曾导致 lookupModel("") 返回 undefined。
    // 这里验证空候选被跳过，不阻断后续链路。
    const m = makeModel({ id: "real", provider: "r" });
    const reg = makeRegistry([m]);
    const r = resolveModelForAgent({
      ...baseArgs,
      paramOverride: { model: "" }, // 空，应被跳过
      globalConfig: { categories: {}, fallback: { model: "r/real" } },
      modelRegistry: reg,
    });
    expect(r.model.id).toBe("real");
  });

  it("throws listing tried candidates + available models when all fail", () => {
    const m = makeModel({ id: "visible", provider: "v" });
    const reg = makeRegistry([m], []); // 全部无鉴权
    expect(() =>
      resolveModelForAgent({
        ...baseArgs,
        paramOverride: { model: "x/explicit" },
        globalConfig: { categories: {}, fallback: { model: "y/fallback" } },
        modelRegistry: reg,
      }),
    ).toThrow(/No available model.*Tried: x\/explicit, y\/fallback.*Available models/s);
  });
});

// ============================================================
// thinkingLevel 解析
// ============================================================

describe("resolveModelForAgent — thinkingLevel resolution", () => {
  it("returns requested thinkingLevel when model supports it", () => {
    const m = makeModel({
      id: "reasoning-model",
      provider: "rp",
      reasoning: true,
      thinkingLevelMap: { low: 1, high: 2, xhigh: 3 },
    });
    const reg = makeRegistry([m]);
    const r = resolveModelForAgent({
      ...baseArgs,
      paramOverride: { model: "rp/reasoning-model", thinkingLevel: "high" },
      modelRegistry: reg,
    });
    expect(r.thinkingLevel).toBe("high");
  });

  it("clamps down to highest available when requested unsupported", () => {
    const m = makeModel({
      id: "limited-model",
      provider: "lp",
      reasoning: true,
      thinkingLevelMap: { low: 1, medium: 2 }, // 不含 xhigh
    });
    const reg = makeRegistry([m]);
    const r = resolveModelForAgent({
      ...baseArgs,
      paramOverride: { model: "lp/limited-model", thinkingLevel: "xhigh" },
      modelRegistry: reg,
    });
    expect(r.thinkingLevel).toBe("medium"); // clamp 到最高可用
  });

  it("returns undefined when model.reasoning === false", () => {
    const m = makeModel({ id: "non-reasoning", provider: "nr", reasoning: false });
    const reg = makeRegistry([m]);
    const r = resolveModelForAgent({
      ...baseArgs,
      paramOverride: { model: "nr/non-reasoning", thinkingLevel: "high" },
      modelRegistry: reg,
    });
    expect(r.thinkingLevel).toBeUndefined();
  });
});

// ============================================================
// availableThinkingLevels
// ============================================================

describe("availableThinkingLevels", () => {
  it("returns [] when reasoning false", () => {
    expect(availableThinkingLevels({ reasoning: false })).toEqual([]);
  });
  it("returns [] when no thinkingLevelMap", () => {
    expect(availableThinkingLevels({ reasoning: true })).toEqual([]);
  });
  it("filters THINKING_ORDER to non-null map entries, ascending", () => {
    expect(
      availableThinkingLevels({ reasoning: true, thinkingLevelMap: { off: 0, high: 2, low: 1, xhigh: 3 } }),
    ).toEqual(["off", "low", "high", "xhigh"]);
  });
});

// ============================================================
// inferCategory
// ============================================================

describe("inferCategory", () => {
  const overrides = { worker: "coding", reviewer: "coding", scout: "research" };
  it("explicit override wins", () => {
    expect(inferCategory("worker", undefined, overrides, "general")).toBe("coding");
  });
  it("name pattern inference (cod/review/fix)", () => {
    expect(inferCategory("code-fixer", undefined, {}, "general")).toBe("coding");
  });
  it("name pattern inference (research/scout)", () => {
    expect(inferCategory("deep-researcher", undefined, {}, "general")).toBe("research");
  });
  it("name pattern inference (test/qa)", () => {
    expect(inferCategory("qa-validator", undefined, {}, "general")).toBe("testing");
  });
  it("name pattern inference (plan/architect)", () => {
    expect(inferCategory("architect-bot", undefined, {}, "general")).toBe("planning");
  });
  it("name pattern inference (vision/ocr)", () => {
    expect(inferCategory("ocr-vision", undefined, {}, "general")).toBe("vision");
  });
  it("falls back to defaultCategory when no match", () => {
    expect(inferCategory("random-name", undefined, {}, "general")).toBe("general");
  });
});
