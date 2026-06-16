import { describe, expect, it } from "vitest";

import { DEFAULT_CATEGORIES } from "../category.ts";
import { resolveAllCategoryModels } from "../tui/batch-model-resolver.ts";
import type { SessionModelState, SubagentsGlobalConfig } from "../types.ts";

const sessionState: SessionModelState = {
  yoloMode: false,
  perAgent: {},
  perCategory: { research: { model: "anthropic/claude-haiku-4-5", thinkingLevel: "low" } },
  categoryConfirmed: false,
};

const globalConfig: SubagentsGlobalConfig = {
  version: 1,
  yoloByDefault: false,
  maxConcurrent: 4,
  categories: { ...DEFAULT_CATEGORIES },
  agentCategoryOverrides: {},
  fallback: { model: "fallback/m", thinkingLevel: "low" },
};

describe("resolveAllCategoryModels", () => {
  it("returns current model string for each category via config chain", () => {
    const result = resolveAllCategoryModels(globalConfig, sessionState);
    // coding 走 category-default（DEFAULT_CATEGORIES.coding.model）
    expect(result.coding).toBe(DEFAULT_CATEGORIES.coding.model);
    // research 走 perCategory 覆盖（优先级更高）
    expect(result.research).toBe("anthropic/claude-haiku-4-5");
  });

  it("returns map keyed by every category in globalConfig.categories", () => {
    const result = resolveAllCategoryModels(globalConfig, sessionState);
    expect(Object.keys(result).sort()).toEqual(Object.keys(DEFAULT_CATEGORIES).sort());
  });
});
