// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach/afterEach）
// 运行命令：npx vitest run src/__tests__/config-loader.test.ts

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach,beforeEach, describe, expect, it } from "vitest";

import {
  discoverWorkflows,
  getWorkflow,
  invalidateCache,
  type WorkflowScanConfig,
} from "../infra/config-loader";

// ── Helpers ──────────────────────────────────────────────────

let tmpRoot: string;
let isolatedUserDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpRoot = mkdtempSync(join(tmpdir(), "pi-workflow-test-"));
  // 隔离 user 级目录，避免真实 ~/.pi/agent/workflows 的脚本污染测试
  isolatedUserDir = join(tmpRoot, "user-workflows");
  mkdirSync(isolatedUserDir, { recursive: true });
  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * 加载 workflow 时注入隔离的 userDir，屏蔽真实 ~/.pi/agent/workflows。
 * 默认 cwd = tmpRoot（与既有测试一致）。
 */
async function loadIsolated(npmDirs: string[] = [], cwd: string = tmpRoot): Promise<
  import("../infra/config-loader").CachedWorkflowMeta[]
> {
  // discoverWorkflows 是唯一发现入口；这里注入隔离 userDir + 空 npmDirs
  return discoverWorkflows({ npmDirs, cwd, userDir: isolatedUserDir });
}

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
      const workflows = await loadIsolated();
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

      const workflows = await loadIsolated();
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

      const workflows = await loadIsolated();
      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe("local-meta");
      expect(workflows[0].description).toBe("No exports needed");
      expect(workflows[0].available).toBe(true);
    });

    it("marks scripts with no meta as unavailable", async () => {
      const dir = makeWorkflowDir();
      writeScript(dir, "bad", `console.log("no meta here");`);

      const workflows = await loadIsolated();
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

      const workflows = await loadIsolated();
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

      const workflows = await loadIsolated();
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

      const workflows = await loadIsolated();
      expect(workflows).toHaveLength(1);
      expect(workflows[0].available).toBe(true);
      expect(workflows[0].name).toBe("mod-exports");
    });

    it("discovers multiple scripts and sorts by available", async () => {
      const dir = makeWorkflowDir();
      writeScript(dir, "good", `const meta = { name: 'good', description: '', phases: [] };`);
      writeScript(dir, "bad", `// no meta`);

      const workflows = await loadIsolated();
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

      const workflows = await loadIsolated();
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

      const workflows = await loadIsolated();
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

        const workflows = await loadIsolated([join(tmpRoot, "node_modules")]);
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

        const workflows = await loadIsolated([join(tmpRoot, "node_modules")]);
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

        const workflows = await loadIsolated([join(tmpRoot, "node_modules")]);
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

        const workflows = await loadIsolated([join(tmpRoot, "node_modules")]);
        expect(workflows).toHaveLength(1);
        expect(workflows[0].name).toBe("deploy");
        expect(workflows[0].phases).toEqual(["build", "push"]);
      });

      it("U5: npm package workflows have priority over user-level workflows", async () => {
        // Create user-level workflow in the isolated user dir
        writeScript(
          isolatedUserDir,
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

        const workflows = await loadIsolated([join(tmpRoot, "node_modules")]);
        expect(workflows).toHaveLength(1);
        expect(workflows[0].name).toBe("same-name");
        expect(workflows[0].description).toBe("NPM version");
      });

      it("E1: ignores npm packages without pi.workflows and without workflows/ dir", async () => {
        // Package without pi.workflows and without workflows/ directory → truly ignored
        makeNpmPackage("@zhushanwen/pi-no-workflows", {
          extensions: ["./index.ts"],
        }, []);

        const workflows = await loadIsolated([join(tmpRoot, "node_modules")]);
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

        const workflows = await loadIsolated([join(tmpRoot, "node_modules")]);
        const fb = workflows.find((w) => w.name === "fallback-wf");
        expect(fb).toBeDefined();
        expect(fb!.available).toBe(true);
      });

      it("E2: ignores npm packages with missing workflow script files", async () => {
        makeNpmPackage("@zhushanwen/pi-broken", {
          workflows: ["./workflows/missing.js"],
        }, []);

        const workflows = await loadIsolated([join(tmpRoot, "node_modules")]);
        expect(workflows).toHaveLength(0);
      });

      it("E4: handles malformed pi.workflows manifest gracefully", async () => {
        // pi.workflows is not an array
        makeNpmPackage("@zhushanwen/pi-bad-manifest", {
          workflows: "not-an-array",
        });

        const workflows = await loadIsolated([join(tmpRoot, "node_modules")]);
        expect(workflows).toHaveLength(0);
      });

      // 根因 1（主因）：pi.workflows 声明为目录（如 pi-coding-workflow 的
      // ["./workflows"]）时，manifest 模式对目录 readFile 会 EISDIR 空转。
      // 修复后目录声明走 scanDirectory。
      it("RC1-dir: discovers workflows when pi.workflows declares a directory", async () => {
        makeNpmPackage("@zhushanwen/pi-coding-workflow", {
          workflows: ["./workflows"],
        }, [
          {
            name: "workflows/execute-full-workflow.js",
            content: `const meta = { name: 'execute-full-workflow', description: 'Dir-declared workflow', phases: ['setup', 'execute'] };`,
          },
          {
            name: "workflows/another.js",
            content: `const meta = { name: 'another', description: 'Sibling in same dir', phases: [] };`,
          },
        ]);

        const workflows = await loadIsolated([join(tmpRoot, "node_modules")]);
        const names = workflows.map((w) => w.name).sort();
        expect(names).toEqual(["another", "execute-full-workflow"]);
        expect(workflows.every((w) => w.available)).toBe(true);
      });

      // 根因 1 防御补充：manifest 全失败（声明的路径都不存在）时，
      // 应 fallback 到包内 workflows/ 目录扫描，而非返回空。
      it("RC1-fallback: falls back to workflows/ dir when manifest paths all miss", async () => {
        makeNpmPackage("@zhushanwen/pi-stale-manifest", {
          // manifest 指向已不存在的文件，但 workflows/ 目录里有合法脚本
          workflows: ["./workflows/deprecated.js"],
        }, [
          {
            name: "workflows/current.js",
            content: `const meta = { name: 'current', description: 'Found via fallback', phases: [] };`,
          },
        ]);

        const workflows = await loadIsolated([join(tmpRoot, "node_modules")]);
        const current = workflows.find((w) => w.name === "current");
        expect(current).toBeDefined();
        expect(current!.available).toBe(true);
      });

      // 根因 3：scanDirectory 用 Dirent.isFile() 过滤会漏掉 symlink。
      // 修复后指向普通文件的 symlink 被纳入扫描。
      it("RC3-symlink: discovers workflow scripts reachable only via symlink", async () => {
        const dir = makeWorkflowDir();
        // 真实文件放在 user 级目录外（模拟 dotfiles/多机同步的集中存放）
        const externalDir = join(tmpRoot, "external-scripts");
        mkdirSync(externalDir, { recursive: true });
        writeFileSync(
          join(externalDir, "linked-wf.js"),
          `const meta = { name: 'linked-wf', description: 'Via symlink', phases: ['a'] };`,
          "utf-8",
        );
        // 在扫描目录内创建 symlink 指向真实文件
        symlinkSync(join(externalDir, "linked-wf.js"), join(dir, "linked-wf.js"));

        const workflows = await loadIsolated();
        const linked = workflows.find((w) => w.name === "linked-wf");
        expect(linked).toBeDefined();
        expect(linked!.available).toBe(true);
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

      const workflows = await loadIsolated([join(tmpRoot, "node_modules")]);
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
      const workflows = await loadIsolated();
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
      const workflows = await loadIsolated();
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
      const workflows = await loadIsolated();
      expect(workflows).toHaveLength(1);
      expect(workflows[0].phases).toEqual(["Valid", { title: "Ok" }]);
    });
  });

  // ── 根因 2：bare+worktree 下 project 级 .pi/workflows 的发现 ────
  // findWorkspaceRoot 原本在检测到 .bare 后固定返回 workspace 根（.bare
  // 所在层），导致用户把 .pi/workflows 放在当前 worktree 内时扫不到。
  // 修复后：若 cwd 是 workspace 根的直接子目录（即 worktree 根）且自身
  // 有 .pi，优先用 cwd。
  describe("bare+worktree: project-level .pi/workflows discovery", () => {
    let wsRoot: string;

    beforeEach(() => {
      // 构造 bare+worktree 结构：
      //   <tmpRoot>/ws/.bare              ← workspace 根标记
      //   <tmpRoot>/ws/main/              ← worktree 根（cwd）
      //   <tmpRoot>/ws/main/.pi/workflows/ ← project 级脚本（应被发现）
      wsRoot = join(tmpRoot, "ws");
      mkdirSync(join(wsRoot, ".bare"), { recursive: true });
      mkdirSync(join(wsRoot, "main", ".pi", "workflows"), { recursive: true });
      writeFileSync(
        join(wsRoot, "main", ".pi", "workflows", "worktree-wf.js"),
        `const meta = { name: 'worktree-wf', description: 'In current worktree', phases: [] };`,
        "utf-8",
      );
    });

    it("RC2: discovers .pi/workflows inside the current worktree (not workspace root)", async () => {
      const cwd = join(wsRoot, "main");
      const workflows = await loadIsolated([], cwd);
      const wf = workflows.find((w) => w.name === "worktree-wf");
      expect(wf).toBeDefined();
      expect(wf!.available).toBe(true);
      // 路径应在 worktree 内，而非 workspace 根
      expect(wf!.path).toContain("/ws/main/.pi/workflows/");
    });

    it("RC2: falls back to workspace root when worktree has no .pi", async () => {
      // 另一个无 .pi 的 worktree——应退回 workspace 根行为
      const otherWorktree = join(wsRoot, "no-pi-wt");
      mkdirSync(otherWorktree, { recursive: true });
      // workspace 根放一个脚本，验证回退后能发现
      mkdirSync(join(wsRoot, ".pi", "workflows"), { recursive: true });
      writeFileSync(
        join(wsRoot, ".pi", "workflows", "shared-wf.js"),
        `const meta = { name: 'shared-wf', description: 'At workspace root', phases: [] };`,
        "utf-8",
      );

      const workflows = await loadIsolated([], otherWorktree);
      const shared = workflows.find((w) => w.name === "shared-wf");
      expect(shared).toBeDefined();
      expect(shared!.available).toBe(true);
    });
  });

  // ── discoverWorkflows：显式 config 注入（单一发现入口）──────
  // discoverWorkflows 是生产/测试唯一通路。loadWorkflows() 是它的无参 preset。
  // 测试用显式 config 注入完整目录集，验证只扫这些目录、不碰全局。
  describe("discoverWorkflows(config)", () => {
    function makeConfig(overrides?: Partial<WorkflowScanConfig>): WorkflowScanConfig {
      const projectDir = join(tmpRoot, "cfg-project");
      const userDir = join(tmpRoot, "cfg-user");
      const tmpDir = join(tmpRoot, "cfg-tmp");
      for (const d of [projectDir, userDir, tmpDir]) mkdirSync(d, { recursive: true });
      return { projectDir, userDir, tmpDir, npmDirs: [], ...overrides };
    }

    it("只扫 config 声明的目录，不碰全局 ~/.pi/agent/workflows", async () => {
      const config = makeConfig();
      writeFileSync(
        join(config.projectDir, "proj-wf.js"),
        `const meta = { name: 'proj-wf', description: 'project scope', phases: [] };`,
        "utf-8",
      );
      writeFileSync(
        join(config.userDir, "user-wf.js"),
        `const meta = { name: 'user-wf', description: 'user scope', phases: [] };`,
        "utf-8",
      );
      writeFileSync(
        join(config.tmpDir, "tmp-wf.js"),
        `const meta = { name: 'tmp-wf', description: 'tmp scope', phases: [] };`,
        "utf-8",
      );

      const workflows = await discoverWorkflows(config);
      const names = workflows.map((w) => w.name).sort();
      expect(names).toEqual(["proj-wf", "tmp-wf", "user-wf"]);
      // 不碰全局——即使 ~/.pi/agent/workflows 有脚本也不会出现
      const globalOnly = workflows.find((w) => w.name === "execute-full-workflow");
      expect(globalOnly).toBeUndefined();
    });

    it("config 的 tmp 优先级高于 project 和 user（同 name 去重）", async () => {
      const config = makeConfig();
      for (const [dir, desc] of [
        [config.userDir, "user-version"],
        [config.projectDir, "project-version"],
        [config.tmpDir, "tmp-version"],
      ] as const) {
        writeFileSync(
          join(dir, "same.js"),
          `const meta = { name: 'same', description: '${desc}', phases: [] };`,
          "utf-8",
        );
      }

      const workflows = await discoverWorkflows(config);
      const same = workflows.find((w) => w.name === "same");
      expect(same).toBeDefined();
      expect(same!.description).toBe("tmp-version");
      expect(same!.source).toBe("tmp");
    });

    it("config npmDirs 声明的 npm 包被扫描（manifest 目录声明兼容）", async () => {
      const npmDir = join(tmpRoot, "cfg-npm");
      const pkgDir = join(npmDir, "@scope", "pkg");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: "@scope/pkg", pi: { workflows: ["./wf"] } }),
        "utf-8",
      );
      const wfDir = join(pkgDir, "wf");
      mkdirSync(wfDir, { recursive: true });
      writeFileSync(
        join(wfDir, "npm-wf.js"),
        `const meta = { name: 'npm-wf', description: 'via npm manifest', phases: [] };`,
        "utf-8",
      );

      const config = makeConfig({ npmDirs: [npmDir] });
      const workflows = await discoverWorkflows(config);
      const npmWf = workflows.find((w) => w.name === "npm-wf");
      expect(npmWf).toBeDefined();
      expect(npmWf!.available).toBe(true);
    });

    it("空 config（全空目录）返回空数组", async () => {
      const config = makeConfig();
      const workflows = await discoverWorkflows(config);
      expect(workflows).toEqual([]);
    });
  });
});
