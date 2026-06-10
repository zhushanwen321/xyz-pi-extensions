// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）
// 运行命令：npx vitest run src/__tests__/state-store.test.ts

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { persistState, reconstructState } from "../infra/state-store.js";
import { createInstance, serializeInstance, type WorkflowInstance } from "../domain/state.js";

// ── Mock helpers ──────────────────────────────────────────────

function makeMockPi() {
  return {
    appendEntry: vi.fn(),
  };
}

function makeMockCtx(entries: unknown[] = []) {
  return {
    sessionManager: {
      getSessionId: vi.fn().mockReturnValue("test-session"),
      getEntries: vi.fn().mockReturnValue(entries),
    },
    ui: { notify: vi.fn() },
  };
}

function makeInstance(overrides: Partial<WorkflowInstance> = {}): WorkflowInstance {
  const base = createInstance({
    runId: "run-test-1",
    name: "test-workflow",
    worker: "worker-1",
  });
  return { ...base, ...overrides };
}

// ── Tests ─────────────────────────────────────────────────────

describe("state-store.ts", () => {
  const tmpDir = path.join(os.tmpdir(), `state-store-test-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("persistState()", () => {
    it("writes instance to JSONL file using writeFile (rewrite mode)", async () => {
      const pi = makeMockPi();
      const inst = makeInstance();
      const instances = new Map([["run-test-1", inst]]);

      await persistState(pi as unknown as Parameters<typeof persistState>[0], tmpDir, instances);

      const filePath = path.join(tmpDir, "workflow-state", "run-test-1.jsonl");
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, "utf8").trim();
      const parsed = JSON.parse(content);
      expect(parsed.runId).toBe("run-test-1");
      expect(parsed.status).toBe("running");
    });

    it("overwrites on second call (rewrite mode, not append)", async () => {
      const pi = makeMockPi();
      const inst = makeInstance();
      const instances = new Map([["run-test-1", inst]]);

      await persistState(pi as unknown as Parameters<typeof persistState>[0], tmpDir, instances);

      // Modify and persist again
      inst.status = "completed";
      inst.completedAt = "2026-01-01T00:00:00Z";
      await persistState(pi as unknown as Parameters<typeof persistState>[0], tmpDir, instances);

      const filePath = path.join(tmpDir, "workflow-state", "run-test-1.jsonl");
      const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
      // Rewrite mode: should have exactly 1 line
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.status).toBe("completed");
    });

    it("calls pi.appendEntry with workflow-state-link", async () => {
      const pi = makeMockPi();
      const inst = makeInstance();
      await persistState(pi as unknown as Parameters<typeof persistState>[0], tmpDir, new Map([["run-test-1", inst]]));

      expect(pi.appendEntry).toHaveBeenCalledWith("workflow-state-link", expect.objectContaining({
        runId: "run-test-1",
      }));
    });

    it("handles multiple instances", async () => {
      const pi = makeMockPi();
      const inst1 = makeInstance({ runId: "run-1" });
      const inst2 = makeInstance({ runId: "run-2" });
      const instances = new Map([["run-1", inst1], ["run-2", inst2]]);

      await persistState(pi as unknown as Parameters<typeof persistState>[0], tmpDir, instances);

      expect(fs.existsSync(path.join(tmpDir, "workflow-state", "run-1.jsonl"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "workflow-state", "run-2.jsonl"))).toBe(true);
      expect(pi.appendEntry).toHaveBeenCalledTimes(2);
    });
  });

  describe("reconstructState()", () => {
    it("reconstructs instances from pointer entries", async () => {
      const inst = makeInstance();
      const filePath = path.join(tmpDir, "workflow-state", "run-test-1.jsonl");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // Write via serializeInstance to ensure correct format
      fs.writeFileSync(filePath, JSON.stringify(serializeInstance(inst)) + "\n");

      const entries = [
        { type: "custom", customType: "workflow-state-link", data: { runId: "run-test-1", path: filePath } },
      ];
      const ctx = makeMockCtx(entries);

      const result = await reconstructState(ctx as unknown as Parameters<typeof reconstructState>[0]);

      expect(result.size).toBe(1);
      expect(result.get("run-test-1")?.runId).toBe("run-test-1");
    });

    it("reads last line for backward compat with old append files", async () => {
      const filePath = path.join(tmpDir, "workflow-state", "run-old.jsonl");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // Simulate old append-mode file with 3 snapshots
      const old = makeInstance({ runId: "run-old", status: "running" });
      const mid = makeInstance({ runId: "run-old", status: "paused" });
      const latest = makeInstance({ runId: "run-old", status: "completed" });
      fs.writeFileSync(filePath, [JSON.stringify(serializeInstance(old)), JSON.stringify(serializeInstance(mid)), JSON.stringify(serializeInstance(latest))].join("\n") + "\n");

      const entries = [
        { type: "custom", customType: "workflow-state-link", data: { runId: "run-old", path: filePath } },
      ];
      const ctx = makeMockCtx(entries);

      const result = await reconstructState(ctx as unknown as Parameters<typeof reconstructState>[0]);
      expect(result.get("run-old")?.status).toBe("completed");
    });

    it("creates state_lost placeholder for missing state file", async () => {
      const entries = [
        { type: "custom", customType: "workflow-state-link", data: { runId: "run-missing", path: "/nonexistent/file.jsonl" } },
      ];
      const ctx = makeMockCtx(entries);

      const result = await reconstructState(ctx as unknown as Parameters<typeof reconstructState>[0]);
      expect(result.get("run-missing")?.status).toBe("state_lost");
    });

    it("returns empty map when no pointer entries exist", async () => {
      const ctx = makeMockCtx([]);
      const result = await reconstructState(ctx as unknown as Parameters<typeof reconstructState>[0]);
      expect(result.size).toBe(0);
    });

    it("returns empty map when getEntries fails", async () => {
      const ctx = {
        sessionManager: { getEntries: vi.fn().mockImplementation(() => { throw new Error("fail"); }) },
        ui: { notify: vi.fn() },
      };
      const result = await reconstructState(ctx as unknown as Parameters<typeof reconstructState>[0]);
      expect(result.size).toBe(0);
    });

    it("last pointer wins for same runId", async () => {
      const filePath = path.join(tmpDir, "workflow-state", "run-dup.jsonl");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const inst = makeInstance({ runId: "run-dup", status: "completed" });
      fs.writeFileSync(filePath, JSON.stringify(serializeInstance(inst)) + "\n");

      const entries = [
        { type: "custom", customType: "workflow-state-link", data: { runId: "run-dup", path: "/old/path.jsonl" } },
        { type: "custom", customType: "workflow-state-link", data: { runId: "run-dup", path: filePath } },
      ];
      const ctx = makeMockCtx(entries);

      const result = await reconstructState(ctx as unknown as Parameters<typeof reconstructState>[0]);
      expect(result.size).toBe(1);
      expect(result.get("run-dup")?.status).toBe("completed");
    });
  });
});
