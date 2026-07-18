import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ManifestStore } from "../execution/manifest-store";

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
});
