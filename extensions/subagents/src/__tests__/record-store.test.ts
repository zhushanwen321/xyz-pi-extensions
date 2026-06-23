// src/__tests__/record-store.test.ts
//
// RecordStore 专属测试（Must-Fix #1）。
// 覆盖：archive mode 路由 / 四源 merge + 内存覆盖 history / cancelled-priority 覆盖 /
//      enforceBgFifo（超限淘汰最旧 + 绝不淘汰 running）/ scheduleSyncExpire（正常 linger + dispose 守卫）/
//      compareRecords（status priority + startedAt desc）。
//
// 用内存 HistoryStore stub 注入（record-store 只调 recent()，无文件 IO 依赖）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRecord } from "../core/execution-record.ts";
import type { HistoryStore } from "../runtime/execution/history-store.ts";
import { RecordStore } from "../runtime/execution/record-store.ts";
import type { ExecutionRecord, PersistedAgentRecord } from "../types.ts";

// ── 与源码 module-private 常量对齐 ──
const SYNC_LINGER_MS = 5000;
const BG_FIFO_MAX = 50;

/** 内存 HistoryStore stub（record-store 只依赖 recent()，无需文件 IO）。
 *  partial 结构兼容 HistoryStore 的 recent() 签名——单次断言即可（非双重断言）。 */
function makeHistoryStub(records: PersistedAgentRecord[] = []): HistoryStore {
  return { recent: () => records.slice() } as HistoryStore;
}

/** 构造 ExecutionRecord（base 默认 running，over 覆盖任意字段）。 */
function makeRecord(over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const base = createRecord("r1", {
    agent: "worker",
    model: "m",
    mode: "sync",
    task: "t",
    startedAt: 1000,
  });
  return { ...base, ...over };
}

describe("RecordStore", () => {
  // ============================================================
  // archive mode 路由
  // ============================================================
  describe("archive mode 路由", () => {
    it("sync record → completed map", () => {
      const store = new RecordStore(makeHistoryStub());
      const r = makeRecord({ id: "sync-1", mode: "sync", status: "done" });
      store.register(r);
      store.archive(r);
      expect(store.getMutable("sync-1")).toBeDefined();
    });

    it("background record → bg map", () => {
      const store = new RecordStore(makeHistoryStub());
      const r = makeRecord({ id: "bg-1", mode: "background", status: "done" });
      store.register(r);
      store.archive(r);
      expect(store.getMutable("bg-1")).toBeDefined();
    });
  });

  // ============================================================
  // 四源 merge + 内存覆盖 history
  // ============================================================
  describe("四源 merge", () => {
    it("内存源覆盖 history（同 id）", () => {
      const historyRec: PersistedAgentRecord = {
        id: "x1", agent: "worker", status: "done", mode: "sync",
        taskPreview: "old", startedAt: 1000, endedAt: 1100, cwd: "/tmp",
      };
      const store = new RecordStore(makeHistoryStub([historyRec]));
      store.register(makeRecord({ id: "x1", mode: "sync", status: "failed", startedAt: 1000 }));
      const found = store.collectRecords(100).find((x) => x.id === "x1");
      expect(found?.status).toBe("failed"); // 内存 failed 覆盖 history done
    });
  });

  // ============================================================
  // cancelled-priority 覆盖
  // ============================================================
  describe("cancelled-priority 覆盖", () => {
    it("history 的 cancelled 优先保留（即使内存有不同状态）", () => {
      const historyRec: PersistedAgentRecord = {
        id: "c1", agent: "worker", status: "cancelled", mode: "sync",
        taskPreview: "cancelled", startedAt: 1000, endedAt: 1100, cwd: "/tmp",
      };
      const store = new RecordStore(makeHistoryStub([historyRec]));
      store.register(makeRecord({ id: "c1", mode: "sync", status: "done", startedAt: 1000 }));
      const found = store.collectRecords(100).find((x) => x.id === "c1");
      expect(found?.status).toBe("cancelled"); // cancelled 优先，不被内存覆盖
    });
  });

  // ============================================================
  // enforceBgFifo：超 BG_FIFO_MAX 淘汰最旧且不淘汰 running
  // ============================================================
  describe("enforceBgFifo", () => {
    it("超 BG_FIFO_MAX 淘汰最旧的非 running", () => {
      const store = new RecordStore(makeHistoryStub());
      for (let i = 0; i < BG_FIFO_MAX + 1; i++) {
        const r = makeRecord({
          id: `bg-${i}`,
          mode: "background",
          startedAt: 1000 + i,
          status: "done",
        });
        store.register(r);
        store.archive(r);
      }
      expect(store.getMutable("bg-0")).toBeUndefined(); // 最旧被淘汰
      expect(store.getMutable(`bg-${BG_FIFO_MAX}`)).toBeDefined();
    });

    it("全是 running 时绝不淘汰（size 可超 BG_FIFO_MAX）", () => {
      const store = new RecordStore(makeHistoryStub());
      for (let i = 0; i < BG_FIFO_MAX + 3; i++) {
        const r = makeRecord({
          id: `run-${i}`,
          mode: "background",
          startedAt: 1000 + i,
          // status 保持 running（createRecord 默认）
        });
        store.register(r);
        store.archive(r);
      }
      for (let i = 0; i < BG_FIFO_MAX + 3; i++) {
        expect(store.getMutable(`run-${i}`)).toBeDefined();
      }
    });
  });

  // ============================================================
  // scheduleSyncExpire：正常 linger + dispose 守卫
  // ============================================================
  describe("scheduleSyncExpire", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("正常 linger：超时后从 completed 移除", () => {
      const store = new RecordStore(makeHistoryStub());
      const r = makeRecord({ id: "ling-1", mode: "sync", status: "done", startedAt: 1000 });
      store.register(r);
      store.archive(r);
      expect(store.getMutable("ling-1")).toBeDefined();
      vi.advanceTimersByTime(SYNC_LINGER_MS + 10);
      expect(store.getMutable("ling-1")).toBeUndefined();
    });

    it("dispose 后 linger timer 不再移除 record（守卫生效）", () => {
      const store = new RecordStore(makeHistoryStub());
      const r = makeRecord({ id: "ling-2", mode: "sync", status: "done", startedAt: 1000 });
      store.register(r);
      store.archive(r);
      store.dispose();
      vi.advanceTimersByTime(SYNC_LINGER_MS + 10);
      // dispose 清除了 timer（且 timer 回调内 _disposed 守卫短路）→ record 不被移除
      expect(store.getMutable("ling-2")).toBeDefined();
    });
  });

  // ============================================================
  // compareRecords 排序稳定性
  // ============================================================
  describe("compareRecords 排序", () => {
    it("status priority（running < failed < done）", () => {
      const store = new RecordStore(makeHistoryStub());
      const done = makeRecord({ id: "done-1", mode: "background", startedAt: 5000, status: "done" });
      const failed = makeRecord({ id: "fail-1", mode: "background", startedAt: 4000, status: "failed" });
      const running = makeRecord({ id: "run-1", mode: "background", startedAt: 3000 });
      for (const r of [done, failed, running]) {
        store.register(r);
        store.archive(r);
      }
      const ids = store.collectRecords(100).map((r) => r.id);
      expect(ids[0]).toBe("run-1");
      expect(ids[1]).toBe("fail-1");
      expect(ids[2]).toBe("done-1");
    });

    it("同 status 时 startedAt desc（新→旧）", () => {
      const store = new RecordStore(makeHistoryStub());
      const older = makeRecord({ id: "old", mode: "background", startedAt: 1000, status: "done" });
      const newer = makeRecord({ id: "new", mode: "background", startedAt: 9000, status: "done" });
      for (const r of [older, newer]) {
        store.register(r);
        store.archive(r);
      }
      expect(store.collectRecords(100).map((r) => r.id)).toEqual(["new", "old"]);
    });
  });
});
