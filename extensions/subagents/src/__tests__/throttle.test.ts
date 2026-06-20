// src/__tests__/throttle.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createThrottle } from "../utils/throttle.ts";

describe("createThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires immediately on first call (leading edge)", () => {
    const fn = vi.fn();
    const throttled = createThrottle(fn, 100);
    throttled("a");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("a");
  });

  it("collapses rapid calls within interval to one trailing call", () => {
    const fn = vi.fn();
    const throttled = createThrottle(fn, 100);
    throttled("a"); // leading
    throttled("b");
    throttled("c");
    throttled("d");
    expect(fn).toHaveBeenCalledTimes(1); // only leading so far
    expect(fn).toHaveBeenLastCalledWith("a");

    vi.advanceTimersByTime(100); // trailing fires with last args
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("d");
  });

  it("trailing call uses the last arguments", () => {
    const fn = vi.fn();
    const throttled = createThrottle(fn, 50);
    throttled(1);
    throttled(2);
    throttled(3);
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenLastCalledWith(3);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("flush() fires pending trailing immediately and clears timer", () => {
    const fn = vi.fn();
    const throttled = createThrottle(fn, 100);
    throttled("x");
    throttled("y"); // queues trailing
    expect(fn).toHaveBeenCalledTimes(1);

    throttled.flush();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("y");

    // Timer already cleared — advancing should NOT fire again
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("flush() is a no-op when no pending trailing", () => {
    const fn = vi.fn();
    const throttled = createThrottle(fn, 100);
    throttled("a"); // leading fires
    throttled.flush(); // no trailing pending
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("resets after interval for a fresh leading edge", () => {
    const fn = vi.fn();
    const throttled = createThrottle(fn, 100);
    throttled(1); // leading
    vi.advanceTimersByTime(100); // no trailing queued → nothing fires
    expect(fn).toHaveBeenCalledTimes(1);

    throttled(2); // fresh leading
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(2);
  });

  it("default interval is 150ms", () => {
    const fn = vi.fn();
    const throttled = createThrottle(fn);
    throttled("a");
    throttled("b");
    vi.advanceTimersByTime(149);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
