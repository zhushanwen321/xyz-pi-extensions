// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach/afterEach）
// 运行命令：npx vitest run src/__tests__/config-loader.test.ts

import { mkdirSync, mkdtempSync, rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach,beforeEach, describe, expect, it } from "vitest";

import {
  getWorkflow,
  invalidateCache,
  loadWorkflowsForTest,
} from "../infra/config-loader";

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

// ── npm package manifest helpers ─────────────────────────────

function writePackageJson(dir: string, content: Record<string, unknown>): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify(content, null, 2), "utf-8");
}

function makeNpmPackage(
  pkgName: string,
  piField: Record<string, unknown>,
  scriptFiles?: Array<{ name: string; content: string }>,
): string {
  const pkgDir = join(tmpRoot, "node_modules", pkgName);
  mkdirSync(pkgDir, { recursive: true });
  writePackageJson(pkgDir, { name: pkgName, pi: piField });

  if (scriptFiles) {
    for (const { name, content } of scriptFiles) {
      const filePath = join(pkgDir, name);
      // Ensure parent directories exist for nested paths
      const parentDir = filePath.substring(0, filePath.lastIndexOf("/"));
      mkdirSync(parentDir, { recursive: true });
      writeFileSync(filePath, content, "utf-8");
    }
  }

  return pkgDir;
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("config-loader", () => {
 // ── loadWorkflows ─────────────────────────────────────────

  describe("loadWorkflows()", () => {
    it("returns empty array when no workflow directories exist", async () => {
      const workflows = await loadWorkflowsForTest([], tmpRoot);
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

      const workflows = await loadWorkflowsForTest([], tmpRoot);
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

      const workflows = await loadWorkflowsForTest([], tmpRoot);
      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe("local-meta");
      expect(workflows[0].description).toBe("No exports needed");
      expect(workflows[0].available).toBe(true);
    });

    it("marks scripts with no meta as unavailable", async () => {
      const dir = makeWorkflowDir();
      writeScript(dir, "bad", `console.log("no meta here");`);

      const workflows = await loadWorkflowsForTest([], tmpRoot);
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

      const workflows = await loadWorkflowsForTest([], tmpRoot);
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

      const workflows = await loadWorkflowsForTest([], tmpRoot);
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

      const workflows = await loadWorkflowsForTest([], tmpRoot);
      expect(workflows).toHaveLength(1);
      expect(workflows[0].available).toBe(true);
      expect(workflows[0].name).toBe("mod-exports");
    });

    it("discovers multiple scripts and sorts by available", async () => {
      const dir = makeWorkflowDir();
      writeScript(dir, "good", `const meta = { name: 'good', description: '', phases: [] };`);
      writeScript(dir, "bad", `// no meta`);

      const workflows = await loadWorkflowsForTest([], tmpRoot);
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

      const workflows = await loadWorkflowsForTest([], tmpRoot);
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

      const workflows = await loadWorkflowsForTest([], tmpRoot);
      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe("esm-workflow");
    });

 // ── npm package manifest discovery ──────────────────────────

    describe("npm package manifest discovery", () => {
      it("U1: discovers workflow from npm package with pi.workflows manifest", async () => {
        makeNpmPackage("@zhushanwen/pi-example", {
          workflows: ["./workflows/greet.js"],
        }, [
          {
            name: "workflows/greet.js",
            content: `const meta = { name: 'npm-greet', description: 'NPM workflow', phases: ['hello'] };`,
          },
        ]);

        const workflows = await loadWorkflowsForTest([join(tmpRoot, "node_modules")], tmpRoot);
        expect(workflows).toHaveLength(1);
        expect(workflows[0].name).toBe("npm-greet");
        expect(workflows[0].description).toBe("NPM workflow");
        expect(workflows[0].available).toBe(true);
      });

      it("U2: resolves relative paths from manifest to absolute paths", async () => {
        makeNpmPackage("@zhushanwen/pi-example", {
          workflows: ["./workflows/build.js"],
        }, [
          {
            name: "workflows/build.js",
            content: `const meta = { name: 'build', description: 'Build workflow', phases: ['compile'] };`,
          },
        ]);

        const workflows = await loadWorkflowsForTest([join(tmpRoot, "node_modules")], tmpRoot);
        expect(workflows).toHaveLength(1);
 // Normalize paths to handle macOS /private/var symlink
        expect(workflows[0].path).toContain("/node_modules/@zhushanwen/pi-example/workflows/build.js");
      });

      it("U3: npm package workflows have correct source 'saved'", async () => {
        makeNpmPackage("@zhushanwen/pi-example", {
          workflows: ["./test.js"],
        }, [
          {
            name: "test.js",
            content: `const meta = { name: 'npm-test', description: '', phases: [] };`,
          },
        ]);

        const workflows = await loadWorkflowsForTest([join(tmpRoot, "node_modules")], tmpRoot);
        expect(workflows).toHaveLength(1);
        expect(workflows[0].source).toBe("saved");
      });

      it("U4: handles scoped packages (@scope/pkg)", async () => {
        makeNpmPackage("@zhushanwen/pi-workflows", {
          workflows: ["./deploy.js"],
        }, [
          {
            name: "deploy.js",
            content: `const meta = { name: 'deploy', description: 'Deploy workflow', phases: ['build', 'push'] };`,
          },
        ]);

        const workflows = await loadWorkflowsForTest([join(tmpRoot, "node_modules")], tmpRoot);
        expect(workflows).toHaveLength(1);
        expect(workflows[0].name).toBe("deploy");
        expect(workflows[0].phases).toEqual(["build", "push"]);
      });

      it("U5: npm package workflows have priority over user-level workflows", async () => {
        // Create user-level workflow
        const userDir = join(tmpRoot, ".pi", "agent", "workflows");
        mkdirSync(userDir, { recursive: true });
        writeScript(
          userDir,
          "same-name",
          `const meta = { name: 'same-name', description: 'User version', phases: ['user'] };`,
        );

        // Create npm package workflow with same name
        makeNpmPackage("@zhushanwen/pi-example", {
          workflows: ["./same-name.js"],
        }, [
          {
            name: "same-name.js",
            content: `const meta = { name: 'same-name', description: 'NPM version', phases: ['npm'] };`,
          },
        ]);

        const workflows = await loadWorkflowsForTest([join(tmpRoot, "node_modules")], tmpRoot);
        expect(workflows).toHaveLength(1);
        expect(workflows[0].name).toBe("same-name");
        expect(workflows[0].description).toBe("NPM version");
      });

      it("E1: ignores npm packages without pi.workflows and without workflows/ dir", async () => {
        // Package without pi.workflows and without workflows/ directory → truly ignored
        makeNpmPackage("@zhushanwen/pi-no-workflows", {
          extensions: ["./index.ts"],
        }, []);

        const workflows = await loadWorkflowsForTest([join(tmpRoot, "node_modules")], tmpRoot);
        expect(workflows).toHaveLength(0);
      });

      it("U2-fallback: discovers workflows from workflows/ dir when no pi.workflows manifest", async () => {
        // plan.md U2: npm 包无 pi.workflows 但有 workflows/ 目录 → fallback 到硬编码目录扫描
        makeNpmPackage("@zhushanwen/pi-fallback-pkg", {
          extensions: ["./index.ts"],
        }, [
          {
            name: "workflows/fallback-script.js",
            content: `const meta = { name: 'fallback-wf', description: 'found via dir scan', phases: [] };`,
          },
        ]);

        const workflows = await loadWorkflowsForTest([join(tmpRoot, "node_modules")], tmpRoot);
        const fb = workflows.find((w) => w.name === "fallback-wf");
        expect(fb).toBeDefined();
        expect(fb!.available).toBe(true);
      });

      it("E2: ignores npm packages with missing workflow script files", async () => {
        makeNpmPackage("@zhushanwen/pi-broken", {
          workflows: ["./workflows/missing.js"],
        }, []);

        const workflows = await loadWorkflowsForTest([join(tmpRoot, "node_modules")], tmpRoot);
        expect(workflows).toHaveLength(0);
      });

      it("E4: handles malformed pi.workflows manifest gracefully", async () => {
        // pi.workflows is not an array
        makeNpmPackage("@zhushanwen/pi-bad-manifest", {
          workflows: "not-an-array",
        });

        const workflows = await loadWorkflowsForTest([join(tmpRoot, "node_modules")], tmpRoot);
        expect(workflows).toHaveLength(0);
      });
    });
  });

  // ── E3: npm 目录端到端发现（pi.workflows manifest）──
  // 注入 tmpRoot 作为 cwd + 临时 npm 目录，消除对 process.cwd() 和真实全局目录的依赖：
  // 写真实全局目录会与其他并发测试文件（registry-impl）的 loadWorkflows() 扫描互相污染。
  describe("E3: discovers workflow from npm directory via pi.workflows manifest", () => {
    it("discovers workflow declared via pi.workflows in npm dir", async () => {
      makeNpmPackage("@zhushanwen/pi-workflow-fixture", {
        workflows: ["./workflows/fixture-demo.js"],
      }, [
        {
          name: "workflows/fixture-demo.js",
          content: `const meta = { name: 'fixture-demo', description: 'E3 fixture', phases: [{ title: 'Demo' }] };`,
        },
      ]);
      invalidateCache();

      const workflows = await loadWorkflowsForTest([join(tmpRoot, "node_modules")], tmpRoot);
      const fixture = workflows.find((w) => w.name === "fixture-demo");
      expect(fixture).toBeDefined();
      expect(fixture!.source).toBe("saved");
      expect(fixture!.available).toBe(true);
    });
  });

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

 // ── Phases type extension (AC-2.1) ─────────────────────────

  describe("phases type extension", () => {
    it("parses phases as array of {title, detail?} objects", async () => {
      const dir = makeWorkflowDir();
      writeScript(
        dir,
        "phase-obj",
        `const meta = { name: 'phase-obj', description: 'Object phases', phases: [{title: 'Review'}, {title: 'Fix', detail: 'Apply fixes'}] };`,
      );

      invalidateCache();
      const workflows = await loadWorkflowsForTest([], tmpRoot);
      expect(workflows).toHaveLength(1);
      expect(workflows[0].phases).toEqual([
        { title: "Review" },
        { title: "Fix", detail: "Apply fixes" },
      ]);
    });

    it("parses mixed phases (strings and objects)", async () => {
      const dir = makeWorkflowDir();
      writeScript(
        dir,
        "phase-mix",
        `const meta = { name: 'phase-mix', description: 'Mixed phases', phases: ['Init', {title: 'Review'}, {title: 'Fix', detail: 'auto'}, 'Done'] };`,
      );

      invalidateCache();
      const workflows = await loadWorkflowsForTest([], tmpRoot);
      expect(workflows).toHaveLength(1);
      expect(workflows[0].phases).toEqual([
        "Init",
        { title: "Review" },
        { title: "Fix", detail: "auto" },
        "Done",
      ]);
    });

    it("filters out invalid phase entries (numbers, null)", async () => {
      const dir = makeWorkflowDir();
      writeScript(
        dir,
        "phase-filter",
 // safeEvalObject will parse 42 and null as-is, which the filter rejects
        `const meta = { name: 'phase-filter', description: 'Filter bad phases', phases: ['Valid', 42, null, {title: 'Ok'}] };`,
      );

      invalidateCache();
      const workflows = await loadWorkflowsForTest([], tmpRoot);
      expect(workflows).toHaveLength(1);
      expect(workflows[0].phases).toEqual(["Valid", { title: "Ok" }]);
    });
  });
});
