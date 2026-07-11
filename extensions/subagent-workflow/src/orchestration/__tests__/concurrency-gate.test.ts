// T3.20: withSlot 不独立占池（槽位占用=N 而非 2N）
// AC-ARCH-5: ConcurrencyGate.withSlot 语义不变（pre-abort throw, fn 直通）

import { describe, expect, it, vi } from "vitest";

import { ConcurrencyGate, ConcurrencyGateOptions, DEFAULT_CONCURRENCY } from "../concurrency-gate.ts";

describe("ConcurrencyGate (wave-3 simplified)", () => {
  // ── Constructor & constants ────────────────────────────────

  describe("constructor + defaults", () => {
    it("DEFAULT_CONCURRENCY constant is 4 (backward compat)", () => {
      expect(DEFAULT_CONCURRENCY).toBe(4);
    });

    it("starts with zero active/queue state", () => {
      const gate = new ConcurrencyGate();
      expect(gate.activeCount).toBe(0);
      expect(gate.queueLength).toBe(0);
    });

    it("accepts number shorthand for maxConcurrency", () => {
      const gate = new ConcurrencyGate(2);
      expect(gate.activeCount).toBe(0);
      expect(gate.queueLength).toBe(0);
    });

    it("accepts options object form", () => {
      const gate = new ConcurrencyGate({ maxConcurrency: 8 } satisfies ConcurrencyGateOptions);
      expect(gate.activeCount).toBe(0);
      expect(gate.queueLength).toBe(0);
    });
  });

  // ── T3.20: withSlot doesn't independently occupy pool ───────

  describe("withSlot — thin abort wrapper (T3.20)", () => {
    it("槽位可用 → 直接执行 fn 并返回其结果", async () => {
      const gate = new ConcurrencyGate({ maxConcurrency: 2 });
      const fn = vi.fn(async () => "result");
      const result = await gate.withSlot(fn);
      expect(result).toBe("result");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("pre-aborted signal → 立即 throw AbortError（不调 fn）", async () => {
      const gate = new ConcurrencyGate({ maxConcurrency: 2 });
      const fn = vi.fn(async () => "result");
      const controller = new AbortController();
      controller.abort();
      await expect(gate.withSlot(fn, controller.signal)).rejects.toThrow(/aborted before start/);
      expect(fn).not.toHaveBeenCalled();
    });

    // T3.20 核心：不独立占池。多个并发 withSlot 互不阻塞。
    it("不独立占池：多个并发 fn 立即执行，互不阻塞（槽位占用=N 非 2N）", async () => {
      const gate = new ConcurrencyGate({ maxConcurrency: 1 });
      // maxConcurrency=1 但 withSlot 不排队 — fn1 和 fn2 立即并行执行
      const order: string[] = [];
      let resolveFirst: () => void = () => {};
      const firstPromise = new Promise<void>((r) => { resolveFirst = r; });

      const fn1 = vi.fn(async () => {
        order.push("fn1-start");
        await firstPromise;
        order.push("fn1-end");
        return 1;
      });
      const fn2 = vi.fn(async () => {
        order.push("fn2-start");
        return 2;
      });

      const p1 = gate.withSlot(fn1);
      // fn2 也应立即开始（无排队）
      const p2 = gate.withSlot(fn2);

      // 两个 fn 都已开始
      expect(fn1).toHaveBeenCalledTimes(1);
      expect(fn2).toHaveBeenCalledTimes(1);
      expect(order).toContain("fn1-start");
      expect(order).toContain("fn2-start");

      resolveFirst();
      // 全 resolve——非独立数据源，禁 allSettled 建议
      const [r1, r2] = await Promise.all([p1, p2]); // eslint-disable-line taste/prefer-allsettled
      expect(r1).toBe(1);
      expect(r2).toBe(2);
    });

    it("不排队：maxConcurrency 参数不影响 withSlot 行为", async () => {
      const gate = new ConcurrencyGate({ maxConcurrency: 1 });
      let resolveFirst: () => void = () => {};
      const delayed = new Promise<void>((r) => { resolveFirst = r; });

      // 3 个 fn 同时提交，maxConcurrency=1 但不阻塞
      const fn1 = vi.fn(async () => { await delayed; return 1; });
      const fn2 = vi.fn(async () => 2);
      const fn3 = vi.fn(async () => 3);

      gate.withSlot(fn1);
      gate.withSlot(fn2);
      gate.withSlot(fn3);

      // 所有 fn 都已被调用（无排队阻塞）
      expect(fn1).toHaveBeenCalledTimes(1);
      expect(fn2).toHaveBeenCalledTimes(1);
      expect(fn3).toHaveBeenCalledTimes(1);

      resolveFirst();
    });

    // AC-ARCH-5: withSlot 语义不变 —— signal abort 处理保持
    it("activeCount 和 queueLength 恒为 0（不独立计槽）", () => {
      const gate = new ConcurrencyGate({ maxConcurrency: 4 });
      expect(gate.activeCount).toBe(0);
      expect(gate.queueLength).toBe(0);

      // 即使并发执行中，计数也不变
      gate.withSlot(async () => { /* noop */ });
      expect(gate.activeCount).toBe(0);
      expect(gate.queueLength).toBe(0);
    });
  });
});
