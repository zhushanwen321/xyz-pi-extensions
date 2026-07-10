// src/__tests__/model-resolver.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  availableThinkingLevels,
  type ModelInfo,
  type ModelRegistryLike,
  resolveModel,
} from "../model-resolver.ts";

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

/** 主 agent model（第三层兼底）。 */
const ctxModel = makeModel({ id: "main-model", provider: "main" });

// ============================================================
// resolveModel — 三层优先级
// ============================================================

describe("resolveModel — three-layer priority", () => {
  it("L1: paramOverride.model wins over agentConfig and ctxModel", () => {
    const m1 = makeModel({ id: "explicit", provider: "p1" });
    const reg = makeRegistry([m1]);
    const r = resolveModel(
      { name: "worker", systemPrompt: "", model: "main/agent-md" },
      reg,
      { model: "p1/explicit" },
      ctxModel,
    );
    expect(r.model.id).toBe("explicit");
  });

  it("L2: agentConfig.model used when no paramOverride", () => {
    const m = makeModel({ id: "agent-md-model", provider: "ap" });
    const reg = makeRegistry([m]);
    const r = resolveModel(
      { name: "worker", systemPrompt: "", model: "ap/agent-md-model" },
      reg,
      undefined,
      ctxModel,
    );
    expect(r.model.id).toBe("agent-md-model");
  });

  it("L3: ctxModel (main agent model) used when no override and no agentConfig.model", () => {
    const reg = makeRegistry([]);
    const r = resolveModel(
      { name: "worker", systemPrompt: "" },
      reg,
      undefined,
      ctxModel,
    );
    expect(r.model).toBe(ctxModel);
    expect(r.thinkingLevel).toBeUndefined();
  });

  it("L3: ctxModel used even when registry is empty (no lookup needed)", () => {
    const reg = makeRegistry([]);
    const r = resolveModel(undefined, reg, undefined, ctxModel);
    expect(r.model).toBe(ctxModel);
  });
});

// ============================================================
// 显式指定失败的错误行为
// ============================================================

describe("resolveModel — explicit override failures throw (no silent fallback)", () => {
  it("paramOverride.model not in registry → throws (does NOT fall back to ctxModel)", () => {
    const reg = makeRegistry([]);
    expect(() =>
      resolveModel(undefined, reg, { model: "x/nonexistent" }, ctxModel),
    ).toThrow(/not found in registry/);
  });

  it("paramOverride.model found but auth missing → throws auth-specific message", () => {
    const m = makeModel({ id: "unauthed", provider: "u" });
    const reg = makeRegistry([m], []); // 无鉴权
    expect(() =>
      resolveModel(undefined, reg, { model: "u/unauthed" }, ctxModel),
    ).toThrow(/exists but auth is not configured/);
  });

  it("agentConfig.model not in registry → throws", () => {
    const reg = makeRegistry([]);
    expect(() =>
      resolveModel(
        { name: "worker", systemPrompt: "", model: "x/missing" },
        reg,
        undefined,
        ctxModel,
      ),
    ).toThrow(/not found in registry/);
  });

  it("no override, no agentConfig.model, no ctxModel → throws listing available", () => {
    const m = makeModel({ id: "visible", provider: "v" });
    const reg = makeRegistry([m]);
    expect(() => resolveModel(undefined, reg, undefined, undefined)).toThrow(
      /No available model.*Available models/s,
    );
  });

  it("invalid model string (no slash) → throws", () => {
    const reg = makeRegistry([]);
    expect(() =>
      resolveModel(undefined, reg, { model: "no-slash" }, ctxModel),
    ).toThrow(/not found in registry/);
  });
});

// ============================================================
// thinkingLevel 解析
// ============================================================

describe("resolveModel — thinkingLevel resolution", () => {
  it("override path: returns requested thinkingLevel when model supports it", () => {
    const m = makeModel({
      id: "reasoning-model",
      provider: "rp",
      reasoning: true,
      thinkingLevelMap: { low: 1, high: 2, xhigh: 3 },
    });
    const reg = makeRegistry([m]);
    const r = resolveModel(undefined, reg, { model: "rp/reasoning-model", thinkingLevel: "high" });
    expect(r.thinkingLevel).toBe("high");
  });

  it("override path: clamps down to highest available when requested unsupported", () => {
    const m = makeModel({
      id: "limited-model",
      provider: "lp",
      reasoning: true,
      thinkingLevelMap: { low: 1, medium: 2 }, // 不含 xhigh
    });
    const reg = makeRegistry([m]);
    const r = resolveModel(undefined, reg, { model: "lp/limited-model", thinkingLevel: "xhigh" });
    expect(r.thinkingLevel).toBe("medium");
  });

  it("override path: returns undefined when model.reasoning === false", () => {
    const m = makeModel({ id: "non-reasoning", provider: "nr", reasoning: false });
    const reg = makeRegistry([m]);
    const r = resolveModel(undefined, reg, { model: "nr/non-reasoning", thinkingLevel: "high" });
    expect(r.thinkingLevel).toBeUndefined();
  });

  it("ctxModel path: thinkingLevel from paramOverride.thinkingLevel (pass-through, no clamp)", () => {
    const reg = makeRegistry([]);
    const r = resolveModel(undefined, reg, { thinkingLevel: "high" }, ctxModel);
    // ctxModel reasoning=false，但 ctxModel 路径不 clamp（主 agent model 直接透传）
    expect(r.thinkingLevel).toBe("high");
  });

  it("ctxModel path: thinkingLevel from agentConfig.thinkingLevel when no paramOverride", () => {
    const reg = makeRegistry([]);
    const r = resolveModel(
      { name: "worker", systemPrompt: "", thinkingLevel: "medium" },
      reg,
      undefined,
      ctxModel,
    );
    expect(r.thinkingLevel).toBe("medium");
  });

  it("ctxModel path: thinkingLevel undefined when no override anywhere", () => {
    const reg = makeRegistry([]);
    const r = resolveModel(undefined, reg, undefined, ctxModel);
    expect(r.thinkingLevel).toBeUndefined();
  });
});

// ============================================================
// lookupModel 容错：剥离 ":thinkingLevel" 后缀（A）
// ============================================================

describe('resolveModel — strips ":thinkingLevel" suffix from model string (A)', () => {
  it('resolves model passed with ":xhigh" suffix', () => {
    const m = makeModel({ id: "ds-pro", provider: "deepseek-router", reasoning: true, thinkingLevelMap: { xhigh: 3 } });
    const reg = makeRegistry([m]);
    const r = resolveModel(undefined, reg, { model: "deepseek-router/ds-pro:xhigh" }, ctxModel);
    expect(r.model.id).toBe("ds-pro");
  });

  it('resolves model passed with ":high" suffix (registry has no suffix)', () => {
    const m = makeModel({ id: "sonnet", provider: "anthropic", reasoning: true, thinkingLevelMap: { high: 2 } });
    const reg = makeRegistry([m]);
    const r = resolveModel(undefined, reg, { model: "anthropic/sonnet:high" });
    expect(r.model.id).toBe("sonnet");
  });

  it('strips ":off" suffix (off is a valid thinking level)', () => {
    const m = makeModel({ id: "m1", provider: "p", reasoning: false });
    const reg = makeRegistry([m]);
    const r = resolveModel(undefined, reg, { model: "p/m1:off" });
    expect(r.model.id).toBe("m1");
  });

  it('does NOT strip unrelated colon suffix (e.g. ":foo")', () => {
    // ":foo" 不是合法 thinking level，不剥离 → 查不到 → 抛 not found
    const m = makeModel({ id: "m1", provider: "p", reasoning: false });
    const reg = makeRegistry([m]);
    expect(() => resolveModel(undefined, reg, { model: "p/m1:foo" })).toThrow(/not found in registry/);
  });

  it('suffix-stripped resolve still respects explicit thinkingLevel param', () => {
    const m = makeModel({ id: "ds-pro", provider: "deepseek-router", reasoning: true, thinkingLevelMap: { high: 2, xhigh: 3 } });
    const reg = makeRegistry([m]);
    // model 带 ":xhigh" 但 thinkingLevel param 指定 high -> thinking 取 high
    const r = resolveModel(undefined, reg, { model: "deepseek-router/ds-pro:xhigh", thinkingLevel: "high" });
    expect(r.model.id).toBe("ds-pro");
    expect(r.thinkingLevel).toBe("high");
  });
});

// ============================================================
// not-found 错误信息：列出相近可用 model（B）
// ============================================================

describe("resolveModel — not-found error suggests similar models (B)", () => {
  it("not-found with available registry lists similar models", () => {
    const m = makeModel({ id: "ds-pro", provider: "deepseek-router" });
    const reg = makeRegistry([m]);
    let msg = "";
    try {
      resolveModel(undefined, reg, { model: "deepseek-router/ds-por" }, ctxModel); // 拼写错误
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/not found in registry/);
    expect(msg).toMatch(/deepseek-router\/ds-pro/); // 建议列表含正确拼写
  });

  it("not-found with empty registry reports no available models", () => {
    const reg = makeRegistry([]);
    expect(() => resolveModel(undefined, reg, { model: "x/none" }, ctxModel)).toThrow(
      /Registry has no available models/,
    );
  });

  it("auth-missing error does NOT list models, points to models.json", () => {
    const m = makeModel({ id: "unauthed", provider: "u" });
    const reg = makeRegistry([m], []);
    let msg = "";
    try {
      resolveModel(undefined, reg, { model: "u/unauthed" }, ctxModel);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/auth is not configured/);
    expect(msg).toMatch(/models\.json/);
    expect(msg).not.toMatch(/Similar available models/); // auth 错误不列 model
  });
});

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
// ModelConfigService: initModel(ctxModel) → resolveModel L3 plumb-through
// changeset 主打路径的 runtime 契约保护（EA-4）。
// 链路：session_start initModel({ctxModel}) → _ctxModel 缓存 → resolveModel 第三层命中
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ModelConfigService } from "../model-config-service.ts";

describe("ModelConfigService: ctx.model plumb-through (EA-4)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-resolver-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 构造已 initModel 的 ModelConfigService，ctxModel 注入缓存。 */
  function makeService(ctxModel: ModelInfo | undefined, registry: ModelRegistryLike = makeRegistry([])): ModelConfigService {
    const svc = new ModelConfigService({ agentDir: tmpDir });
    svc.initModel({
      modelRegistry: registry,
      sessionId: "test-session",
      ctxModel,
    });
    return svc;
  }

  it("initModel caches ctxModel; resolveModel L3 returns it (no override, no agentConfig.model)", () => {
    const main = makeModel({ id: "main-model", provider: "main" });
    const svc = makeService(main);

    // 无 override、无 agentConfig.model → 第三层命中缓存的 ctxModel
    const r = svc.resolveModel("general-purpose", undefined);
    expect(r.model).toBe(main);
  });

  it("resolveModel L3 hits cached ctxModel even with agent that has no model in frontmatter", () => {
    const main = makeModel({ id: "inherited", provider: "parent" });
    const svc = makeService(main);

    // worker.md 无 model frontmatter → 跳过 L2，命中 L3 ctxModel
    const r = svc.resolveModel("worker", undefined);
    expect(r.model).toBe(main);
  });

  it("resolveModel still prefers explicit paramOverride over cached ctxModel (L1 > L3)", () => {
    const main = makeModel({ id: "main", provider: "main" });
    const explicit = makeModel({ id: "explicit", provider: "p1" });
    const svc = makeService(main, makeRegistry([explicit]));

    const r = svc.resolveModel("worker", { model: "p1/explicit" });
    expect(r.model.id).toBe("explicit");
  });
});
