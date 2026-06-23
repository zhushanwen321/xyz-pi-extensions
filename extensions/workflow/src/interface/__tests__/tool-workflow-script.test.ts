// 测试框架：vitest
// 运行命令：npx vitest run src/interface/__tests__/tool-workflow-script.test.ts
//
// tool-workflow-script（5 actions: generate/lint/save/delete/list）测试。
// 不实际注册 tool——直接测 execute 路由（通过提取的 action 函数或注册后的 tool）。
//
// 测试 fixture 用结构化 stub 构造 mock ExtensionAPI（vi.fn 注册 tool），
// 需 `as unknown as` 断言——这是测试边界，生产代码无此需求。

/* eslint-disable taste/no-unsafe-cast */

import { describe, expect, it, vi } from "vitest";

// Mock workflow-files（save/delete 不实际写文件）
vi.mock("../../infra/workflow-files.js", () => ({
  saveWorkflow: vi.fn(async (name: string) => `Saved ${name}`),
  deleteWorkflow: vi.fn((name: string, _isRunning: (n: string) => boolean) => `Deleted ${name}`),
}));

// Mock config-loader（lint/list 不实际扫文件系统）
vi.mock("../../infra/config-loader.js", () => ({
  loadWorkflows: vi.fn(async () => []),
  invalidateCache: vi.fn(),
}));

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { WorkflowScript } from "../../engine/models/workflow-script.js";
import type { WorkflowScriptRegistry } from "../../engine/models/workflow-script-registry.js";
import { registerWorkflowScriptTool } from "../tool-workflow-script.js";

// ── 测试夹具 ─────────────────────────────────────────────────

function makePi(): { api: ExtensionAPI; registered: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> } {
  const registered: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const api = {
    registerTool: vi.fn((tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
      registered.push(tool);
    }),
  };
  return { api: api as unknown as ExtensionAPI, registered };
}

function makeRegistry(scripts: WorkflowScript[] = []): WorkflowScriptRegistry {
  return {
    loadAll: vi.fn().mockResolvedValue(scripts),
    get: vi.fn().mockResolvedValue(scripts[0]),
    invalidate: vi.fn(),
  };
}

function makeScript(name: string, available = true): WorkflowScript {
  return new WorkflowScript({
    name,
    source: "saved",
    path: `/abs/.pi/workflows/${name}.js`,
    sourceCode: `const meta = { name: "${name}" }; agent({ prompt: "hi" });`,
    meta: { name, description: `desc ${name}`, phases: [] },
    available,
  });
}

async function runAction(
  tool: { execute: (...args: unknown[]) => Promise<unknown> },
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: string; text: string }>; details: unknown; isError?: boolean }> {
  return (await tool.execute("call-1", params, signal ?? undefined, undefined, undefined)) as {
    content: Array<{ type: string; text: string }>;
    details: unknown;
    isError?: boolean;
  };
}

// ── generate action ──────────────────────────────────────────

describe("workflow-script generate", () => {
  it("有效脚本 → 生成成功（含 path）", async () => {
    const { api, registered } = makePi();
    registerWorkflowScriptTool(api, makeRegistry(), () => false);
    const result = await runAction(registered[0], {
      action: "generate",
      name: "test-gen",
      script: 'const meta = { name: "test-gen" };\nconst r = await agent({ prompt: "hi" });',
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("test-gen");
    expect(result.details).toMatchObject({ action: "generate", name: "test-gen", status: "ready" });
  });

  it("缺 name → error", async () => {
    const { api, registered } = makePi();
    registerWorkflowScriptTool(api, makeRegistry(), () => false);
    const result = await runAction(registered[0], {
      action: "generate",
      script: "const x = 1;",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("name");
  });

  it("ESM import → error", async () => {
    const { api, registered } = makePi();
    registerWorkflowScriptTool(api, makeRegistry(), () => false);
    const result = await runAction(registered[0], {
      action: "generate",
      name: "x",
      script: 'import fs from "fs"; const meta = { name: "x" }; agent({ prompt: "hi" });',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("import");
  });

  it("无 agent() → error", async () => {
    const { api, registered } = makePi();
    registerWorkflowScriptTool(api, makeRegistry(), () => false);
    const result = await runAction(registered[0], {
      action: "generate",
      name: "x",
      script: 'const meta = { name: "x" }; console.log("no agent");',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("agent()");
  });

  it("signal aborted → error", async () => {
    const { api, registered } = makePi();
    registerWorkflowScriptTool(api, makeRegistry(), () => false);
    const controller = new AbortController();
    controller.abort();
    const result = await runAction(
      registered[0],
      { action: "generate", name: "x", script: "x" },
      controller.signal,
    );
    expect(result.isError).toBe(true);
  });
});

// ── lint action ──────────────────────────────────────────────

describe("workflow-script lint", () => {
  it("缺 name → error", async () => {
    const { api, registered } = makePi();
    registerWorkflowScriptTool(api, makeRegistry(), () => false);
    const result = await runAction(registered[0], { action: "lint" });
    expect(result.isError).toBe(true);
  });
});

// ── save action ──────────────────────────────────────────────

describe("workflow-script save", () => {
  it("调 saveWorkflow（成功）", async () => {
    const { saveWorkflow } = await import("../../infra/workflow-files.js");
    const { api, registered } = makePi();
    registerWorkflowScriptTool(api, makeRegistry(), () => false);
    const result = await runAction(registered[0], { action: "save", name: "tmp-wf" });
    expect(saveWorkflow).toHaveBeenCalledWith("tmp-wf", undefined);
    expect(result.content[0].text).toContain("Saved");
  });

  it("缺 name → error", async () => {
    const { api, registered } = makePi();
    registerWorkflowScriptTool(api, makeRegistry(), () => false);
    const result = await runAction(registered[0], { action: "save" });
    expect(result.isError).toBe(true);
  });
});

// ── delete action ────────────────────────────────────────────

describe("workflow-script delete", () => {
  it("调 deleteWorkflow（成功）+ invalidate 缓存", async () => {
    const { deleteWorkflow } = await import("../../infra/workflow-files.js");
    const registry = makeRegistry();
    const { api, registered } = makePi();
    registerWorkflowScriptTool(api, registry, () => false);
    const result = await runAction(registered[0], { action: "delete", name: "wf-x" });
    expect(deleteWorkflow).toHaveBeenCalledWith("wf-x", expect.any(Function));
    expect(registry.invalidate).toHaveBeenCalled();
    expect(result.content[0].text).toContain("Deleted");
  });

  it("运行中的脚本 → deleteWorkflow 抛错（isRunning=true 时拒绝）", async () => {
    const { deleteWorkflow } = await import("../../infra/workflow-files.js");
    vi.mocked(deleteWorkflow).mockImplementationOnce((name: string) => {
      throw new Error(`Cannot delete '${name}': workflow is currently running`);
    });
    const { api, registered } = makePi();
    registerWorkflowScriptTool(api, makeRegistry(), () => true); // isRunning=true
    const result = await runAction(registered[0], { action: "delete", name: "running-wf" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("running");
  });
});

// ── list action ──────────────────────────────────────────────

describe("workflow-script list", () => {
  it("有脚本 → 列出（含 source + name + description）", async () => {
    const registry = makeRegistry([
      makeScript("wf-a"),
      makeScript("wf-b"),
    ]);
    const { api, registered } = makePi();
    registerWorkflowScriptTool(api, registry, () => false);
    const result = await runAction(registered[0], { action: "list" });
    expect(registry.loadAll).toHaveBeenCalled();
    expect(result.content[0].text).toContain("wf-a");
    expect(result.content[0].text).toContain("wf-b");
    expect(result.details).toMatchObject({ action: "list", count: 2 });
  });

  it("无脚本 → 'No workflow scripts available.'", async () => {
    const registry = makeRegistry([]);
    const { api, registered } = makePi();
    registerWorkflowScriptTool(api, registry, () => false);
    const result = await runAction(registered[0], { action: "list" });
    expect(result.content[0].text).toContain("No workflow");
  });

  it("available=false 的脚本不列出", async () => {
    const registry = makeRegistry([
      makeScript("ok"),
      makeScript("bad", false),
    ]);
    const { api, registered } = makePi();
    registerWorkflowScriptTool(api, registry, () => false);
    const result = await runAction(registered[0], { action: "list" });
    expect(result.content[0].text).toContain("ok");
    expect(result.content[0].text).not.toContain("bad");
  });
});

// ── tool 注册 ────────────────────────────────────────────────

describe("registerWorkflowScriptTool 注册", () => {
  it("注册名为 'workflow-script' 的 tool", () => {
    const { api, registered } = makePi();
    registerWorkflowScriptTool(api, makeRegistry(), () => false);
    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe("workflow-script");
  });
});
