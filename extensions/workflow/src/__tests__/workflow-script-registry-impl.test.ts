// 测试框架：vitest
// 运行命令：npx vitest run src/__tests__/workflow-script-registry-impl.test.ts
//
// 回归测试：WorkflowScriptRegistryImpl 必须填充 sourceCode。
//
// 重构期 registry 曾用 sourceCode: "" 占位（注释自称"Interface 层 readFile"），
// 但 launcher.runAndWait / tool-workflow.actionRun 直接调 script.toExecutable
// / validate 不读文件 → worker 收到空脚本 → workflow 13ms 内 0 agent 调用空跑完成。
//
// Spec（domain-models.md §7 + spec.md FR-2）：registry 是唯一读文件处（扫描+缓存+去重），
// 必须返回 sourceCode 已填充的 WorkflowScript。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type WorkflowScanConfig } from "../infra/config-loader.js";
import { WorkflowScriptRegistryImpl } from "../infra/workflow-script-registry-impl.js";

// ── Fixtures ─────────────────────────────────────────────────

let tmpRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpRoot = mkdtempSync(join(tmpdir(), "pi-workflow-registry-test-"));
  // 隔离 user 级目录，避免真实 ~/.pi/agent/workflows 污染
  mkdirSync(join(tmpRoot, "user-workflows"), { recursive: true });
  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 隔离 config：所有目录指向 tmpRoot，不碰全局 ~/.pi/agent/* */
function isolatedConfig(): WorkflowScanConfig {
  return {
    projectDir: join(tmpRoot, ".pi", "workflows"),
    tmpDir: join(tmpRoot, ".pi", "workflows", ".tmp"),
    userDir: join(tmpRoot, "user-workflows"),
    npmDirs: [],
  };
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

function scriptFor(name: string, prompt = "Review the diff"): string {
  return `const meta = {
  name: "${name}",
  description: "Test workflow ${name}",
  phases: ["review", "fix"],
};

// Workflow body — calls agent
const result = await agent({ prompt: "${prompt}", model: "test-model" });
return { reviewed: true };
`;
}

// ── Tests ────────────────────────────────────────────────────

describe("WorkflowScriptRegistryImpl — sourceCode population", () => {
  it("get() returns WorkflowScript with sourceCode populated from file", async () => {
    const dir = makeWorkflowDir();
    const expected = scriptFor("review-fix-loop");
    writeScript(dir, "review-fix-loop", expected);

    const registry = new WorkflowScriptRegistryImpl(isolatedConfig());
    const script = await registry.get("review-fix-loop");

    expect(script).toBeDefined();
    expect(script!.available).toBe(true);
 // 核心断言：sourceCode 非空，等于文件内容
    expect(script!.sourceCode).toBe(expected);
    expect(script!.sourceCode.length).toBeGreaterThan(0);
  });

  it("loadAll() returns WorkflowScript[] with sourceCode populated for each", async () => {
    const dir = makeWorkflowDir();
    writeScript(dir, "wf-a", scriptFor("wf-a"));
    writeScript(
      dir,
      "wf-b",
      `const meta = { name: "wf-b", description: "B", phases: ["p"] };
agent({ prompt: "hi" });
`,
    );

    const registry = new WorkflowScriptRegistryImpl(isolatedConfig());
    const scripts = await registry.loadAll();

    expect(scripts).toHaveLength(2);
    for (const s of scripts) {
      expect(s.available).toBe(true);
      expect(s.sourceCode.length).toBeGreaterThan(0);
      expect(s.sourceCode).toContain("agent(");
    }
  });

  it("toExecutable() returns strip-`export const meta` source (sourceCode flows through)", async () => {
    const dir = makeWorkflowDir();
 // Use `export const meta` form to verify the strip transformation
    const sourceWithExport = `export const meta = {
  name: "with-export",
  description: "Has export keyword",
  phases: ["p"],
};

agent({ prompt: "run" });
`;
    writeScript(dir, "with-export", sourceWithExport);

    const registry = new WorkflowScriptRegistryImpl(isolatedConfig());
    const script = await registry.get("with-export");

    expect(script).toBeDefined();
 // sourceCode preserves original (with export)
    expect(script!.sourceCode).toContain("export const meta");
 // toExecutable strips `export const meta` → `const meta`
    const executable = script!.toExecutable();
    expect(executable).not.toContain("export const meta");
    expect(executable).toContain("const meta");
    expect(executable).toContain("agent(");
  });

  it("60s TTL cache: second get() within TTL returns same sourceCode (no re-read)", async () => {
    const dir = makeWorkflowDir();
    const expected = scriptFor("cached-wf");
    writeScript(dir, "cached-wf", expected);

    const registry = new WorkflowScriptRegistryImpl(isolatedConfig());
    const first = await registry.get("cached-wf");
    const second = await registry.get("cached-wf");

    expect(first).toBeDefined();
    expect(second).toBeDefined();
 // Both reads populate sourceCode (cache hit still returns fully-formed entity)
    expect(first!.sourceCode).toBe(expected);
    expect(second!.sourceCode).toBe(expected);
  });

  it("invalidate() forces re-scan; updated file content is reflected", async () => {
    const dir = makeWorkflowDir();
    const path = writeScript(dir, "editable", scriptFor("editable", "ORIGINAL"));

    const registry = new WorkflowScriptRegistryImpl(isolatedConfig());
    const before = await registry.get("editable");
    expect(before!.sourceCode).toContain("ORIGINAL");

 // Mutate the file
    writeFileSync(path, scriptFor("editable", "UPDATED"), "utf-8");

 // After invalidate, fresh read reflects new content
    registry.invalidate();
    const after = await registry.get("editable");
    expect(after!.sourceCode).toContain("UPDATED");
    expect(after!.sourceCode).not.toContain("ORIGINAL");
  });

  it("available=false when meta extraction fails (sourceCode still read but script unusable)", async () => {
    const dir = makeWorkflowDir();
 // No `const meta` declaration → meta extraction fails → available=false
    writeScript(dir, "no-meta", 'console.log("no meta here"); agent({ prompt: "x" });');

    const registry = new WorkflowScriptRegistryImpl(isolatedConfig());
    const script = await registry.get("no-meta");

    expect(script).toBeDefined();
    expect(script!.available).toBe(false);
  });
});
