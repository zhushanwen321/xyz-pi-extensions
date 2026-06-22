// src/__tests__/notifier.test.ts
import { describe, expect, it, vi } from "vitest";

import type { BgNotifyRecord, NotifierHost } from "../runtime/execution/notifier.ts";
import { BgNotifier } from "../runtime/execution/notifier.ts";

// ── 工厂 ──
function makeRecord(over: Partial<BgNotifyRecord> = {}): BgNotifyRecord {
  return {
    id: "bg-1",
    status: "done",
    agent: "worker",
    result: "task completed",
    startedAt: 1000,
    endedAt: 2000,
    ...over,
  };
}

function makeHost(over: Partial<NotifierHost> = {}): NotifierHost & {
  sendMessage: ReturnType<typeof vi.fn>;
  hasRunningBackground: ReturnType<typeof vi.fn>;
} {
  return {
    sendMessage: vi.fn(),
    hasRunningBackground: vi.fn(() => false),
    ...over,
  };
}

describe("BgNotifier", () => {
  // ============================================================
  // direct notify
  // ============================================================
  it("sends immediately when no running background", () => {
    const host = makeHost({ hasRunningBackground: () => false });
    const notifier = new BgNotifier(host);
    notifier.notify(makeRecord());
    expect(host.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("delays when has running background", () => {
    vi.useFakeTimers();
    const host = makeHost({ hasRunningBackground: () => true });
    const notifier = new BgNotifier(host);
    notifier.notify(makeRecord());
    expect(host.sendMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(host.sendMessage).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("sends with triggerTurn + followUp", () => {
    const host = makeHost();
    const notifier = new BgNotifier(host);
    notifier.notify(makeRecord());
    expect(host.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: expect.any(String), display: true }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  it("merges multiple records in window when running background", () => {
    vi.useFakeTimers();
    const host = makeHost({ hasRunningBackground: () => true });
    const notifier = new BgNotifier(host);
    notifier.notify(makeRecord({ id: "bg-1", agent: "worker" }));
    notifier.notify(makeRecord({ id: "bg-2", agent: "reviewer" }));
    expect(host.sendMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(host.sendMessage).toHaveBeenCalledTimes(1);
    const call = host.sendMessage.mock.calls[0][0] as { details: unknown };
    expect(call.details).toEqual({ batch: true, items: expect.any(Array) });
    vi.useRealTimers();
  });

  it("immediate flush when last running background completes", () => {
    let running = true;
    const host = makeHost({ hasRunningBackground: () => running });
    const notifier = new BgNotifier(host);
    notifier.notify(makeRecord({ id: "bg-1" }));
    running = false;
    notifier.notify(makeRecord({ id: "bg-2" }));
    // bg-2 triggers immediate flush of pending [bg-1, bg-2]
    expect(host.sendMessage).toHaveBeenCalledTimes(1);
    const call = host.sendMessage.mock.calls[0][0] as { details: unknown };
    expect(call.details).toEqual({ batch: true, items: expect.any(Array) });
  });

  it("deduplicates same id within TTL", () => {
    vi.useFakeTimers();
    const host = makeHost();
    const notifier = new BgNotifier(host);
    const record = makeRecord({ id: "bg-1" });
    notifier.notify(record);
    notifier.notify(record);
    // dedup blocks duplicate, only 1 message
    expect(host.sendMessage).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  // ============================================================
  // dispose / revive
  // ============================================================
  it("dispose prevents further notifications", () => {
    const host = makeHost();
    const notifier = new BgNotifier(host);
    notifier.dispose();
    notifier.notify(makeRecord());
    expect(host.sendMessage).not.toHaveBeenCalled();
  });

  it("revive re-enables notifications after dispose", () => {
    const host = makeHost();
    const notifier = new BgNotifier(host);
    notifier.dispose();
    notifier.revive();
    notifier.notify(makeRecord());
    expect(host.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("flushPendingNotifications sends pending immediately", () => {
    vi.useFakeTimers();
    const host = makeHost({ hasRunningBackground: () => true });
    const notifier = new BgNotifier(host);
    notifier.notify(makeRecord({ id: "bg-1" }));
    expect(host.sendMessage).not.toHaveBeenCalled();
    notifier.flushPendingNotifications();
    expect(host.sendMessage).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("dispose clears pending and timer", () => {
    vi.useFakeTimers();
    const host = makeHost({ hasRunningBackground: () => true });
    const notifier = new BgNotifier(host);
    notifier.notify(makeRecord({ id: "bg-1" }));
    notifier.dispose();
    vi.advanceTimersByTime(60_000);
    expect(host.sendMessage).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // ============================================================
  // content / details
  // ============================================================
  it("content includes FULL result (no truncation) for done", () => {
    const host = makeHost();
    const notifier = new BgNotifier(host);
    const longResult = "x".repeat(500);
    notifier.notify(makeRecord({ id: "bg-7", agent: "worker", result: longResult }));
    const call = host.sendMessage.mock.calls[0][0] as { content: string; details: unknown };
    expect(call.content).toContain("worker");
    expect(call.content).toContain("bg-7");
    expect(call.content).toContain("x".repeat(500));
  });

  it("content includes error for failed", () => {
    const host = makeHost();
    const notifier = new BgNotifier(host);
    notifier.notify(makeRecord({ id: "bg-8", agent: "scout", status: "failed", error: "exploded" }));
    const call = host.sendMessage.mock.calls[0][0] as { content: string };
    expect(call.content).toContain("exploded");
  });

  it("content shows cancelled for cancelled status", () => {
    const host = makeHost();
    const notifier = new BgNotifier(host);
    notifier.notify(makeRecord({ id: "bg-9", agent: "w", status: "cancelled" }));
    const call = host.sendMessage.mock.calls[0][0] as { content: string };
    expect(call.content).toContain("cancelled");
  });

  it("details is the raw BgNotifyRecord", () => {
    const host = makeHost();
    const notifier = new BgNotifier(host);
    const rec = makeRecord({ id: "bg-9", agent: "w", result: "x".repeat(500) });
    notifier.notify(rec);
    const call = host.sendMessage.mock.calls[0][0] as { details: unknown };
    expect(call.details).toEqual(rec);
  });
});
