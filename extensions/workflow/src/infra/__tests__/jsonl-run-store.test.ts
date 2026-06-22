// 测试框架：vitest
// 运行命令：npx vitest run src/infra/__tests__/jsonl-run-store.test.ts

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentCall } from "../../engine/models/agent-call.js";
import { Budget } from "../../engine/models/budget.js";
import { Trace } from "../../engine/models/trace.js";
import { WorkflowRun } from "../../engine/models/workflow-run.js";
import { JsonlRunStore, SNAPSHOT_VERSION } from "../jsonl-run-store.js";

// ── Helpers ─────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSpec(): {
  scriptSource: string;
  args: Record<string, unknown>;
  scriptName: string;
  scriptPath: string;
  description?: string;
} {
  return {
    scriptSource: 'return "ok";',
    args: { key: "value" },
    scriptName: "test-script",
    scriptPath: "/tmp/test.mjs",
    description: "a test",
  };
}

function makePausedRun(runId = "run-1"): WorkflowRun {
  return new WorkflowRun(runId, makeSpec(), {
    status: "paused",
    budget: new Budget({ maxTokens: 1000 }),
    calls: new Map<number, AgentCall>(),
    trace: new Trace(),
    errorLogs: [],
  }, { startedAt: "2026-01-01T00:00:00.000Z" });
}

/** Mock ExtensionAPI capturing appendEntry calls. */
function mockPi(): ExtensionAPI & {
  _entries: Array<{ type: string; data: unknown }>;
} {
  const entries: Array<{ type: string; data: unknown }> = [];
  // eslint-disable-next-line taste/no-unsafe-cast
  return {
    appendEntry: vi.fn((type: string, data: unknown) => {
      entries.push({ type, data });
    }),
    _entries: entries,
  } as unknown as ExtensionAPI & { _entries: Array<{ type: string; data: unknown }> };
}

/** Build a mock ctx whose sessionManager.getEntries returns given entries. */
function mockCtx(entries: Array<{ type: string; customType?: string; data?: unknown }>): ExtensionContext {
  // eslint-disable-next-line taste/no-unsafe-cast
  return {
    sessionManager: {
      getEntries: () => entries,
    },
     
  } as unknown as ExtensionContext;
}

// ═══════════════════════════════════════════════════════════════
// Test suite covers save/loadAll round-trip + D-5 old-format handling;
// length exceeds default 300-line function cap intentionally.
// eslint-disable-next-line max-lines-per-function
describe("JsonlRunStore", () => {
  // ── save ──────────────────────────────────────────────────

  describe("save", () => {
    it("writes a single-line JSON snapshot to <sessionDir>/workflow-state/<runId>.jsonl", async () => {
      const store = new JsonlRunStore({ sessionDir: tmpDir });
      const run = makePausedRun("run-abc");
      await store.save(run);

      const filePath = path.join(tmpDir, "workflow-state", "run-abc.jsonl");
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n").filter((l) => l.trim());
      expect(lines.length).toBe(1); // rewrite mode: single line
    });

    it("snapshot includes SNAPSHOT_VERSION guard", async () => {
      const store = new JsonlRunStore({ sessionDir: tmpDir });
      await store.save(makePausedRun());
      const filePath = path.join(tmpDir, "workflow-state", "run-1.jsonl");
      const content = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(content.trim());
      expect(parsed.v).toBe(SNAPSHOT_VERSION);
    });

    it("appends workflow-state-link pointer entry via pi.appendEntry", async () => {
      const pi = mockPi();
      const store = new JsonlRunStore({ sessionDir: tmpDir, pi });
      await store.save(makePausedRun("run-link"));

      expect(pi._entries.length).toBe(1);
      expect(pi._entries[0]!.type).toBe("workflow-state-link");
      const data = pi._entries[0]!.data as { runId: string; path: string };
      expect(data.runId).toBe("run-link");
      expect(data.path).toContain("run-link.jsonl");
    });

    it("rewrite mode overwrites previous snapshot on re-save", async () => {
      const store = new JsonlRunStore({ sessionDir: tmpDir });
      const run = makePausedRun();
      await store.save(run);

      // Modify + re-save
      run.meta.pausedAt = "2026-01-02T00:00:00.000Z";
      await store.save(run);

      const filePath = path.join(tmpDir, "workflow-state", "run-1.jsonl");
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n").filter((l) => l.trim());
      expect(lines.length).toBe(1); // still single line
      const parsed = JSON.parse(lines[0]!);
      expect(parsed.meta.pausedAt).toBe("2026-01-02T00:00:00.000Z");
    });

    it("works without pi (no pointer entries, just file)", async () => {
      const store = new JsonlRunStore({ sessionDir: tmpDir });
      await store.save(makePausedRun());
      // No throw — pi is optional
      const filePath = path.join(tmpDir, "workflow-state", "run-1.jsonl");
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });

  // ── loadAll — round trip ──────────────────────────────────

  describe("loadAll round trip", () => {
    it("returns empty when ctx is undefined", async () => {
      const store = new JsonlRunStore({ sessionDir: tmpDir });
      const runs = await store.loadAll();
      expect(runs).toEqual([]);
    });

    it("reconstructs a saved run via pointer entries", async () => {
      const pi = mockPi();
      const store = new JsonlRunStore({ sessionDir: tmpDir, pi });
      const original = makePausedRun("run-rt");
      await store.save(original);

      // Build a fresh store with ctx that returns the pointer entries pi captured
      const store2 = new JsonlRunStore({
        sessionDir: tmpDir,
        ctx: mockCtx(pi._entries.map((e) => ({
          type: "custom",
          customType: e.type,
          data: e.data,
        }))),
      });
      const runs = await store2.loadAll();
      expect(runs.length).toBe(1);
      expect(runs[0]!.runId).toBe("run-rt");
      expect(runs[0]!.state.status).toBe("paused");
      expect(runs[0]!.spec.scriptName).toBe("test-script");
    });

    it("round-trips budget fields", async () => {
      const pi = mockPi();
      const store = new JsonlRunStore({ sessionDir: tmpDir, pi });
      const run = makePausedRun();
      run.state.budget.consume({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.05, contextTokens: 150, turns: 1 });
      run.state.budget.incrementCallCount();
      run.state.budget.incrementCallCount();
      await store.save(run);

      const store2 = new JsonlRunStore({
        sessionDir: tmpDir,
        ctx: mockCtx(pi._entries.map((e) => ({
          type: "custom",
          customType: e.type,
          data: e.data,
        }))),
      });
      const [loaded] = await store2.loadAll();
      expect(loaded!.state.budget.maxTokens).toBe(1000);
      expect(loaded!.state.budget.usedTokens).toBe(150);
      expect(loaded!.state.budget.usedCost).toBe(0.05);
      expect(loaded!.state.budget.totalCallCount).toBe(2);
    });

    it("round-trips calls (Map<number, AgentCall>)", async () => {
      const pi = mockPi();
      const store = new JsonlRunStore({ sessionDir: tmpDir, pi });
      const run = makePausedRun();
      const call = new AgentCall(42, { prompt: "test" }, {
        stepIndex: 42,
        agent: "default",
        task: "test",
        model: "test-model",
        status: "pending",
      });
      call.markRunning();
      call.markDone({ content: "result-text", usage: undefined });
      run.state.calls.set(42, call);
      await store.save(run);

      const store2 = new JsonlRunStore({
        sessionDir: tmpDir,
        ctx: mockCtx(pi._entries.map((e) => ({
          type: "custom",
          customType: e.type,
          data: e.data,
        }))),
      });
      const [loaded] = await store2.loadAll();
      expect(loaded!.state.calls.size).toBe(1);
      const restored = loaded!.state.calls.get(42);
      expect(restored).toBeDefined();
      expect(restored!.id).toBe(42);
      expect(restored!.opts.prompt).toBe("test");
      expect(restored!.result?.content).toBe("result-text");
      expect(restored!.status).toBe("done");
    });

    it("round-trips trace nodes", async () => {
      const pi = mockPi();
      const store = new JsonlRunStore({ sessionDir: tmpDir, pi });
      const run = makePausedRun();
      run.state.trace.append({
        stepIndex: 0,
        agent: "default",
        task: "first",
        model: "m1",
        status: "completed",
      });
      run.state.trace.append({
        stepIndex: 1,
        agent: "default",
        task: "second",
        model: "m2",
        status: "running",
      });
      await store.save(run);

      const store2 = new JsonlRunStore({
        sessionDir: tmpDir,
        ctx: mockCtx(pi._entries.map((e) => ({
          type: "custom",
          customType: e.type,
          data: e.data,
        }))),
      });
      const [loaded] = await store2.loadAll();
      expect(loaded!.state.trace.length).toBe(2);
      const nodes = loaded!.state.trace.toArray();
      expect(nodes[0]!.task).toBe("first");
      expect(nodes[1]!.status).toBe("running");
    });

    it("round-trips meta (startedAt, pausedAt, completedAt)", async () => {
      const pi = mockPi();
      const store = new JsonlRunStore({ sessionDir: tmpDir, pi });
      const run = makePausedRun();
      run.meta.pausedAt = "2026-02-01T00:00:00.000Z";
      run.meta.workerErrorCount = 3;
      await store.save(run);

      const store2 = new JsonlRunStore({
        sessionDir: tmpDir,
        ctx: mockCtx(pi._entries.map((e) => ({
          type: "custom",
          customType: e.type,
          data: e.data,
        }))),
      });
      const [loaded] = await store2.loadAll();
      expect(loaded!.meta.startedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(loaded!.meta.pausedAt).toBe("2026-02-01T00:00:00.000Z");
      expect(loaded!.meta.workerErrorCount).toBe(3);
    });

    it("reconstructed run has runtime===undefined (worker not rehydrated)", async () => {
      const pi = mockPi();
      const store = new JsonlRunStore({ sessionDir: tmpDir, pi });
      await store.save(makePausedRun());

      const store2 = new JsonlRunStore({
        sessionDir: tmpDir,
        ctx: mockCtx(pi._entries.map((e) => ({
          type: "custom",
          customType: e.type,
          data: e.data,
        }))),
      });
      const [loaded] = await store2.loadAll();
      expect(loaded!.runtime).toBeUndefined();
    });

    // ── D-4: reconstruct 不崩溃于 running 快照（I1 跳过） ───

    it("D-4: reconstructs a running run WITHOUT throwing I1 (kill-9 recovery path)", async () => {
      // 模拟 kill-9 崩溃前持久化的 running run：
      // 1. 构造 paused run（constructor 校验 I1 通过）
      // 2. 用 assignRuntime 进入 running（I1 保持：runtime!==undefined && status==="running"）
      // 3. 直接序列化（绕过 store.save，因为 save 会触发额外状态变化）——模拟崩溃前快照
      // 4. loadAll 重水合——必须不抛 I1（reconstruct 跳过校验），D-4 循环才能 catch 到
      const pi = mockPi();
      const store = new JsonlRunStore({ sessionDir: tmpDir, pi });

      // 构造 running run via assignRuntime
      const pausedRun = makePausedRun("kill9-run");
      const fakeRuntime = {
        worker: { postMessage() {}, terminate() {}, isCurrent: true, on() {} },
        gate: { enqueue: vi.fn(), activeCount: 0, queueLength: 0 },
        controller: new AbortController(),
        release() {},
        isReleased: false,
      };
      // eslint-disable-next-line taste/no-unsafe-cast
      pausedRun.assignRuntime(fakeRuntime as any);
      expect(pausedRun.state.status).toBe("running");

      // 持久化（snapshot 会含 status:"running"，runtime 不持久化）
      await store.save(pausedRun);

      // 重水合——D-4 路径的关键：reconstruct 不抛 I1
      const store2 = new JsonlRunStore({
        sessionDir: tmpDir,
        ctx: mockCtx(pi._entries.map((e) => ({
          type: "custom",
          customType: e.type,
          data: e.data,
        }))),
      });
      const loaded = await store2.loadAll();
      expect(loaded.length).toBe(1);
      const [reconstructed] = loaded;
      expect(reconstructed!.runId).toBe("kill9-run");
      // 关键断言：重水合后的 run status 仍是 running（worker 缺失但 I1 跳过校验）
      expect(reconstructed!.state.status).toBe("running");
      expect(reconstructed!.runtime).toBeUndefined();

      // D-4 kill-9 恢复：调用方把 running → done,failed（恢复 I1）
      reconstructed!.state.error = "Process killed (kill-9 or crash recovery)";
      reconstructed!.transition("done", "failed");
      expect(reconstructed!.state.status).toBe("done");
      expect(reconstructed!.state.reason).toBe("failed");
    });
  });

  // ── D-5: old format returns empty ─────────────────────────

  describe("D-5 — old format / version mismatch", () => {
    it("skips snapshots with wrong version (old session)", async () => {
      // Write a fake "old format" file with v="legacy-v0"
      const stateDir = path.join(tmpDir, "workflow-state");
      fs.mkdirSync(stateDir, { recursive: true });
      const filePath = path.join(stateDir, "run-old.jsonl");
      fs.writeFileSync(filePath, JSON.stringify({
        v: "legacy-v0",
        runId: "run-old",
        // ...old shape
      }) + "\n", "utf8");

      const store = new JsonlRunStore({
        sessionDir: tmpDir,
        ctx: mockCtx([{
          type: "custom",
          customType: "workflow-state-link",
          data: { runId: "run-old", path: filePath },
        }]),
      });
      const runs = await store.loadAll();
      // D-5: old format skipped, not reconstructed
      expect(runs.length).toBe(0);
    });

    it("skips snapshots with missing version field", async () => {
      const stateDir = path.join(tmpDir, "workflow-state");
      fs.mkdirSync(stateDir, { recursive: true });
      const filePath = path.join(stateDir, "run-noversion.jsonl");
      fs.writeFileSync(filePath, JSON.stringify({
        // No v field at all
        runId: "run-noversion",
        status: "running",
      }) + "\n", "utf8");

      const store = new JsonlRunStore({
        sessionDir: tmpDir,
        ctx: mockCtx([{
          type: "custom",
          customType: "workflow-state-link",
          data: { runId: "run-noversion", path: filePath },
        }]),
      });
      const runs = await store.loadAll();
      expect(runs.length).toBe(0);
    });

    it("skips corrupt/unreadable files (doesn't crash loadAll)", async () => {
      const stateDir = path.join(tmpDir, "workflow-state");
      fs.mkdirSync(stateDir, { recursive: true });
      const filePath = path.join(stateDir, "run-corrupt.jsonl");
      fs.writeFileSync(filePath, "not valid json {{{", "utf8");

      const store = new JsonlRunStore({
        sessionDir: tmpDir,
        ctx: mockCtx([{
          type: "custom",
          customType: "workflow-state-link",
          data: { runId: "run-corrupt", path: filePath },
        }]),
      });
      const runs = await store.loadAll();
      expect(runs.length).toBe(0); // skipped, no throw
    });

    it("mixed valid + old format: only valid returned", async () => {
      const pi = mockPi();
      const store = new JsonlRunStore({ sessionDir: tmpDir, pi });
      await store.save(makePausedRun("valid-run"));

      // Add an old-format file manually
      const stateDir = path.join(tmpDir, "workflow-state");
      const oldFilePath = path.join(stateDir, "old-run.jsonl");
      fs.writeFileSync(oldFilePath, JSON.stringify({ v: "legacy-v0", runId: "old-run" }) + "\n", "utf8");

      const entries = [
        ...pi._entries.map((e) => ({ type: "custom", customType: e.type, data: e.data })),
        { type: "custom", customType: "workflow-state-link", data: { runId: "old-run", path: oldFilePath } },
      ];
      const store2 = new JsonlRunStore({ sessionDir: tmpDir, ctx: mockCtx(entries) });
      const runs = await store2.loadAll();
      expect(runs.length).toBe(1);
      expect(runs[0]!.runId).toBe("valid-run");
    });
  });

  // ── Multiple runs ─────────────────────────────────────────

  describe("multiple runs", () => {
    it("reconstructs multiple saved runs", async () => {
      const pi = mockPi();
      const store = new JsonlRunStore({ sessionDir: tmpDir, pi });
      await store.save(makePausedRun("run-a"));
      await store.save(makePausedRun("run-b"));
      await store.save(makePausedRun("run-c"));

      const store2 = new JsonlRunStore({
        sessionDir: tmpDir,
        ctx: mockCtx(pi._entries.map((e) => ({
          type: "custom",
          customType: e.type,
          data: e.data,
        }))),
      });
      const runs = await store2.loadAll();
      expect(runs.length).toBe(3);
      const ids = runs.map((r) => r.runId).sort();
      expect(ids).toEqual(["run-a", "run-b", "run-c"]);
    });
  });

  // ── Non-custom entries ignored ───────────────────────────

  describe("filtering", () => {
    it("ignores non-custom and non-workflow-state-link entries", async () => {
      const pi = mockPi();
      const store = new JsonlRunStore({ sessionDir: tmpDir, pi });
      await store.save(makePausedRun());

      const store2 = new JsonlRunStore({
        sessionDir: tmpDir,
        ctx: mockCtx([
          // noise entries
          { type: "user-message", data: {} },
          { type: "assistant-message", data: {} },
          { type: "custom", customType: "some-other-type", data: {} },
          // valid pointer
          ...pi._entries.map((e) => ({ type: "custom", customType: e.type, data: e.data })),
        ]),
      });
      const runs = await store2.loadAll();
      expect(runs.length).toBe(1);
    });
  });
});
