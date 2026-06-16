// src/__tests__/concurrency-pool.test.ts
import { describe, expect, it } from "vitest";

import { DefaultConcurrencyPool } from "../pool/concurrency-pool.ts";

describe("DefaultConcurrencyPool", () => {
  it("allows up to maxConcurrent concurrent tasks", async () => {
    const pool = new DefaultConcurrencyPool(2);
    let active = 0;
    let peak = 0;
    const _task = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    };

    await pool.acquire();
    await pool.acquire();
    // 第三个 acquire 应阻塞
    let thirdAcquired = false;
    const third = pool.acquire().then(() => { thirdAcquired = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(thirdAcquired).toBe(false);
    expect(pool.activeCount).toBe(2);
    expect(pool.queueLength).toBe(1);

    pool.release();
    await third;
    expect(thirdAcquired).toBe(true);
    expect(pool.activeCount).toBe(2);

    pool.release();
    pool.release();
    await new Promise((r) => setTimeout(r, 5));
    expect(pool.activeCount).toBe(0);
  });

  it("higher priority acquires the pool first", async () => {
    const pool = new DefaultConcurrencyPool(1);
    await pool.acquire(); // 占满

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

  it("reports maxConcurrent", () => {
    const pool = new DefaultConcurrencyPool(4);
    expect(pool.maxConcurrent).toBe(4);
  });

  it("same-priority tasks wake in FIFO (seq) order", async () => {
    const pool = new DefaultConcurrencyPool(1);
    await pool.acquire(); // fill slot

    const order: number[] = [];
    // Enqueue 3 tasks with same priority — they should resolve in enqueue order
    const p1 = pool.acquire(0).then(() => { order.push(1); pool.release(); });
    const p2 = pool.acquire(0).then(() => { order.push(2); pool.release(); });
    const p3 = pool.acquire(0).then(() => { order.push(3); pool.release(); });

    pool.release(); // kick off the chain
    await Promise.allSettled([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
  });

  it("extra release() does not make activeCount negative", () => {
    const pool = new DefaultConcurrencyPool(2);
    pool.release(); // no acquires yet
    pool.release();
    pool.release();
    expect(pool.activeCount).toBe(0);
  });
});
