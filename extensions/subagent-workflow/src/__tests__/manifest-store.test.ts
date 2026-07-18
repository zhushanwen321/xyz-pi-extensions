import * as fsPromises from "node:fs/promises";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManifestStore } from "../execution/manifest-store";

// [C10] 磁盘满测试需要可控的 fs.promises.rename（拖 ENOSPC/EACCES）。
// hoisted flag + vi.mock 透传：默认 renameErrorRef.current=null 走真实 rename，
// 磁盘满 it 里置入 Error 让 rename 拖出（拖一次后自动重置），其它 it 不受影响。
const { renameErrorRef } = vi.hoisted(() => ({
  renameErrorRef: { current: null as NodeJS.ErrnoException | null },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (renameErrorRef.current) {
        const err = renameErrorRef.current;
        renameErrorRef.current = null; // 抛一次后自动重置，避免污染后续 it
        throw err;
      }
      return actual.rename(...args);
    },
  };
});

describe("ManifestStore", () => {
  let store: ManifestStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-test-"));
    store = new ManifestStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("writeManifest", () => {
    it("should create manifest file with UUID name", async () => {
      const record = {
        id: "550e8400-e29b-41d4-a716-446655440000",
        rootSessionId: "session-123",
        agentName: "worker",
        status: "running" as const,
        createdAt: Date.now(),
      };

      await store.writeManifest(record);

      const manifestPath = path.join(tmpDir, `${record.id}.json`);
      expect(fs.existsSync(manifestPath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      expect(content.id).toBe(record.id);
    });

    it("should use atomic write (tmp + rename)", async () => {
      const record = {
        id: "test-atomic",
        rootSessionId: "session-123",
        agentName: "worker",
        status: "running" as const,
        createdAt: Date.now(),
      };

      await store.writeManifest(record);

      // Verify no tmp files remain after write
      const files = fs.readdirSync(tmpDir);
      const tmpFiles = files.filter((f) => f.includes(".tmp."));
      expect(tmpFiles.length).toBe(0);
      expect(files.length).toBe(1); // Only the final manifest
    });

    it("should throw on write failure (not bestEffort)", async () => {
      const record = {
        id: "test-error",
        rootSessionId: "session-123",
        agentName: "worker",
        status: "running" as const,
        createdAt: Date.now(),
      };

      // Delete the directory to cause write failure
      fs.rmSync(tmpDir, { recursive: true, force: true });

      await expect(store.writeManifest(record)).rejects.toThrow();
    });
  });

  describe("recoverTmpFiles", () => {
    it("should delete tmp when manifest exists", async () => {
      const id = "test-recovery-1";
      const manifestPath = path.join(tmpDir, `${id}.json`);
      const tmpPath = path.join(tmpDir, `${id}.json.tmp.12345`);

      fs.writeFileSync(manifestPath, '{"id":"test-recovery-1"}');
      fs.writeFileSync(tmpPath, '{"id":"test-recovery-1"}');

      const result = await store.recoverTmpFiles();

      expect(result.deleted).toBe(1);
      expect(fs.existsSync(tmpPath)).toBe(false);
      expect(fs.existsSync(manifestPath)).toBe(true);
    });

    it("should rename valid tmp when manifest missing", async () => {
      const id = "test-recovery-2";
      const tmpPath = path.join(tmpDir, `${id}.json.tmp.12345`);
      const manifestPath = path.join(tmpDir, `${id}.json`);

      fs.writeFileSync(tmpPath, JSON.stringify({ id, status: "running" }));

      const result = await store.recoverTmpFiles();

      expect(result.recovered).toBe(1);
      expect(fs.existsSync(manifestPath)).toBe(true);
      expect(fs.existsSync(tmpPath)).toBe(false);
    });

    it("should delete invalid tmp when manifest missing", async () => {
      const id = "test-recovery-3";
      const tmpPath = path.join(tmpDir, `${id}.json.tmp.12345`);

      fs.writeFileSync(tmpPath, "invalid json {{{");

      const result = await store.recoverTmpFiles();

      expect(result.deleted).toBe(1);
      expect(fs.existsSync(tmpPath)).toBe(false);
    });
  });

  describe("readManifest", () => {
    it("should return null for non-existent manifest", async () => {
      const result = await store.readManifest("nonexistent");
      expect(result).toBeNull();
    });

    it("should return manifest data", async () => {
      const record = {
        id: "test-read",
        rootSessionId: "session-123",
        agentName: "worker",
        status: "running" as const,
        createdAt: Date.now(),
      };

      await store.writeManifest(record);
      const result = await store.readManifest(record.id);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(record.id);
      expect(result?.status).toBe("running");
    });
  });

  // ── A3+C10：listAllSync + 并发写 + 磁盘满 rename 失败 ──

  describe("listAllSync (A3)", () => {
    it("正常读：返回目录下所有合法 manifest", async () => {
      await store.writeManifest({ id: "a-1", rootSessionId: "s", agentName: "w", status: "running" as const, createdAt: 1 });
      await store.writeManifest({ id: "a-2", rootSessionId: "s", agentName: "w", status: "completed" as const, createdAt: 2 });
      const all = store.listAllSync();
      expect(all.length).toBe(2);
      expect(all.map((r) => r.id).sort()).toEqual(["a-1", "a-2"]);
    });

    it("损坏文件跳过：非法 JSON + 非 manifest schema 不计入，合法的正常返回", async () => {
      await store.writeManifest({ id: "good", rootSessionId: "s", agentName: "w", status: "running" as const, createdAt: 1 });
      fs.writeFileSync(path.join(tmpDir, "broken.json"), "not json {{{");
      fs.writeFileSync(path.join(tmpDir, "wrong-schema.json"), JSON.stringify({ id: "x", foo: "bar" }));
      const all = store.listAllSync();
      expect(all.length).toBe(1);
      expect(all[0].id).toBe("good");
    });

    it("空目录：返回空数组", () => {
      const fresh = path.join(tmpDir, "empty-sub");
      fs.mkdirSync(fresh);
      const s = new ManifestStore(fresh);
      expect(s.listAllSync()).toEqual([]);
    });

    it("tmp 文件跳过：.tmp. 后缀不计入（不与正式 manifest 重复）", async () => {
      await store.writeManifest({ id: "keep", rootSessionId: "s", agentName: "w", status: "running" as const, createdAt: 1 });
      // 同 id 的残留 tmp（合法内容）——必须被跳过，避免与正式 manifest 重复计数
      fs.writeFileSync(
        path.join(tmpDir, "keep.json.tmp.123"),
        JSON.stringify({ id: "keep", rootSessionId: "s", agentName: "w", status: "running", createdAt: 1 }),
      );
      const all = store.listAllSync();
      expect(all.length).toBe(1);
      expect(all[0].id).toBe("keep");
    });
  });

  describe("并发写 (C10)", () => {
    it("Promise.all 并发写 N 个不同 id：不丢不重，内容正确", async () => {
      const N = 10;
      const records = Array.from({ length: N }, (_, i) => ({
        id: `concurrent-${i}`,
        rootSessionId: "s",
        agentName: "w",
        status: "running" as const,
        createdAt: i,
      }));
      // 并发写要求全部成功（一个失败即测试失败 = 原子性语义），故意用 Promise.all 而非 allSettled
      // eslint-disable-next-line taste/prefer-allsettled
      await Promise.all(records.map((r) => store.writeManifest(r)));

      const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json") && !f.includes(".tmp."));
      expect(files.length).toBe(N); // 不丢
      const ids = files.map((f) => f.replace(".json", ""));
      expect(new Set(ids).size).toBe(N); // 不重
      // 内容正确：每个 id 都能读回且 createdAt 对应
      for (const r of records) {
        const got = await store.readManifest(r.id);
        expect(got?.id).toBe(r.id);
        expect(got?.createdAt).toBe(r.createdAt);
      }
    });
  });

  describe("磁盘满（rename 失败）(C10)", () => {
    afterEach(() => {
      renameErrorRef.current = null; // 保险：防 flag 残留污染后续测试
    });

    it("rename 抛 ENOSPC：writeManifest rejects + tmp 文件被清理 + 最终 manifest 未写入", async () => {
      renameErrorRef.current = Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" });
      const rec = { id: "disk-full", rootSessionId: "s", agentName: "w", status: "running" as const, createdAt: 1 };
      await expect(store.writeManifest(rec)).rejects.toThrow();

      const files = fs.readdirSync(tmpDir);
      expect(files.filter((f) => f.includes(".tmp.")).length).toBe(0); // best-effort 清理 tmp
      expect(files.some((f) => f === "disk-full.json")).toBe(false); // 最终 manifest 未写入
    });

    it("rename 抛 EACCES：同样清理 tmp + throw（不掩盖原错误）", async () => {
      renameErrorRef.current = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      const rec = { id: "perm-denied", rootSessionId: "s", agentName: "w", status: "running" as const, createdAt: 1 };
      await expect(store.writeManifest(rec)).rejects.toThrow();

      const files = fs.readdirSync(tmpDir);
      expect(files.filter((f) => f.includes(".tmp.")).length).toBe(0);
      expect(files.some((f) => f === "perm-denied.json")).toBe(false);
    });
  });
});
