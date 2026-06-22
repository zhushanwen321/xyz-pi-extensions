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
  it("sends immediately regardless of hasRunningBackground", () => {
    const host = makeHost({ hasRunningBackground: () => true });
    const notifier = new BgNotifier(host);
    notifier.notify(makeRecord());
    expect(host.sendMessage).toHaveBeenCalledTimes(1);
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

  it("sends each record as separate message", () => {
    const host = makeHost();
    const notifier = new BgNotifier(host);
    notifier.notify(makeRecord({ id: "bg-1", agent: "worker" }));
    notifier.notify(makeRecord({ id: "bg-2", agent: "reviewer" }));
    expect(host.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("allows duplicate id (no dedup)", () => {
    const host = makeHost();
    const notifier = new BgNotifier(host);
    const record = makeRecord({ id: "bg-1" });
    notifier.notify(record);
    notifier.notify(record);
    expect(host.sendMessage).toHaveBeenCalledTimes(2);
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

  it("flushPendingNotifications is a no-op", () => {
    const host = makeHost();
    const notifier = new BgNotifier(host);
    notifier.flushPendingNotifications();
    expect(host.sendMessage).not.toHaveBeenCalled();
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
