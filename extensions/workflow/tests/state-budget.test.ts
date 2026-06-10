// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach）
// 运行命令：npx vitest run tests/state-budget.test.ts

import { describe, expect,it } from "vitest";

import {
  ALL_STATUSES,
  canTransition,
  createInstance,
  deserializeInstance,
  deserializeState,
  ENTRY_TYPE,
  isTerminal,
  serializeInstance,
  TERMINAL_STATUSES,
  transitionStatus,
  VALID_TRANSITIONS,
  type WorkflowInstance,
  type WorkflowStatus,
} from "../src/state";

// ═══════════════════════════════════════════════════════════════
// state.ts
// ═══════════════════════════════════════════════════════════════

// eslint-disable-next-line max-lines-per-function
describe("state.ts", () => {
  // ── isTerminal ────────────────────────────────────────────
  describe("isTerminal()", () => {
    it("returns true for all 5 terminal statuses", () => {
      expect(isTerminal("completed")).toBe(true);
      expect(isTerminal("failed")).toBe(true);
      expect(isTerminal("aborted")).toBe(true);
      expect(isTerminal("budget_limited")).toBe(true);
      expect(isTerminal("time_limited")).toBe(true);
    });

    it("returns false for non-terminal statuses", () => {
      expect(isTerminal("running")).toBe(false);
      expect(isTerminal("paused")).toBe(false);
    });
  });

  // ── canTransition ─────────────────────────────────────────
  describe("canTransition()", () => {
    it("allows valid transitions from running", () => {
      expect(canTransition("running", "paused")).toBe(true);
      expect(canTransition("running", "completed")).toBe(true);
      expect(canTransition("running", "failed")).toBe(true);
      expect(canTransition("running", "aborted")).toBe(true);
    });

    it("allows valid transitions from paused", () => {
      expect(canTransition("paused", "running")).toBe(true);
      expect(canTransition("paused", "aborted")).toBe(true);
    });

    it("rejects invalid transitions from terminal states", () => {
      expect(canTransition("completed", "running")).toBe(false);
      expect(canTransition("failed", "running")).toBe(false);
      expect(canTransition("aborted", "running")).toBe(false);
      expect(canTransition("budget_limited", "paused")).toBe(false);
      expect(canTransition("time_limited", "failed")).toBe(false);
    });

    it("rejects invalid transitions from non-terminal states", () => {
      expect(canTransition("running", "running")).toBe(false);
      expect(canTransition("paused", "completed")).toBe(false);
    });
  });

  // ── transitionStatus ──────────────────────────────────────
  describe("transitionStatus()", () => {
    function makeInstance(status: WorkflowStatus): WorkflowInstance {
      return {
        runId: "test-run",
        name: "test",
        status,
        callCache: new Map(),
        trace: [],
        worker: "agent-1",
        budget: { usedTokens: 0, usedCost: 0 },
      };
    }

    it("updates instance status on valid transition", () => {
      const inst = makeInstance("running");
      transitionStatus(inst, "paused");
      expect(inst.status).toBe("paused");

      transitionStatus(inst, "running");
      expect(inst.status).toBe("running");
    });

    it("throws on invalid transition from terminal state", () => {
      const inst = makeInstance("completed");
      expect(() => transitionStatus(inst, "running")).toThrow(
        /Invalid state transition/,
      );
    });

    it("throws on invalid transition between incompatible states", () => {
      const inst = makeInstance("paused");
      expect(() => transitionStatus(inst, "completed")).toThrow(
        /Invalid state transition/,
      );
    });

    it("returns the new status", () => {
      const inst = makeInstance("running");
      const result = transitionStatus(inst, "failed");
      expect(result).toBe("failed");
      expect(inst.status).toBe("failed");
    });
  });

  // ── createInstance ────────────────────────────────────────
  describe("createInstance()", () => {
    it("creates instance with default status=running", () => {
      const inst = createInstance({
        runId: "r1",
        name: "wf1",
        worker: "agent-1",
      });
      expect(inst.status).toBe("running");
      expect(inst.runId).toBe("r1");
      expect(inst.name).toBe("wf1");
      expect(inst.worker).toBe("agent-1");
      expect(inst.callCache).toBeInstanceOf(Map);
      expect(inst.callCache.size).toBe(0);
      expect(inst.trace).toEqual([]);
    });

    it("creates instance with custom status", () => {
      const inst = createInstance({
        runId: "r2",
        name: "wf2",
        worker: "agent-2",
        status: "paused",
      });
      expect(inst.status).toBe("paused");
    });

    it("initializes budget fields with defaults", () => {
      const inst = createInstance({
        runId: "r3",
        name: "wf3",
        worker: "agent-1",
      });
      expect(inst.budget).toEqual({
        maxTokens: undefined,
        maxCost: undefined,
        maxTimeMs: undefined,
        usedTokens: 0,
        usedCost: 0,
      });
    });

    it("merges partial budget overrides", () => {
      const inst = createInstance({
        runId: "r4",
        name: "wf4",
        worker: "agent-1",
        budget: { maxTokens: 100_000, maxCost: 5.0 },
      });
      expect(inst.budget.maxTokens).toBe(100_000);
      expect(inst.budget.maxCost).toBe(5.0);
      expect(inst.budget.maxTimeMs).toBeUndefined();
      expect(inst.budget.usedTokens).toBe(0);
      expect(inst.budget.usedCost).toBe(0);
    });
  });

  // ── serializeInstance / deserializeInstance round-trip ────
  describe("serialize/deserialize round-trip", () => {
    it("preserves all key fields through serialize → deserialize", () => {
      const original = createInstance({
        runId: "rt-1",
        name: "round-trip-test",
        worker: "agent-x",
        budget: { maxTokens: 50_000, maxCost: 2.5 },
      });
      original.status = "completed";
      original.startedAt = "2026-01-01T00:00:00Z";
      original.completedAt = "2026-01-01T00:10:00Z";
      original.callCache.set(0, { content: "result-0" });
      original.callCache.set(1, {
        content: "result-1",
        usage: { input: 100, output: 50, cost: 0.01, contextTokens: 150, turns: 1, cacheRead: 0, cacheWrite: 0 },
        durationMs: 3000,
      });
      original.trace.push({
        stepIndex: 0,
        agent: "agent-x",
        task: "do stuff",
        model: "gpt-4",
        status: "completed",
      });

      const serialized = serializeInstance(original);
      const restored = deserializeInstance(serialized);

      expect(restored.runId).toBe(original.runId);
      expect(restored.name).toBe(original.name);
      expect(restored.status).toBe(original.status);
      expect(restored.worker).toBe(original.worker);
      expect(restored.startedAt).toBe(original.startedAt);
      expect(restored.completedAt).toBe(original.completedAt);
      expect(restored.budget).toEqual(original.budget);
      expect(restored.trace).toEqual(original.trace);
      expect(restored.callCache.size).toBe(2);
      expect(restored.callCache.get(0)?.content).toBe("result-0");
      expect(restored.callCache.get(1)?.usage?.input).toBe(100);
    });
  });

  // ── deserializeInstance backward compat ──────────────────
  describe("deserializeInstance() backward compat", () => {
    it('maps legacy "created" status to "running"', () => {
      const data = {
        runId: "legacy-1",
        name: "old-wf",
        status: "created",
        callCache: [],
        trace: [],
        worker: "agent-1",
      };
      const inst = deserializeInstance(data);
      expect(inst.status).toBe("running");
    });

    it("preserves modern status values", () => {
      const data = {
        runId: "modern-1",
        name: "new-wf",
        status: "paused",
        callCache: [],
        trace: [],
        worker: "agent-1",
      };
      const inst = deserializeInstance(data);
      expect(inst.status).toBe("paused");
    });

    it("provides default budget when missing", () => {
      const data = {
        runId: "no-budget",
        name: "wf",
        status: "running",
        callCache: [],
        trace: [],
        worker: "agent-1",
      };
      const inst = deserializeInstance(data);
      expect(inst.budget).toEqual({ usedTokens: 0, usedCost: 0 });
    });

    it("handles null/undefined callCache gracefully", () => {
      const data = {
        runId: "null-cache",
        name: "wf",
        status: "running",
        callCache: null,
        trace: null,
        worker: "agent-1",
      };
      const inst = deserializeInstance(data);
      expect(inst.callCache.size).toBe(0);
      expect(inst.trace).toEqual([]);
    });
  });

  // ── deserializeState ─────────────────────────────────────
  describe("deserializeState()", () => {
    it("returns populated Map from valid entries", () => {
      const entry = {
        type: ENTRY_TYPE,
        instances: [
          {
            runId: "r1",
            name: "wf1",
            status: "running",
            callCache: [],
            trace: [],
            worker: "a1",
          },
          {
            runId: "r2",
            name: "wf2",
            status: "completed",
            callCache: [],
            trace: [],
            worker: "a2",
          },
        ],
      };
      const map = deserializeState(entry);
      expect(map.size).toBe(2);
      expect(map.get("r1")?.status).toBe("running");
      expect(map.get("r2")?.status).toBe("completed");
    });

    it("returns empty Map for wrong type", () => {
      const entry = { type: "other-type", instances: [] };
      const map = deserializeState(entry);
      expect(map.size).toBe(0);
    });

    it("returns empty Map for undefined/null input", () => {
      expect(deserializeState(undefined).size).toBe(0);
      expect(deserializeState(null).size).toBe(0);
    });

    it("returns empty Map for non-object input", () => {
      expect(deserializeState("string").size).toBe(0);
      expect(deserializeState(42).size).toBe(0);
    });

    it("skips malformed instances without crashing", () => {
      const entry = {
        type: ENTRY_TYPE,
        instances: [
          {
            runId: "good",
            name: "valid",
            status: "running",
            callCache: [],
            trace: [],
            worker: "a1",
          },
          // malformed: missing required fields — deserializeInstance may throw or not
          { status: "running" },
          // another bad one
          null,
        ],
      };
      const map = deserializeState(entry);
      // at least the good one survives; bad ones are skipped
      expect(map.has("good")).toBe(true);
      // null/missing-runId entries won't crash the whole loop
      expect(map.size).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Constants ─────────────────────────────────────────────
  describe("constants", () => {
    it("ALL_STATUSES contains exactly 8 statuses", () => {
      expect(ALL_STATUSES).toHaveLength(8);
      const expected: readonly WorkflowStatus[] = [
        "running", "paused", "completed", "failed",
        "aborted", "budget_limited", "time_limited", "state_lost",
      ];
      expect(ALL_STATUSES).toEqual(expected);
    });

    it("TERMINAL_STATUSES contains exactly 6 statuses", () => {
      expect(TERMINAL_STATUSES).toHaveLength(6);
      const expected: readonly WorkflowStatus[] = [
        "completed", "failed", "aborted", "budget_limited", "time_limited", "state_lost",
      ];
      expect(TERMINAL_STATUSES).toEqual(expected);
    });

    it("terminal states have empty transition lists in VALID_TRANSITIONS", () => {
      for (const ts of TERMINAL_STATUSES) {
        expect(VALID_TRANSITIONS[ts]).toEqual([]);
      }
    });

    it("running has valid outgoing transitions", () => {
      expect(VALID_TRANSITIONS.running).toContain("paused");
      expect(VALID_TRANSITIONS.running).toContain("completed");
      expect(VALID_TRANSITIONS.running).toContain("failed");
      expect(VALID_TRANSITIONS.running).toContain("aborted");
      expect(VALID_TRANSITIONS.running).toContain("budget_limited");
      expect(VALID_TRANSITIONS.running).toContain("time_limited");
    });

    it("paused can go to running or aborted", () => {
      expect(VALID_TRANSITIONS.paused).toEqual(["running", "aborted"]);
    });
  });
});


