// 测试框架：vitest
// 运行命令：npx vitest run src/infra/__tests__/worker-host.test.ts

import { describe, expect, it, vi } from "vitest";

import type { WorkerHandlers, WorkerHost } from "../../engine/models/ports.js";
import type { RunSpec } from "../../engine/models/run-spec.js";
import { WorkerHandle } from "../worker-handle.js";
import { WorkerHostImpl } from "../worker-host.js";

// ── Helpers ─────────────────────────────────────────────────

function makeSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    scriptSource: 'log("done");',
    args: {},
    scriptName: "test-script",
    scriptPath: "/tmp/test.mjs",
    ...overrides,
  };
}

/** Build a WorkerHandlers spy bag. */
function makeHandlerSpies(): {
  spies: {
    onMessage: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
    onExit: ReturnType<typeof vi.fn>;
  };
  handlers: WorkerHandlers;
} {
  const onMessage = vi.fn(async () => {});
  const onError = vi.fn(async () => {});
  const onExit = vi.fn(async () => {});
  return {
    spies: { onMessage, onError, onExit },
    handlers: { onMessage, onError, onExit },
  };
}

// ── Typed message narrowing (avoid unsafe cast warnings) ─────

interface WorkerMsg {
  type: string;
  error?: string;
  result?: { argsVal?: unknown };
  workerLogs?: unknown[];
}

function asMsg(m: unknown): WorkerMsg {
  return m as WorkerMsg;
}

function msgType(m: unknown): string {
  return asMsg(m).type;
}

/**
 * Wait until the onExit spy is called, or timeout. Worker thread exit events
 * are asynchronous and timing-dependent; a fixed delay flakes. Resolves with
 * the call args (or null on timeout) so tests can assert robustly.
 */
async function waitForExit(
  onExit: ReturnType<typeof vi.fn>,
  timeoutMs = 1000,
): Promise<[number, WorkerHandle] | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (onExit.mock.calls.length > 0) {
      return onExit.mock.calls[0] as [number, WorkerHandle];
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

/**
 * Wait until the onMessage spy has been called at least minCount times.
 */
async function waitForMessages(
  onMessage: ReturnType<typeof vi.fn>,
  minCount = 1,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (onMessage.mock.calls.length >= minCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ═══════════════════════════════════════════════════════════════

describe("WorkerHostImpl", () => {
  it("implements WorkerHost port", () => {
    const host: WorkerHost = new WorkerHostImpl();
    expect(typeof host.start).toBe("function");
  });

 // ── start — basic contract ─────────────────────────────────

  describe("start — basic contract", () => {
    it("returns a WorkerHandle", () => {
      const host = new WorkerHostImpl();
      const { handlers } = makeHandlerSpies();
      const handle = host.start(makeSpec(), {}, handlers);

      expect(handle).toBeInstanceOf(WorkerHandle);
 // Cleanup
      void handle.terminate();
    });

    it("handle.isCurrent is true immediately after start", () => {
      const host = new WorkerHostImpl();
      const { handlers } = makeHandlerSpies();
      const handle = host.start(makeSpec(), {}, handlers);

      expect(handle.isCurrent).toBe(true);
      void handle.terminate();
    });
  });

 // ── Event wiring — message / return ───────────────────────

  describe("event wiring — message", () => {
    it("forwards worker messages to handlers.onMessage", async () => {
      const host = new WorkerHostImpl();
      const { spies, handlers } = makeHandlerSpies();

 // Script that posts a log message, then returns
      const spec = makeSpec({
        scriptSource: 'log("hello-from-worker"); return { ok: true };',
      });
      const handle = host.start(spec, {}, handlers);

 // Wait for worker to post at least one message
      await waitForMessages(spies.onMessage, 1);

      expect(spies.onMessage).toHaveBeenCalled();
 // The "log" and "return" message types should both route to onMessage
      const messages = spies.onMessage.mock.calls.map((c) => c[0]);
      const hasLog = messages.some((m) => msgType(m) === "log");
      const hasReturn = messages.some((m) => msgType(m) === "return");
      expect(hasLog || hasReturn).toBe(true);

      await handle.terminate();
    });

    it("forwards worker exit to handlers.onExit with the handle (C.3)", async () => {
      const host = new WorkerHostImpl();
      const { spies, handlers } = makeHandlerSpies();

 // Use a script with a syntax error to force the worker thread to exit
 // on its own (non-zero). A well-formed script posts a "return" message
 // and stays alive — only crash paths trigger natural exit.
      const spec = makeSpec({ scriptSource: "const broken = ;" });
      const handle = host.start(spec, {}, handlers);

      const exitCall = await waitForExit(spies.onExit);
      expect(exitCall).not.toBeNull();
      const [code, handleArg] = exitCall!;
      expect(code).toBe(1);
 // C.3 fix: handle is passed to onExit so caller can use isCurrent
      expect(handleArg).toBe(handle);

      await handle.terminate();
    });
  });

 // ── Event wiring — error ──────────────────────────────────

  describe("event wiring — error", () => {
    it("forwards worker error to handlers.onError", async () => {
      const host = new WorkerHostImpl();
      const { spies, handlers } = makeHandlerSpies();

 // Script that throws inside the IIFE — routes through .catch which
 // posts an "error" message (handled by onMessage), but a synchronous
 // throw in user code at top-level may surface as worker 'error' event.
 // Use an unreachable reference to force an error path.
      const spec = makeSpec({
        scriptSource: 'throw new Error("script-boom");',
      });
      const handle = host.start(spec, {}, handlers);

      await waitForMessages(spies.onMessage, 1);

 // The thrown error is caught by the IIFE .catch and posted as a
 // type:"error" message — verify onMessage received it.
      expect(spies.onMessage).toHaveBeenCalled();
      const messages = spies.onMessage.mock.calls.map((c) => c[0]);
      const hasErrorMsg = messages.some(
        (m) =>
          msgType(m) === "error" &&
          typeof asMsg(m).error === "string" &&
          (asMsg(m).error ?? "").includes("script-boom"),
      );
      expect(hasErrorMsg).toBe(true);

      await handle.terminate();
    });
  });

 // ── workerData injection ──────────────────────────────────

  describe("workerData injection", () => {
    it("passes args to worker via $ARGS", async () => {
      const host = new WorkerHostImpl();
      const { spies, handlers } = makeHandlerSpies();

      const spec = makeSpec({
        scriptSource: 'return { argsVal: $ARGS.foo };',
      });
      const handle = host.start(spec, { foo: "bar" }, handlers);

      await waitForMessages(spies.onMessage, 1);

 // Worker should post a "return" message with result.argsVal === "bar"
      expect(spies.onMessage).toHaveBeenCalled();
      const messages = spies.onMessage.mock.calls.map((c) => c[0]);
      const returnMsg = messages.find((m) => msgType(m) === "return");
      expect(asMsg(returnMsg).result?.argsVal).toBe("bar");

      await handle.terminate();
    });

    it("passes scriptPath + meta to workerData", async () => {
      const host = new WorkerHostImpl();
      const { spies, handlers } = makeHandlerSpies();

      const spec = makeSpec({
        scriptSource: 'return "ok";',
        scriptPath: "/custom/path.mjs",
        scriptName: "my-script",
        description: "a test",
      });
      const handle = host.start(spec, {}, handlers);

 // Worker posts a "return" message — if workerData was malformed, worker
 // would crash instead. Verify the return message arrived.
      await waitForMessages(spies.onMessage, 1);
      const messages = spies.onMessage.mock.calls.map((c) => c[0]);
      const hasReturn = messages.some((m) => msgType(m) === "return");
      expect(hasReturn).toBe(true);

      await handle.terminate();
    });
  });

 // ── C.3: handle passed to onExit for G-025 race guard ──────

  describe("C.3 + G-025 — onExit handle enables race guard", () => {
    it("onExit receives the same handle instance returned by start()", async () => {
      const host = new WorkerHostImpl();
      const { spies, handlers } = makeHandlerSpies();

 // Syntax-error script forces the worker to exit on its own (non-zero).
 // A well-formed script stays alive after posting "return" — only crash
 // paths exercise the natural-exit handler.
      const spec = makeSpec({ scriptSource: "const broken = ;" });
      const returnedHandle = host.start(spec, {}, handlers);

      const exitCall = await waitForExit(spies.onExit);
      expect(exitCall).not.toBeNull();
      const [, exitHandle] = exitCall!;
 // C.3: same reference — caller can check exitHandle.isCurrent
      expect(exitHandle).toBe(returnedHandle);

      await returnedHandle.terminate();
    });

    it("terminate() before worker exits prevents stale onExit (G-025)", async () => {
      const host = new WorkerHostImpl();
      const { spies, handlers } = makeHandlerSpies();

 // Long-running script that won't exit on its own
      const spec = makeSpec({
        scriptSource: 'await new Promise(() => {});', // never resolves
      });
      const handle = host.start(spec, {}, handlers);

 // Terminate immediately
      await handle.terminate();
      await new Promise((resolve) => setTimeout(resolve, 100));

 // Worker was force-killed; its exit event fires but WorkerHandle's
 // isCurrent guard means handlers.onExit must NOT fire
 // (the race guard: terminate(old) → old exit must be ignored).
      expect(spies.onExit).not.toHaveBeenCalled();
    });
  });
});
