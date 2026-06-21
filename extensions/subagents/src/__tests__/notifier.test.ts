// src/__tests__/notifier.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BgNotifyRecord, NotifierHost } from "../runtime/execution/notifier.ts";
import { BgNotifier } from "../runtime/execution/notifier.ts";

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
  // content / details（取代旧 formatBgCompletionMessage）
  // ============================================================
  // content 进 LLM context，必须含完整 result——旧实现截断到 200 字符，导致
  // AI 看不到完整结果被迫 poll。现在 content 不截断，renderer 靠 details 自己压。
  describe("content / details", () => {
    it("content includes FULL result (no truncation) for done", () => {
      const host = makeHost();
      const notifier = new BgNotifier(host);
      const longResult = "x".repeat(500);
      notifier.notify(makeRecord({ id: "bg-7", agent: "worker", result: longResult }));
      const call = host.sendMessage.mock.calls[0][0] as { content: string; details: unknown };
      expect(call.content).toContain("worker");
      expect(call.content).toContain("bg-7");
      // content 必须含完整 500 字符，不截断
      expect(call.content).toContain("x".repeat(500));
    });

    it("content includes error for failed", () => {
      const host = makeHost();
      const notifier = new BgNotifier(host);
      notifier.notify(makeRecord({ id: "bg-8", agent: "scout", status: "failed", error: "exploded" }));
      const call = host.sendMessage.mock.calls[0][0] as { content: string };
      expect(call.content).toContain("exploded");
    });

    it("details carries full BgNotifyRecord for renderer", () => {
      const host = makeHost();
      const notifier = new BgNotifier(host);
      const longResult = "x".repeat(500);
      const rec = makeRecord({ id: "bg-9", agent: "w", result: longResult });
      notifier.notify(rec);
      const call = host.sendMessage.mock.calls[0][0] as { details: unknown };
      // details 是完整 record，renderer 自己 firstLine + truncLine 压缩
      expect(call.details).toEqual(rec);
    });

    it("batch flush: content merges all full results, details carries items", () => {
      const host = makeHost({ hasRunningBackground: () => true });
      const notifier = new BgNotifier(host);
      notifier.notify(makeRecord({ id: "bg-a", agent: "w1", result: "result-A-full" }));
      notifier.notify(makeRecord({ id: "bg-b", agent: "w2", result: "result-B-full" }));
      notifier.flushPendingNotifications();
      const call = host.sendMessage.mock.calls[0][0] as { content: string; details: unknown };
      expect(call.content).toContain("result-A-full");
      expect(call.content).toContain("result-B-full");
      expect((call.details as { batch: boolean }).batch).toBe(true);
      expect((call.details as { items: unknown[] }).items.length).toBe(2);
    });
  });
});
