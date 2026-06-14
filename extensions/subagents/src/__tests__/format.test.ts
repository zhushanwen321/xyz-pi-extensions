// src/__tests__/format.test.ts
import { describe, expect,it } from "vitest";

import { DEFAULT_CATEGORIES } from "../category.ts";
import { formatConfigSummary, formatThinkingLevelOption } from "../tui/format.ts";
import type { SubagentsGlobalConfig } from "../types.ts";

const cfg: SubagentsGlobalConfig = {
  version: 1, yoloByDefault: false, maxConcurrent: 4,
  categories: { ...DEFAULT_CATEGORIES },
  agentCategoryOverrides: {},
  fallback: { model: "mimo-router/mimo-v2.5", thinkingLevel: "low" },
};

describe("formatConfigSummary", () => {
  it("includes all categories with model + thinkingLevel", () => {
    const summary = formatConfigSummary(cfg, false);
    expect(summary).toContain("coding");
    expect(summary).toContain("deepseek-router/ds-flash");
    expect(summary).toContain("research");
    expect(summary).toContain("YOLO: OFF");
  });

  it("shows YOLO status", () => {
    expect(formatConfigSummary(cfg, true)).toContain("YOLO: ON");
    expect(formatConfigSummary(cfg, false)).toContain("YOLO: OFF");
  });

  it("shows maxConcurrent", () => {
    expect(formatConfigSummary(cfg, false)).toContain("4");
  });
});

describe("formatThinkingLevelOption", () => {
  it("formats level with description", () => {
    expect(formatThinkingLevelOption("high")).toBe("high — 深度推理，耗时较长");
    expect(formatThinkingLevelOption("xhigh")).toBe("xhigh — 最深度推理，耗时最长");
    expect(formatThinkingLevelOption("off")).toBe("off — 不使用推理");
  });
});
