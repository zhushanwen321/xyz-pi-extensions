import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BgNotifier, type BgNotifyRecord } from "../persistence/bg-notifier.ts";
import { getGlobalSeenMap } from "../persistence/completion-dedupe.ts";

function makeRecord(overrides: Partial<BgNotifyRecord> = {}): BgNotifyRecord {
  return {
    id: overrides.id ?? "bg-1",
    status: overrides.status ?? "done",
    agent: overrides.agent ?? "coder",
    result: overrides.result ?? { text: "Done!", sessionFile: "/tmp/session.json" },
    startedAt: overrides.startedAt ?? Date.now() - 1000,
    ...overrides,
  };
}

function makePi() {
  return {
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
}

describe("BgNotifier", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Clear global dedup state between tests
    getGlobalSeenMap("__subagents_bg_notify_seen__").clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("formatBgCompletionMessage: formats single record", () => {
    const pi = makePi();
    const notifier = new BgNotifier(pi);
    const msg = notifier.formatBgCompletionMessage(makeRecord());
    expect(msg).toContain("completed");
    expect(msg).toContain("**coder**");
    expect(msg).toContain("Done!");
    expect(msg).toContain("bg-1");
    expect(msg).toContain("Session file: /tmp/session.json");
  });

  it("formatBgCompletionMessage: truncates long body to 500 chars", () => {
    const pi = makePi();
    const notifier = new BgNotifier(pi);
    const longText = "x".repeat(600);
    const msg = notifier.formatBgCompletionMessage(makeRecord({ result: { text: longText } }));
    expect(msg.length).toBeLessThan(800);
    expect(msg).toContain("...");
  });

  it("formatBgCompletionMessage: shows error when no result text", () => {
    const pi = makePi();
    const notifier = new BgNotifier(pi);
    const msg = notifier.formatBgCompletionMessage(
      makeRecord({ status: "failed", result: undefined, error: "killed" }),
    );
    expect(msg).toContain("failed");
    expect(msg).toContain("killed");
  });

  it("notifyBgCompletion: first event sends immediately", () => {
    const pi = makePi();
    const notifier = new BgNotifier(pi);
    notifier.notifyBgCompletion(makeRecord());
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    // display:false — 静默投递：不渲染紫色块（避免双 block），但仍唤醒主 agent 处理结果。
    const [message, options] = pi.sendMessage.mock.calls[0];
    expect(message).toMatchObject({ customType: "subagent-bg-notify", display: false });
    expect(options).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
  });

  it("notifyBgCompletion: subsequent events within merge window are batched", () => {
    const pi = makePi();
    const notifier = new BgNotifier(pi);
    notifier.notifyBgCompletion(makeRecord({ id: "bg-1" }));
    notifier.notifyBgCompletion(makeRecord({ id: "bg-2" }));
    notifier.notifyBgCompletion(makeRecord({ id: "bg-3" }));
    // Only first sent immediately
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    // Advance past merge window (2000ms)
    vi.advanceTimersByTime(2100);
    // bg-1 sent immediately; bg-2+bg-3 batched = 2 total calls
    expect(pi.sendMessage).toHaveBeenCalledTimes(2);
    const batchCall = pi.sendMessage.mock.calls[1][0];
    expect(batchCall.content).toContain("2 background tasks completed");
  });

  it("notifyBgCompletion: deduplicates by completion key", () => {
    const pi = makePi();
    const notifier = new BgNotifier(pi);
    const record = makeRecord({ id: "bg-1" });
    notifier.notifyBgCompletion(record);
    notifier.notifyBgCompletion(record); // duplicate
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("flushPendingNotifications: sends batch when pending exist", () => {
    const pi = makePi();
    const notifier = new BgNotifier(pi);
    notifier.notifyBgCompletion(makeRecord({ id: "bg-1" }));
    notifier.notifyBgCompletion(makeRecord({ id: "bg-2" }));
    notifier.flushPendingNotifications();
    expect(pi.sendMessage).toHaveBeenCalledTimes(2); // 1 immediate + 1 flush
    const batchCall = pi.sendMessage.mock.calls[1][0];
    expect(batchCall.content).toContain("1 background tasks completed");
    // 合并发送也是静默投递（display:false）
    expect(batchCall).toMatchObject({ customType: "subagent-bg-notify", display: false });
  });

  it("flushPendingNotifications: no-op when no pending", () => {
    const pi = makePi();
    const notifier = new BgNotifier(pi);
    notifier.flushPendingNotifications();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("dispose: clears timer, does not flush pending", () => {
    const pi = makePi();
    const notifier = new BgNotifier(pi);
    notifier.notifyBgCompletion(makeRecord({ id: "bg-1" }));
    notifier.notifyBgCompletion(makeRecord({ id: "bg-2" }));
    notifier.dispose();
    vi.advanceTimersByTime(3000);
    // Only the first immediate send; no flush because disposed
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("dispose: subsequent notify is no-op", () => {
    const pi = makePi();
    const notifier = new BgNotifier(pi);
    notifier.dispose();
    notifier.notifyBgCompletion(makeRecord());
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("revive: restores after dispose, allows new notifications", () => {
    const pi = makePi();
    const notifier = new BgNotifier(pi);
    notifier.dispose();
    notifier.notifyBgCompletion(makeRecord({ id: "bg-1" }));
    expect(pi.sendMessage).not.toHaveBeenCalled();
    notifier.revive();
    notifier.notifyBgCompletion(makeRecord({ id: "bg-2" }));
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("sendSingleNotification: stale runtime first catch → falls back to appendEntry", () => {
    const pi = makePi();
    pi.sendMessage.mockImplementation(() => {
      throw new Error("stale runtime");
    });
    const notifier = new BgNotifier(pi);
    notifier.notifyBgCompletion(makeRecord());
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(pi.appendEntry).toHaveBeenCalledWith("subagent-bg-record", {
      id: "bg-1",
      status: "done",
    });
  });

  it("sendSingleNotification: both layers stale → silently gives up", () => {
    const pi = makePi();
    pi.sendMessage.mockImplementation(() => {
      throw new Error("stale");
    });
    pi.appendEntry.mockImplementation(() => {
      throw new Error("also stale");
    });
    const notifier = new BgNotifier(pi);
    // Should not throw
    notifier.notifyBgCompletion(makeRecord());
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("null pi: no-op without throwing", () => {
    const notifier = new BgNotifier(null);
    // Should not throw
    notifier.notifyBgCompletion(makeRecord());
    notifier.flushPendingNotifications();
    notifier.dispose();
    notifier.revive();
  });

  it("dispose+revive+dispose cycle", () => {
    const pi = makePi();
    const notifier = new BgNotifier(pi);
    notifier.dispose();
    notifier.revive();
    notifier.notifyBgCompletion(makeRecord({ id: "bg-1" }));
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    notifier.dispose();
    notifier.notifyBgCompletion(makeRecord({ id: "bg-2" }));
    // Still only 1 call — bg-2 was disposed
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });
});
