// src/__tests__/fuzzy-model.test.ts
import { describe, expect, it } from "vitest";

import { fuzzyMatchModel } from "../resolution/model-resolver.ts";

function makeRegistry(models: Array<{ provider: string; name: string; id?: string; reasoning?: boolean }>) {
  return {
    find: () => undefined,
    hasConfiguredAuth: () => true,
    getAvailable: () => models.map((m) => ({
      ...m,
      id: m.id ?? m.name,
      reasoning: m.reasoning ?? true,
    })),
  };
}

describe("fuzzyMatchModel", () => {
  const registry = makeRegistry([
    { provider: "anthropic", name: "claude-haiku-4-5-20251001" },
    { provider: "anthropic", name: "claude-sonnet-4-5-20250514" },
    { provider: "deepseek-router", name: "ds-flash" },
    { provider: "mimo-router", name: "mimo-v2.5" },
  ]);

  it("exact name match scores 100", () => {
    const m = fuzzyMatchModel("ds-flash", registry as never);
    expect(m?.name).toBe("ds-flash");
  });

  it("substring in name matches (haiku → claude-haiku)", () => {
    const m = fuzzyMatchModel("haiku", registry as never);
    expect(m?.name).toBe("claude-haiku-4-5-20251001");
  });

  it("substring in id matches (claude → first claude)", () => {
    const m = fuzzyMatchModel("claude", registry as never);
    expect(m?.provider).toBe("anthropic");
  });

  it("all-parts match scores 20", () => {
    const m = fuzzyMatchModel("claude sonnet", registry as never);
    expect(m?.name).toContain("sonnet");
  });

  it("no match returns undefined", () => {
    expect(fuzzyMatchModel("nonexistent-model-xyz", registry as never)).toBeUndefined();
  });

  it("empty query returns undefined", () => {
    expect(fuzzyMatchModel("", registry as never)).toBeUndefined();
  });

  it("empty available returns undefined", () => {
    expect(fuzzyMatchModel("haiku", { find: () => undefined, hasConfiguredAuth: () => true, getAvailable: () => [] } as never)).toBeUndefined();
  });
});
