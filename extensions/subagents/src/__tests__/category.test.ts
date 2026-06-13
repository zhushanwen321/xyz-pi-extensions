// src/__tests__/category.test.ts
import { describe, it, expect } from "vitest";
import { DEFAULT_CATEGORIES, inferCategory } from "../category.ts";

describe("DEFAULT_CATEGORIES", () => {
  it("has 6 default categories", () => {
    expect(Object.keys(DEFAULT_CATEGORIES).sort()).toEqual(
      ["coding", "general", "planning", "research", "testing", "vision"]
    );
  });
});

describe("inferCategory", () => {
  it("uses agentConfig.category when present", () => {
    expect(inferCategory("worker", { category: "vision" } as never, {})).toBe("vision");
  });

  it("uses agentCategoryOverrides when no explicit category", () => {
    expect(inferCategory("worker", {} as never, { worker: "coding" })).toBe("coding");
  });

  it("infers by name convention: review/reviewer → coding", () => {
    expect(inferCategory("code-reviewer", {} as never, {})).toBe("coding");
  });

  it("infers by name convention: search/research → research", () => {
    expect(inferCategory("web-researcher", {} as never, {})).toBe("research");
  });

  it("infers by name convention: test/tester → testing", () => {
    expect(inferCategory("unit-tester", {} as never, {})).toBe("testing");
  });

  it("infers by name convention: plan/planner → planning", () => {
    expect(inferCategory("task-planner", {} as never, {})).toBe("planning");
  });

  it("defaults to general", () => {
    expect(inferCategory("random-agent", {} as never, {})).toBe("general");
  });
});
