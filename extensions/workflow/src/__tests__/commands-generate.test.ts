// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach）
// 运行命令：npx vitest run src/__tests__/commands-generate.test.ts

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach,beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkflowInstance } from "../domain/state";

// ── Mock 外部依赖（必须在 import 被测模块之前） ──────────────

const { mockLoadWorkflows, mockInvalidateCache } = vi.hoisted(() => ({
  mockLoadWorkflows: vi.fn<() => Promise<Array<{ name: string; source: string; path: string }>>>(),
  mockInvalidateCache: vi.fn(),
}));

const { mockMkdirSync, mockWriteFileSync } = vi.hoisted(() => ({
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
}));

// commands.ts / tool-generate.ts 导入 config-loader
vi.mock("../infra/config-loader.js", () => ({
  loadWorkflows: mockLoadWorkflows,
  invalidateCache: mockInvalidateCache,
}));

// tool-generate.ts 导入 pi-tui
vi.mock("@mariozechner/pi-tui", () => ({
  Text: class Text { constructor(public text: string) {} },
}));

// tool-generate.ts 导入 typebox
vi.mock("typebox", () => ({
  Type: {
    Object: (schema: unknown) => schema,
    String: (opts?: unknown) => opts ?? {},
    Optional: (schema: unknown) => schema,
  },
}));

// Mock node:fs 中的 mkdirSync/writeFileSync，保留 existsSync 等
vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  return {
    ...orig,
    mkdirSync: mockMkdirSync,
    writeFileSync: mockWriteFileSync,
  };
});

import { deleteWorkflow,sendCompletionNotification } from "../interface/commands";
import { registerGenerateTool } from "../interface/tool-generate";

// ── Helpers ──────────────────────────────────────────────────

/** 构造一个最小 WorkflowInstance，只填充 sendCompletionNotification 需要的字段 */
function makeInstance(overrides: Partial<WorkflowInstance> = {}): WorkflowInstance {
  return {
    runId: "run-abc123def456",
    name: "test-workflow",
    status: "completed",
    scriptPath: "/fake/script.js",
    trace: [],
    startedAt: Date.now(),
    ...overrides,
  } as WorkflowInstance;
}

// ═══════════════════════════════════════════════════════════════
// commands.ts — sendCompletionNotification
// ═══════════════════════════════════════════════════════════════

describe("sendCompletionNotification", () => {
  // commands.ts 使用模块级 Set 追踪已通知的 runId，
  // 通过重复调用同一 runId 来验证去重行为。

  let sendMessageMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendMessageMock = vi.fn();
  });

  it("首次调用 -> api.sendMessage 被调用", () => {
    const api = { sendMessage: sendMessageMock } as unknown as ExtensionAPI;
    const instance = makeInstance({ runId: "unique-run-001" });

    sendCompletionNotification(api, "unique-run-001", instance);

    expect(sendMessageMock).toHaveBeenCalledOnce();
    const call = sendMessageMock.mock.calls[0][0];
    expect(call.customType).toBe("workflow-result");
    expect(call.display).toBe(true);
    expect(call.details.runId).toBe("unique-run-001");
    // FR-NOTIFY: 完成通知作为 steering 消息注入并唤醒 parent agent
    expect(sendMessageMock.mock.calls[0][1]).toEqual({ triggerTurn: true, deliverAs: "steer" });
  });

  it("重复调用同一 runId -> sendMessage 不被调用(去重)", () => {
    const api = { sendMessage: sendMessageMock } as unknown as ExtensionAPI;
    const instance = makeInstance({ runId: "dedup-run-002" });

    sendCompletionNotification(api, "dedup-run-002", instance);
    sendCompletionNotification(api, "dedup-run-002", instance);

    expect(sendMessageMock).toHaveBeenCalledOnce();
  });

  it("不同 runId -> sendMessage 各调用一次", () => {
    const api = { sendMessage: sendMessageMock } as unknown as ExtensionAPI;
    const inst1 = makeInstance({ runId: "multi-run-003" });
    const inst2 = makeInstance({ runId: "multi-run-004" });

    sendCompletionNotification(api, "multi-run-003", inst1);
    sendCompletionNotification(api, "multi-run-004", inst2);

    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it("sendMessage payload 包含 _render descriptor", () => {
    const api = { sendMessage: sendMessageMock } as unknown as ExtensionAPI;
    const instance = makeInstance({
      runId: "render-run-005",
      trace: [
        { stepIndex: 0, agent: "coder", task: "fix bug", status: "completed", result: "done" },
      ],
    });

    sendCompletionNotification(api, "render-run-005", instance);

    const payload = sendMessageMock.mock.calls[0][0];
    expect(payload.details._render).toBeDefined();
    expect(payload.details._render.type).toBe("task-list");
    expect(payload.details._render.data.items).toHaveLength(1);
    expect(payload.details._render.data.items[0].label).toContain("coder");
  });
});

// ═══════════════════════════════════════════════════════════════
// commands.ts — deleteWorkflow
// ═══════════════════════════════════════════════════════════════

describe("deleteWorkflow", () => {
  const testDir = join(tmpdir(), "pi-workflow-test-delete");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("isRunning 返回 true -> 抛出错误拒绝删除", () => {
    expect(() => deleteWorkflow("running-wf", () => true)).toThrow(
      "Cannot delete 'running-wf': workflow is currently running",
    );
  });

  it("isRunning 为 false 但文件不存在 -> 抛出 not found", () => {
    // deleteWorkflow 内部用硬编码路径(.pi/workflows/)查找文件
    // 在测试 CWD 下这些文件不存在，所以 isRunning=false 时必定 not found
    expect(() => deleteWorkflow("ghost", () => false)).toThrow("not found");
  });

  it("文件不存在 -> 抛出 Error 含 not found", () => {
    expect(() => deleteWorkflow("nonexistent-wf", () => false)).toThrow(
      "not found",
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// tool-generate.ts — registerGenerateTool execute
// ═══════════════════════════════════════════════════════════════

describe("tool-generate execute", () => {
  let executeFn: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadWorkflows.mockResolvedValue([]);

    // 注册工具并捕获 execute
    let captured: ((...args: unknown[]) => Promise<unknown>) | undefined;
    const mockPi = {
      registerTool: vi.fn((def: Record<string, unknown>) => {
        captured = def.execute as ((...args: unknown[]) => Promise<unknown>);
      }),
    } as unknown as ExtensionAPI;

    registerGenerateTool(mockPi);

    if (!captured) throw new Error("registerGenerateTool did not register a tool");
    executeFn = captured as typeof executeFn;
  });

  // ── 辅助：构造合法最小脚本 ──
  const validScript =
    "const meta = { name: 'test', description: 'test', phases: ['a'] };\n" +
    "const r = await agent({ prompt: 'hi' });\n" +
    "return r;";

  // ── 正常路径 ──

  it("合法脚本 -> 成功写入, content 包含 'Generated workflow script:'", async () => {
    const result = await executeFn("tc-1", {
      name: "hello",
      script: validScript,
    });

    // 成功时返回对象不含 isError 属性
    expect(result).not.toHaveProperty("isError");
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("Generated workflow script:");
    expect(text).toContain("hello");
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    expect(mockInvalidateCache).toHaveBeenCalledOnce();
  });

  // ── ESM import 拒绝 ──

  it("ESM import 语法 -> isError=true, 提示用 require()", async () => {
    const esmScript =
      "import fs from 'node:fs';\n" +
      "const meta = { name: 'x', phases: [] };\n" +
      "const r = await agent({ prompt: 'a' });";
    const result = await executeFn("tc-2", { name: "bad-esm", script: esmScript });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("require()");
  });

  // ── 非 meta 的 export 拒绝 ──

  it("ESM export 非 meta -> isError=true", async () => {
    const exportScript =
      "const meta = { name: 'x', phases: [] };\n" +
      "export function helper() {}\n" +
      "const r = await agent({ prompt: 'a' });";
    const result = await executeFn("tc-3", { name: "bad-export", script: exportScript });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("export");
  });

  // ── export const meta 允许(CC 兼容格式) ──

  it("export const meta -> 不报错(CC 兼容格式)", async () => {
    const ccScript =
      "export const meta = { name: 'cc', description: 'cc', phases: ['x'] };\n" +
      "const r = await agent({ prompt: 'hi' });\n" +
      "return r;";
    const result = await executeFn("tc-cc", { name: "cc-ok", script: ccScript });

    // 不应报 ESM export 错误
    expect(result).not.toHaveProperty("isError");
  });

  // ── 缺 meta 声明 ──

  it("缺 meta 声明 -> isError=true, 提示 must contain a meta declaration", async () => {
    const noMeta = "const r = await agent({ prompt: 'hi' });\nreturn r;";
    const result = await executeFn("tc-4", { name: "no-meta", script: noMeta });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("must contain a meta declaration");
  });

  // ── 缺 agent() 调用 ──

  it("缺 agent() 调用 -> isError=true, 提示 agent()", async () => {
    const noAgent = "const meta = { name: 'x', description: 'x', phases: [] };\nconsole.log('no agent');";
    const result = await executeFn("tc-5", { name: "no-agent", script: noAgent });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("agent()");
  });

  // ── module.exports.execute 无 await agent() 调用 ──

  it("module.exports.execute 但无 await agent() 调用 -> isError=true", async () => {
    // 源码的 hasTopLevelAwait 正则匹配脚本中任意位置的 "await agent("
    // 所以必须确保脚本中完全没有 "await agent(" 才能触发此错误
    const modExport =
      "const meta = { name: 'x', phases: [] };\n" +
      "module.exports = { execute: async function() { const r = agent({ prompt: 'a' }); return r; } };";
    const result = await executeFn("tc-6", { name: "mod-export", script: modExport });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("module.exports.execute");
  });

  // ── 语法错误 ──

  it("语法错误脚本 -> isError=true, 提示 Syntax error", async () => {
    const badSyntax =
      "const meta = { name: 'x', phases: [] };\n" +
      "const r = await agent({ prompt: 'hi' });\n" +
      "function ( { }";
    const result = await executeFn("tc-7", { name: "bad-syntax", script: badSyntax });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("Syntax error");
  });

  // ── 名称冲突 ──

  it("名称冲突 -> isError=true, 提示 Name conflict", async () => {
    mockLoadWorkflows.mockResolvedValue([
      { name: "existing", source: "saved", path: "/fake/existing.js" },
    ]);

    const result = await executeFn("tc-8", {
      name: "existing",
      script: validScript,
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("Name conflict");
    expect(text).toContain("existing");
    // 不应写入文件
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});
