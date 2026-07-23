// Behavioral tests for weak-model parameter-misuse detectors.
//
// Complements the source-text prompt-quality tests (subagent-tool-prompt.test.ts /
// workflow-tool-prompt.test.ts): those lock that the Correct examples / anti-pattern
// STRINGS exist in source; these lock the actual trigger/no-trigger LOGIC, so a
// refactor that inverts a condition or swaps keys cannot pass just by keeping the
// literal string alive.
//
// Covers the detectors added in the weak-model-robustness PR:
//   - subagent hasFlattenedStartFields (startParam envelope missing)
//   - workflow findFlattenedArgKeys (args sub-fields flattened to top level — P0)

import { describe, expect, it } from "vitest";

import { hasFlattenedStartFields } from "../subagent-tool";
import { findFlattenedArgKeys } from "../tool-workflow";

describe("hasFlattenedStartFields (subagent startParam flatten detector)", () => {
  it("triggers when task/slug flattened to top level (the original failure mode)", () => {
    expect(hasFlattenedStartFields({ action: "start", task: "x", slug: "s" })).toBe(true);
    expect(hasFlattenedStartFields({ action: "start", task: "x" })).toBe(true);
    expect(hasFlattenedStartFields({ action: "start", slug: "s" })).toBe(true);
  });

  it("does NOT trigger when startParam envelope is present (correct nesting)", () => {
    expect(
      hasFlattenedStartFields({ action: "start", startParam: { task: "x", slug: "s" } }),
    ).toBe(false);
  });

  it("does NOT trigger when neither task nor slug is present", () => {
    expect(hasFlattenedStartFields({ action: "start" })).toBe(false);
    expect(hasFlattenedStartFields({ action: "list" })).toBe(false);
  });

  it("returns false for non-object input", () => {
    expect(hasFlattenedStartFields(null)).toBe(false);
    expect(hasFlattenedStartFields(undefined)).toBe(false);
    expect(hasFlattenedStartFields("start")).toBe(false);
    expect(hasFlattenedStartFields(42)).toBe(false);
  });
});

describe("findFlattenedArgKeys (workflow args flatten detector — P0)", () => {
  it("triggers when args sub-fields flattened to top level", () => {
    expect(findFlattenedArgKeys({ action: "run", name: "chain", task: "x" })).toEqual(["task"]);
    expect(findFlattenedArgKeys({ action: "run", name: "x", items: ["a"] })).toEqual(["items"]);
    expect(
      findFlattenedArgKeys({ action: "run", name: "x", task: "t", perspectives: ["p"] }),
    ).toEqual(["task", "perspectives"]);
  });

  it("does NOT trigger when fields correctly nested in args", () => {
    expect(
      findFlattenedArgKeys({ action: "run", name: "x", args: { task: "x", items: ["a"] } }),
    ).toEqual([]);
  });

  it("edge: key present at BOTH top-level and inside args is NOT flagged", () => {
    // 同时传 args.task 和顶层 task：args 已提供，顶层冗余被忽略，不算平铺。
    // 这是 reviewer 点名的 untested edge。
    expect(
      findFlattenedArgKeys({ action: "run", name: "x", args: { task: "x" }, task: "y" }),
    ).toEqual([]);
  });

  it("does NOT trigger when no known arg keys present", () => {
    expect(findFlattenedArgKeys({ action: "run", name: "x", args: {} })).toEqual([]);
    expect(findFlattenedArgKeys({ action: "status" })).toEqual([]);
  });

  it("returns [] for non-object input", () => {
    expect(findFlattenedArgKeys(null)).toEqual([]);
    expect(findFlattenedArgKeys(undefined)).toEqual([]);
  });
});
