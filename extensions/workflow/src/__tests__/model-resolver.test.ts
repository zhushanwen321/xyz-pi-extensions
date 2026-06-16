// src/__tests__/model-resolver.test.ts
//
// resolveModel() 单元测试（spawn 架构版）：
// scene→model 解析已删除，resolveModel 现在仅直传 opts.model。
//   1. opts.model 显式值 → 原样返回
//   2. opts.model 缺失 → undefined（由 pi 子进程用默认模型）
//   3. opts.model="" 空串 → undefined（falsy 契约，与 undefined 一致）

import { describe, expect, it } from "vitest";

import { resolveModel } from "../engine/model-resolver.js";

describe("resolveModel", () => {
  it("opts.model 显式值时直传", async () => {
    const result = await resolveModel({ prompt: "x", model: "openai/gpt-5" });
    expect(result).toBe("openai/gpt-5");
  });

  it("opts.model 缺失时返回 undefined", async () => {
    const result = await resolveModel({ prompt: "x" });
    expect(result).toBeUndefined();
  });

  it("opts.model 空串时返回 undefined（falsy 契约）", async () => {
    const result = await resolveModel({ prompt: "x", model: "" });
    expect(result).toBeUndefined();
  });

  it("scene 字段存在但无 model 时仍返回 undefined（scene 解析已移除）", async () => {
    const result = await resolveModel({ prompt: "x", scene: "coding" });
    expect(result).toBeUndefined();
  });
});
