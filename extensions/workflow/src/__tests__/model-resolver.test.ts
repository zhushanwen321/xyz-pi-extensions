// src/__tests__/model-resolver.test.ts
//
// resolveModel() 单元测试：
//   1. opts.model 显式值直传（不调用 runtime）
//   2. scene 解析：runtime.resolveModelForScene 返回 string → 原样返回
//   3. scene 解析：runtime undefined → undefined
//   4. resolver 抛错 → undefined（不向上传播）
//   5. opts.model + scene 同时存在时 model 优先

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  runtime: undefined as
    | { resolveModelForScene: (scene: string) => string | undefined }
    | undefined,
}));

vi.mock("@zhushanwen/pi-subagents", () => ({
  getRuntime: () => mockState.runtime,
}));

import { resolveModel } from "../engine/model-resolver.js";

beforeEach(() => {
  mockState.runtime = undefined;
});

describe("resolveModel", () => {
  it("opts.model 显式值时直传，不调用 runtime", async () => {
    mockState.runtime = {
      resolveModelForScene: vi.fn(() => "provider/from-scene"),
    };
    const result = await resolveModel({ prompt: "x", model: "openai/gpt-5" });
    expect(result).toBe("openai/gpt-5");
    expect(mockState.runtime.resolveModelForScene).not.toHaveBeenCalled();
  });

  it("scene 解析：runtime.resolveModelForScene 返回 string → 原样返回", async () => {
    mockState.runtime = {
      resolveModelForScene: vi.fn(() => "anthropic/claude-sonnet-4.5"),
    };
    const result = await resolveModel({ prompt: "x", scene: "coding" });
    expect(result).toBe("anthropic/claude-sonnet-4.5");
    expect(mockState.runtime.resolveModelForScene).toHaveBeenCalledWith("coding");
  });

  it("runtime 未初始化（undefined）时返回 undefined", async () => {
    const result = await resolveModel({ prompt: "x", scene: "coding" });
    expect(result).toBeUndefined();
  });

  it("runtime.resolveModelForScene 抛错时返回 undefined（不向上传播）", async () => {
    mockState.runtime = {
      resolveModelForScene: vi.fn(() => {
        throw new Error("registry unavailable");
      }),
    };
    const result = await resolveModel({ prompt: "x", scene: "coding" });
    expect(result).toBeUndefined();
  });

  it("scene 解析返回 undefined（无匹配）时返回 undefined", async () => {
    mockState.runtime = {
      resolveModelForScene: vi.fn(() => undefined),
    };
    const result = await resolveModel({ prompt: "x", scene: "unknown" });
    expect(result).toBeUndefined();
  });

  it("opts.model 与 scene 同时存在时，model 优先", async () => {
    mockState.runtime = {
      resolveModelForScene: vi.fn(() => "from/scene"),
    };
    const result = await resolveModel({ prompt: "x", model: "explicit/model", scene: "coding" });
    expect(result).toBe("explicit/model");
    expect(mockState.runtime.resolveModelForScene).not.toHaveBeenCalled();
  });

  it("既无 model 也无 scene 时返回 undefined", async () => {
    mockState.runtime = {
      resolveModelForScene: vi.fn(() => "should/not/reach"),
    };
    const result = await resolveModel({ prompt: "x" });
    expect(result).toBeUndefined();
    expect(mockState.runtime.resolveModelForScene).not.toHaveBeenCalled();
  });

  // Round 6 SUG#19: empty-string model falls through to scene resolution
  // (falsy contract — same as undefined). Lock the boundary in.
  it("opts.model=\"\" (空串) 时走 scene 解析，与 undefined 行为一致", async () => {
    mockState.runtime = {
      resolveModelForScene: vi.fn(() => "anthropic/claude-sonnet-4.5"),
    };
    const result = await resolveModel({ prompt: "x", model: "", scene: "coding" });
    expect(result).toBe("anthropic/claude-sonnet-4.5");
    expect(mockState.runtime.resolveModelForScene).toHaveBeenCalledWith("coding");
  });
});
