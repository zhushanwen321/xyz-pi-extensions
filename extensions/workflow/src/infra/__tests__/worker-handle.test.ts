// 测试框架：vitest
// 运行命令：npx vitest run src/infra/__tests__/worker-handle.test.ts

import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkerHandle } from "../worker-handle.js";

// ── Fake Worker ──────────────────────────────────────────────

/**
 * Fake Worker that satisfies the EventEmitter subset WorkerHandle uses.
 * Real Worker adds postMessage/terminate; we stub those here for assertions.
 */
interface FakeWorker extends EventEmitter {
  postMessage: (msg: unknown) => void;
  terminate: () => Promise<number>;
}

function createFakeWorker(): FakeWorker {
  const postMessage = vi.fn();
  const terminate = vi.fn(async () => 1);
  return Object.assign(new EventEmitter(), { postMessage, terminate });
}

/** Cast fake to the type WorkerHandle expects. */
function asWorker(fw: FakeWorker): Worker {
 // eslint-disable-next-line taste/no-unsafe-cast
  return fw as unknown as Worker;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════

describe("WorkerHandle — isCurrent (race guard G-025)", () => {
  it("isCurrent is true before terminate", () => {
    const handle = new WorkerHandle(asWorker(createFakeWorker()));
    expect(handle.isCurrent).toBe(true);
  });

  it("terminate() flips isCurrent to false", async () => {
    const fw = createFakeWorker();
    const handle = new WorkerHandle(asWorker(fw));
    await handle.terminate();
    expect(handle.isCurrent).toBe(false);
  });

  it("terminate() is idempotent (second call no-op)", async () => {
    const fw = createFakeWorker();
    const handle = new WorkerHandle(asWorker(fw));
    await handle.terminate();
    expect(fw.terminate).toHaveBeenCalledTimes(1);
    await handle.terminate();
    expect(fw.terminate).toHaveBeenCalledTimes(1); // not called again
    expect(handle.isCurrent).toBe(false);
  });

  it("terminate() swallows worker.terminate() rejection (current already false)", async () => {
    const fw = createFakeWorker();
    fw.terminate = vi.fn(async () => {
      throw new Error("already exited");
    });
    const handle = new WorkerHandle(asWorker(fw));
 // Must not reject
    await expect(handle.terminate()).resolves.toBeUndefined();
    expect(handle.isCurrent).toBe(false);
  });
});

// ── postMessage ──────────────────────────────────────────────

describe("WorkerHandle — postMessage", () => {
  it("forwards to underlying worker when isCurrent", () => {
    const fw = createFakeWorker();
    const handle = new WorkerHandle(asWorker(fw));
    handle.postMessage({ type: "hello" });
    expect(fw.postMessage).toHaveBeenCalledWith({ type: "hello" });
    expect(fw.postMessage).toHaveBeenCalledTimes(1);
  });

  it("is no-op after terminate", async () => {
    const fw = createFakeWorker();
    const handle = new WorkerHandle(asWorker(fw));
    await handle.terminate();
    handle.postMessage({ type: "stale" });
    expect(fw.postMessage).not.toHaveBeenCalled();
  });
});

// ── Event handlers (G-025 race guard) ────────────────────────

describe("WorkerHandle — onMessage / onError / onExit", () => {
  it("onMessage fires handler when isCurrent", () => {
    const fw = createFakeWorker();
    const handler = vi.fn();
    new WorkerHandle(asWorker(fw)).onMessage(handler);

    fw.emit("message", { type: "agent-call", callId: "c1" });

    expect(handler).toHaveBeenCalledWith({ type: "agent-call", callId: "c1" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("onMessage handler is NOT called after terminate (stale event ignored)", async () => {
    const fw = createFakeWorker();
    const handler = vi.fn();
    const handle = new WorkerHandle(asWorker(fw)).onMessage(handler);

    await handle.terminate();
    fw.emit("message", { type: "stale" });

    expect(handler).not.toHaveBeenCalled();
  });

  it("onError fires handler when isCurrent", () => {
    const fw = createFakeWorker();
    const handler = vi.fn();
    new WorkerHandle(asWorker(fw)).onError(handler);

    const err = new Error("boom");
    fw.emit("error", err);

    expect(handler).toHaveBeenCalledWith(err);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("onError handler is NOT called after terminate", async () => {
    const fw = createFakeWorker();
    const handler = vi.fn();
    const handle = new WorkerHandle(asWorker(fw)).onError(handler);

    await handle.terminate();
    fw.emit("error", new Error("stale"));

    expect(handler).not.toHaveBeenCalled();
  });

  it("onExit fires handler with code when isCurrent", () => {
    const fw = createFakeWorker();
    const handler = vi.fn();
    new WorkerHandle(asWorker(fw)).onExit(handler);

    fw.emit("exit", 0);

    expect(handler).toHaveBeenCalledWith(0);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("onExit handler is NOT called after terminate (THE G-025 race)", async () => {
 // Race scenario: terminate(old) → startWorker(new) → old exit fires.
 // Without the guard, old exit would be handled as if it's the new worker.
    const fw = createFakeWorker();
    const handler = vi.fn();
    const handle = new WorkerHandle(asWorker(fw)).onExit(handler);

    await handle.terminate();
 // Old worker emits exit AFTER terminate — must be ignored.
    fw.emit("exit", 1);

    expect(handler).not.toHaveBeenCalled();
  });

  it("chained onMessage().onError().onExit() all bind independently", () => {
    const fw = createFakeWorker();
    const msgHandler = vi.fn();
    const errHandler = vi.fn();
    const exitHandler = vi.fn();

    const handle = new WorkerHandle(asWorker(fw))
      .onMessage(msgHandler)
      .onError(errHandler)
      .onExit(exitHandler);

    fw.emit("message", "m");
    fw.emit("error", new Error("e"));
    fw.emit("exit", 0);

    expect(msgHandler).toHaveBeenCalledTimes(1);
    expect(errHandler).toHaveBeenCalledTimes(1);
    expect(exitHandler).toHaveBeenCalledTimes(1);

 // After terminate, ALL handlers go silent
    void handle.terminate();
  });
});

// ── raw accessor ─────────────────────────────────────────────

describe("WorkerHandle — raw accessor", () => {
  it("exposes the underlying Worker for direct access", () => {
    const fw = createFakeWorker();
    const handle = new WorkerHandle(asWorker(fw));
 // Identity preserved (cast back to FakeWorker for assertion)
    expect(handle.raw).toBe(fw);
  });
});

// ── Multi-handle scenario (real G-025 reproduction) ─────────

describe("WorkerHandle — multi-handle race (G-025 end-to-end)", () => {
  it("old handle's exit does not fire when new handle is current", async () => {
 // Simulate: WorkerHost creates handle A → terminate A → creates handle B
 // → A's worker emits a delayed exit. B's exit handler should be unaffected.
    const workerA = createFakeWorker();
    const workerB = createFakeWorker();

    const handleA = new WorkerHandle(asWorker(workerA));
    const exitCalls: string[] = [];
    handleA.onExit(() => exitCalls.push("A"));

 // Terminate A (e.g. on pause)
    await handleA.terminate();
    expect(handleA.isCurrent).toBe(false);

 // New handle B for resume
    const handleB = new WorkerHandle(asWorker(workerB));
    handleB.onExit(() => exitCalls.push("B"));
    expect(handleB.isCurrent).toBe(true);

 // A's worker emits a delayed exit — MUST be ignored (stale)
    workerA.emit("exit", 1);
 // B's worker emits exit — MUST be processed
    workerB.emit("exit", 0);

    expect(exitCalls).toEqual(["B"]);
  });

  it("postMessage on old handle does not reach its worker after terminate", async () => {
    const workerA = createFakeWorker();
    const handleA = new WorkerHandle(asWorker(workerA));

    await handleA.terminate();
    handleA.postMessage({ type: "would-be-stale" });

    expect(workerA.postMessage).not.toHaveBeenCalled();
  });
});
