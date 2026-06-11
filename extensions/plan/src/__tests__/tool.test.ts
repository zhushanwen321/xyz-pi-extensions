import { describe, it, expect } from "vitest";
import { PLAN_ACTIONS, validateAction } from "../tool.js";

describe("Plan Tool", () => {
  it("PLAN_ACTIONS contains all required actions", () => {
    expect(PLAN_ACTIONS).toContain("list-template");
    expect(PLAN_ACTIONS).toContain("select-template");
    expect(PLAN_ACTIONS).toContain("create-template");
    expect(PLAN_ACTIONS).toContain("complete");
    expect(PLAN_ACTIONS).toContain("abort");
    expect(PLAN_ACTIONS).toHaveLength(5);
  });

  it("validateAction returns true for valid actions", () => {
    for (const action of PLAN_ACTIONS) {
      expect(validateAction(action)).toBe(true);
    }
  });

  it("validateAction returns false for invalid actions", () => {
    expect(validateAction("invalid")).toBe(false);
    expect(validateAction("")).toBe(false);
  });
});
