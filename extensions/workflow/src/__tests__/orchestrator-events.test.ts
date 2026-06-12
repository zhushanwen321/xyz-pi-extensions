/**
 * Tests for WorkflowEventEmitter (FR-5)
 *
 * Covers: subscribe/unsubscribe, emit, listener error isolation,
 * tick interval lifecycle, subscription counting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkflowEventEmitter } from "../engine/orchestrator-events.js";

describe("WorkflowEventEmitter", () => {
  let emitter: WorkflowEventEmitter;

  beforeEach(() => {
    emitter = new WorkflowEventEmitter();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Subscribe & emit ───────────────────────────────────────

  it("subscribe then emit triggers listener", () => {
    const listener = vi.fn();
    emitter.subscribe("run-1", listener);

    const event = { type: "status" as const, status: "completed" as const };
    emitter.emit("run-1", event);

    expect(listener).toHaveBeenCalledWith(event);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops listener from receiving events", () => {
    const listener = vi.fn();
    const unsub = emitter.subscribe("run-1", listener);

    unsub();
    emitter.emit("run-1", { type: "status", status: "running" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("multiple listeners fire independently", () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    emitter.subscribe("run-1", l1);
    emitter.subscribe("run-1", l2);

    emitter.emit("run-1", { type: "status", status: "paused" });

    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });

  it("emit to non-existent runId is no-op", () => {
    const listener = vi.fn();
    emitter.subscribe("run-1", listener);

    emitter.emit("run-2", { type: "status", status: "running" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("unsubscribe one listener keeps others active", () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    const unsub1 = emitter.subscribe("run-1", l1);
    emitter.subscribe("run-1", l2);

    unsub1();
    emitter.emit("run-1", { type: "status", status: "running" });

    expect(l1).not.toHaveBeenCalled();
    expect(l2).toHaveBeenCalledTimes(1);
  });

  // ── Listener error isolation (FR-5.5) ──────────────────────

  it("listener error does not affect other listeners", () => {
    const errorListener = vi.fn(() => {
      throw new Error("boom");
    });
    const goodListener = vi.fn();

    emitter.subscribe("run-1", errorListener);
    emitter.subscribe("run-1", goodListener);

    // Emit must not throw and must reach the second listener. Listener
    // errors are now silently swallowed (they previously logged via
    // console.error, which leaked to the input area).
    expect(() => emitter.emit("run-1", { type: "status", status: "running" })).not.toThrow();

    expect(errorListener).toHaveBeenCalledTimes(1);
    expect(goodListener).toHaveBeenCalledTimes(1);
  });

  // ── getSubscriptionCount ───────────────────────────────────

  it("getSubscriptionCount returns correct count", () => {
    expect(emitter.getSubscriptionCount("run-1")).toBe(0);

    const unsub1 = emitter.subscribe("run-1", vi.fn());
    expect(emitter.getSubscriptionCount("run-1")).toBe(1);

    emitter.subscribe("run-1", vi.fn());
    expect(emitter.getSubscriptionCount("run-1")).toBe(2);

    unsub1();
    expect(emitter.getSubscriptionCount("run-1")).toBe(1);
  });

  it("getSubscriptionCount returns 0 for unknown runId", () => {
    expect(emitter.getSubscriptionCount("unknown")).toBe(0);
  });

  // ── Tick interval lifecycle (FR-5.4, AC-16) ────────────────

  it("tick fires after first subscribe", () => {
    const listener = vi.fn();
    emitter.subscribe("run-1", listener);

    vi.advanceTimersByTime(1000);

    // Should have received at least one tick event
    const tickCalls = listener.mock.calls.filter(
      (call) => call[0].type === "tick",
    );
    expect(tickCalls.length).toBeGreaterThanOrEqual(1);
    expect(tickCalls[0][0]).toHaveProperty("now");
    expect(typeof tickCalls[0][0].now).toBe("number");
  });

  it("tick interval cleared when all subscribers unsubscribe", () => {
    const listener = vi.fn();
    const unsub = emitter.subscribe("run-1", listener);

    unsub();

    // Advance time — no tick should fire since no subscribers
    vi.advanceTimersByTime(3000);

    // listener was called 0 times (unsubscribed before any tick)
    expect(listener).not.toHaveBeenCalled();
  });

  it("tick continues when one of two subscribers unsubscribes", () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    const unsub1 = emitter.subscribe("run-1", l1);
    emitter.subscribe("run-1", l2);

    unsub1();
    vi.advanceTimersByTime(1000);

    // l2 should still get tick events
    const tickCalls = l2.mock.calls.filter((c) => c[0].type === "tick");
    expect(tickCalls.length).toBeGreaterThanOrEqual(1);
  });
});
