// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach）
// 运行命令：npx vitest run tests/orchestrator.test.ts

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @zhushanwen/pi-model-switch to avoid transitive typebox dependency
vi.mock("@zhushanwen/pi-model-switch", () => ({
  resolveModelForScene: vi.fn().mockReturnValue(undefined),
}));

import { WorkflowOrchestrator } from "../src/orchestrator";
import {
  createInstance,
  type WorkflowInstance,
  type AgentResult,
} from "../src/state";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Helpers ──────────────────────────────────────────────────

function makeMockPi(): ExtensionAPI {
  return { appendEntry: vi.fn() } as unknown as ExtensionAPI;
}

function makeMockCtx(): ExtensionContext {
  return {
    sessionManager: { getSessionId: vi.fn().mockReturnValue("test-session") },
  } as unknown as ExtensionContext;
}

/** Create a WorkflowInstance with the given runId, status, and optional overrides. */
function makeInstance(
  runId: string,
  status: WorkflowInstance["status"] = "running",
  overrides?: Partial<WorkflowInstance>,
): WorkflowInstance {
  const inst = createInstance({
    runId,
    name: `workflow-${runId}`,
    worker: "agent-test",
  });
  inst.status = status;
  inst.startedAt = "2026-01-01T00:00:00Z";
  return { ...inst, ...overrides };
}

/** Build a Map of instances from an array. */
function makeInstanceMap(
  ...instances: WorkflowInstance[]
): Map<string, WorkflowInstance> {
  const map = new Map<string, WorkflowInstance>();
  for (const inst of instances) {
    map.set(inst.runId, inst);
  }
  return map;
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("WorkflowOrchestrator", () => {
  let orch: WorkflowOrchestrator;
  let mockPi: ExtensionAPI;

  beforeEach(() => {
    mockPi = makeMockPi();
    const mockCtx = makeMockCtx();
    orch = new WorkflowOrchestrator(mockPi, mockCtx);
  });

  // ── list() ────────────────────────────────────────────────

  describe("list()", () => {
    it("returns empty array when no instances exist", () => {
      expect(orch.list()).toEqual([]);
    });

    it("returns correct summaries for restored instances", () => {
      const i1 = makeInstance("wf-001", "running");
      const i2 = makeInstance("wf-002", "completed", {
        completedAt: "2026-01-01T01:00:00Z",
      });
      const i3 = makeInstance("wf-003", "paused", { pausedAt: "2026-01-01T00:30:00Z" });

      orch.restoreInstances(makeInstanceMap(i1, i2, i3));
      const summaries = orch.list();

      expect(summaries).toHaveLength(3);
      expect(summaries.map((s) => s.runId).sort()).toEqual(["wf-001", "wf-002", "wf-003"]);

      const s1 = summaries.find((s) => s.runId === "wf-001")!;
      expect(s1.status).toBe("running");
      expect(s1.name).toBe("workflow-wf-001");
      expect(s1.startedAt).toBe("2026-01-01T00:00:00Z");
      expect(s1.traceLength).toBe(0);
      expect(s1.cachedCalls).toBe(0);

      const s2 = summaries.find((s) => s.runId === "wf-002")!;
      expect(s2.status).toBe("completed");
      expect(s2.completedAt).toBe("2026-01-01T01:00:00Z");

      const s3 = summaries.find((s) => s.runId === "wf-003")!;
      expect(s3.status).toBe("paused");
    });
  });

  // ── getInstance() ─────────────────────────────────────────

  describe("getInstance()", () => {
    it("returns instance when runId exists", () => {
      const inst = makeInstance("wf-100");
      orch.restoreInstances(makeInstanceMap(inst));

      const result = orch.getInstance("wf-100");
      expect(result).toBeDefined();
      expect(result?.runId).toBe("wf-100");
    });

    it("returns undefined when runId does not exist", () => {
      expect(orch.getInstance("nonexistent")).toBeUndefined();
    });
  });

  // ── abort() ───────────────────────────────────────────────

  describe("abort()", () => {
    it("transitions running → aborted and sets completedAt", () => {
      const inst = makeInstance("wf-abort-ok", "running");
      orch.restoreInstances(makeInstanceMap(inst));

      orch.abort("wf-abort-ok");

      const updated = orch.getInstance("wf-abort-ok")!;
      expect(updated.status).toBe("aborted");
      expect(updated.completedAt).toBeDefined();
    });

    it("transitions paused → aborted", () => {
      const inst = makeInstance("wf-abort-paused", "paused");
      orch.restoreInstances(makeInstanceMap(inst));

      orch.abort("wf-abort-paused");

      expect(orch.getInstance("wf-abort-paused")!.status).toBe("aborted");
    });

    it("throws when workflow is already completed", () => {
      const inst = makeInstance("wf-abort-done", "completed");
      orch.restoreInstances(makeInstanceMap(inst));

      expect(() => orch.abort("wf-abort-done")).toThrow(
        /Cannot abort workflow in state 'completed'/,
      );
    });

    it("throws when workflow is already failed", () => {
      const inst = makeInstance("wf-abort-fail", "failed");
      orch.restoreInstances(makeInstanceMap(inst));

      expect(() => orch.abort("wf-abort-fail")).toThrow(
        /Cannot abort workflow in state 'failed'/,
      );
    });

    it("throws when runId does not exist", () => {
      expect(() => orch.abort("nonexistent")).toThrow(/not found/);
    });
  });

  // ── pause() ───────────────────────────────────────────────

  describe("pause()", () => {
    it("transitions running → paused and sets pausedAt", () => {
      const inst = makeInstance("wf-pause-ok", "running");
      orch.restoreInstances(makeInstanceMap(inst));

      orch.pause("wf-pause-ok");

      const updated = orch.getInstance("wf-pause-ok")!;
      expect(updated.status).toBe("paused");
      expect(updated.pausedAt).toBeDefined();
    });

    it("throws when workflow is already paused", () => {
      const inst = makeInstance("wf-pause-twice", "paused");
      orch.restoreInstances(makeInstanceMap(inst));

      expect(() => orch.pause("wf-pause-twice")).toThrow(
        /Cannot pause workflow in state 'paused'/,
      );
    });

    it("throws when workflow is completed", () => {
      const inst = makeInstance("wf-pause-done", "completed");
      orch.restoreInstances(makeInstanceMap(inst));

      expect(() => orch.pause("wf-pause-done")).toThrow(
        /Cannot pause workflow in state 'completed'/,
      );
    });

    it("throws when runId does not exist", () => {
      expect(() => orch.pause("nonexistent")).toThrow(/not found/);
    });
  });

  // ── resume() ──────────────────────────────────────────────

  describe("resume()", () => {
    it("transitions paused → running and clears pausedAt", () => {
      const inst = makeInstance("wf-resume-ok", "paused");
      inst.pausedAt = "2026-01-01T00:30:00Z";
      orch.restoreInstances(makeInstanceMap(inst));

      orch.resume("wf-resume-ok");

      const updated = orch.getInstance("wf-resume-ok")!;
      expect(updated.status).toBe("running");
      expect(updated.pausedAt).toBeUndefined();
    });

    it("throws when workflow is already running", () => {
      const inst = makeInstance("wf-resume-running", "running");
      orch.restoreInstances(makeInstanceMap(inst));

      expect(() => orch.resume("wf-resume-running")).toThrow(
        /Cannot resume workflow in state 'running'/,
      );
    });

    it("throws when workflow is completed", () => {
      const inst = makeInstance("wf-resume-done", "completed");
      orch.restoreInstances(makeInstanceMap(inst));

      expect(() => orch.resume("wf-resume-done")).toThrow(
        /Cannot resume workflow in state 'completed'/,
      );
    });

    it("throws when runId does not exist", () => {
      expect(() => orch.resume("nonexistent")).toThrow(/not found/);
    });
  });

  // ── retryNode() ───────────────────────────────────────────

  describe("retryNode()", () => {
    it("clears the specified callId from callCache for running instance", () => {
      const inst = makeInstance("wf-retry-ok", "running");
      const cachedResult: AgentResult = { content: "cached-output" };
      inst.callCache.set(0, cachedResult);
      inst.callCache.set(1, { content: "other-cache" });
      orch.restoreInstances(makeInstanceMap(inst));

      orch.retryNode("wf-retry-ok", 0);

      const updated = orch.getInstance("wf-retry-ok")!;
      expect(updated.callCache.has(0)).toBe(false);
      expect(updated.callCache.has(1)).toBe(true);
    });

    it("clears the specified callId for paused instance", () => {
      const inst = makeInstance("wf-retry-paused", "paused");
      inst.callCache.set(5, { content: "old-result" });
      orch.restoreInstances(makeInstanceMap(inst));

      orch.retryNode("wf-retry-paused", 5);

      expect(orch.getInstance("wf-retry-paused")!.callCache.has(5)).toBe(false);
    });

    it("throws when instance is completed", () => {
      const inst = makeInstance("wf-retry-done", "completed");
      inst.callCache.set(0, { content: "x" });
      orch.restoreInstances(makeInstanceMap(inst));

      expect(() => orch.retryNode("wf-retry-done", 0)).toThrow(
        /Cannot retry node in state 'completed'/,
      );
    });

    it("throws when runId does not exist", () => {
      expect(() => orch.retryNode("nonexistent", 0)).toThrow(/not found/);
    });

    it("resets trace node for the retried callId", () => {
      const inst = makeInstance("wf-retry-trace", "running");
      inst.callCache.set(3, { content: "cached" });
      inst.trace.push({
        stepIndex: 3,
        agent: "test-agent",
        task: "do work",
        model: "default",
        status: "completed",
        completedAt: "2026-01-01T00:05:00Z",
      });
      orch.restoreInstances(makeInstanceMap(inst));

      orch.retryNode("wf-retry-trace", 3);

      const node = orch.getInstance("wf-retry-trace")!.trace.find(
        (n) => n.stepIndex === 3,
      );
      expect(node).toBeDefined();
      expect(node!.status).toBe("pending");
      expect(node!.result).toBeUndefined();
      expect(node!.completedAt).toBeUndefined();
    });
  });

  // ── skipNode() ────────────────────────────────────────────

  describe("skipNode()", () => {
    it("injects a placeholder into callCache", () => {
      const inst = makeInstance("wf-skip-ok", "running");
      expect(inst.callCache.has(7)).toBe(false);
      orch.restoreInstances(makeInstanceMap(inst));

      orch.skipNode("wf-skip-ok", 7);

      const cached = orch.getInstance("wf-skip-ok")!.callCache.get(7);
      expect(cached).toBeDefined();
      expect(cached!.content).toBe("");
      expect(cached!.usage).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      });
    });

    it("updates existing trace node to completed with placeholder result", () => {
      const inst = makeInstance("wf-skip-trace", "running");
      inst.trace.push({
        stepIndex: 2,
        agent: "agent-a",
        task: "do something",
        model: "default",
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
      });
      orch.restoreInstances(makeInstanceMap(inst));

      orch.skipNode("wf-skip-trace", 2);

      const node = orch.getInstance("wf-skip-trace")!.trace.find(
        (n) => n.stepIndex === 2,
      );
      expect(node!.status).toBe("completed");
      expect(node!.result).toBeDefined();
      expect(node!.completedAt).toBeDefined();
    });

    it("works on paused instances without status check", () => {
      const inst = makeInstance("wf-skip-paused", "paused");
      orch.restoreInstances(makeInstanceMap(inst));

      orch.skipNode("wf-skip-paused", 10);

      expect(orch.getInstance("wf-skip-paused")!.callCache.has(10)).toBe(true);
    });

    it("throws when runId does not exist", () => {
      expect(() => orch.skipNode("nonexistent", 0)).toThrow(/not found/);
    });
  });

  // ── persistState() ────────────────────────────────────────

  describe("persistState()", () => {
    it("calls pi.appendEntry with workflow-state type and serialized instances", () => {
      const inst = makeInstance("wf-persist", "running");
      orch.restoreInstances(makeInstanceMap(inst));

      orch.persistState();

      const appendFn = (mockPi as unknown as { appendEntry: ReturnType<typeof vi.fn> }).appendEntry;
      expect(appendFn).toHaveBeenCalledTimes(1);
      expect(appendFn).toHaveBeenCalledWith("workflow-state", expect.objectContaining({
        type: "workflow-state",
        instances: expect.arrayContaining([
          expect.objectContaining({ runId: "wf-persist", status: "running" }),
        ]),
      }));
    });

    it("serializes all instances including their callCache", () => {
      const inst = makeInstance("wf-persist-cache", "running");
      inst.callCache.set(0, { content: "result-0" });
      inst.callCache.set(1, { content: "result-1" });
      orch.restoreInstances(makeInstanceMap(inst));

      orch.persistState();

      const appendFn = (mockPi as unknown as { appendEntry: ReturnType<typeof vi.fn> }).appendEntry;
      const call = appendFn.mock.calls[0];
      const data = call[1] as { instances: Array<{ runId: string; callCache: Array<{ key: number }> }> };
      const serialized = data.instances.find((i) => i.runId === "wf-persist-cache")!;
      expect(serialized.callCache).toHaveLength(2);
    });
  });

  // ── restoreInstances() ────────────────────────────────────

  describe("restoreInstances()", () => {
    it("merges multiple instances into the orchestrator", () => {
      const i1 = makeInstance("wf-r1", "running");
      const i2 = makeInstance("wf-r2", "completed");

      orch.restoreInstances(makeInstanceMap(i1));
      orch.restoreInstances(makeInstanceMap(i2));

      expect(orch.getInstance("wf-r1")).toBeDefined();
      expect(orch.getInstance("wf-r2")).toBeDefined();
      expect(orch.list()).toHaveLength(2);
    });

    it("overwrites existing instance with same runId", () => {
      const original = makeInstance("wf-overwrite", "running");
      const updated = makeInstance("wf-overwrite", "completed");

      orch.restoreInstances(makeInstanceMap(original));
      orch.restoreInstances(makeInstanceMap(updated));

      expect(orch.getInstance("wf-overwrite")!.status).toBe("completed");
    });
  });
});
