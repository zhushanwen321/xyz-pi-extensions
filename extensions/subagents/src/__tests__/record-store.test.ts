// src/__tests__/record-store.test.ts
//
// RecordStore 专属测试。
// 覆盖：
//   - archive 立即移除（终态 record 不留内存，读时从 session.jsonl 重建）
//   - collectRecords 合并内存(running) + 磁盘(session.jsonl 重建)
//   - collectRecords statusFilter（"running" vs "all"）
//   - cancelled tombstone override
//   - compareRecords 排序（status priority + startedAt desc）
//   - 重建缓存（notifyChange 失效）
//
// 用 tmpdir + 真实 .jsonl fixture（隔离真实文件系统，同 session-reconstructor.test.ts 模式）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRecord } from "../core/execution-record.ts";
import { writeAliveMarker } from "../runtime/execution/alive-store.ts";
import { writeFinalized } from "../runtime/execution/finalized-marker.ts";
import type { StatusFilter } from "../runtime/execution/record-store.ts";
import { RecordStore } from "../runtime/execution/record-store.ts";
import { writeCancelledTombstone } from "../runtime/execution/tombstone-store.ts";
import type { AliveMarker, ExecutionRecord } from "../types.ts";

/** 构造 ExecutionRecord（base 默认 running，over 覆盖任意字段）。 */
function makeRecord(over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const base = createRecord("r1", {
    agent: "worker",
    model: "m",
    mode: "sync",
    task: "t",
    startedAt: 1000,
    parentSessionId: "sess-current",
  });
  return { ...base, ...over };
}

/**
 * 写一个最小合法的 session.jsonl（含 identity custom entry + 1 个 assistant message）。
 * 用于 collectRecords 磁盘源重建测试。
 */
function writeSessionJsonl(
  filePath: string,
  identity: { id: string; agent: string; mode: "sync" | "background"; task: string; startedAt: number; parentSessionId?: string; lastTs?: number },
  assistantText = "result text",
): void {
  const lastTs = identity.lastTs ?? identity.startedAt + 1000;
  const header = JSON.stringify({
    type: "session", version: 3, id: "sess-uuid", timestamp: new Date(identity.startedAt).toISOString(), cwd: "/tmp",
  });
  const identityData: Record<string, unknown> = {
    id: identity.id,
    agent: identity.agent,
    mode: identity.mode,
    task: identity.task,
    startedAt: identity.startedAt,
  };
  if (identity.parentSessionId !== undefined) identityData.parentSessionId = identity.parentSessionId;
  const identityEntry = JSON.stringify({
    type: "custom",
    id: "id-1",
    parentId: null,
    timestamp: new Date(identity.startedAt).toISOString(),
    customType: "subagent-identity",
    data: identityData,
  });
  const assistantMsg = JSON.stringify({
    type: "message",
    id: "msg-1",
    parentId: "id-1",
    timestamp: new Date(lastTs).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: assistantText }],
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { total: 0 } },
      stopReason: "stop",
      timestamp: lastTs,
    },
  });
  fs.writeFileSync(filePath, `${header}\n${identityEntry}\n${assistantMsg}\n`, "utf-8");
}

describe("RecordStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ============================================================
  // archive 立即移除
  // ============================================================
  describe("archive 立即移除", () => {
    it("archive 后 record 立即从内存移除（不再 linger）", () => {
      const store = new RecordStore(tmpDir);
      const r = makeRecord({ id: "sync-1", mode: "sync", status: "done" });
      store.register(r);
      expect(store.getMutable("sync-1")).toBeDefined();
      store.archive(r);
      expect(store.getMutable("sync-1")).toBeUndefined();
    });

    it("background record 同样立即移除（不再 FIFO）", () => {
      const store = new RecordStore(tmpDir);
      const r = makeRecord({ id: "bg-1", mode: "background", status: "done" });
      store.register(r);
      store.archive(r);
      expect(store.getMutable("bg-1")).toBeUndefined();
    });
  });

  // ============================================================
  // collectRecords：内存(running) + 磁盘(重建) 合并
  // ============================================================
  describe("collectRecords 合并", () => {
    it("内存 running record 出现在结果中", () => {
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "run-1", mode: "background", startedAt: 1000 }));
      const ids = store.collectRecords(100).map((r) => r.id);
      expect(ids).toContain("run-1");
    });

    it("磁盘 session.jsonl 重建的终态 record 出现在结果中（无 sidecar → crashed）", () => {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-a.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "worker", mode: "background", task: "do it", startedAt: 5000,
      });
      // 无 sidecar → 四分支兜底 crashed
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === "bg-1");
      expect(found).toBeDefined();
      expect(found?.status).toBe("crashed");
      expect(found?.agent).toBe("worker");
      expect(found?.turns).toBe(1);
      expect(found?.totalTokens).toBe(30);
      expect(found?.result).toBe("result text");
    });

    it("磁盘 session.jsonl + .finalized sidecar → done", () => {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-b.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-2", agent: "worker", mode: "background", task: "do it", startedAt: 5000,
      });
      writeFinalized(sessionFile);
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === "bg-2");
      expect(found).toBeDefined();
      expect(found?.status).toBe("done");
    });

    it("statusFilter='running' 只返回 running（磁盘终态被滤掉）", () => {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-a.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "worker", mode: "background", task: "do it", startedAt: 5000,
      });
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "run-1", mode: "background", startedAt: 1000 }));
      const filter: StatusFilter = "running";
      const ids = store.collectRecords(100, filter).map((r) => r.id);
      expect(ids).toEqual(["run-1"]); // 只有内存 running，磁盘 crashed 被滤
    });

    it("statusFilter='all'（默认）返回内存 + 磁盘", () => {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-a.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "worker", mode: "background", task: "do it", startedAt: 5000,
      });
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "run-1", mode: "background", startedAt: 1000 }));
      const ids = store.collectRecords(100).map((r) => r.id);
      expect(ids).toContain("run-1");
      expect(ids).toContain("bg-1");
    });

    it("内存 running 优先于磁盘同 id（内存覆盖）", () => {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-a.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "dup-1", agent: "worker", mode: "background", task: "from disk", startedAt: 5000,
      });
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "dup-1", mode: "background", status: "running", startedAt: 5000 }));
      const found = store.collectRecords(100).find((r) => r.id === "dup-1");
      expect(found?.status).toBe("running"); // 内存 running 覆盖磁盘 crashed
    });
  });

  // ============================================================
  // cancelled tombstone override
  // ============================================================
  describe("cancelled tombstone", () => {
    it("有 .cancelled sidecar → status override 为 cancelled", () => {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-a.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "worker", mode: "background", task: "do it", startedAt: 5000,
      });
      writeCancelledTombstone(sessionFile, {
        id: "bg-1", status: "cancelled", agent: "worker", startedAt: 5000, endedAt: 6000,
      });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === "bg-1");
      expect(found?.status).toBe("cancelled");
      expect(found?.error).toBe("cancelled by user");
    });
  });

  // ============================================================
  // compareRecords 排序稳定性（内存 running record）
  // ============================================================
  describe("compareRecords 排序", () => {
    it("status priority（running < crashed）", () => {
      const store = new RecordStore(tmpDir);
      // 内存 running record vs 磁盘无 sidecar → crashed
      const running = makeRecord({ id: "run-1", mode: "background", startedAt: 3000, status: "running" });
      store.register(running);
      // 磁盘 crashed record（无 sidecar → 四分支兜底）
      writeSessionJsonl(path.join(tmpDir, "a.jsonl"), {
        id: "done-1", agent: "w", mode: "background", task: "t", startedAt: 5000,
      });
      const ids = store.collectRecords(100).map((r) => r.id);
      expect(ids[0]).toBe("run-1"); // running 排前
    });

    it("同 status 时 startedAt desc（新→旧）", () => {
      const store = new RecordStore(tmpDir);
      writeSessionJsonl(path.join(tmpDir, "old.jsonl"), {
        id: "old", agent: "w", mode: "background", task: "t", startedAt: 1000,
      });
      writeSessionJsonl(path.join(tmpDir, "new.jsonl"), {
        id: "new", agent: "w", mode: "background", task: "t", startedAt: 9000,
      });
      // 两个都是 crashed（磁盘重建，无 sidecar），按 startedAt desc
      const ids = store.collectRecords(100).map((r) => r.id);
      expect(ids).toEqual(["new", "old"]);
    });
  });

  // ============================================================
  // 重建缓存
  // ============================================================
  describe("重建缓存", () => {
    it("notifyChange 后缓存失效（新 session.jsonl 可见）", () => {
      const store = new RecordStore(tmpDir);
      // 首次 collect：空目录
      expect(store.collectRecords(100)).toHaveLength(0);
      // 写新 session.jsonl
      writeSessionJsonl(path.join(tmpDir, "new.jsonl"), {
        id: "bg-1", agent: "w", mode: "background", task: "t", startedAt: 1000,
      });
      // 缓存仍命中旧结果（notifyChange 未触发）
      expect(store.collectRecords(100)).toHaveLength(0);
      // register 触发 notifyChange → 缓存失效
      store.register(makeRecord({ id: "trigger", mode: "sync", startedAt: 2000 }));
      store.archive(makeRecord({ id: "trigger", mode: "sync", startedAt: 2000 }));
      // 现在 bg-1 可见
      const ids = store.collectRecords(100).map((r) => r.id);
      expect(ids).toContain("bg-1");
    });
  });

  // ============================================================
  // dispose / revive
  // ============================================================
  describe("dispose / revive", () => {
    it("dispose 后 notifyChange 不再触发 listener", () => {
      const store = new RecordStore(tmpDir);
      let count = 0;
      store.onChange(() => { count++; });
      store.register(makeRecord({ id: "r1", startedAt: 1000 }));
      expect(count).toBe(1);
      store.dispose();
      store.register(makeRecord({ id: "r2", startedAt: 2000 }));
      expect(count).toBe(1); // dispose 后不再通知
    });
  });

  // ============================================================
  // 四分支 sidecar 矩阵（D-006 + D-021）
  // ============================================================
  describe("四分支 sidecar 矩阵", () => {
    const SESSION_ID = "bg-1";
    const STARTED_AT = 1000;

    function writeBaseSession(): string {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-sidecar.jsonl");
      writeSessionJsonl(sessionFile, {
        id: SESSION_ID, agent: "worker", mode: "background", task: "do it", startedAt: STARTED_AT,
      });
      return sessionFile;
    }

    // ── 分支 1: .cancelled ──
    it(".cancelled sidecar → cancelled", () => {
      const sessionFile = writeBaseSession();
      writeCancelledTombstone(sessionFile, {
        id: SESSION_ID, status: "cancelled", agent: "worker", startedAt: STARTED_AT, endedAt: 6000,
      });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("cancelled");
      expect(found?.error).toBe("cancelled by user");
      expect(found?.endedAt).toBe(6000);
    });

    // ── 分支 2: .finalized done ──
    it(".finalized sidecar + stopReason=stop → done", () => {
      const sessionFile = writeBaseSession();
      writeFinalized(sessionFile);
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("done");
    });

    // ── 分支 2: .finalized failed ──
    it(".finalized sidecar + stopReason=error → failed", () => {
      // 写一个 stopReason=error 的 session.jsonl
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-fail.jsonl");
      const header = JSON.stringify({
        type: "session", version: 3, id: "sess-uuid", timestamp: new Date(STARTED_AT).toISOString(), cwd: "/tmp",
      });
      const identityEntry = JSON.stringify({
        type: "custom", id: "id-1", parentId: null, timestamp: new Date(STARTED_AT).toISOString(),
        customType: "subagent-identity",
        data: { id: SESSION_ID, agent: "worker", mode: "background", task: "do it", startedAt: STARTED_AT },
      });
      const assistantMsg = JSON.stringify({
        type: "message", id: "msg-1", parentId: "id-1",
        timestamp: new Date(STARTED_AT + 1000).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "error output" }],
          usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { total: 0 } },
          stopReason: "error",
          errorMessage: "something went wrong",
          timestamp: STARTED_AT + 1000,
        },
      });
      fs.writeFileSync(sessionFile, `${header}\n${identityEntry}\n${assistantMsg}\n`, "utf-8");

      writeFinalized(sessionFile);
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("failed");
    });

    // ── 分支 3: .alive + 活 pid → running + externalInstance ──
    it(".alive + 存活 pid → running + externalInstance=true", () => {
      const sessionFile = writeBaseSession();
      const recentStartedAt = Date.now() - 1000; // 1 秒前，确保未超 24h
      const marker: AliveMarker = { pid: process.pid, id: SESSION_ID, startedAt: recentStartedAt };
      writeAliveMarker(sessionFile, marker);
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("running");
      expect(found?.externalInstance).toEqual(marker);
    });

    // ── 分支 3→4: .alive + 死 pid → crashed ──
    it(".alive + 死 pid → crashed", () => {
      const sessionFile = writeBaseSession();
      const marker: AliveMarker = { pid: 9999999, id: SESSION_ID, startedAt: STARTED_AT };
      writeAliveMarker(sessionFile, marker);
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("crashed");
      expect(found?.externalInstance).toBeUndefined();
    });

    // ── 分支 4: 都无 sidecar → crashed ──
    it("无任何 sidecar → crashed", () => {
      writeBaseSession();
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("crashed");
    });

    // ── 分支 4: >24h 软超时 → crashed（无视探活）──
    it(">24h 软超时 → crashed（即使 pid 存活）", () => {
      const sessionFile = writeBaseSession();
      // startedAt 设为 25 小时前
      const oldStartedAt = Date.now() - 25 * 60 * 60 * 1000;
      const marker: AliveMarker = { pid: process.pid, id: SESSION_ID, startedAt: oldStartedAt };
      writeAliveMarker(sessionFile, marker);

      // 重写 session.jsonl 使 startedAt 匹配
      fs.unlinkSync(sessionFile);
      writeSessionJsonl(sessionFile, {
        id: SESSION_ID, agent: "worker", mode: "background", task: "do it", startedAt: oldStartedAt,
      });

      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("crashed");
      expect(found?.externalInstance).toBeUndefined();
    });

    // ── 回归：.cancelled 优先于 .finalized ──
    it(".cancelled 优先于 .finalized（即使两者共存）", () => {
      const sessionFile = writeBaseSession();
      writeFinalized(sessionFile);
      writeCancelledTombstone(sessionFile, {
        id: SESSION_ID, status: "cancelled", agent: "worker", startedAt: STARTED_AT, endedAt: 6000,
      });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("cancelled");
    });

    // ── 回归：旧 .cancelled 单分支行为不变 ──
    it("旧 .cancelled 单分支行为不变（回归）", () => {
      const sessionFile = writeBaseSession();
      writeCancelledTombstone(sessionFile, {
        id: SESSION_ID, status: "cancelled", agent: "worker", startedAt: STARTED_AT, endedAt: 7000,
      });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("cancelled");
      expect(found?.error).toBe("cancelled by user");
      expect(found?.endedAt).toBe(7000);
    });
  });

  // ============================================================
  // session 隔离（问题 1 修复）
  // ============================================================
  describe("session 隔离（parentSessionId 过滤）", () => {
    it("磁盘源：只返回 parentSessionId 匹配的 record", () => {
      writeSessionJsonl(path.join(tmpDir, "mine.jsonl"), {
        id: "mine", agent: "w", mode: "background", task: "t", startedAt: 1000, parentSessionId: "sess-A",
      });
      writeSessionJsonl(path.join(tmpDir, "other.jsonl"), {
        id: "other", agent: "w", mode: "background", task: "t", startedAt: 2000, parentSessionId: "sess-B",
      });
      const store = new RecordStore(tmpDir);
      const ids = store.collectRecords(100, "all", "sess-A").map((r) => r.id);
      expect(ids).toEqual(["mine"]); // other 属于 sess-B，被隔离
    });

    it("磁盘源：parentSessionId 缺失（旧文件）被排除（无法判定归属）", () => {
      writeSessionJsonl(path.join(tmpDir, "legacy.jsonl"), {
        id: "legacy", agent: "w", mode: "background", task: "t", startedAt: 1000, // 无 parentSessionId
      });
      const store = new RecordStore(tmpDir);
      const ids = store.collectRecords(100, "all", "sess-A").map((r) => r.id);
      expect(ids).toEqual([]); // 旧文件被排除
    });

    it("磁盘源：不传 filter（undefined）不过滤（向后兼容）", () => {
      writeSessionJsonl(path.join(tmpDir, "legacy.jsonl"), {
        id: "legacy", agent: "w", mode: "background", task: "t", startedAt: 1000,
      });
      writeSessionJsonl(path.join(tmpDir, "tagged.jsonl"), {
        id: "tagged", agent: "w", mode: "background", task: "t", startedAt: 2000, parentSessionId: "sess-A",
      });
      const store = new RecordStore(tmpDir);
      const ids = store.collectRecords(100).map((r) => r.id);
      expect(ids.sort()).toEqual(["legacy", "tagged"]); // 全返回，不过滤
    });

    it("内存源：只返回 parentSessionId 匹配的 running record", () => {
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "mine", startedAt: 1000, parentSessionId: "sess-A" }));
      store.register(makeRecord({ id: "other", startedAt: 2000, parentSessionId: "sess-B" }));
      const ids = store.collectRecords(100, "all", "sess-A").map((r) => r.id);
      expect(ids).toEqual(["mine"]);
    });

    it("内存+磁盘混合：同时按 session 过滤", () => {
      writeSessionJsonl(path.join(tmpDir, "disk-A.jsonl"), {
        id: "disk-A", agent: "w", mode: "background", task: "t", startedAt: 1000, parentSessionId: "sess-A",
      });
      writeSessionJsonl(path.join(tmpDir, "disk-B.jsonl"), {
        id: "disk-B", agent: "w", mode: "background", task: "t", startedAt: 2000, parentSessionId: "sess-B",
      });
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "mem-A", startedAt: 3000, parentSessionId: "sess-A" }));
      store.register(makeRecord({ id: "mem-B", startedAt: 4000, parentSessionId: "sess-B" }));
      const ids = store.collectRecords(100, "all", "sess-A").map((r) => r.id).sort();
      expect(ids).toEqual(["disk-A", "mem-A"]);
    });

    it("重建缓存：不同 filter 共享缓存，不交叉污染", () => {
      writeSessionJsonl(path.join(tmpDir, "a.jsonl"), {
        id: "a", agent: "w", mode: "background", task: "t", startedAt: 1000, parentSessionId: "sess-A",
      });
      writeSessionJsonl(path.join(tmpDir, "b.jsonl"), {
        id: "b", agent: "w", mode: "background", task: "t", startedAt: 2000, parentSessionId: "sess-B",
      });
      const store = new RecordStore(tmpDir);
      // 先查 sess-A（建缓存）
      expect(store.collectRecords(100, "all", "sess-A").map((r) => r.id)).toEqual(["a"]);
      // 再查 sess-B（复用缓存基底，过滤不交叉）
      expect(store.collectRecords(100, "all", "sess-B").map((r) => r.id)).toEqual(["b"]);
      // 不带 filter（复用缓存，全量）
      expect(store.collectRecords(100).map((r) => r.id).sort()).toEqual(["a", "b"]);
    });
  });

  // ============================================================
  // endedAt 重建（问题 2 修复：终态耗时不再随墙钟增长）
  // ============================================================
  describe("endedAt 重建（耗时不再无限增长）", () => {
    it(".finalized → endedAt 为最后 entry 时间戳（非 now）", () => {
      const sessionFile = path.join(tmpDir, "fin.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "w", mode: "background", task: "t",
        startedAt: 5000, lastTs: 9000, parentSessionId: "sess-A",
      });
      writeFinalized(sessionFile);
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100, "all", "sess-A").find((r) => r.id === "bg-1");
      expect(found?.endedAt).toBe(9000); // 不是 Date.now()
    });

    it("无 sidecar（crashed）→ endedAt 为最后 entry 时间戳（非 now）", () => {
      const sessionFile = path.join(tmpDir, "crash.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "w", mode: "background", task: "t",
        startedAt: 5000, lastTs: 9000, parentSessionId: "sess-A",
      });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100, "all", "sess-A").find((r) => r.id === "bg-1");
      expect(found?.status).toBe("crashed");
      expect(found?.endedAt).toBe(9000);
    });

    it(".alive running → endedAt 保持 undefined（running 耗时继续增长是正确的）", () => {
      const sessionFile = path.join(tmpDir, "alive.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "w", mode: "background", task: "t",
        startedAt: Date.now() - 1000, lastTs: Date.now(), parentSessionId: "sess-A",
      });
      writeAliveMarker(sessionFile, { pid: process.pid, id: "bg-1", startedAt: Date.now() - 1000 });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100, "all", "sess-A").find((r) => r.id === "bg-1");
      expect(found?.status).toBe("running");
      expect(found?.endedAt).toBeUndefined();
    });
  });
});
