// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）
// 运行命令：npx vitest run src/__tests__/state-machine.test.ts

import { describe, expect, it } from "vitest";

import {
  ALL_STATUSES,
  canTransition,
  createInstance,
  deserializeInstance,
  deserializeState,
  ENTRY_TYPE,
  isTerminal,
  serializeInstance,
  serializeState,
  TERMINAL_STATUSES,
  transitionStatus,
  VALID_TRANSITIONS,
  type WorkflowInstance,
  type WorkflowStatus,
} from "../domain/state";

/** 测试向后兼容：serialized 故意省略字段，验证 deserializeInstance 补默认值。 */
function deserializePartial(s: object): WorkflowInstance {
  // eslint-disable-next-line taste/no-unsafe-cast
  return deserializeInstance(s as unknown as Parameters<typeof deserializeInstance>[0]);
}

// ── isTerminal ──────────────────────────────────────────────

describe("isTerminal", () => {
  it.each([...TERMINAL_STATUSES])("returns true for terminal status %s", (status) => {
    expect(isTerminal(status)).toBe(true);
  });

  it("returns false for running", () => {
    expect(isTerminal("running")).toBe(false);
  });

  it("returns false for paused", () => {
    expect(isTerminal("paused")).toBe(false);
  });

  // 回归 A5：budget_limited 必须被 isTerminal 覆盖，
  // orchestrator.handleWorkerMessage 依赖此（已删除冗余的 || status === "budget_limited"）
  it("returns true for budget_limited (regression for A5 redundant guard)", () => {
    expect(isTerminal("budget_limited")).toBe(true);
  });
});

// ── canTransition ───────────────────────────────────────────

describe("canTransition", () => {
  it("running → paused is valid", () => {
    expect(canTransition("running", "paused")).toBe(true);
  });

  it("paused → running is valid", () => {
    expect(canTransition("paused", "running")).toBe(true);
  });

  it("running → completed is valid", () => {
    expect(canTransition("running", "completed")).toBe(true);
  });

  it("running → failed is valid", () => {
    expect(canTransition("running", "failed")).toBe(true);
  });

  it("running → aborted is valid", () => {
    expect(canTransition("running", "aborted")).toBe(true);
  });

  it("running → budget_limited is valid", () => {
    expect(canTransition("running", "budget_limited")).toBe(true);
  });

  it("running → time_limited is valid", () => {
    expect(canTransition("running", "time_limited")).toBe(true);
  });

  it("paused → aborted is valid", () => {
    expect(canTransition("paused", "aborted")).toBe(true);
  });

  it("running → running is invalid", () => {
    expect(canTransition("running", "running")).toBe(false);
  });

  it("completed → running is invalid", () => {
    expect(canTransition("completed", "running")).toBe(false);
  });

  it("failed → running is invalid", () => {
    expect(canTransition("failed", "running")).toBe(false);
  });

  it("aborted → running is invalid", () => {
    expect(canTransition("aborted", "running")).toBe(false);
  });

  it("paused → completed is invalid (must resume first)", () => {
    expect(canTransition("paused", "completed")).toBe(false);
  });

  it("paused → failed is invalid (must resume first)", () => {
    expect(canTransition("paused", "failed")).toBe(false);
  });

  it("all terminal statuses have no outgoing transitions", () => {
    for (const ts of TERMINAL_STATUSES) {
      expect(VALID_TRANSITIONS[ts]).toEqual([]);
    }
  });
});

// ── transitionStatus ────────────────────────────────────────

describe("transitionStatus", () => {
  function makeRunning(): WorkflowInstance {
    return createInstance({ runId: "r1", name: "test-wf", worker: "w1" });
  }

  it("transitions running → paused", () => {
    const inst = makeRunning();
    const result = transitionStatus(inst, "paused");
    expect(result).toBe("paused");
    expect(inst.status).toBe("paused");
  });

  it("transitions paused → running", () => {
    const inst = makeRunning();
    transitionStatus(inst, "paused");
    const result = transitionStatus(inst, "running");
    expect(result).toBe("running");
    expect(inst.status).toBe("running");
  });

  it("transitions running → completed", () => {
    const inst = makeRunning();
    expect(transitionStatus(inst, "completed")).toBe("completed");
  });

  it("transitions running → failed", () => {
    const inst = makeRunning();
    expect(transitionStatus(inst, "failed")).toBe("failed");
  });

  it("transitions running → aborted", () => {
    const inst = makeRunning();
    expect(transitionStatus(inst, "aborted")).toBe("aborted");
  });

  it("transitions paused → aborted", () => {
    const inst = makeRunning();
    transitionStatus(inst, "paused");
    expect(transitionStatus(inst, "aborted")).toBe("aborted");
  });

  it("throws on invalid transition completed → running", () => {
    const inst = makeRunning();
    transitionStatus(inst, "completed");
    expect(() => transitionStatus(inst, "running")).toThrow(
      /Invalid state transition/,
    );
  });

  it("throws on invalid transition paused → completed", () => {
    const inst = makeRunning();
    transitionStatus(inst, "paused");
    expect(() => transitionStatus(inst, "completed")).toThrow(
      /Invalid state transition/,
    );
  });

  it("error message lists allowed transitions", () => {
    const inst = makeRunning();
    transitionStatus(inst, "paused");
    expect(() => transitionStatus(inst, "completed")).toThrow(
      /Allowed:.*running.*aborted/,
    );
  });
});

// ── Serialize / Deserialize round-trip ──────────────────────

describe("serialize/deserialize round-trip", () => {
  it("preserves all fields after round-trip", () => {
    const inst = createInstance({
      runId: "rt-1",
      name: "round-trip-test",
      worker: "agent-1",
      budget: { maxTokens: 10000, maxCost: 5.0, maxTimeMs: 60000 },
    });
    inst.startedAt = "2025-01-01T00:00:00Z";
    inst.description = "test description";
    inst.trace.push({
      stepIndex: 0,
      agent: "a1",
      task: "do work",
      model: "gpt-4",
      status: "completed",
      startedAt: "2025-01-01T00:00:00Z",
      completedAt: "2025-01-01T00:01:00Z",
    });
    inst.callCache.set(0, {
      content: "result",
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 150, turns: 1 },
      durationMs: 5000,
    });

    const serialized = serializeInstance(inst);
    const restored = deserializeInstance(serialized);

    expect(restored.runId).toBe("rt-1");
    expect(restored.name).toBe("round-trip-test");
    expect(restored.description).toBe("test description");
    expect(restored.status).toBe("running");
    expect(restored.worker).toBe("agent-1");
    expect(restored.startedAt).toBe("2025-01-01T00:00:00Z");
    expect(restored.budget.maxTokens).toBe(10000);
    expect(restored.budget.maxCost).toBe(5.0);
    expect(restored.budget.maxTimeMs).toBe(60000);
    expect(restored.budget.usedTokens).toBe(0);
    expect(restored.budget.usedCost).toBe(0);
    expect(restored.trace).toHaveLength(1);
    expect(restored.trace[0].agent).toBe("a1");
    expect(restored.callCache.size).toBe(1);
    expect(restored.callCache.get(0)?.content).toBe("result");
  });

  it("preserves status after round-trip", () => {
    for (const status of ALL_STATUSES) {
      const inst = createInstance({ runId: `s-${status}`, name: "t", worker: "w" });
      // state_lost is not a normal createInstance status; set it directly
      if (status !== "running") inst.status = status;
      const restored = deserializeInstance(serializeInstance(inst));
      expect(restored.status).toBe(status);
    }
  });

  it("serializeState/deserializeState round-trip with multiple instances", () => {
    const map = new Map<string, WorkflowInstance>();
    map.set("a", createInstance({ runId: "a", name: "wf-a", worker: "w1" }));
    map.set("b", createInstance({ runId: "b", name: "wf-b", worker: "w2" }));

    const entry = serializeState(map);
    expect(entry.type).toBe(ENTRY_TYPE);
    expect(entry.instances).toHaveLength(2);

    const restored = deserializeState(entry);
    expect(restored.size).toBe(2);
    expect(restored.get("a")?.name).toBe("wf-a");
    expect(restored.get("b")?.name).toBe("wf-b");
  });
});

// ── Backward compatibility ──────────────────────────────────

describe("backward compatibility", () => {
  it("old 'created' status deserializes as 'running'", () => {
    const serialized = {
      runId: "old-1",
      name: "old-wf",
      // 测旧版 "created" 状态迁移到 "running"（WorkflowStatus 联合不含 created）。
      // eslint-disable-next-line taste/no-unsafe-cast
      status: "created" as unknown as WorkflowStatus,
      callCache: [],
      trace: [],
      worker: "w1",
    };
    const restored = deserializePartial(serialized);
    expect(restored.status).toBe("running");
  });

  it("missing budget defaults to { usedTokens: 0, usedCost: 0 }", () => {
    const serialized = {
      runId: "no-budget",
      name: "wf",
      status: "running" as WorkflowStatus,
      callCache: [],
      trace: [],
      worker: "w1",
    };
    const restored = deserializePartial(serialized);
    expect(restored.budget).toEqual({ usedTokens: 0, usedCost: 0 });
  });

  it("missing trace defaults to empty array", () => {
    const serialized = {
      runId: "no-trace",
      name: "wf",
      status: "running" as WorkflowStatus,
      callCache: [],
      worker: "w1",
    };
    const restored = deserializePartial(serialized);
    expect(restored.trace).toEqual([]);
  });

  it("missing callCache defaults to empty map", () => {
    const serialized = {
      runId: "no-cache",
      name: "wf",
      status: "running" as WorkflowStatus,
      trace: [],
      worker: "w1",
    };
    const restored = deserializePartial(serialized);
    expect(restored.callCache.size).toBe(0);
  });

  it("deserializeState returns empty map for null input", () => {
    expect(deserializeState(null).size).toBe(0);
  });

  it("deserializeState returns empty map for wrong type", () => {
    expect(deserializeState({ type: "wrong" }).size).toBe(0);
  });

  it("deserializeState skips malformed entries", () => {
    const entry = {
      type: ENTRY_TYPE,
      instances: [
        { runId: "good", name: "ok", status: "running", callCache: [], trace: [], worker: "w" },
        null, // malformed
        undefined, // malformed
      ],
    };
    const restored = deserializeState(entry);
    expect(restored.size).toBe(1);
    expect(restored.get("good")?.name).toBe("ok");
  });
});
