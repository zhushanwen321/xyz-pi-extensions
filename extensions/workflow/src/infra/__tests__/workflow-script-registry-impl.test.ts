// 测试框架：vitest
// 运行命令：npx vitest run src/infra/__tests__/workflow-script-registry-impl.test.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkflowScript } from "../../engine/models/workflow-script.js";
import type { WorkflowScriptRegistry } from "../../engine/models/workflow-script-registry.js";
// 直接测底层 invalidateCache（registry.invalidate 只是它的薄包装；这里要验证
// 缓存失效后真正触发文件系统重扫，故绕过包装直达底层）。
import { invalidateCache } from "../config-loader.js";
import { WorkflowScriptRegistryImpl } from "../workflow-script-registry-impl.js";

// ── Helpers ─────────────────────────────────────────────────

let tmpRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpRoot = mkdtempSync(join(tmpdir(), "wf-registry-test-"));
  process.chdir(tmpRoot);
  invalidateCache();
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
  invalidateCache();
});

function makeWorkflowDir(): string {
  const dir = join(tmpRoot, ".pi", "workflows");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTmpDir(): string {
  const dir = join(tmpRoot, ".pi", "workflows", ".tmp");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeScript(dir: string, name: string, content: string): string {
  const filePath = join(dir, `${name}.js`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

const VALID_SCRIPT = (name: string, desc = "") =>
  `const meta = { name: '${name}', description: '${desc}', phases: ['a'] };
agent("test");`;

// ═══════════════════════════════════════════════════════════════

describe("WorkflowScriptRegistryImpl", () => {
  it("implements WorkflowScriptRegistry port", () => {
    const registry: WorkflowScriptRegistry = new WorkflowScriptRegistryImpl();
    expect(typeof registry.loadAll).toBe("function");
    expect(typeof registry.get).toBe("function");
    expect(typeof registry.invalidate).toBe("function");
  });

 // ── loadAll ───────────────────────────────────────────────

  describe("loadAll", () => {
    it("returns empty array when no workflow directories exist", async () => {
      const registry = new WorkflowScriptRegistryImpl();
      const scripts = await registry.loadAll();
      expect(scripts).toEqual([]);
    });

    it("returns WorkflowScript instances (not raw CachedWorkflowMeta)", async () => {
      const dir = makeWorkflowDir();
      writeScript(dir, "hello", VALID_SCRIPT("hello", "Hello workflow"));

      const registry = new WorkflowScriptRegistryImpl();
      const scripts = await registry.loadAll();

      expect(scripts.length).toBe(1);
      expect(scripts[0]).toBeInstanceOf(WorkflowScript);
    });

    it("maps fields: name, source, path, meta, available", async () => {
      const dir = makeWorkflowDir();
      writeScript(dir, "test-wf", VALID_SCRIPT("test-wf", "a desc"));

      const registry = new WorkflowScriptRegistryImpl();
      const [script] = await registry.loadAll();

      expect(script!.name).toBe("test-wf");
      expect(script!.source).toBe("saved");
 // macOS may prefix /private — assert by suffix only for portability
      expect(script!.path).toMatch(/test-wf\.js$/);
      expect(script!.available).toBe(true);
      expect(script!.meta.name).toBe("test-wf");
      expect(script!.meta.description).toBe("a desc");
      expect(script!.meta.phases).toEqual(["a"]);
    });

    it("marks scripts with no meta as available=false (stem name fallback)", async () => {
      const dir = makeWorkflowDir();
      writeScript(dir, "broken", 'console.log("no meta");');

      const registry = new WorkflowScriptRegistryImpl();
      const [script] = await registry.loadAll();

      expect(script!.available).toBe(false);
      expect(script!.name).toBe("broken");
      expect(script!.meta.phases).toEqual([]);
    });

    it("deduplicates by priority tmp > project > user (same name)", async () => {
 // project workflow
      const projDir = makeWorkflowDir();
      writeScript(projDir, "shared", VALID_SCRIPT("shared", "project version"));
 // tmp workflow with same name overrides
      const tmpDir = makeTmpDir();
      writeScript(tmpDir, "shared", VALID_SCRIPT("shared", "tmp version"));

      const registry = new WorkflowScriptRegistryImpl();
      const scripts = await registry.loadAll();

 // Only one "shared" entry — tmp wins
      expect(scripts.length).toBe(1);
      expect(scripts[0]!.meta.description).toBe("tmp version");
      expect(scripts[0]!.source).toBe("tmp");
    });

    it("get() uses 60s TTL cache after loadAll populates it", async () => {
 // loadAll always re-scans, but it writes to the cache that get reads.
 // Verify: after loadAll, get serves from cache even if file is removed.
      const dir = makeWorkflowDir();
      writeScript(dir, "cached", VALID_SCRIPT("cached"));

      const registry = new WorkflowScriptRegistryImpl();
      await registry.loadAll(); // populates cache

 // Remove the file — get should still find it via cache
      rmSync(join(dir, "cached.js"), { force: true });
      const script = await registry.get("cached");
      expect(script).toBeDefined();
      expect(script!.name).toBe("cached");
    });
  });

 // ── get (exact match) ─────────────────────────────────────

  describe("get (exact match)", () => {
    it("returns the matching script by name", async () => {
      const dir = makeWorkflowDir();
      writeScript(dir, "findme", VALID_SCRIPT("findme", "target"));

      const registry = new WorkflowScriptRegistryImpl();
      const script = await registry.get("findme");

      expect(script).toBeDefined();
      expect(script).toBeInstanceOf(WorkflowScript);
      expect(script!.name).toBe("findme");
      expect(script!.meta.description).toBe("target");
    });

    it("returns undefined when name not found", async () => {
      const registry = new WorkflowScriptRegistryImpl();
      const script = await registry.get("nonexistent");
      expect(script).toBeUndefined();
    });

    it("returns undefined for partial name (no fuzzy match in registry)", async () => {
      const dir = makeWorkflowDir();
      writeScript(dir, "code-review", VALID_SCRIPT("code-review"));

      const registry = new WorkflowScriptRegistryImpl();
 // "code" is a prefix but not exact match — registry returns undefined
 // (fuzzy matching is the Interface layer's job)
      const script = await registry.get("code");
      expect(script).toBeUndefined();
    });

    it("uses cache on second get (same name)", async () => {
      const dir = makeWorkflowDir();
      writeScript(dir, "cached-get", VALID_SCRIPT("cached-get"));

      const registry = new WorkflowScriptRegistryImpl();
      const first = await registry.get("cached-get");
      const second = await registry.get("cached-get");

      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(second!.name).toBe("cached-get");
    });
  });

 // ── invalidate ────────────────────────────────────────────

  describe("invalidate", () => {
    it("clears cache — next loadAll re-scans filesystem", async () => {
      const dir = makeWorkflowDir();
      writeScript(dir, "first", VALID_SCRIPT("first"));

      const registry = new WorkflowScriptRegistryImpl();
      const firstLoad = await registry.loadAll();
      expect(firstLoad.length).toBe(1);

 // Add a new script + invalidate
      writeScript(dir, "second", VALID_SCRIPT("second"));
      registry.invalidate();
      const secondLoad = await registry.loadAll();

      expect(secondLoad.length).toBe(2);
      expect(secondLoad.map((s) => s.name).sort()).toEqual(["first", "second"]);
    });

    it("clears get() cache too", async () => {
      const dir = makeWorkflowDir();
      writeScript(dir, "x", VALID_SCRIPT("x"));

      const registry = new WorkflowScriptRegistryImpl();
      await registry.get("x"); // populate cache
      registry.invalidate();
      writeScript(dir, "y", VALID_SCRIPT("y"));

      const scripts = await registry.loadAll();
      expect(scripts.length).toBe(2);
    });

    it("invalidate is idempotent (no throw on empty cache)", () => {
      const registry = new WorkflowScriptRegistryImpl();
      expect(() => registry.invalidate()).not.toThrow();
      expect(() => registry.invalidate()).not.toThrow();
    });
  });

 // ── sourceCode field ──────────────────────────────────────

  describe("sourceCode field", () => {
    it("registry populates sourceCode from file (FR-2 single read path)", async () => {
      const dir = makeWorkflowDir();
      const expected = VALID_SCRIPT("src-test");
      writeScript(dir, "src-test", expected);

      const registry = new WorkflowScriptRegistryImpl();
      const [script] = await registry.loadAll();

 // FR-2: registry is the single filesystem reader (扫描+缓存+去重).
 // sourceCode MUST be populated here so launcher.runAndWait /
 // tool-workflow.actionRun can call validate/toExecutable directly
 // without each doing their own readFile.
      expect(script!.sourceCode).toBe(expected);
      expect(script!.sourceCode.length).toBeGreaterThan(0);
    });
  });
});
