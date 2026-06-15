// src/__tests__/runtime-resolve-scene.test.ts
//
// SubagentRuntime.resolveModelForScene() 行为测试。
//
// FR-9.9: 返回 provider/modelId（SDK ModelRegistry.find 用 modelId 解析），
// 不是 provider/name（展示名）。这是 workflow model-resolver 依赖的契约。
//
// 覆盖：
//   - scene → provider/modelId 字符串
//   - 未知 scene（fallback 全失败）→ undefined
//   - modelRegistry 未注入 → undefined
//   - registry 抛错 → undefined（不向上传播）

import { describe, expect, it, vi } from "vitest";

import { SubagentRuntime } from "../runtime.ts";

function makeRuntime(modelRegistryImpl: () => unknown): SubagentRuntime {
  const rt = new SubagentRuntime({
    cwd: "/tmp/test-cwd",
    homeDir: "/tmp/test-home-nonexistent",
    agentDir: "/tmp/test-agent",
  });
  rt.injectModelRegistry(modelRegistryImpl() as never);
  return rt;
}

describe("SubagentRuntime.resolveModelForScene", () => {
  it("scene 解析成功时返回 'provider/modelId' 格式（DEFAULT_CATEGORIES.coding → deepseek-router/ds-flash）", () => {
    // 默认 coding category 的 model 是 "deepseek-router/ds-flash"（见 category.ts DEFAULT_CATEGORIES）。
    // Mock 返回的 ModelInfo 中 id='ds-flash' 而 name='display-name' 区分二者：
    // 验证返回值用 id 而非 name。
    const rt = makeRuntime(() => ({
      find: vi.fn((provider: string, modelId: string) => ({
        id: modelId,
        name: "display-name",
        provider,
        reasoning: true,
        thinkingLevelMap: { high: "high" },
      })),
      hasConfiguredAuth: () => true,
      getAvailable: () => [],
    }));
    const result = rt.resolveModelForScene("coding");
    // 必须是 provider/modelId，而非 provider/name
    expect(result).toBe("deepseek-router/ds-flash");
    expect(result).not.toContain("display-name");
  });

  it("scene 解析：所有候选失败时返回 undefined（不抛错）", () => {
    const rt = makeRuntime(() => ({
      find: () => undefined,
      hasConfiguredAuth: () => false,
      getAvailable: () => [],
    }));
    const result = rt.resolveModelForScene("nonexistent-scene");
    expect(result).toBeUndefined();
  });

  it("modelRegistry 未注入时返回 undefined", () => {
    const rt = new SubagentRuntime({
      cwd: "/tmp/test-cwd",
      homeDir: "/tmp/test-home-nonexistent",
      agentDir: "/tmp/test-agent",
    });
    // 不调用 injectModelRegistry
    const result = rt.resolveModelForScene("coding");
    expect(result).toBeUndefined();
  });

  it("registry.find 抛错时返回 undefined（不向上传播）", () => {
    const rt = makeRuntime(() => ({
      find: () => {
        throw new Error("registry broken");
      },
      hasConfiguredAuth: () => true,
      getAvailable: () => [],
    }));
    expect(() => rt.resolveModelForScene("coding")).not.toThrow();
    expect(rt.resolveModelForScene("coding")).toBeUndefined();
  });

  it("多次调用 scene 解析结果稳定（无副作用累积）", () => {
    const findMock = vi.fn((provider: string, modelId: string) => ({
      id: modelId,
      name: modelId,
      provider,
      reasoning: true,
    }));
    const rt = makeRuntime(() => ({
      find: findMock,
      hasConfiguredAuth: () => true,
      getAvailable: () => [],
    }));
    const r1 = rt.resolveModelForScene("coding");
    const r2 = rt.resolveModelForScene("coding");
    expect(r1).toBe(r2);
    expect(r1).toBe("deepseek-router/ds-flash");
  });
});
