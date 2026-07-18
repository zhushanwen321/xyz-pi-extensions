import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { RecordStore } from "../execution/record-store";
import { ManifestStore } from "../execution/manifest-store";

describe("FR-8: Orphan Recovery from Manifest", () => {
  let sessionsDir: string;
  let recordsDir: string;
  let manifestStore: ManifestStore;

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-"));
    recordsDir = fs.mkdtempSync(path.join(os.tmpdir(), "records-"));
    manifestStore = new ManifestStore(recordsDir);
  });

  afterEach(() => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    fs.rmSync(recordsDir, { recursive: true, force: true });
  });

  it("should recover orphan records from manifest when session.jsonl is missing", async () => {
    const store = new RecordStore(sessionsDir, manifestStore);

    // Write a manifest record (simulating a subagent that crashed before writing session.jsonl)
    await manifestStore.writeManifest({
      id: "orphan-1",
      rootSessionId: "session-main",
      agentName: "worker",
      status: "completed",
      createdAt: 1000,
      completedAt: 2000,
      sessionFile: "/path/to/session.jsonl",
    });

    const records = store.collectRecords(100, "all", "session-main");
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe("orphan-1");
    expect(records[0].agent).toBe("worker");
    expect(records[0].status).toBe("done");
    expect(records[0].startedAt).toBe(1000);
    expect(records[0].endedAt).toBe(2000);
  });

  it("should not duplicate records already recovered from session.jsonl", async () => {
    // Create a session.jsonl with an identity entry (simulating successful reconstruction)
    const sessionId = "existing-session";
    const timestamp = "2026-07-18T12-00-00-000Z";
    const sessionFile = path.join(sessionsDir, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
    fs.writeFileSync(sessionFile, JSON.stringify({
      type: "custom",
      customType: "subagent-identity",
      data: {
        id: "existing-1",
        agent: "explorer",
        mode: "background",
        task: "explore codebase",
        slug: "explore",
        startedAt: 1000,
        rootSessionId: "session-main",
        depth: 0,
      },
    }) + "\n");

    // Also write a manifest for the same record
    await manifestStore.writeManifest({
      id: "existing-1",
      rootSessionId: "session-main",
      agentName: "explorer",
      status: "completed",
      createdAt: 1000,
      completedAt: 2000,
      sessionFile,
    });

    const store = new RecordStore(sessionsDir, manifestStore);
    const records = store.collectRecords(100, "all", "session-main");

    // Should have exactly 1 record (no duplication)
    const matching = records.filter((r) => r.id === "existing-1");
    expect(matching).toHaveLength(1);
  });

  it("should filter manifest records by rootSessionId", async () => {
    const store = new RecordStore(sessionsDir, manifestStore);

    await manifestStore.writeManifest({
      id: "orphan-session-a",
      rootSessionId: "session-a",
      agentName: "worker",
      status: "completed",
      createdAt: 1000,
    });

    await manifestStore.writeManifest({
      id: "orphan-session-b",
      rootSessionId: "session-b",
      agentName: "worker",
      status: "completed",
      createdAt: 2000,
    });

    const recordsA = store.collectRecords(100, "all", "session-a");
    expect(recordsA).toHaveLength(1);
    expect(recordsA[0].id).toBe("orphan-session-a");

    const recordsB = store.collectRecords(100, "all", "session-b");
    expect(recordsB).toHaveLength(1);
    expect(recordsB[0].id).toBe("orphan-session-b");
  });

  it("should map manifest status correctly", async () => {
    const store = new RecordStore(sessionsDir, manifestStore);

    await manifestStore.writeManifest({
      id: "status-completed",
      rootSessionId: "session-main",
      agentName: "worker",
      status: "completed",
      createdAt: 1000,
    });

    await manifestStore.writeManifest({
      id: "status-failed",
      rootSessionId: "session-main",
      agentName: "worker",
      status: "failed",
      createdAt: 2000,
    });

    await manifestStore.writeManifest({
      id: "status-error",
      rootSessionId: "session-main",
      agentName: "worker",
      status: "error",
      createdAt: 3000,
    });

    const records = store.collectRecords(100, "all", "session-main");
    expect(records).toHaveLength(3);

    const completed = records.find((r) => r.id === "status-completed");
    expect(completed?.status).toBe("done");

    const failed = records.find((r) => r.id === "status-failed");
    expect(failed?.status).toBe("failed");

    const error = records.find((r) => r.id === "status-error");
    expect(error?.status).toBe("failed");
  });

  it("in-memory records should take priority over manifest records", async () => {
    const store = new RecordStore(sessionsDir, manifestStore);

    // Register a running record in memory
    store.register({
      id: "memory-record",
      agent: "worker",
      model: "test/model",
      thinkingLevel: undefined,
      mode: "background",
      task: "test task",
      slug: "test",
      startedAt: 1000,
      rootSessionId: "session-main",
      parentRecordId: undefined,
      depth: 0,
      status: "running",
      turns: [],
      turnCount: 0,
      totalTokens: 0,
      lastError: undefined,
      endedAt: undefined,
      result: undefined,
      error: undefined,
      agentResult: undefined,
      sessionFile: undefined,
      controller: undefined,
    });

    // Also write a manifest with the same id but different status
    await manifestStore.writeManifest({
      id: "memory-record",
      rootSessionId: "session-main",
      agentName: "different-agent",
      status: "completed",
      createdAt: 500,
    });

    const records = store.collectRecords(100, "all", "session-main");
    expect(records).toHaveLength(1);
    // Memory record should win
    expect(records[0].status).toBe("running");
    expect(records[0].agent).toBe("worker");
  });

  it("should work without manifestStore (backward compatible)", () => {
    const store = new RecordStore(sessionsDir); // No manifestStore

    // Should not throw
    const records = store.collectRecords(100, "all", "session-main");
    expect(records).toHaveLength(0);
  });

  it("should handle manifest with status=running as running", async () => {
    const store = new RecordStore(sessionsDir, manifestStore);

    await manifestStore.writeManifest({
      id: "still-running",
      rootSessionId: "session-main",
      agentName: "worker",
      status: "running",
      createdAt: Date.now(),
    });

    const records = store.collectRecords(100, "all", "session-main");
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("running");
  });
});
