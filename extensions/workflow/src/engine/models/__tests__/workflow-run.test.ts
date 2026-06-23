// 测试框架：vitest
// 运行命令：npx vitest run src/engine/models/__tests__/workflow-run.test.ts

import { describe, expect, it, vi } from "vitest";

import { ConcurrencyGate } from "../../../infra/concurrency-gate.js";
import type { WorkerHandle } from "../../../infra/worker-handle.js";
import type { AgentCall } from "../agent-call.js";
import { Budget } from "../budget.js";
import { RunRuntime } from "../run-runtime.js";
import { Trace } from "../trace.js";
import { WorkflowRun } from "../workflow-run.js";

// ── Stub factories ───────────────────────────────────────────

/**
 * Stub WorkerHandle — RunRuntime.release only calls worker.terminate.
 */
class StubWorkerHandle {
  isCurrent = true;
  terminate = vi.fn(async () => undefined);
  postMessage = vi.fn();
  onMessage = vi.fn(() => this);
  onError = vi.fn(() => this);
  onExit = vi.fn(() => this);
  get raw(): never {
 // eslint-disable-next-line taste/no-unsafe-cast
    return null as never;
  }
}

/** Cast stub to WorkerHandle (single concentrated cast). */
function stubHandle(): WorkerHandle {
 // eslint-disable-next-line taste/no-unsafe-cast
  return new StubWorkerHandle() as unknown as WorkerHandle;
}

/** Read terminate spy from a stub-cast handle. */
function spyTerminate(h: WorkerHandle): ReturnType<typeof vi.fn> {
 // eslint-disable-next-line taste/no-unsafe-cast
  return (h as unknown as StubWorkerHandle).terminate;
}

/** Build a fresh RunRuntime with stubbed worker. */
function makeRuntime(): { rt: RunRuntime; handle: WorkerHandle } {
  const handle = stubHandle();
  const rt = new RunRuntime(handle, new ConcurrencyGate(), new AbortController());
  return { rt, handle };
}

/** Minimal RunSpec for tests. */
function makeSpec(): {
  scriptSource: string;
  args: Record<string, unknown>;
  scriptName: string;
  scriptPath: string;
} {
  return {
    scriptSource: 'return "ok";',
    args: {},
    scriptName: "test",
    scriptPath: "/tmp/test.mjs",
  };
}

/** Build a fresh WorkflowRun in "paused" state (no runtime). */
function makePausedRun(runId = "run-1"): WorkflowRun {
  return new WorkflowRun(runId, makeSpec(), {
    status: "paused",
    budget: new Budget(),
    calls: new Map<number, AgentCall>(),
    trace: new Trace(),
    errorLogs: [],
  }, {
    startedAt: new Date().toISOString(),
  });
}

// ═══════════════════════════════════════════════════════════════

describe("WorkflowRun — construction", () => {
  it("constructs in paused state with no runtime", () => {
    const run = makePausedRun();
    expect(run.state.status).toBe("paused");
    expect(run.runtime).toBeUndefined();
    expect(run.runId).toBe("run-1");
    expect(run.spec.scriptName).toBe("test");
  });

  it("constructs with done state for reconstructed runs (loadAll)", () => {
    const run = new WorkflowRun("r-done", makeSpec(), {
      status: "done",
      reason: "completed",
      budget: new Budget(),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
      scriptResult: { ok: true },
    }, { startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:01:00.000Z" });
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("completed");
    expect(run.runtime).toBeUndefined();
  });

  it("meta defaults: startedAt set, completedAt/pausedAt/counts undefined", () => {
    const run = makePausedRun();
    expect(run.meta.startedAt).toBeDefined();
    expect(run.meta.completedAt).toBeUndefined();
    expect(run.meta.pausedAt).toBeUndefined();
    expect(run.meta.workerErrorCount).toBeUndefined();
    expect(run.meta.scriptErrorCount).toBeUndefined();
  });
});

// ── Invariant I1: status==="running" ⟺ runtime!==undefined ──

describe("Invariant I1: status==='running' ⟺ runtime!==undefined", () => {
  it("constructor throws if status==='running' but runtime undefined", () => {
    expect(() => new WorkflowRun("r-bad", makeSpec(), {
      status: "running",
      budget: new Budget(),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    }, { startedAt: new Date().toISOString() })).toThrow(/I1.*running.*undefined/);
  });

  it("paused state has runtime===undefined (consistent)", () => {
    const run = makePausedRun();
    expect(run.state.status).toBe("paused");
    expect(run.runtime).toBeUndefined();
  });

  it("done state has runtime===undefined (consistent)", () => {
    const run = new WorkflowRun("r", makeSpec(), {
      status: "done",
      reason: "aborted",
      budget: new Budget(),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    }, { startedAt: "2026-01-01T00:00:00.000Z" });
    expect(run.runtime).toBeUndefined();
  });
});

// ── Invariant I2: status==="done" ⟹ reason!==undefined ──────

describe("Invariant I2: status==='done' ⟹ reason!==undefined", () => {
  it("constructor throws if status==='done' but reason undefined", () => {
    expect(() => new WorkflowRun("r-bad", makeSpec(), {
      status: "done",
      budget: new Budget(),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    }, { startedAt: new Date().toISOString() })).toThrow(/I2.*done.*reason/);
  });

  it("done state requires reason at construction (reconstructed run)", () => {
    for (const reason of ["completed", "failed", "aborted", "budget_limited", "time_limited"] as const) {
      const run = new WorkflowRun(`r-${reason}`, makeSpec(), {
        status: "done",
        reason,
        budget: new Budget(),
        calls: new Map(),
        trace: new Trace(),
        errorLogs: [],
      }, { startedAt: "2026-01-01T00:00:00.000Z" });
      expect(run.state.reason).toBe(reason);
    }
  });
});

// ── assignRuntime (paused → running) ────────────────────────

describe("assignRuntime (paused → running)", () => {
  it("binds runtime and transitions to running", () => {
    const run = makePausedRun();
    const { rt } = makeRuntime();
    run.assignRuntime(rt);

    expect(run.runtime).toBe(rt);
    expect(run.state.status).toBe("running");
  });

  it("throws if runtime already defined (double assign)", () => {
    const run = makePausedRun();
    const { rt: rt1 } = makeRuntime();
    run.assignRuntime(rt1);

    const { rt: rt2 } = makeRuntime();
    expect(() => run.assignRuntime(rt2)).toThrow(/already defined/);
  });

  it("throws if status !== 'paused'", () => {
 // Construct a done run (no runtime)
    const run = new WorkflowRun("r", makeSpec(), {
      status: "done",
      reason: "completed",
      budget: new Budget(),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    }, { startedAt: "2026-01-01T00:00:00.000Z" });
    const { rt } = makeRuntime();
    expect(() => run.assignRuntime(rt)).toThrow(/requires status.*paused/);
  });

  it("maintains invariant I1 after assign (no intermediate visible state)", () => {
    const run = makePausedRun();
    const { rt } = makeRuntime();
 // After assignRuntime: status="running" AND runtime!==undefined (I1 holds)
    run.assignRuntime(rt);
    expect(run.state.status).toBe("running");
    expect(run.runtime).toBe(rt);
  });
});

// ── releaseRuntime ──────────────────────────────────────────

describe("releaseRuntime", () => {
  it("releases worker + aborts controller and clears runtime", () => {
    const run = makePausedRun();
    const { rt, handle } = makeRuntime();
    run.assignRuntime(rt);

    run.releaseRuntime();

    expect(spyTerminate(handle)).toHaveBeenCalledTimes(1);
    expect(run.runtime).toBeUndefined();
  });

  it("is no-op when runtime is already undefined (idempotent)", () => {
    const run = makePausedRun();
 // runtime is undefined; releaseRuntime should not throw
    expect(() => run.releaseRuntime()).not.toThrow();
    expect(run.runtime).toBeUndefined();
  });
});

// ── transition — paused → running rejected ─────────────────

describe("transition('running') is rejected", () => {
  it("throws — caller must use assignRuntime instead", () => {
    const run = makePausedRun();
    expect(() => run.transition("running")).toThrow(/use assignRuntime/);
  });
});

// ── transition — running → paused (G3-001) ─────────────────

describe("transition running → paused (G3-001)", () => {
  it("transitions to paused and releases runtime", () => {
    const run = makePausedRun();
    const { rt, handle } = makeRuntime();
    run.assignRuntime(rt);

    run.transition("paused");

    expect(run.state.status).toBe("paused");
    expect(run.runtime).toBeUndefined(); // G3-001: runtime discarded
    expect(spyTerminate(handle)).toHaveBeenCalledTimes(1);
  });

  it("sets meta.pausedAt on transition to paused", () => {
    const run = makePausedRun();
    const { rt } = makeRuntime();
    run.assignRuntime(rt);

    expect(run.meta.pausedAt).toBeUndefined();
    run.transition("paused");
    expect(run.meta.pausedAt).toBeDefined();
  });

  it("preserves invariant I1 (paused ⟹ runtime undefined)", () => {
    const run = makePausedRun();
    const { rt } = makeRuntime();
    run.assignRuntime(rt);
    run.transition("paused");
    expect(run.state.status).toBe("paused");
    expect(run.runtime).toBeUndefined();
  });
});

// ── transition — running → done ─────────────────────────────

describe("transition running → done", () => {
  it("transitions to done with reason and releases runtime", () => {
    const run = makePausedRun();
    const { rt, handle } = makeRuntime();
    run.assignRuntime(rt);

    run.transition("done", "completed");

    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("completed");
    expect(run.runtime).toBeUndefined();
    expect(spyTerminate(handle)).toHaveBeenCalledTimes(1);
  });

  it("sets meta.completedAt on transition to done", () => {
    const run = makePausedRun();
    const { rt } = makeRuntime();
    run.assignRuntime(rt);

    expect(run.meta.completedAt).toBeUndefined();
    run.transition("done", "failed");
    expect(run.meta.completedAt).toBeDefined();
  });

  it("throws if reason missing (invariant I2)", () => {
    const run = makePausedRun();
    const { rt } = makeRuntime();
    run.assignRuntime(rt);

    expect(() => run.transition("done")).toThrow(/requires a reason/);
  });

  it("accepts all 5 DoneReasons", () => {
    for (const reason of ["completed", "failed", "aborted", "budget_limited", "time_limited"] as const) {
      const run = makePausedRun(`r-${reason}`);
      const { rt } = makeRuntime();
      run.assignRuntime(rt);
      run.transition("done", reason);
      expect(run.state.reason).toBe(reason);
    }
  });
});

// ── transition — paused → done (without runtime) ───────────

describe("transition paused → done", () => {
  it("transitions done directly from paused (no runtime to release)", () => {
    const run = makePausedRun();
    run.transition("done", "aborted");

    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("aborted");
    expect(run.runtime).toBeUndefined();
  });
});

// ── transition — illegal transitions ────────────────────────

describe("illegal transitions throw", () => {
  it("done → anything throws (zombie)", () => {
    const run = new WorkflowRun("r", makeSpec(), {
      status: "done",
      reason: "completed",
      budget: new Budget(),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    }, { startedAt: "2026-01-01T00:00:00.000Z" });
    expect(() => run.transition("paused")).toThrow(/illegal transition/);
    expect(() => run.transition("done", "failed")).toThrow(/illegal transition/);
  });

  it("paused → paused throws (no-op not allowed)", () => {
    const run = makePausedRun();
    expect(() => run.transition("paused")).toThrow(/illegal transition/);
  });

  it("running → running throws (use assignRuntime not transition)", () => {
    const run = makePausedRun();
    const { rt } = makeRuntime();
    run.assignRuntime(rt);
 // running → running isn't even in VALID_RUN_TRANSITIONS, but our code
 // specifically rejects "running" target with assignRuntime hint
    expect(() => run.transition("running")).toThrow(/assignRuntime/);
  });
});

// ── replaceRuntime (G5-001 + G6-001) ───────────────────────

describe("replaceRuntime (G5-001 atomic, G6-001 running-only)", () => {
  it("atomically swaps runtime while staying in running status", () => {
    const run = makePausedRun();
    const { rt: old, handle: oldHandle } = makeRuntime();
    run.assignRuntime(old);

    const { rt: newRt } = makeRuntime();
    run.replaceRuntime(newRt);

    expect(run.runtime).toBe(newRt);
    expect(run.state.status).toBe("running"); // unchanged
 // old runtime released
    expect(spyTerminate(oldHandle)).toHaveBeenCalledTimes(1);
  });

  it("G6-001: throws if status !== 'running' (paused rejects)", () => {
    const run = makePausedRun();
    const { rt } = makeRuntime();
    expect(() => run.replaceRuntime(rt)).toThrow(/requires status.*running/);
  });

  it("G6-001: throws if status === 'done'", () => {
    const run = new WorkflowRun("r", makeSpec(), {
      status: "done",
      reason: "completed",
      budget: new Budget(),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    }, { startedAt: "2026-01-01T00:00:00.000Z" });
    const { rt } = makeRuntime();
    expect(() => run.replaceRuntime(rt)).toThrow(/requires status.*running/);
  });

  it("preserves invariant I1 across replace (runtime never observed undefined)", () => {
    const run = makePausedRun();
    const { rt: old } = makeRuntime();
    run.assignRuntime(old);
    const { rt: newRt } = makeRuntime();

 // Replace is atomic — after call, runtime is newRt and status still running
    run.replaceRuntime(newRt);
    expect(run.state.status).toBe("running");
    expect(run.runtime).toBe(newRt);
  });

  it("releases old runtime's worker (terminate called once on old)", () => {
    const run = makePausedRun();
    const { rt: old, handle: oldHandle } = makeRuntime();
    run.assignRuntime(old);
    const { rt: newRt, handle: newHandle } = makeRuntime();

    run.replaceRuntime(newRt);

    expect(spyTerminate(oldHandle)).toHaveBeenCalledTimes(1);
 // New runtime's worker is NOT terminated (still active)
    expect(spyTerminate(newHandle)).not.toHaveBeenCalled();
  });
});

// ── Full lifecycle: paused → running → paused → running → done ─

describe("full lifecycle (pause/resume + done)", () => {
  it("supports paused → running → paused → running → done", () => {
    const run = makePausedRun();

 // First running segment
    const { rt: rt1 } = makeRuntime();
    run.assignRuntime(rt1);
    expect(run.state.status).toBe("running");

 // Pause
    run.transition("paused");
    expect(run.state.status).toBe("paused");
    expect(run.runtime).toBeUndefined();

 // Resume (new runtime — G3-001 rebuild)
    const { rt: rt2 } = makeRuntime();
    run.assignRuntime(rt2);
    expect(run.state.status).toBe("running");
    expect(run.runtime).toBe(rt2);

 // Done
    run.transition("done", "completed");
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("completed");
    expect(run.runtime).toBeUndefined();
  });

  it("supports running → done directly (no pause)", () => {
    const run = makePausedRun();
    const { rt } = makeRuntime();
    run.assignRuntime(rt);
    run.transition("done", "completed");
    expect(run.state.status).toBe("done");
  });

  it("supports paused → done (abort from paused state)", () => {
    const run = makePausedRun();
    run.transition("done", "aborted");
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("aborted");
  });
});
