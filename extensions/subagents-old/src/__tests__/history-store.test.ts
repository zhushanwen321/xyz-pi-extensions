// src/__tests__/history-store.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getHistoryFilePath } from "../config/config-path.ts";
import { buildPersistedRecord, HistoryStore } from "../persistence/history-store.ts";
import { HISTORY_MAX_RECORDS } from "../types.ts";

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-test-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function makeStore(cwd = "/fake/project"): HistoryStore {
  return new HistoryStore(tmpHome, cwd);
}

function makeRecord(overrides: Partial<Parameters<typeof buildPersistedRecord>[0]> = {}) {
  return buildPersistedRecord({
    id: "run-1",
    agent: "worker",
    status: "done",
    mode: "sync",
    task: "Fix the typo",
    startedAt: 1000,
    endedAt: 2000,
    turns: 3,
    totalTokens: 500,
    resultText: "Done",
    cwd: "/fake/project",
    ...overrides,
  });
}

describe("HistoryStore — ADR-024 L1", () => {
  it("append + read round-trip", async () => {
    const store = makeStore();
    await store.append(makeRecord({ id: "run-1" }));
    await store.append(makeRecord({ id: "run-2", agent: "reviewer" }));

    const records = store.read();
    expect(records).toHaveLength(2);
    expect(records[0].id).toBe("run-1");
    expect(records[1].id).toBe("run-2");
    expect(records[1].agent).toBe("reviewer");
  });

  it("read returns empty array when file does not exist", () => {
    const store = makeStore();
    expect(store.read()).toEqual([]);
  });

  it("recent(N) returns newest-first, limited to N", async () => {
    const store = makeStore();
    for (let i = 0; i < 5; i++) {
      await store.append(makeRecord({ id: `run-${i}`, startedAt: 1000 + i }));
    }
    const recent = store.recent(3);
    expect(recent).toHaveLength(3);
    // 新→旧
    expect(recent[0].id).toBe("run-4");
    expect(recent[2].id).toBe("run-2");
  });

  it("creates parent directories on first append", async () => {
    const store = makeStore("/deeply/nested/project");
    await store.append(makeRecord({ cwd: "/deeply/nested/project" }));
    const filePath = getHistoryFilePath(tmpHome, "/deeply/nested/project");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("isolates records by cwd", async () => {
    const storeA = makeStore("/project-a");
    const storeB = makeStore("/project-b");
    await storeA.append(makeRecord({ id: "run-a", cwd: "/project-a" }));
    await storeB.append(makeRecord({ id: "run-b", cwd: "/project-b" }));

    expect(storeA.read()).toHaveLength(1);
    expect(storeA.read()[0].id).toBe("run-a");
    expect(storeB.read()).toHaveLength(1);
    expect(storeB.read()[0].id).toBe("run-b");
  });

  it("skips corrupted lines, keeps valid ones", async () => {
    const store = makeStore();
    await store.append(makeRecord({ id: "run-1" }));
    // 手动写入损坏行
    const filePath = getHistoryFilePath(tmpHome, "/fake/project");
    fs.appendFileSync(filePath, "{not valid json\n");
    await store.append(makeRecord({ id: "run-2" }));

    const records = store.read();
    expect(records).toHaveLength(2);
    expect(records[0].id).toBe("run-1");
    expect(records[1].id).toBe("run-2");
  });

  it("truncatePreview limits taskPreview length", async () => {
    const longTask = "x".repeat(500);
    const store = makeStore();
    await store.append(makeRecord({ task: longTask }));
    const records = store.read();
    expect(records[0].taskPreview.length).toBeLessThanOrEqual(200);
    expect(records[0].taskPreview.endsWith("...")).toBe(true);
  });

  it("FIFO eviction when exceeding HISTORY_MAX_RECORDS", async () => {
    const store = makeStore();
    const overflow = 20;
    const total = HISTORY_MAX_RECORDS + overflow;
    for (let i = 0; i < total; i++) {
      await store.append(makeRecord({ id: `run-${i}`, startedAt: i }));
    }
    // 强制 GC（生产路径是概率性 1/10 触发）
    store.forceGc();
    const records = store.read();
    expect(records.length).toBe(HISTORY_MAX_RECORDS);
    // 最旧的 overflow 条被淘汰
    const ids = records.map((r) => r.id);
    expect(ids).not.toContain("run-0");
    expect(ids).not.toContain(`run-${overflow - 1}`);
    expect(ids).toContain(`run-${overflow}`);
    expect(ids).toContain(`run-${total - 1}`);
  });

  it("append is serial (no interleaved lines)", async () => {
    const store = makeStore();
    // 并发 append 20 条
    const promises = [];
    for (let i = 0; i < 20; i++) {
      promises.push(store.append(makeRecord({ id: `run-${i}` })));
    }
    await Promise.all(promises);
    const records = store.read();
    expect(records).toHaveLength(20);
    // 每个 id 唯一（行未交错）
    const ids = new Set(records.map((r) => r.id));
    expect(ids.size).toBe(20);
  });

  it("background mode records round-trip", async () => {
    const store = makeStore();
    await store.append(
      makeRecord({
        id: "bg-1-xxx",
        mode: "background",
        status: "failed",
        error: "model timeout",
        resultText: undefined,
      }),
    );
    const records = store.read();
    expect(records[0].mode).toBe("background");
    expect(records[0].status).toBe("failed");
    expect(records[0].error).toBe("model timeout");
  });

  it("sessionFile field preserved (L2 link)", async () => {
    const store = makeStore();
    await store.append(makeRecord({ sessionFile: "2026-06-14T10-00-00-000Z_abc.jsonl" }));
    const records = store.read();
    expect(records[0].sessionFile).toBe("2026-06-14T10-00-00-000Z_abc.jsonl");
  });

  it("model + thinkingLevel round-trip", async () => {
    const store = makeStore();
    await store.append(makeRecord({
      model: "anthropic/claude-sonnet-4.5",
      thinkingLevel: "high",
    }));
    const records = store.read();
    expect(records[0].model).toBe("anthropic/claude-sonnet-4.5");
    expect(records[0].thinkingLevel).toBe("high");
  });

  // ── FR-O1.6: 双写去重（cancelBackground 写 cancelled + runAgent catch 写 failed）──
  it("recent() dedupes by id, keeping latest endedAt (cancelled wins on tie)", async () => {
    const store = makeStore();
    // 模拟 cancel + abort catch 双写：同 id，先 cancelled（endedAt=2000）后 failed（endedAt=2000）
    await store.append(makeRecord({ id: "bg-1", status: "cancelled", startedAt: 1000, endedAt: 2000 }));
    await store.append(makeRecord({ id: "bg-1", status: "failed", startedAt: 1000, endedAt: 2000 }));
    const recent = store.recent(10);
    // 去重后只剩 1 条
    expect(recent).toHaveLength(1);
    // endedAt 相同时 cancelled 优先（保留用户意图）
    expect(recent[0].id).toBe("bg-1");
    expect(recent[0].status).toBe("cancelled");
  });

  it("recent() dedupes by id, keeping latest endedAt when timestamps differ", async () => {
    const store = makeStore();
    // failed 先写（endedAt=1500），cancelled 后写（endedAt=2000）
    await store.append(makeRecord({ id: "bg-2", status: "failed", startedAt: 1000, endedAt: 1500 }));
    await store.append(makeRecord({ id: "bg-2", status: "cancelled", startedAt: 1000, endedAt: 2000 }));
    const recent = store.recent(10);
    expect(recent).toHaveLength(1);
    // endedAt 更大的 cancelled 胜出
    expect(recent[0].status).toBe("cancelled");
  });

  it("recent() keeps distinct ids intact", async () => {
    const store = makeStore();
    await store.append(makeRecord({ id: "run-a", startedAt: 1000, endedAt: 2000 }));
    await store.append(makeRecord({ id: "run-b", startedAt: 1000, endedAt: 3000 }));
    await store.append(makeRecord({ id: "run-a", startedAt: 1000, endedAt: 4000 })); // run-a 更新
    const recent = store.recent(10);
    expect(recent).toHaveLength(2); // run-a + run-b
    // 新→旧：run-a(4000) 在前，run-b(3000) 在后
    expect(recent[0].id).toBe("run-a");
    expect(recent[1].id).toBe("run-b");
  });

  it("recent(0) returns empty array (P3 boundary fix)", async () => {
    const store = makeStore();
    await store.append(makeRecord({ id: "run-x" }));
    expect(store.recent(0)).toEqual([]);
  });

  // ── sessionId 过滤（/subagents list 只显示当前 session）──
  it("read(sessionId) filters by session", async () => {
    const store = makeStore();
    await store.append(makeRecord({ id: "run-a", sessionId: "sess-1" }));
    await store.append(makeRecord({ id: "run-b", sessionId: "sess-2" }));
    await store.append(makeRecord({ id: "run-c", sessionId: "sess-1" }));

    expect(store.read("sess-1")).toHaveLength(2);
    expect(store.read("sess-1").map((r) => r.id)).toEqual(["run-a", "run-c"]);
    expect(store.read("sess-2")).toHaveLength(1);
    expect(store.read("sess-2")[0].id).toBe("run-b");
  });

  it("read(undefined) returns all records (no filter, e.g. for GC)", async () => {
    const store = makeStore();
    await store.append(makeRecord({ id: "run-a", sessionId: "sess-1" }));
    await store.append(makeRecord({ id: "run-b", sessionId: "sess-2" }));
    expect(store.read()).toHaveLength(2);
  });

  it("recent(limit, sessionId) filters by session", async () => {
    const store = makeStore();
    await store.append(makeRecord({ id: "run-a", sessionId: "sess-1", startedAt: 1000 }));
    await store.append(makeRecord({ id: "run-b", sessionId: "sess-2", startedAt: 2000 }));
    await store.append(makeRecord({ id: "run-c", sessionId: "sess-1", startedAt: 3000 }));

    const recent = store.recent(10, "sess-1");
    expect(recent).toHaveLength(2);
    // 新→旧
    expect(recent[0].id).toBe("run-c");
    expect(recent[1].id).toBe("run-a");
  });

  it("records without sessionId are excluded when filtering", async () => {
    const store = makeStore();
    // 旧记录无 sessionId 字段（模拟迁移前数据）
    await store.append(makeRecord({ id: "old-1", sessionId: undefined }));
    await store.append(makeRecord({ id: "new-1", sessionId: "sess-1" }));
    // 过滤 sess-1 时，old-1（sessionId=undefined）被排除
    expect(store.read("sess-1")).toHaveLength(1);
    expect(store.read("sess-1")[0].id).toBe("new-1");
  });
});
