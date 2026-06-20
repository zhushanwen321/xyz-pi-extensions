// src/__tests__/concurrency-pool.test.ts
import { describe, expect, it } from "vitest";

import { DefaultConcurrencyPool } from "../core/concurrency-pool.ts";

describe("DefaultConcurrencyPool", () => {
  it("allows up to maxConcurrent concurrent tasks", async () => {
    const pool = new DefaultConcurrencyPool(2);
    await pool.acquire(0);
    await pool.acquire(0);
    // 第三个 acquire 应阻塞
    let thirdAcquired = false;
    const third = pool.acquire(0).then(() => { thirdAcquired = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(thirdAcquired).toBe(false);
    expect(pool.active).toBe(2);

    pool.release();
    await third;
    expect(thirdAcquired).toBe(true);
    expect(pool.active).toBe(2);

    pool.release();
    pool.release();
    await new Promise((r) => setTimeout(r, 5));
    expect(pool.active).toBe(0);
  });

  it("higher priority acquires the pool first", async () => {
    const pool = new DefaultConcurrencyPool(1);
    await pool.acquire(0); // 占满

    let lowAcquired = false;
    let highAcquired = false;
    const low = pool.acquire(10).then(() => { lowAcquired = true; });
    const high = pool.acquire(0).then(() => { highAcquired = true; });

    await new Promise((r) => setTimeout(r, 5));
    pool.release();
    await Promise.race([low, high, new Promise((r) => setTimeout(r, 20))]);

    expect(highAcquired).toBe(true);
    expect(lowAcquired).toBe(false);
    pool.release();
  });

  it("same-priority tasks wake in FIFO (seq) order", async () => {
    const pool = new DefaultConcurrencyPool(1);
    await pool.acquire(0); // fill slot

    const order: number[] = [];
    // Enqueue 3 tasks with same priority — they should resolve in enqueue order
    const p1 = pool.acquire(0).then(() => { order.push(1); pool.release(); });
    const p2 = pool.acquire(0).then(() => { order.push(2); pool.release(); });
    const p3 = pool.acquire(0).then(() => { order.push(3); pool.release(); });

    pool.release(); // kick off the chain
    await Promise.allSettled([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
  });

  it("extra release() does not make active negative", () => {
    const pool = new DefaultConcurrencyPool(2);
    pool.release(); // no acquires yet
    pool.release();
    pool.release();
    expect(pool.active).toBe(0);
  });

  it("active never exceeds maxConcurrent", async () => {
    const pool = new DefaultConcurrencyPool(2);
    const acquires: Array<Promise<void>> = [];
    let peak = 0;
    for (let i = 0; i < 6; i++) {
      acquires.push(pool.acquire(0).then(() => {
        peak = Math.max(peak, pool.active);
      }));
    }
    // Drain: release one at a time so we can observe peak
    for (let i = 0; i < 6; i++) {
      pool.release();
      await new Promise((r) => setTimeout(r, 2));
    }
    await Promise.allSettled(acquires);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("clamps maxConcurrent=0 to 1 (no deadlock, C3 fix)", async () => {
    const pool = new DefaultConcurrencyPool(0);
    // 不会死锁——clamp 到 1，acquire 立即返回
    await pool.acquire(0);
    expect(pool.active).toBe(1);
    pool.release();
    expect(pool.active).toBe(0);
  });

  it("clamps negative maxConcurrent to 1", async () => {
    const pool = new DefaultConcurrencyPool(-5);
    await pool.acquire(0);
    expect(pool.active).toBe(1);
  });

  it("priority 0 (sync) preempts priority 1000 (background)", async () => {
    const pool = new DefaultConcurrencyPool(1);
    await pool.acquire(1000); // background 占满

    let bgAcquired = false;
    let syncAcquired = false;
    const bg = pool.acquire(1000).then(() => { bgAcquired = true; });
    const sync = pool.acquire(0).then(() => { syncAcquired = true; });

    await new Promise((r) => setTimeout(r, 5));
    pool.release();
    await Promise.race([bg, sync, new Promise((r) => setTimeout(r, 20))]);

    expect(syncAcquired).toBe(true);
    expect(bgAcquired).toBe(false);
    pool.release();
  });
});
