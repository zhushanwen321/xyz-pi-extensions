/**
 * weightTokens 加权计算测试
 */
import { describe, expect, it } from "vitest";

import {
  CACHE_READ_WEIGHT,
  CACHE_WRITE_WEIGHT,
  INPUT_WEIGHT,
  OUTPUT_WEIGHT,
  weightTokens,
} from "../accounting.js";

// ── 权重常量值 ────────────────────────────────────────

describe("权重常量", () => {
  it("INPUT_WEIGHT = 1（基准）", () => expect(INPUT_WEIGHT).toBe(1));
  it("CACHE_READ_WEIGHT = 0.02（1/50）", () => expect(CACHE_READ_WEIGHT).toBe(0.02));
  it("CACHE_WRITE_WEIGHT = 0（不计）", () => expect(CACHE_WRITE_WEIGHT).toBe(0));
  it("OUTPUT_WEIGHT = 2", () => expect(OUTPUT_WEIGHT).toBe(2));
});

// ── weightTokens ─────────────────────────────────────

describe("weightTokens", () => {
  it("全 0 → 0", () => {
    expect(weightTokens({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0);
  });

  it("纯 input（非缓存）→ input × 1", () => {
    expect(weightTokens({ input: 100, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(100);
  });

  it("纯 output → output × 2", () => {
    expect(weightTokens({ input: 0, output: 50, cacheRead: 0, cacheWrite: 0 })).toBe(100);
  });

  it("纯 cacheRead → cacheRead × 0.02", () => {
    expect(weightTokens({ input: 0, output: 0, cacheRead: 5000, cacheWrite: 0 })).toBe(100);
  });

  it("cacheWrite 不计入（权重 0）", () => {
    expect(weightTokens({ input: 0, output: 0, cacheRead: 0, cacheWrite: 9999 })).toBe(0);
  });

  it("四项混合加权求和", () => {
    // input=10×1 + output=20×2 + cacheRead=5×0.02 + cacheWrite=5×0 = 10 + 40 + 0.1 + 0 = 50.1
    expect(weightTokens({ input: 10, output: 20, cacheRead: 5, cacheWrite: 5 })).toBe(50.1);
  });

  it("长 session cacheRead 主导场景（验证缓存不被重复高估）", () => {
    // input=5×1 + output=100×2 + cacheRead=50000×0.02 + cacheWrite=0 = 5 + 200 + 1000 = 1205
    expect(weightTokens({ input: 5, output: 100, cacheRead: 50000, cacheWrite: 0 })).toBe(1205);
  });
});
