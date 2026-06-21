// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach/afterEach）
// 运行命令：npx vitest run src/infra/__tests__/workflow-files.test.ts

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { invalidateCache } from "../config-loader.js";
import { deleteWorkflow, saveWorkflow } from "../workflow-files.js";

// ── Helpers ──────────────────────────────────────────────────

let tmpRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpRoot = mkdtempSync(join(tmpdir(), "pi-workflow-files-test-"));
  process.chdir(tmpRoot);
  invalidateCache();
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
});

function ensureDir(subpath: string): string {
  const dir = join(tmpRoot, subpath);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeScript(subdir: string, name: string, content: string): string {
  ensureDir(subdir);
  const path = join(tmpRoot, subdir, `${name}.js`);
  writeFileSync(path, content, "utf-8");
  return path;
}

// ── Tests ────────────────────────────────────────────────────

describe("workflow-files", () => {
  describe("saveWorkflow()", () => {
    it("renames tmp file to saved dir, tmp disappears", async () => {
      writeScript(
        ".pi/workflows/.tmp",
        "my-wf",
        "const meta = { name: 'my-wf', description: '', phases: [] };",
      );

      const result = await saveWorkflow("my-wf");

      expect(result).toContain("Saved 'my-wf' → 'my-wf'");
      expect(existsSync(join(tmpRoot, ".pi/workflows", "my-wf.js"))).toBe(true);
      expect(existsSync(join(tmpRoot, ".pi/workflows/.tmp", "my-wf.js"))).toBe(false);
    });

    it("saves with a new name when newName is provided", async () => {
      writeScript(
        ".pi/workflows/.tmp",
        "tmp-wf",
        "const meta = { name: 'tmp-wf', description: '', phases: [] };",
      );

      const result = await saveWorkflow("tmp-wf", "renamed-wf");

      expect(result).toContain("Saved 'tmp-wf' → 'renamed-wf'");
      expect(existsSync(join(tmpRoot, ".pi/workflows", "renamed-wf.js"))).toBe(true);
      expect(existsSync(join(tmpRoot, ".pi/workflows/.tmp", "tmp-wf.js"))).toBe(false);
    });

    it("throws when destination already exists", async () => {
      writeScript(
        ".pi/workflows/.tmp",
        "dup",
        "const meta = { name: 'dup', description: '', phases: [] };",
      );
      writeScript(
        ".pi/workflows",
        "dup",
        "const meta = { name: 'dup', description: '', phases: [] };",
      );

      await expect(saveWorkflow("dup")).rejects.toThrow("already exists");
    });

    it("throws when tmp workflow is not found", async () => {
      await expect(saveWorkflow("nonexistent")).rejects.toThrow("not found");
    });
  });

  describe("deleteWorkflow()", () => {
    it("deletes a saved workflow file", () => {
      writeScript(
        ".pi/workflows",
        "to-delete",
        "const meta = { name: 'to-delete', description: '', phases: [] };",
      );

      const result = deleteWorkflow("to-delete", () => false);

      expect(result).toContain("Deleted workflow 'to-delete'");
      expect(existsSync(join(tmpRoot, ".pi/workflows", "to-delete.js"))).toBe(false);
    });

    it("deletes a tmp workflow file", () => {
      writeScript(
        ".pi/workflows/.tmp",
        "tmp-delete",
        "const meta = { name: 'tmp-delete', description: '', phases: [] };",
      );

      const result = deleteWorkflow("tmp-delete", () => false);

      expect(result).toContain("Deleted workflow 'tmp-delete'");
      expect(existsSync(join(tmpRoot, ".pi/workflows/.tmp", "tmp-delete.js"))).toBe(false);
    });

    it("throws when the workflow is currently running", () => {
      writeScript(
        ".pi/workflows",
        "running-wf",
        "const meta = { name: 'running-wf', description: '', phases: [] };",
      );

      expect(() => deleteWorkflow("running-wf", () => true)).toThrow(
        "currently running",
      );
    });

    it("throws when file is not found", () => {
      expect(() => deleteWorkflow("nonexistent", () => false)).toThrow("not found");
    });
  });
});
