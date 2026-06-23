// 测试框架：vitest
// 运行命令：npx vitest run src/engine/models/__tests__/budget.test.ts

import { describe, expect, it } from "vitest";

import { Budget, SOFT_MAX_AGENTS_WARNING } from "../budget.js";
import type { AgentUsage } from "../types.js";

function usage(partial: Partial<AgentUsage>): AgentUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
    ...partial,
  };
}

// ── consume ──────────────────────────────────────────────────

describe("Budget.consume", () => {
  it("累加四项 token（input+output+cacheRead+cacheWrite）", () => {
    const b = new Budget({ maxTokens: 1000 });
    b.consume(usage({ input: 10, output: 20, cacheRead: 5, cacheWrite: 5, cost: 0.1 }));
    expect(b.usedTokens).toBe(40);
    expect(b.usedCost).toBe(0.1);
  });

  it("多次调用累加（retry 间如实记录）", () => {
    const b = new Budget();
    b.consume(usage({ input: 100 }));
    b.consume(usage({ input: 50, output: 50 }));
    expect(b.usedTokens).toBe(200);
  });

  it("无副作用回调——consume 后无任何通知发出（D-12）", () => {
    const b = new Budget({ maxTokens: 10 });
 // Budget 是纯值对象——consume 无副作用回调，这里断言不抛、状态正确。
    expect(() => b.consume(usage({ input: 5 }))).not.toThrow();
    expect(b.usedTokens).toBe(5);
  });
});

// ── incrementCallCount ───────────────────────────────────────

describe("Budget.incrementCallCount", () => {
  it("累加调用计数", () => {
    const b = new Budget();
    expect(b.totalCallCount).toBe(0);
    b.incrementCallCount();
    b.incrementCallCount();
    expect(b.totalCallCount).toBe(2);
  });
});

// ── isExceeded ───────────────────────────────────────────────

describe("Budget.isExceeded", () => {
  it("maxTokens===0 视为不限制（守卫，首个 agent 完成不误判）", () => {
    const b = new Budget({ maxTokens: 0 });
    b.consume(usage({ input: 999999 }));
    expect(b.isExceeded()).toBe(false);
  });

  it("maxTokens undefined 视为不限制", () => {
    const b = new Budget();
    b.consume(usage({ input: 999999 }));
    expect(b.isExceeded()).toBe(false);
  });

  it("usedTokens >= maxTokens 超限", () => {
    const b = new Budget({ maxTokens: 100 });
    b.consume(usage({ input: 100 }));
    expect(b.isExceeded()).toBe(true);
  });

  it("maxCost 超限", () => {
    const b = new Budget({ maxCost: 1 });
    b.consume(usage({ cost: 1.5 }));
    expect(b.isExceeded()).toBe(true);
  });

  it("maxCost===0 视为不限制", () => {
    const b = new Budget({ maxCost: 0 });
    b.consume(usage({ cost: 999 }));
    expect(b.isExceeded()).toBe(false);
  });

  it("未达阈值不超限", () => {
    const b = new Budget({ maxTokens: 1000, maxCost: 10 });
    b.consume(usage({ input: 50, cost: 0.5 }));
    expect(b.isExceeded()).toBe(false);
  });
});

// ── isSoftLimitReached ───────────────────────────────────────

describe("Budget.isSoftLimitReached", () => {
  it(`totalCallCount > ${SOFT_MAX_AGENTS_WARNING} 触发`, () => {
    const b = new Budget();
    for (let i = 0; i < SOFT_MAX_AGENTS_WARNING; i++) b.incrementCallCount();
    expect(b.isSoftLimitReached()).toBe(false);
    b.incrementCallCount();
    expect(b.isSoftLimitReached()).toBe(true);
  });

  it("无状态——可重复查询（不像一次性 flag 只返回一次）", () => {
    const b = new Budget({ totalCallCount: SOFT_MAX_AGENTS_WARNING + 1 });
    expect(b.isSoftLimitReached()).toBe(true);
    expect(b.isSoftLimitReached()).toBe(true); // 仍 true
  });
});

// ── isThresholdReached ───────────────────────────────────────

describe("Budget.isThresholdReached", () => {
  it("达到 90% 阈值", () => {
    const b = new Budget({ maxTokens: 1000 });
    b.consume(usage({ input: 900 }));
    expect(b.isThresholdReached(0.9)).toBe(true);
  });

  it("未达 90% 阈值", () => {
    const b = new Budget({ maxTokens: 1000 });
    b.consume(usage({ input: 899 }));
    expect(b.isThresholdReached(0.9)).toBe(false);
  });

  it("maxTokens===0 时阈值查询返回 false", () => {
    const b = new Budget({ maxTokens: 0 });
    b.consume(usage({ input: 999999 }));
    expect(b.isThresholdReached(0.9)).toBe(false);
  });

  it("纯查询无状态——重复查询结果一致", () => {
    const b = new Budget({ maxTokens: 1000 });
    b.consume(usage({ input: 950 }));
    expect(b.isThresholdReached(0.9)).toBe(true);
    expect(b.isThresholdReached(0.9)).toBe(true);
  });
});

// ── 构造与序列化形状 ─────────────────────────────────────────

describe("Budget 构造", () => {
  it("默认值全 0 / undefined", () => {
    const b = new Budget();
    expect(b.usedTokens).toBe(0);
    expect(b.usedCost).toBe(0);
    expect(b.totalCallCount).toBe(0);
    expect(b.maxTokens).toBeUndefined();
    expect(b.maxCost).toBeUndefined();
    expect(b.maxTimeMs).toBeUndefined();
  });

  it("从持久化数据重建", () => {
    const b = new Budget({
      maxTokens: 5000,
      maxCost: 2,
      maxTimeMs: 60000,
      usedTokens: 100,
      usedCost: 0.3,
      totalCallCount: 7,
    });
    expect(b.maxTokens).toBe(5000);
    expect(b.usedTokens).toBe(100);
    expect(b.totalCallCount).toBe(7);
  });
});
