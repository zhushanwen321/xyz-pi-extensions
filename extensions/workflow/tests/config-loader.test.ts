// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach/afterEach）
// 运行命令：npx vitest run tests/config-loader.test.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getWorkflow,
  loadWorkflows,
  invalidateCache,
} from "../src/config-loader";

// ── Helpers ──────────────────────────────────────────────────

let tmpRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpRoot = mkdtempSync(join(tmpdir(), "pi-workflow-test-"));
  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeWorkflowDir(): string {
  const dir = join(tmpRoot, ".pi", "workflows");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeScript(dir: string, name: string, content: string): string {
  const path = join(dir, `${name}.js`);
  writeFileSync(path, content, "utf-8");
  return path;
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("config-loader", () => {
  // ── loadWorkflows ─────────────────────────────────────────

  describe("loadWorkflows()", () => {
    it("returns empty array when no workflow directories exist", async () => {
      const workflows = await loadWorkflows();
      expect(workflows).toEqual([]);
    });

    it("discovers script with module.exports.meta as available", async () => {
      const dir = makeWorkflowDir();
      writeScript(
        dir,
        "hello",
        `const meta = { name: 'hello', description: 'Hello workflow', phases: ['greet', 'farewell'] };
module.exports = { meta };`,
      );

      const workflows = await loadWorkflows();
      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe("hello");
      expect(workflows[0].description).toBe("Hello workflow");
      expect(workflows[0].phases).toEqual(["greet", "farewell"]);
      expect(workflows[0].available).toBe(true);
      expect(workflows[0].source).toBe("saved");
    });

    it("extracts meta from const meta = { ... } without module.exports (regex)", async () => {
      const dir = makeWorkflowDir();
      writeScript(
        dir,
        "local-meta",
        `const meta = { name: 'local-meta', description: 'No exports needed', phases: ['a'] };`,
      );

      const workflows = await loadWorkflows();
      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe("local-meta");
      expect(workflows[0].description).toBe("No exports needed");
      expect(workflows[0].available).toBe(true);
    });

    it("marks scripts with no meta as unavailable", async () => {
      const dir = makeWorkflowDir();
      writeScript(dir, "bad", `console.log("no meta here");`);

      const workflows = await loadWorkflows();
      expect(workflows).toHaveLength(1);
      expect(workflows[0].available).toBe(false);
      expect(workflows[0].name).toBe("bad"); // fallback to stem name
    });

    it("handles scripts with stub globals (agent, $ARGS, etc.)", async () => {
      const dir = makeWorkflowDir();
      writeScript(
        dir,
        "complex",
        `const meta = { name: 'complex', description: 'Uses globals', phases: ['a'] };
const x = agent;
console.log($ARGS, $WORKSPACE, $BUDGET);`,
      );

      const workflows = await loadWorkflows();
      expect(workflows).toHaveLength(1);
      expect(workflows[0].available).toBe(true);
      expect(workflows[0].name).toBe("complex");
    });

    it("extracts meta from export const meta (ESM syntax)", async () => {
      const dir = makeWorkflowDir();
      writeScript(
        dir,
        "esm-meta",
        `export const meta = { name: 'esm-meta', description: 'ESM export syntax', phases: ['init'] };`,
      );

      const workflows = await loadWorkflows();
      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe("esm-meta");
      expect(workflows[0].available).toBe(true);
    });

    it("handles scripts with module.exports = { meta } pattern", async () => {
      const dir = makeWorkflowDir();
      writeScript(
        dir,
        "mod-exports",
        `const meta = { name: 'mod-exports', description: 'Uses module.exports', phases: ['one'] };
module.exports = { meta };`,
      );

      const workflows = await loadWorkflows();
      expect(workflows).toHaveLength(1);
      expect(workflows[0].available).toBe(true);
      expect(workflows[0].name).toBe("mod-exports");
    });

    it("discovers multiple scripts and sorts by available", async () => {
      const dir = makeWorkflowDir();
      writeScript(dir, "good", `const meta = { name: 'good', description: '', phases: [] };`);
      writeScript(dir, "bad", `// no meta`);

      const workflows = await loadWorkflows();
      expect(workflows).toHaveLength(2);
      const good = workflows.find((w) => w.name === "good")!;
      const bad = workflows.find((w) => w.name === "bad")!;
      expect(good.available).toBe(true);
      expect(bad.available).toBe(false);
    });

    it("ignores non-js files (.ts, .json, etc.)", async () => {
      const dir = makeWorkflowDir();
      writeScript(dir, "valid", `const meta = { name: 'valid', description: '', phases: [] };`);
      writeFileSync(join(dir, "types.d.ts"), "// types", "utf-8");
      writeFileSync(join(dir, "config.json"), "{}", "utf-8");

      const workflows = await loadWorkflows();
      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe("valid");
    });

    it("handles .mjs extension", async () => {
      const dir = makeWorkflowDir();
      const path = join(dir, "esm-workflow.mjs");
      writeFileSync(
        path,
        `const meta = { name: 'esm-workflow', description: 'ESM script', phases: ['init'] };`,
        "utf-8",
      );

      const workflows = await loadWorkflows();
      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe("esm-workflow");
    });
  });

  // ── getWorkflow ───────────────────────────────────────────

  describe("getWorkflow()", () => {
    it("returns undefined for non-existent workflow", async () => {
      const result = await getWorkflow("nonexistent");
      expect(result).toBeUndefined();
    });

    it("returns workflow by name", async () => {
      const dir = makeWorkflowDir();
      writeScript(dir, "my-wf", `const meta = { name: 'my-wf', description: 'My workflow', phases: ['step1'] };`);

      // Invalidate cache to force fresh load
      invalidateCache();

      const result = await getWorkflow("my-wf");
      expect(result).toBeDefined();
      expect(result!.name).toBe("my-wf");
      expect(result!.available).toBe(true);
    });

    it("uses cache for repeated lookups", async () => {
      const dir = makeWorkflowDir();
      writeScript(dir, "cached-wf", `const meta = { name: 'cached-wf', description: 'Cached', phases: [] };`);

      invalidateCache();
      const first = await getWorkflow("cached-wf");
      expect(first).toBeDefined();

      // Second call should hit cache (same result)
      const second = await getWorkflow("cached-wf");
      expect(second).toBeDefined();
      expect(second!.name).toBe("cached-wf");
    });
  });

  // ── invalidateCache ───────────────────────────────────────

  describe("invalidateCache()", () => {
    it("forces re-scan after invalidation", async () => {
      const dir = makeWorkflowDir();
      writeScript(dir, "fresh", `const meta = { name: 'fresh', description: '', phases: [] };`);

      invalidateCache();
      const first = await getWorkflow("fresh");
      expect(first).toBeDefined();

      // Write a new script with the same name (simulating update)
      writeScript(
        dir,
        "fresh",
        `const meta = { name: 'fresh', description: 'Updated description', phases: ['a', 'b'] };`,
      );

      invalidateCache();
      const updated = await getWorkflow("fresh");
      expect(updated!.description).toBe("Updated description");
      expect(updated!.phases).toEqual(["a", "b"]);
    });
  });
});
