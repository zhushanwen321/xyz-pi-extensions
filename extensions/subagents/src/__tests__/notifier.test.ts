// src/__tests__/notifier.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BgNotifyRecord, NotifierHost } from "../runtime/notifier.ts";
import { BgNotifier } from "../runtime/notifier.ts";

// ── 常量（与源码对齐）──
const MERGE_WINDOW_MS = 2000;
const DEDUP_TTL_MS = 5000;

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
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ============================================================
  // immediate flush when no background running
  // ============================================================
  describe("immediate flush (hasRunningBackground === false)", () => {
    it("sends immediately when no background running", () => {
      const host = makeHost({ hasRunningBackground: () => false });
      const notifier = new BgNotifier(host);
      notifier.notify(makeRecord());
      expect(host.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("sends immediately with triggerTurn + followUp", () => {
      const host = makeHost();
      const notifier = new BgNotifier(host);
      notifier.notify(makeRecord());
      expect(host.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ customType: expect.any(String), display: true }),
        { triggerTurn: true, deliverAs: "followUp" },
      );
    });
  });

  // ============================================================
  // sliding window merge (hasRunningBackground === true)
  // ============================================================
  describe("sliding window merge (hasRunningBackground === true)", () => {
    it("defers notification when background is running", () => {
      const host = makeHost({ hasRunningBackground: () => true });
      const notifier = new BgNotifier(host);
      notifier.notify(makeRecord({ id: "bg-1" }));
      expect(host.sendMessage).not.toHaveBeenCalled();

      vi.advanceTimersByTime(MERGE_WINDOW_MS);
      expect(host.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("merges multiple records into one sendMessage after window", () => {
      const host = makeHost({ hasRunningBackground: () => true });
      const notifier = new BgNotifier(host);
      notifier.notify(makeRecord({ id: "bg-1", agent: "worker" }));
      notifier.notify(makeRecord({ id: "bg-2", agent: "reviewer" }));

      // not sent yet
      expect(host.sendMessage).not.toHaveBeenCalled();
      vi.advanceTimersByTime(MERGE_WINDOW_MS);

      expect(host.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("resets the timer on each new notify (sliding window)", () => {
      const host = makeHost({ hasRunningBackground: () => true });
      const notifier = new BgNotifier(host);
      notifier.notify(makeRecord({ id: "bg-1" }));
      vi.advanceTimersByTime(MERGE_WINDOW_MS - 100); // almost fired
      notifier.notify(makeRecord({ id: "bg-2" })); // resets timer

      vi.advanceTimersByTime(MERGE_WINDOW_MS - 100); // would have fired if not reset
      expect(host.sendMessage).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100); // now full window elapsed since last notify
      expect(host.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // dedup (TTL)
  // ============================================================
  describe("dedup", () => {
    it("suppresses duplicate notify for same id within DEDUP_TTL_MS", () => {
      const host = makeHost({ hasRunningBackground: () => false });
      const notifier = new BgNotifier(host);
      const record = makeRecord({ id: "bg-1" });
      notifier.notify(record); // immediate flush
      expect(host.sendMessage).toHaveBeenCalledTimes(1);

      notifier.notify(record); // deduped
      expect(host.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("allows same id again after DEDUP_TTL_MS", () => {
      const host = makeHost({ hasRunningBackground: () => false });
      const notifier = new BgNotifier(host);
      const record = makeRecord({ id: "bg-1" });
      notifier.notify(record);
      expect(host.sendMessage).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(DEDUP_TTL_MS + 1);
      notifier.notify(record);
      expect(host.sendMessage).toHaveBeenCalledTimes(2);
    });

    it("does not dedup different ids", () => {
      const host = makeHost({ hasRunningBackground: () => false });
      const notifier = new BgNotifier(host);
      notifier.notify(makeRecord({ id: "bg-1" }));
      notifier.notify(makeRecord({ id: "bg-2" }));
      expect(host.sendMessage).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================
  // dispose / revive
  // ============================================================
  describe("dispose / revive", () => {
    it("dispose prevents further notifications", () => {
      const host = makeHost({ hasRunningBackground: () => false });
      const notifier = new BgNotifier(host);
      notifier.dispose();
      notifier.notify(makeRecord());
      expect(host.sendMessage).not.toHaveBeenCalled();
    });

    it("dispose clears pending timer", () => {
      const host = makeHost({ hasRunningBackground: () => true });
      const notifier = new BgNotifier(host);
      notifier.notify(makeRecord({ id: "bg-1" }));
      notifier.dispose();
      vi.advanceTimersByTime(MERGE_WINDOW_MS * 2);
      expect(host.sendMessage).not.toHaveBeenCalled();
    });

    it("revive re-enables notifications after dispose", () => {
      const host = makeHost({ hasRunningBackground: () => false });
      const notifier = new BgNotifier(host);
      notifier.dispose();
      notifier.revive();
      notifier.notify(makeRecord());
      expect(host.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("dispose clears dedup map (M2 fix — no stale entries across /resume)", () => {
      const host = makeHost({ hasRunningBackground: () => false });
      const notifier = new BgNotifier(host);
      notifier.notify(makeRecord({ id: "bg-1" })); // populates dedup
      expect(host.sendMessage).toHaveBeenCalledTimes(1);
      notifier.dispose();
      // revive 后同 id 应能再次通知（dedup 已清）
      notifier.revive();
      notifier.notify(makeRecord({ id: "bg-1" }));
      expect(host.sendMessage).toHaveBeenCalledTimes(2);
    });

    it("flushPendingNotifications is a no-op when empty", () => {
      const host = makeHost();
      const notifier = new BgNotifier(host);
      notifier.flushPendingNotifications();
      expect(host.sendMessage).not.toHaveBeenCalled();
    });

    it("flushPendingNotifications sends pending batch immediately", () => {
      const host = makeHost({ hasRunningBackground: () => true });
      const notifier = new BgNotifier(host);
      notifier.notify(makeRecord({ id: "bg-1" }));
      notifier.notify(makeRecord({ id: "bg-2" }));
      notifier.flushPendingNotifications();
      expect(host.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // formatBgCompletionMessage
  // ============================================================
  describe("formatBgCompletionMessage", () => {
    it("includes agent name and id for done", () => {
      const notifier = new BgNotifier(makeHost());
      const msg = notifier.formatBgCompletionMessage(
        makeRecord({ id: "bg-7", agent: "worker", status: "done", result: "all good" }),
      );
      expect(msg).toContain("worker");
      expect(msg).toContain("bg-7");
      expect(msg).toContain("all good");
    });

    it("includes error for failed", () => {
      const notifier = new BgNotifier(makeHost());
      const msg = notifier.formatBgCompletionMessage(
        makeRecord({ id: "bg-8", agent: "scout", status: "failed", error: "exploded" }),
      );
      expect(msg).toContain("exploded");
    });

    it("truncates long result to PREVIEW_MAX", () => {
      const notifier = new BgNotifier(makeHost());
      const longResult = "x".repeat(500);
      const msg = notifier.formatBgCompletionMessage(
        makeRecord({ id: "bg-9", agent: "w", status: "done", result: longResult }),
      );
      // PREVIEW_MAX = 200; message contains at most 200 chars of the result
      expect(msg).not.toContain("x".repeat(201));
      expect(msg).toContain("x".repeat(200));
    });
  });
});
