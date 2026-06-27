import { describe, expect, it } from "vitest";

/**
 * W0 脚手架冒烟测试（完成判定：vitest run 退出 0）。
 * 验 vitest 运行器就位；W1 起被各模块测试取代其实际价值。
 */
describe("vitest scaffold", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
