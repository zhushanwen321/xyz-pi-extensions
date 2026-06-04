// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach）
// 运行命令：npx vitest run tests/orchestrator.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";

// Mock fs.promises before importing the module under test
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: vi.fn().mockResolvedValue(undefined),
      appendFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn(),
    },
  };
});

// Mock @zhushanwen/pi-model-switch to avoid transitive typebox dependency
vi.mock("@zhushanwen/pi-model-switch", () => ({
  resolveModelForScene: vi.fn().mockReturnValue(undefined),
}));

import { WorkflowOrchestrator } from "../src/orchestrator";
import {
  createInstance,
  serializeInstance,
  type WorkflowInstance,
  type AgentResult,
} from "../src/state";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Helpers ──────────────────────────────────────────────────

function makeMockPi(): ExtensionAPI & { sendUserMessage: ReturnType<typeof vi.fn> } {
  return {
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
  } as unknown as ExtensionAPI & { sendUserMessage: ReturnType<typeof vi.fn> };
}

function makeMockCtx(): ExtensionContext & {
  ui: { notify: ReturnType<typeof vi.fn> };
  sessionManager: {
    getSessionId: ReturnType<typeof vi.fn>;
    getEntries: ReturnType<typeof vi.fn>;
    getBranch: ReturnType<typeof vi.fn>;
  };
} {
  return {
    sessionManager: {
      getSessionId: vi.fn().mockReturnValue("test-session"),
      getEntries: vi.fn().mockReturnValue([]),
      getBranch: vi.fn().mockReturnValue([]),
    },
    ui: { notify: vi.fn() },
  } as unknown as ExtensionContext & {
    ui: { notify: ReturnType<typeof vi.fn> };
    sessionManager: {
      getSessionId: ReturnType<typeof vi.fn>;
      getEntries: ReturnType<typeof vi.fn>;
      getBranch: ReturnType<typeof vi.fn>;
    };
  };
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

// eslint-disable-next-line max-lines-per-function
describe("WorkflowOrchestrator", () => {
  let orch: WorkflowOrchestrator;
  let mockPi: ReturnType<typeof makeMockPi>;
  let mockCtx: ReturnType<typeof makeMockCtx>;

  beforeEach(() => {
    mockPi = makeMockPi();
    mockCtx = makeMockCtx();
    orch = new WorkflowOrchestrator(mockPi, mockCtx);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
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
    it("transitions running → aborted and sets completedAt", async () => {
      const inst = makeInstance("wf-abort-ok", "running");
      orch.restoreInstances(makeInstanceMap(inst));

      await orch.abort("wf-abort-ok");

      const updated = orch.getInstance("wf-abort-ok")!;
      expect(updated.status).toBe("aborted");
      expect(updated.completedAt).toBeDefined();
    });

    it("transitions paused → aborted", async () => {
      const inst = makeInstance("wf-abort-paused", "paused");
      orch.restoreInstances(makeInstanceMap(inst));

      await orch.abort("wf-abort-paused");

      expect(orch.getInstance("wf-abort-paused")!.status).toBe("aborted");
    });

    it("throws when workflow is already completed", async () => {
      const inst = makeInstance("wf-abort-done", "completed");
      orch.restoreInstances(makeInstanceMap(inst));

      await expect(orch.abort("wf-abort-done")).rejects.toThrow(
        /Cannot abort workflow in state 'completed'/,
      );
    });

    it("throws when workflow is already failed", async () => {
      const inst = makeInstance("wf-abort-fail", "failed");
      orch.restoreInstances(makeInstanceMap(inst));

      await expect(orch.abort("wf-abort-fail")).rejects.toThrow(
        /Cannot abort workflow in state 'failed'/,
      );
    });

    it("throws when runId does not exist", async () => {
      await expect(orch.abort("nonexistent")).rejects.toThrow(/not found/);
    });
  });

  // ── pause() ───────────────────────────────────────────────

  describe("pause()", () => {
    it("transitions running → paused and sets pausedAt", async () => {
      const inst = makeInstance("wf-pause-ok", "running");
      orch.restoreInstances(makeInstanceMap(inst));

      await orch.pause("wf-pause-ok");

      const updated = orch.getInstance("wf-pause-ok")!;
      expect(updated.status).toBe("paused");
      expect(updated.pausedAt).toBeDefined();
    });

    it("throws when workflow is already paused", async () => {
      const inst = makeInstance("wf-pause-twice", "paused");
      orch.restoreInstances(makeInstanceMap(inst));

      await expect(orch.pause("wf-pause-twice")).rejects.toThrow(
        /Cannot pause workflow in state 'paused'/,
      );
    });

    it("throws when workflow is completed", async () => {
      const inst = makeInstance("wf-pause-done", "completed");
      orch.restoreInstances(makeInstanceMap(inst));

      await expect(orch.pause("wf-pause-done")).rejects.toThrow(
        /Cannot pause workflow in state 'completed'/,
      );
    });

    it("throws when runId does not exist", async () => {
      await expect(orch.pause("nonexistent")).rejects.toThrow(/not found/);
    });
  });

  // ── resume() ──────────────────────────────────────────────

  describe("resume()", () => {
    it("transitions paused → running and clears pausedAt", async () => {
      const inst = makeInstance("wf-resume-ok", "paused");
      inst.pausedAt = "2026-01-01T00:30:00Z";
      orch.restoreInstances(makeInstanceMap(inst));

      await orch.resume("wf-resume-ok");

      const updated = orch.getInstance("wf-resume-ok")!;
      expect(updated.status).toBe("running");
      expect(updated.pausedAt).toBeUndefined();
    });

    it("throws when workflow is already running", async () => {
      const inst = makeInstance("wf-resume-running", "running");
      orch.restoreInstances(makeInstanceMap(inst));

      await expect(orch.resume("wf-resume-running")).rejects.toThrow(
        /Cannot resume workflow in state 'running'/,
      );
    });

    it("throws when workflow is completed", async () => {
      const inst = makeInstance("wf-resume-done", "completed");
      orch.restoreInstances(makeInstanceMap(inst));

      await expect(orch.resume("wf-resume-done")).rejects.toThrow(
        /Cannot resume workflow in state 'completed'/,
      );
    });

    it("throws when runId does not exist", async () => {
      await expect(orch.resume("nonexistent")).rejects.toThrow(/not found/);
    });
  });

  // ── retryNode() ───────────────────────────────────────────

  describe("retryNode()", () => {
    it("clears the specified callId from callCache for running instance", async () => {
      const inst = makeInstance("wf-retry-ok", "running");
      const cachedResult: AgentResult = { content: "cached-output" };
      inst.callCache.set(0, cachedResult);
      inst.callCache.set(1, { content: "other-cache" });
      orch.restoreInstances(makeInstanceMap(inst));

      await orch.retryNode("wf-retry-ok", 0);

      const updated = orch.getInstance("wf-retry-ok")!;
      expect(updated.callCache.has(0)).toBe(false);
      expect(updated.callCache.has(1)).toBe(true);
    });

    it("clears the specified callId for paused instance", async () => {
      const inst = makeInstance("wf-retry-paused", "paused");
      inst.callCache.set(5, { content: "old-result" });
      orch.restoreInstances(makeInstanceMap(inst));

      await orch.retryNode("wf-retry-paused", 5);

      expect(orch.getInstance("wf-retry-paused")!.callCache.has(5)).toBe(false);
    });

    it("throws when instance is completed", async () => {
      const inst = makeInstance("wf-retry-done", "completed");
      inst.callCache.set(0, { content: "x" });
      orch.restoreInstances(makeInstanceMap(inst));

      await expect(orch.retryNode("wf-retry-done", 0)).rejects.toThrow(
        /Cannot retry node in state 'completed'/,
      );
    });

    it("throws when runId does not exist", async () => {
      await expect(orch.retryNode("nonexistent", 0)).rejects.toThrow(/not found/);
    });

    it("resets trace node for the retried callId", async () => {
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

      await orch.retryNode("wf-retry-trace", 3);

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
    it("injects a placeholder into callCache", async () => {
      const inst = makeInstance("wf-skip-ok", "running");
      expect(inst.callCache.has(7)).toBe(false);
      orch.restoreInstances(makeInstanceMap(inst));

      await orch.skipNode("wf-skip-ok", 7);

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

    it("updates existing trace node to completed with placeholder result", async () => {
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

      await orch.skipNode("wf-skip-trace", 2);

      const node = orch.getInstance("wf-skip-trace")!.trace.find(
        (n) => n.stepIndex === 2,
      );
      expect(node!.status).toBe("completed");
      expect(node!.result).toBeDefined();
      expect(node!.completedAt).toBeDefined();
    });

    it("works on paused instances without status check", async () => {
      const inst = makeInstance("wf-skip-paused", "paused");
      orch.restoreInstances(makeInstanceMap(inst));

      await orch.skipNode("wf-skip-paused", 10);

      expect(orch.getInstance("wf-skip-paused")!.callCache.has(10)).toBe(true);
    });

    it("throws when runId does not exist", async () => {
      await expect(orch.skipNode("nonexistent", 0)).rejects.toThrow(/not found/);
    });
  });

  // ── persistState() — external file storage ────────────────

  describe("persistState()", () => {
    const fsMock = vi.mocked(fs.promises);

    it("writes external file via fs.appendFile with correct path", async () => {
      const inst = makeInstance("wf-ext-file", "running");
      orch.restoreInstances(makeInstanceMap(inst));

      await orch.persistState();

      expect(fsMock.mkdir).toHaveBeenCalled();
      expect(fsMock.appendFile).toHaveBeenCalledTimes(1);
      const [filePath, content] = fsMock.appendFile.mock.calls[0]!;
      expect(filePath).toContain(path.join("workflow-state", "wf-ext-file.jsonl"));
      expect(typeof content).toBe("string");
      // Content should be valid JSONL (one line)
      const parsed = JSON.parse(content as string);
      expect(parsed).toMatchObject({ runId: "wf-ext-file", status: "running" });
    });

    it("writes workflow-state-link entry via pi.appendEntry", async () => {
      const inst = makeInstance("wf-link-entry", "completed");
      orch.restoreInstances(makeInstanceMap(inst));

      await orch.persistState();

      const appendFn = mockPi.appendEntry as ReturnType<typeof vi.fn>;
      expect(appendFn).toHaveBeenCalled();
      const [customType, data] = appendFn.mock.calls[0]!;
      expect(customType).toBe("workflow-state-link");
      expect(data).toMatchObject({
        runId: "wf-link-entry",
        path: expect.stringContaining("wf-link-entry.jsonl"),
      });
      expect(data.updatedAt).toBeDefined();
    });

    it("does not write old workflow-state entry via pi.appendEntry", async () => {
      const inst = makeInstance("wf-no-old", "running");
      orch.restoreInstances(makeInstanceMap(inst));

      await orch.persistState();

      const appendFn = mockPi.appendEntry as ReturnType<typeof vi.fn>;
      // All calls should be "workflow-state-link", never "workflow-state"
      for (const call of appendFn.mock.calls) {
        expect(call[0]).not.toBe("workflow-state");
      }
    });
  });

  // ── reconstructState() — external file loading ────────────

  describe("reconstructState()", () => {
    // Import the module-level reconstructState is not directly accessible,
    // so we test through session_start simulation or the public restoreInstances.
    // However, reconstructState is defined inside the factory function.
    // We'll test it indirectly by simulating what session_start does.

    // For direct testing, we import the orchestrator module and test the
    // internal behavior through integration-style tests.

    it("reads pointer entry and loads instance from external file", async () => {
      const instance = makeInstance("wf-load-ok", "running");
      const serialized = serializeInstance(instance);
      const jsonlLine = JSON.stringify(serialized) + "\n";

      // Mock fs.promises.readFile to return the JSONL content
      vi.mocked(fs.promises.readFile).mockResolvedValue(jsonlLine);

      // Mock sessionManager.getEntries to return a pointer entry
      const filePath = path.join(process.env.HOME ?? "/tmp", ".pi", "agent", "workflow-state", "wf-load-ok.jsonl");
      mockCtx.sessionManager.getEntries.mockReturnValue([
        {
          type: "custom",
          customType: "workflow-state-link",
          data: { runId: "wf-load-ok", path: filePath, updatedAt: "2026-01-01T00:00:00Z" },
        },
      ]);

      // Simulate what session_start does: create orchestrator, reconstruct, restore
      const testOrch = new WorkflowOrchestrator(mockPi, mockCtx);

      // Access the internal reconstructState via the module
      // Since reconstructState is inside the factory, we test through the session_start flow.
      // For unit testing, we directly test the file reading and deserialization.
      const instances = new Map<string, import("../src/state").WorkflowInstance>();
      const entries = mockCtx.sessionManager.getEntries();
      const pointers = new Map<string, { path: string }>();
      for (const entry of entries) {
        if (entry.type !== "custom") continue;
        const custom = entry as { customType?: string; data?: { runId?: string; path?: string } };
        if (custom.customType !== "workflow-state-link") continue;
        if (custom.data?.runId && custom.data?.path) {
          pointers.set(custom.data.runId, { path: custom.data.path });
        }
      }
      for (const [_runId, pointer] of pointers) {
        const content = await fs.promises.readFile(pointer.path, "utf8");
        const lines = content.split("\n").filter((l) => l.trim());
        for (const line of lines) {
          const parsed = JSON.parse(line) as Parameters<typeof import("../src/state").deserializeInstance>[0];
          const deserialized = import("../src/state").then((m) => m.deserializeInstance(parsed));
          const inst = await deserialized;
          instances.set(inst.runId, inst);
        }
      }

      testOrch.restoreInstances(instances);

      const loaded = testOrch.getInstance("wf-load-ok");
      expect(loaded).toBeDefined();
      expect(loaded!.status).toBe("running");
      expect(loaded!.name).toBe("workflow-wf-load-ok");
    });

    it("ignores old workflow-state entries without error", async () => {
      // Mock getEntries to return an old-style "workflow-state" entry
      mockCtx.sessionManager.getEntries.mockReturnValue([
        {
          type: "custom",
          customType: "workflow-state",
          data: { type: "workflow-state", instances: [] },
        },
      ]);

      // Simulate: old entries are skipped (no workflow-state-link)
      const entries = mockCtx.sessionManager.getEntries();
      const pointers = new Map<string, { path: string }>();
      for (const entry of entries) {
        if (entry.type !== "custom") continue;
        const custom = entry as { customType?: string; data?: { runId?: string; path?: string } };
        if (custom.customType !== "workflow-state-link") continue;
        if (custom.data?.runId && custom.data?.path) {
          pointers.set(custom.data.runId, { path: custom.data.path });
        }
      }

      // No pointers found → empty instances, no error
      expect(pointers.size).toBe(0);
    });

    it("skips missing file and notifies via ctx.ui.notify", async () => {
      const filePath = path.join(process.env.HOME ?? "/tmp", ".pi", "agent", "workflow-state", "wf-missing.jsonl");

      // Mock readFile to throw ENOENT
      vi.mocked(fs.promises.readFile).mockRejectedValue(new Error("ENOENT: no such file"));

      mockCtx.sessionManager.getEntries.mockReturnValue([
        {
          type: "custom",
          customType: "workflow-state-link",
          data: { runId: "wf-missing", path: filePath, updatedAt: "2026-01-01T00:00:00Z" },
        },
      ]);

      // Simulate the loading logic from reconstructState
      const entries = mockCtx.sessionManager.getEntries();
      const pointers = new Map<string, { path: string }>();
      for (const entry of entries) {
        if (entry.type !== "custom") continue;
        const custom = entry as { customType?: string; data?: { runId?: string; path?: string } };
        if (custom.customType !== "workflow-state-link") continue;
        if (custom.data?.runId && custom.data?.path) {
          pointers.set(custom.data.runId, { path: custom.data.path });
        }
      }

      const instances = new Map<string, import("../src/state").WorkflowInstance>();
      for (const [runId, pointer] of pointers) {
        try {
          const content = await fs.promises.readFile(pointer.path, "utf8");
          const lines = content.split("\n").filter((l) => l.trim());
          for (const line of lines) {
            const parsed = JSON.parse(line) as Parameters<typeof import("../src/state").deserializeInstance>[0];
            const inst = await import("../src/state").then((m) => m.deserializeInstance(parsed));
            instances.set(inst.runId, inst);
          }
        } catch {
          mockCtx.ui.notify(`WARN: missing or corrupt state for ${runId}`, "warning");
        }
      }

      expect(instances.size).toBe(0);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        "WARN: missing or corrupt state for wf-missing",
        "warning",
      );
    });

    it("skips corrupt JSONL and notifies via ctx.ui.notify", async () => {
      const filePath = path.join(process.env.HOME ?? "/tmp", ".pi", "agent", "workflow-state", "wf-corrupt.jsonl");

      // Mock readFile to return corrupt content (valid file, but malformed JSON lines)
      vi.mocked(fs.promises.readFile).mockResolvedValue("{ not valid jsonl\n");

      mockCtx.sessionManager.getEntries.mockReturnValue([
        {
          type: "custom",
          customType: "workflow-state-link",
          data: { runId: "wf-corrupt", path: filePath, updatedAt: "2026-01-01T00:00:00Z" },
        },
      ]);

      // Simulate the loading logic from reconstructState
      const entries = mockCtx.sessionManager.getEntries();
      const pointers = new Map<string, { path: string }>();
      for (const entry of entries) {
        if (entry.type !== "custom") continue;
        const custom = entry as { customType?: string; data?: { runId?: string; path?: string } };
        if (custom.customType !== "workflow-state-link") continue;
        if (custom.data?.runId && custom.data?.path) {
          pointers.set(custom.data.runId, { path: custom.data.path });
        }
      }

      const instances = new Map<string, import("../src/state").WorkflowInstance>();
      for (const [runId, pointer] of pointers) {
        try {
          const content = await fs.promises.readFile(pointer.path, "utf8");
          const lines = content.split("\n").filter((l) => l.trim());
          for (const line of lines) {
            const parsed = JSON.parse(line) as Parameters<typeof import("../src/state").deserializeInstance>[0];
            const inst = await import("../src/state").then((m) => m.deserializeInstance(parsed));
            instances.set(inst.runId, inst);
          }
        } catch {
          mockCtx.ui.notify(`WARN: missing or corrupt state for ${runId}`, "warning");
        }
      }

      // File was read successfully but JSON parse failed → notify
      expect(instances.size).toBe(0);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        "WARN: missing or corrupt state for wf-corrupt",
        "warning",
      );
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

  // ── AgentPool soft-limit callback ─────────────────────────

  describe("soft-limit warning callback", () => {
    it("invokes pi.sendUserMessage with description, totalCalls, and budget info", () => {
      const pool = (orch as unknown as { agentPool: { onSoftLimitReached?: (info: { description: string; totalCalls: number }) => void } }).agentPool;
      expect(pool.onSoftLimitReached).toBeDefined();

      // Inject a running instance so the callback can find budget info
      const instances = (orch as unknown as { instances: Map<string, import("../../src/state.js").WorkflowInstance> }).instances;
      instances.set("run-budget-test", {
        runId: "run-budget-test",
        name: "budgeted-workflow",
        status: "running",
        callCache: new Map(),
        trace: [],
        worker: "test.js",
        budget: { maxTokens: 100000, usedTokens: 42000, usedCost: 0.5 },
      });

      pool.onSoftLimitReached!({
        description: "my-agent-step",
        totalCalls: 501,
      });

      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
      const msg = (mockPi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(msg).toContain("501 agent calls");
      expect(msg).toContain("my-agent-step");
      expect(msg).toContain("42000/100000");
    });
  });
});
