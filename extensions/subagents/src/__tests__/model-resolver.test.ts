// src/__tests__/model-resolver.test.ts
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CATEGORIES } from "../category.ts";
import { resolveModelForAgent } from "../resolution/model-resolver.ts";
import type { SessionModelState,SubagentsGlobalConfig } from "../types.ts";

// Mock ModelRegistry（duck-typed）
function makeRegistry(available: Record<string, { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> }>) {
  return {
    find: vi.fn((provider: string, modelId: string) => {
      const key = `${provider}/${modelId}`;
      const def = available[key];
      if (!def) return undefined;
      return {
        id: modelId, name: modelId, provider,
        reasoning: def.reasoning ?? true,
        thinkingLevelMap: def.thinkingLevelMap,
      };
    }),
    hasConfiguredAuth: vi.fn(() => true),
    getAvailable: vi.fn(() => []),
  };
}

const baseConfig: SubagentsGlobalConfig = {
  version: 1, yoloByDefault: false, maxConcurrent: 4,
  categories: { ...DEFAULT_CATEGORIES },
  agentCategoryOverrides: {},
  fallback: { model: "mimo-router/mimo-v2.5", thinkingLevel: "low" },
};
const emptyState: SessionModelState = { yoloMode: false, perAgent: {}, perCategory: {} };

describe("resolveModelForAgent", () => {
  it("resolves category default model and validates thinkingLevel", () => {
    const registry = makeRegistry({
      "deepseek-router/ds-flash": { thinkingLevelMap: { off: "off", low: "low", high: "high", xhigh: "max" } },
    });
    const result = resolveModelForAgent({
      agentName: "worker",
      agentConfig: { name: "worker", systemPrompt: "", source: "builtin" },
      category: "coding",
      globalConfig: baseConfig, sessionState: emptyState,
      modelRegistry: registry as never,
    });
    expect(result.model.provider).toBe("deepseek-router");
    expect(result.model.name).toBe("ds-flash");
    expect(result.thinkingLevel).toBe("high");
  });

  it("falls back to agent.modelCandidates when primary unavailable", () => {
    const registry = makeRegistry({
      "mimo-router/mimo-v2.5": { thinkingLevelMap: { low: "low", medium: "medium", high: "high" } },
    });
    const result = resolveModelForAgent({
      agentName: "x",
      agentConfig: { name: "x", systemPrompt: "", source: "builtin", model: "unavail/model", modelCandidates: ["mimo-router/mimo-v2.5"] },
      category: "nonexistent",
      globalConfig: baseConfig, sessionState: emptyState,
      modelRegistry: registry as never,
    });
    expect(result.model.name).toBe("mimo-v2.5");
    expect(result.source).toBe("agent-default");
  });

  it("falls back to global fallback when agent model and candidates unavailable", () => {
    const registry = makeRegistry({
      "mimo-router/mimo-v2.5": { thinkingLevelMap: { low: "low" } },
    });
    const result = resolveModelForAgent({
      agentName: "x",
      agentConfig: { name: "x", systemPrompt: "", source: "builtin", model: "unavail/model" },
      category: "nonexistent",
      globalConfig: baseConfig, sessionState: emptyState,
      modelRegistry: registry as never,
    });
    expect(result.model.name).toBe("mimo-v2.5");
    expect(result.source).toBe("global-fallback");
  });

  it("uses env SUBAGENT_MODEL as last resort", () => {
    process.env.SUBAGENT_MODEL = "env/model";
    const registry = makeRegistry({ "env/model": { thinkingLevelMap: { off: "off" } } });
    const result = resolveModelForAgent({
      agentName: "x",
      agentConfig: { name: "x", systemPrompt: "", source: "builtin" },
      category: "nonexistent",
      globalConfig: { ...baseConfig, fallback: { model: "alsounavail/model" } },
      sessionState: emptyState,
      modelRegistry: registry as never,
    });
    expect(result.model.provider).toBe("env");
    expect(result.source).toBe("env");
    delete process.env.SUBAGENT_MODEL;
  });

  it("throws when no model available", () => {
    const registry = makeRegistry({});
    expect(() => resolveModelForAgent({
      agentName: "x",
      agentConfig: { name: "x", systemPrompt: "", source: "builtin" },
      category: "nonexistent",
      globalConfig: { ...baseConfig, fallback: { model: "unavail/model" } },
      sessionState: emptyState,
      modelRegistry: registry as never,
    })).toThrow(/No available model/);
  });

  it("skips thinkingLevel when model.reasoning === false", () => {
    const registry = makeRegistry({
      "carbon-router/qwen3-0.6b": { reasoning: false },
    });
    const result = resolveModelForAgent({
      agentName: "x",
      agentConfig: { name: "x", systemPrompt: "", source: "builtin" },
      category: "general",
      globalConfig: { ...baseConfig, categories: { ...DEFAULT_CATEGORIES, general: { label: "g", model: "carbon-router/qwen3-0.6b", thinkingLevel: "low" } } },
      sessionState: emptyState,
      modelRegistry: registry as never,
    });
    expect(result.thinkingLevel).toBeUndefined();
  });

  it("clamps thinkingLevel to highest available when requested level unavailable", () => {
    const registry = makeRegistry({
      "zhipu-coding-plan-router/glm-5.1": {
        thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: "max" },
      },
    });
    const result = resolveModelForAgent({
      agentName: "x",
      agentConfig: { name: "x", systemPrompt: "", source: "builtin" },
      category: "general",
      globalConfig: { ...baseConfig, categories: { ...DEFAULT_CATEGORIES, general: { label: "g", model: "zhipu-coding-plan-router/glm-5.1", thinkingLevel: "medium" } } },
      sessionState: emptyState,
      modelRegistry: registry as never,
    });
    expect(result.thinkingLevel).toBe("xhigh");
  });
});
