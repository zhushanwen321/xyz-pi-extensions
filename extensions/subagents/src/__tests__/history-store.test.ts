// src/__tests__/history-store.test.ts
//
// HistoryStore 专属测试（Must-Fix #2）。
// 覆盖：isValidPersistedRecord 边界 / append→read 往返 / read 跳过损坏 JSON /
//      recent 去重（后写覆盖 + cancelled 优先）/ recent 排序（endedAt desc + startedAt 兜底）/
//      forceGc（超 HISTORY_MAX 重写保留最新 N）/ 并发 append 串行化。
//
// tmpdir 注入，隔离真实文件系统。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getHistoryFilePath,
  HistoryStore,
  isValidPersistedRecord,
} from "../runtime/execution/history-store.ts";
import type { PersistedAgentRecord } from "../types.ts";

// 与源码 module-private 常量对齐
const HISTORY_MAX = 500;

function makeRecord(over: Partial<PersistedAgentRecord> = {}): PersistedAgentRecord {
  return {
    id: "r1",
    agent: "worker",
    status: "done",
    mode: "sync",
    taskPreview: "task",
    startedAt: 1000,
    endedAt: 1100,
    cwd: "/tmp",
    ...over,
  };
}

describe("HistoryStore", () => {
  let tmpDir: string;
  const cwd = "/fake-cwd";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ============================================================
  // isValidPersistedRecord 边界
  // ============================================================
  describe("isValidPersistedRecord", () => {
    it("合法 record → true", () => {
      expect(isValidPersistedRecord(makeRecord())).toBe(true);
    });

    it("非对象 → false", () => {
      expect(isValidPersistedRecord(null)).toBe(false);
      expect(isValidPersistedRecord("string")).toBe(false);
      expect(isValidPersistedRecord(42)).toBe(false);
      expect(isValidPersistedRecord(undefined)).toBe(false);
    });

    it("缺必填字段 / 类型错 → false", () => {
      expect(isValidPersistedRecord({ ...makeRecord(), id: undefined })).toBe(false);
      expect(isValidPersistedRecord({ ...makeRecord(), agent: undefined })).toBe(false);
      expect(isValidPersistedRecord({ ...makeRecord(), cwd: undefined })).toBe(false);
      expect(isValidPersistedRecord({ ...makeRecord(), startedAt: "1000" })).toBe(false);
    });

    it("非法 status/mode → false", () => {
      expect(isValidPersistedRecord({ ...makeRecord(), status: "bogus" })).toBe(false);
      expect(isValidPersistedRecord({ ...makeRecord(), mode: "weird" })).toBe(false);
    });
  });

  // ============================================================
  // append → read 往返
  // ============================================================
  describe("append → read 往返", () => {
    it("写入一条并读回", async () => {
      const store = new HistoryStore(tmpDir, cwd);
      await store.append(makeRecord({ id: "a1" }));
      const records = store.read();
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe("a1");
    });

    it("read 空文件/不存在 → []", () => {
      const store = new HistoryStore(tmpDir, cwd);
      expect(store.read()).toEqual([]);
    });

    it("sessionId 过滤", async () => {
      const store = new HistoryStore(tmpDir, cwd);
      await store.append(makeRecord({ id: "a1", sessionId: "s1" }));
      await store.append(makeRecord({ id: "a2", sessionId: "s2" }));
      expect(store.read("s1").map((r) => r.id)).toEqual(["a1"]);
    });
  });

  // ============================================================
  // read 跳过损坏 JSON
  // ============================================================
  describe("read 跳过损坏 JSON", () => {
    it("损坏行跳过，合法行仍解析", async () => {
      const store = new HistoryStore(tmpDir, cwd);
      await store.append(makeRecord({ id: "good1" }));
      // 直接追加损坏行 + 结构不合法的 JSON 行到文件
      const filePath = getHistoryFilePath(tmpDir, cwd);
      fs.appendFileSync(filePath, "NOT VALID JSON\n{\"broken\":true}\n");
      await store.append(makeRecord({ id: "good2" }));
      expect(store.read().map((r) => r.id)).toEqual(["good1", "good2"]);
    });
  });

  // ============================================================
  // recent 去重（后写覆盖 + cancelled 优先）
  // ============================================================
  describe("recent 去重", () => {
    it("同 id 后写覆盖前写", async () => {
      const store = new HistoryStore(tmpDir, cwd);
      await store.append(makeRecord({ id: "d1", status: "done", endedAt: 2000 }));
      await store.append(makeRecord({ id: "d1", status: "failed", endedAt: 2000 }));
      const records = store.recent(10);
      expect(records).toHaveLength(1);
      expect(records[0].status).toBe("failed"); // 后写覆盖
    });

    it("cancelled 优先（即使被后写覆盖）", async () => {
      const store = new HistoryStore(tmpDir, cwd);
      await store.append(makeRecord({ id: "d2", status: "cancelled", endedAt: 3000 }));
      await store.append(makeRecord({ id: "d2", status: "failed", endedAt: 3000 }));
      const records = store.recent(10);
      expect(records).toHaveLength(1);
      expect(records[0].status).toBe("cancelled");
    });
  });

  // ============================================================
  // recent 排序
  // ============================================================
  describe("recent 排序", () => {
    it("endedAt desc（新→旧）", async () => {
      const store = new HistoryStore(tmpDir, cwd);
      await store.append(makeRecord({ id: "old", startedAt: 1000, endedAt: 2000 }));
      await store.append(makeRecord({ id: "new", startedAt: 1500, endedAt: 5000 }));
      expect(store.recent(10).map((r) => r.id)).toEqual(["new", "old"]);
    });

    it("running 无 endedAt → 用 startedAt 兜底排序", async () => {
      const store = new HistoryStore(tmpDir, cwd);
      await store.append(makeRecord({ id: "r-old", startedAt: 1000, status: "running" }));
      await store.append(makeRecord({ id: "r-new", startedAt: 9000, status: "running" }));
      expect(store.recent(10).map((r) => r.id)).toEqual(["r-new", "r-old"]);
    });
  });

  // ============================================================
  // forceGc：超 HISTORY_MAX 重写保留最新 N 条
  // ============================================================
  describe("forceGc", () => {
    it("超 HISTORY_MAX 重写保留最新 N 条", () => {
      const store = new HistoryStore(tmpDir, cwd);
      // 直接写文件，绕过 append 的 maybeGc，确保 > HISTORY_MAX 条待 GC
      const filePath = getHistoryFilePath(tmpDir, cwd);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const lines = Array.from({ length: HISTORY_MAX + 10 }, (_, i) =>
        JSON.stringify(makeRecord({ id: `g-${i}`, startedAt: i })),
      ).join("\n") + "\n";
      fs.writeFileSync(filePath, lines, "utf-8");

      store.forceGc();
      const records = store.read();
      expect(records).toHaveLength(HISTORY_MAX);
      expect(records[0].id).toBe("g-10"); // 丢弃最旧 10 条
      expect(records[records.length - 1].id).toBe(`g-${HISTORY_MAX + 9}`);
    });
  });

  // ============================================================
  // 并发 append 串行化
  // ============================================================
  describe("并发 append 串行化", () => {
    it("并发 append 不交错（所有记录都落盘）", async () => {
      const store = new HistoryStore(tmpDir, cwd);
      const N = 20;
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          store.append(makeRecord({ id: `c-${i}`, startedAt: i })),
        ),
      );
      expect(store.read().map((r) => r.id)).toHaveLength(N);
    });
  });
});
