// 测试框架：vitest
// 运行命令：npx vitest run src/engine/models/__tests__/run-runtime.test.ts

import { describe, expect, it, vi } from "vitest";

import { ConcurrencyGate } from "../../../infra/concurrency-gate.js";
import type { WorkerHandle } from "../../../infra/worker-handle.js";
import { RunRuntime } from "../run-runtime.js";

// ── Stub factories ───────────────────────────────────────────

/**
 * Stub WorkerHandle: implements the WorkerHandle surface as a class so the
 * RunRuntime (which only calls worker.terminate in release) can be tested
 * without spinning up a real node:worker_threads Worker.
 */
class StubWorkerHandle {
  isCurrent = true;
  terminate = vi.fn(async () => undefined);
  postMessage = vi.fn();
  onMessage = vi.fn(() => this);
  onError = vi.fn(() => this);
  onExit = vi.fn(() => this);
  get raw(): never {
 // RunRuntime never accesses .raw; satisfy the type only.
 // eslint-disable-next-line taste/no-unsafe-cast
    return null as never;
  }
}

/** Test-facing handle with spied terminate, cast to WorkerHandle for RunRuntime. */
function createStubWorkerHandle(): WorkerHandle {
 // Single concentrated cast — StubWorkerHandle structurally satisfies the
 // WorkerHandle surface RunRuntime uses (terminate/isCurrent). The `raw` getter
 // is unreachable in release so the null-coercion is harmless.
 // eslint-disable-next-line taste/no-unsafe-cast
  return new StubWorkerHandle() as unknown as WorkerHandle;
}

/** Spy accessor (read terminate call count) — recovers the spied instance. */
function spyTerminate(handle: WorkerHandle): ReturnType<typeof vi.fn> {
 // eslint-disable-next-line taste/no-unsafe-cast
  return (handle as unknown as StubWorkerHandle).terminate;
}

// ═══════════════════════════════════════════════════════════════

describe("RunRuntime", () => {
 // ── Construction ───────────────────────────────────────────

  describe("construction", () => {
    it("holds worker / gate / controller references", () => {
      const worker = createStubWorkerHandle();
      const gate = new ConcurrencyGate();
      const controller = new AbortController();
      const rt = new RunRuntime(worker, gate, controller);

      expect(rt.worker).toBe(worker);
      expect(rt.gate).toBe(gate);
      expect(rt.controller).toBe(controller);
    });

    it("isReleased is false initially", () => {
      const rt = new RunRuntime(
        createStubWorkerHandle(),
        new ConcurrencyGate(),
        new AbortController(),
      );
      expect(rt.isReleased).toBe(false);
    });
  });

 // ── release — idempotency ──────────────────────────────────

  describe("release — idempotency", () => {
    it("terminates the worker on release (pause mode)", () => {
      const worker = createStubWorkerHandle();
      const rt = new RunRuntime(worker, new ConcurrencyGate(), new AbortController());

      rt.release("pause");

      expect(spyTerminate(worker)).toHaveBeenCalledTimes(1);
      expect(rt.isReleased).toBe(true);
    });

    it("terminates the worker on release (terminal mode)", () => {
      const worker = createStubWorkerHandle();
      const rt = new RunRuntime(worker, new ConcurrencyGate(), new AbortController());

      rt.release("terminal");

      expect(spyTerminate(worker)).toHaveBeenCalledTimes(1);
      expect(rt.isReleased).toBe(true);
    });

    it("is idempotent — second release call is no-op", () => {
      const worker = createStubWorkerHandle();
      const rt = new RunRuntime(worker, new ConcurrencyGate(), new AbortController());

      rt.release("pause");
      rt.release("pause");
      rt.release("terminal");

 // worker.terminate called exactly once despite 3 release calls
      expect(spyTerminate(worker)).toHaveBeenCalledTimes(1);
      expect(rt.isReleased).toBe(true);
    });

    it("mixed-mode releases still only fire once", () => {
      const worker = createStubWorkerHandle();
      const rt = new RunRuntime(worker, new ConcurrencyGate(), new AbortController());

      rt.release("pause");
      rt.release("terminal");

      expect(spyTerminate(worker)).toHaveBeenCalledTimes(1);
    });
  });

 // ── release — controller abort ─────────────────────────────

  describe("release — controller abort", () => {
    it("aborts the controller on release", () => {
      const controller = new AbortController();
      const rt = new RunRuntime(createStubWorkerHandle(), new ConcurrencyGate(), controller);

      expect(controller.signal.aborted).toBe(false);
      rt.release("pause");
      expect(controller.signal.aborted).toBe(true);
    });

    it("does not abort before release", () => {
      const controller = new AbortController();
      const rt = new RunRuntime(createStubWorkerHandle(), new ConcurrencyGate(), controller);

      expect(controller.signal.aborted).toBe(false);
      expect(rt.isReleased).toBe(false);
    });

    it("controller.signal.aborted stays true after multiple releases", () => {
      const controller = new AbortController();
      const rt = new RunRuntime(createStubWorkerHandle(), new ConcurrencyGate(), controller);

      rt.release("pause");
      rt.release("terminal");
      expect(controller.signal.aborted).toBe(true);
    });
  });

 // ── release — fire-once semantics for listener chain ──────

  describe("release — listener chain", () => {
    it("controller abort fires registered listeners exactly once", () => {
      const controller = new AbortController();
      const rt = new RunRuntime(createStubWorkerHandle(), new ConcurrencyGate(), controller);

      const listener = vi.fn();
      controller.signal.addEventListener("abort", listener);

      rt.release("pause");
      rt.release("pause");

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

 // ── Mode equivalence (G3-001 comment) ─────────────────────

  describe("mode equivalence", () => {
    it("pause and terminal both fully release resources (semantic equivalence)", () => {
      const worker1 = createStubWorkerHandle();
      const controller1 = new AbortController();
      const rt1 = new RunRuntime(worker1, new ConcurrencyGate(), controller1);
      rt1.release("pause");

      const worker2 = createStubWorkerHandle();
      const controller2 = new AbortController();
      const rt2 = new RunRuntime(worker2, new ConcurrencyGate(), controller2);
      rt2.release("terminal");

 // Both modes terminate worker + abort controller
      expect(spyTerminate(worker1)).toHaveBeenCalledTimes(1);
      expect(spyTerminate(worker2)).toHaveBeenCalledTimes(1);
      expect(controller1.signal.aborted).toBe(true);
      expect(controller2.signal.aborted).toBe(true);
      expect(rt1.isReleased).toBe(true);
      expect(rt2.isReleased).toBe(true);
    });
  });

 // ── G3-001 discard semantics ──────────────────────────────

  describe("G3-001 — discard after release", () => {
    it("a released runtime is meant to be discarded (not reused)", () => {
      const worker = createStubWorkerHandle();
      const rt = new RunRuntime(worker, new ConcurrencyGate(), new AbortController());

      rt.release("pause");
      expect(rt.isReleased).toBe(true);

 // Caller (WorkflowRun.releaseRuntime) sets runtime=undefined after this.
 // Resume creates a new RunRuntime via assignRuntime(new RunRuntime(...)).
 // The old instance lingers for GC but its callbacks are no-ops (WorkerHandle
 // isCurrent guard) and controller is one-shot aborted.
      expect(spyTerminate(worker)).toHaveBeenCalledTimes(1);
    });
  });
});
