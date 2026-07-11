/**
 * config-loader — 单元测试。
 *
 * 覆盖：discoverWorkflows / loadWorkflows / getWorkflow / invalidateCache /
 *      meta 正则提取、缓存 TTL、坏配置容错、目录优先级、来源标签。
 *
 * 策略：真实临时目录 + 真实 workflow 脚本文件（meta 提取走真实文件读取）。
 * 只 mock `findWorkspaceRoot`（getWorkflow 的 workspace 推导依赖它，且耦合
 * process.cwd()，难以隔离），保留 `discoverResources` 真实实现——扫描逻辑
 * 本身是 resource-discovery 的职责。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// resource-discovery 位于 src/shared/（从 __tests__/ 看是 ../../shared/）。
// 只覆盖 findWorkspaceRoot；其余（discoverResources 等）保持真实实现。
vi.mock("../../shared/resource-discovery.ts", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../shared/resource-discovery.ts")
  >();
  return {
    ...actual,
    findWorkspaceRoot: vi.fn(() => "/unused-by-default"),
  };
});

import {
  discoverWorkflows,
  getWorkflow,
  invalidateCache,
  type WorkflowScanConfig,
} from "../config-loader.ts";
import { findWorkspaceRoot } from "../../shared/resource-discovery.ts";

const mockedFindWorkspaceRoot = vi.mocked(findWorkspaceRoot);

// ── 临时工作区工具 ────────────────────────────────────────────

interface TempWorkspace {
  /** workspace 根（= toScanConfig 推导出的 workspaceRoot） */
  root: string;
  /** <root>/.pi/workflows —— WorkflowScanConfig.projectDir */
  projectDir: string;
  /** <root>/.pi/workflows/.tmp */
  tmpDir: string;
  /** <root>/.agents/workflows */
  agentsDir: string;
}

async function makeTempWorkspace(): Promise<TempWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "wf-cfg-test-"));
  const projectDir = join(root, ".pi", "workflows");
  const tmpDir = join(projectDir, ".tmp");
  const agentsDir = join(root, ".agents", "workflows");
  await mkdir(projectDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });
  await mkdir(agentsDir, { recursive: true });
  return { root, projectDir, tmpDir, agentsDir };
}

async function writeScript(
  dir: string,
  name: string,
  content: string,
): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, content, "utf-8");
  return p;
}

/** 合法的单行 meta 脚本。 */
function validScript(
  name: string,
  opts: { description?: string; phases?: string[] } = {},
): string {
  const description = opts.description ?? `${name} desc`;
  const phases = JSON.stringify(opts.phases ?? []);
  return `const meta = { name: "${name}", description: "${description}", phases: ${phases} };\nagent({ prompt: "x" });\n`;
}

// ── Setup / Teardown ──────────────────────────────────────────

let ws: TempWorkspace;

beforeEach(async () => {
  invalidateCache();
  mockedFindWorkspaceRoot.mockReturnValue("/unused-by-default");
  ws = await makeTempWorkspace();
});

afterEach(async () => {
  vi.useRealTimers();
  if (ws) await rm(ws.root, { recursive: true, force: true });
});

/** 过滤掉可能从真实 homedir 泄漏进来的 user-agents 文件，只保留临时工作区内结果。 */
function inTemp(wfs: Awaited<ReturnType<typeof discoverWorkflows>>) {
  return wfs.filter((w) => w.path.startsWith(ws.root));
}

// ── 测试 ──────────────────────────────────────────────────────

describe("discoverWorkflows — 加载合法配置", () => {
  it("正确加载合法 workflow 并提取 meta", async () => {
    await writeScript(ws.projectDir, "foo.js", validScript("foo"));

    const result = inTemp(await discoverWorkflows({ projectDir: ws.projectDir }));
    const foo = result.find((w) => w.name === "foo");

    expect(foo).toBeDefined();
    expect(foo!.available).toBe(true);
    expect(foo!.description).toBe("foo desc");
    expect(foo!.phases).toEqual([]);
    expect(foo!.path).toBe(join(ws.projectDir, "foo.js"));
  });

  it("支持 export const meta 形式", async () => {
    await writeScript(
      ws.projectDir,
      "bar.mjs",
      `export const meta = { name: "bar", description: "d", phases: ["p1"] };\nagent({ prompt: "x" });\n`,
    );

    const result = inTemp(await discoverWorkflows({ projectDir: ws.projectDir }));
    const bar = result.find((w) => w.name === "bar");

    expect(bar).toBeDefined();
    expect(bar!.available).toBe(true);
    expect(bar!.description).toBe("d");
    expect(bar!.phases).toEqual(["p1"]);
  });

  it("多行 meta 对象正确解析", async () => {
    await writeScript(
      ws.projectDir,
      "multi.js",
      [
        "const meta = {",
        '  name: "multi",',
        '  description: "multi-line",',
        '  phases: ["a", "b"],',
        "};",
        'agent({ prompt: "x" });',
        "",
      ].join("\n"),
    );

    const result = inTemp(await discoverWorkflows({ projectDir: ws.projectDir }));
    const multi = result.find((w) => w.name === "multi");

    expect(multi).toBeDefined();
    expect(multi!.available).toBe(true);
    expect(multi!.description).toBe("multi-line");
    expect(multi!.phases).toEqual(["a", "b"]);
  });

  it("未声明 phases 时默认为空数组", async () => {
    await writeScript(
      ws.projectDir,
      "nophase.js",
      `const meta = { name: "nophase", description: "x" };\n`,
    );

    const result = inTemp(await discoverWorkflows({ projectDir: ws.projectDir }));
    const noPhase = result.find((w) => w.name === "nophase");

    expect(noPhase).toBeDefined();
    expect(noPhase!.phases).toEqual([]);
  });
});

describe("getWorkflow — 按名查找", () => {
  beforeEach(() => {
    // getWorkflow 内部用 findWorkspaceRoot() 推导 bucket key，指向临时根。
    mockedFindWorkspaceRoot.mockReturnValue(ws.root);
  });

  it("按名查找存在的 workflow", async () => {
    await writeScript(ws.projectDir, "foo.js", validScript("foo"));

    // 先 discoverWorkflows 填充缓存（bucket key = ws.root）
    await discoverWorkflows({ projectDir: ws.projectDir });
    const foo = await getWorkflow("foo");

    expect(foo).toBeDefined();
    expect(foo!.name).toBe("foo");
    expect(foo!.available).toBe(true);
  });

  it("查找不存在的 workflow 返回 undefined", async () => {
    await writeScript(ws.projectDir, "foo.js", validScript("foo"));
    await discoverWorkflows({ projectDir: ws.projectDir });

    const missing = await getWorkflow("does-not-exist");
    expect(missing).toBeUndefined();
  });
});

describe("缓存 — invalidateCache 与 TTL", () => {
  beforeEach(() => {
    mockedFindWorkspaceRoot.mockReturnValue(ws.root);
  });

  it("invalidateCache 后 getWorkflow 重新读取文件（反映最新内容）", async () => {
    const scriptPath = await writeScript(
      ws.projectDir,
      "foo.js",
      validScript("foo", { description: "v1" }),
    );

    await discoverWorkflows({ projectDir: ws.projectDir });
    let foo = await getWorkflow("foo");
    expect(foo!.description).toBe("v1");

    // 修改文件内容；未失效缓存前 getWorkflow 仍返回旧值
    await writeFile(
      scriptPath,
      validScript("foo", { description: "v2" }),
      "utf-8",
    );
    foo = await getWorkflow("foo");
    expect(foo!.description).toBe("v1");

    // 失效缓存后重新加载
    invalidateCache();
    foo = await getWorkflow("foo");
    expect(foo!.description).toBe("v2");
  });

  it("缓存 TTL 过期后触发重新加载", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const scriptPath = await writeScript(
      ws.projectDir,
      "foo.js",
      validScript("foo", { description: "v1" }),
    );

    await discoverWorkflows({ projectDir: ws.projectDir });
    expect((await getWorkflow("foo"))!.description).toBe("v1");

    // 在 TTL（60s）内修改文件 → 缓存命中，仍是旧值
    await writeFile(
      scriptPath,
      validScript("foo", { description: "v2" }),
      "utf-8",
    );
    vi.advanceTimersByTime(30_000);
    expect((await getWorkflow("foo"))!.description).toBe("v1");

    // 超过 TTL → 缓存失效 → 重新加载
    vi.advanceTimersByTime(31_000);
    expect((await getWorkflow("foo"))!.description).toBe("v2");
  });
});

describe("坏配置容错 — 不 crash，标记 available=false", () => {
  it("缺少 const meta 声明的脚本被标记不可用", async () => {
    await writeScript(
      ws.projectDir,
      "broken.js",
      `// this script has no meta\nconsole.log("nothing");\n`,
    );

    const result = inTemp(await discoverWorkflows({ projectDir: ws.projectDir }));
    const broken = result.find((w) => w.path.endsWith("broken.js"));

    expect(broken).toBeDefined();
    expect(broken!.available).toBe(false);
    expect(broken!.name).toBe("broken"); // fallback 到文件名 stem
    expect(broken!.description).toBe("");
    expect(broken!.phases).toEqual([]);
  });

  it("meta.name 非字符串被标记不可用", async () => {
    await writeScript(
      ws.projectDir,
      "badname.js",
      `const meta = { name: 123, description: "x" };\n`,
    );

    const result = inTemp(await discoverWorkflows({ projectDir: ws.projectDir }));
    const bad = result.find((w) => w.path.endsWith("badname.js"));

    expect(bad).toBeDefined();
    expect(bad!.available).toBe(false);
    expect(bad!.name).toBe("badname"); // fallback stem
  });

  it("语法损坏的 meta 不 crash 并 fallback", async () => {
    await writeScript(
      ws.projectDir,
      "garbage.js",
      `const meta = { name: "oops", description: ;;;; };\n`,
    );

    const result = inTemp(await discoverWorkflows({ projectDir: ws.projectDir }));
    const garbage = result.find((w) => w.path.endsWith("garbage.js"));

    expect(garbage).toBeDefined();
    expect(garbage!.available).toBe(false);
    expect(garbage!.name).toBe("garbage");
  });

  it("混合可用/不可用脚本时可用脚本仍正确返回", async () => {
    await writeScript(ws.projectDir, "good.js", validScript("good"));
    await writeScript(ws.projectDir, "bad.js", `// no meta here\n`);

    const result = inTemp(await discoverWorkflows({ projectDir: ws.projectDir }));
    const good = result.find((w) => w.name === "good");
    const bad = result.find((w) => w.path.endsWith("bad.js"));

    expect(good!.available).toBe(true);
    expect(bad!.available).toBe(false);
  });
});

describe("来源标签（WorkflowSource）", () => {
  it("project .pi/workflows 下的脚本 source = saved", async () => {
    await writeScript(ws.projectDir, "foo.js", validScript("foo"));

    const result = inTemp(await discoverWorkflows({ projectDir: ws.projectDir }));
    const foo = result.find((w) => w.name === "foo");

    expect(foo!.source).toBe("saved");
  });

  it(".pi/workflows/.tmp 下的脚本 source = tmp", async () => {
    await writeScript(ws.tmpDir, "temp.js", validScript("temp"));

    const result = inTemp(await discoverWorkflows({ projectDir: ws.projectDir }));
    const temp = result.find((w) => w.name === "temp");

    expect(temp).toBeDefined();
    expect(temp!.source).toBe("tmp");
  });
});

describe("目录优先级 — 同名资源高优先级覆盖", () => {
  it("project-agents(.agents) 覆盖 project-pi(.pi/workflows)", async () => {
    // 两个文件 stem 均为 "dup"，但 meta.name 不同
    await writeScript(
      ws.projectDir,
      "dup.js",
      validScript("dup-from-pi", { description: "lower priority" }),
    );
    await writeScript(
      ws.agentsDir,
      "dup.js",
      validScript("dup-from-agents", { description: "higher priority" }),
    );

    const result = inTemp(await discoverWorkflows({ projectDir: ws.projectDir }));

    // 优先级：project-pi < project-agents，后者胜出
    const dup = result.find((w) => w.path.includes(".agents"));
    expect(dup).toBeDefined();
    expect(dup!.name).toBe("dup-from-agents");
    expect(dup!.path).toBe(join(ws.agentsDir, "dup.js"));

    // 低优先级版本不应出现
    expect(result.find((w) => w.name === "dup-from-pi")).toBeUndefined();
  });
});

describe("WorkflowScanConfig 类型接口", () => {
  it("接受完整 WorkflowScanConfig（仅 projectDir 即可触发隔离模式）", async () => {
    await writeScript(ws.projectDir, "foo.js", validScript("foo"));

    const config: WorkflowScanConfig = {
      projectDir: ws.projectDir,
      userDir: "/nonexistent-user",
      tmpDir: ws.tmpDir,
      npmDirs: [],
    };
    const result = inTemp(await discoverWorkflows(config));

    expect(result.find((w) => w.name === "foo")).toBeDefined();
  });
});
