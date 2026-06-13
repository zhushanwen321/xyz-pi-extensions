// src/__tests__/config-merger.test.ts
import { describe, it, expect } from "vitest";
import { mergeConfig } from "../resolution/config-merger.ts";
import { DEFAULT_CATEGORIES } from "../category.ts";
import type { SubagentsGlobalConfig, SessionModelState } from "../types.ts";

const baseConfig: SubagentsGlobalConfig = {
  version: 1, yoloByDefault: false, maxConcurrent: 4,
  categories: { ...DEFAULT_CATEGORIES },
  agentCategoryOverrides: {},
  fallback: { model: "fallback/model", thinkingLevel: "low" },
};
const emptyState: SessionModelState = { yoloMode: false, perAgent: {}, perCategory: {} };

describe("mergeConfig (5-level priority)", () => {
  it("level 5 (param override) wins over everything", () => {
    const result = mergeConfig({
      agentConfig: { name: "worker", systemPrompt: "", source: "builtin", model: "agent/model" },
      agentName: "worker",
      category: "coding",
      globalConfig: baseConfig,
      sessionState: { ...emptyState, perAgent: { worker: { model: "session/model" } } },
      paramOverride: { model: "param/model", thinkingLevel: "xhigh" },
    });
    expect(result.model).toBe("param/model");
    expect(result.thinkingLevel).toBe("xhigh");
    expect(result.source).toBe("param");
  });

  it("level 4 (per-agent session) wins over category default", () => {
    const result = mergeConfig({
      agentConfig: { name: "worker", systemPrompt: "", source: "builtin" },
      agentName: "worker",
      category: "coding",
      globalConfig: baseConfig,
      sessionState: { ...emptyState, perAgent: { worker: { model: "session/model", thinkingLevel: "high" } } },
    });
    expect(result.model).toBe("session/model");
    expect(result.source).toBe("per-agent");
  });

  it("level 3 (per-category session) wins over global category default", () => {
    const result = mergeConfig({
      agentConfig: { name: "x", systemPrompt: "", source: "builtin" },
      agentName: "x",
      category: "coding",
      globalConfig: baseConfig,
      sessionState: { ...emptyState, perCategory: { coding: { model: "session-cat/model" } } },
    });
    expect(result.model).toBe("session-cat/model");
    expect(result.source).toBe("per-category");
  });

  it("level 2 (global category default) used when no session override", () => {
    const result = mergeConfig({
      agentConfig: { name: "x", systemPrompt: "", source: "builtin" },
      agentName: "x",
      category: "coding",
      globalConfig: baseConfig,
      sessionState: emptyState,
    });
    expect(result.model).toBe(DEFAULT_CATEGORIES.coding.model);
    expect(result.source).toBe("category-default");
  });

  it("level 1 (agent frontmatter model) used when no category match", () => {
    const result = mergeConfig({
      agentConfig: { name: "x", systemPrompt: "", source: "builtin", model: "agent/model" },
      agentName: "x",
      category: "nonexistent-category",
      globalConfig: baseConfig,
      sessionState: emptyState,
    });
    expect(result.model).toBe("agent/model");
    expect(result.source).toBe("agent-default");
  });

  it("falls back to global fallback model when nothing else matches", () => {
    const result = mergeConfig({
      agentConfig: { name: "x", systemPrompt: "", source: "builtin" },
      agentName: "x",
      category: "nonexistent",
      globalConfig: baseConfig,
      sessionState: emptyState,
    });
    expect(result.model).toBe("fallback/model");
    expect(result.source).toBe("global-fallback");
  });
});
