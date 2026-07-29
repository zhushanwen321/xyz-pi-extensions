// Behavioral tests for weak-model parameter-misuse detectors.
//
// Complements the source-text prompt-quality tests (subagent-tool-prompt.test.ts /
// workflow-tool-prompt.test.ts): those lock that the Correct examples / anti-pattern
// STRINGS exist in source; these lock the actual trigger/no-trigger LOGIC, so a
// refactor that inverts a condition or swaps keys cannot pass just by keeping the
// literal string alive.
//
// Covers the detectors added in the weak-model-robustness PR:
//   - workflow findFlattenedArgKeys (args sub-fields flattened to top level — P0)
//
// NOTE: subagent hasFlattenedStartFields detector 已随 wave 3 拍平删除——
// startParam envelope 不再存在，task/slug 平铺到顶层是合法形态，原 detector 无意义。

import { describe, expect, it } from "vitest";

import { findFlattenedArgKeys } from "../tool-workflow";

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
