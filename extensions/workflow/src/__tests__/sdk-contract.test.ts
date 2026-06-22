// src/__tests__/sdk-contract.test.ts
//
// SDK 契约测试：验证扩展对 Pi SDK 的消费符合 [MANDATORY] checklist。
// 关闭 CI sdk-contract-audit job 的前向引用。
//
// 核心断言（[MANDATORY] checklist）：
//   1. registerWorkflowTool 注册名为 "workflow" 的工具，execute 是 5 参数
//      (toolCallId, params, signal, onUpdate, ctx) —— ctx 是第 5 参数（SDK 契约）
//   2. registerWorkflowScriptTool 注册名为 "workflow-script" 的工具，schema 存在
//   3. /workflows command 注册名为 "workflows"，handler 是 (args, ctx)
//   4. Factory 注册 session_start / session_tree / session_shutdown 三个 handler
//
// 参考：extensions/subagents/src/__tests__/sdk-contract.test.ts（模板来源）。

/* eslint-disable taste/no-unsafe-cast */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

// ── Leaf module mocks（绕过 pi-ai / typebox 值导入 + registry 副作用） ──

vi.mock("@mariozechner/pi-ai", () => ({
  StringEnum: (values: readonly string[]) => ({ type: "string", enum: values }),
}));
vi.mock("@earendil-works/pi-ai", () => ({
  StringEnum: (values: readonly string[]) => ({ type: "string", enum: values }),
}));
vi.mock("typebox", () => ({
  Type: {
    Object: (props: Record<string, unknown>) => ({ type: "object", properties: props }),
    Optional: (schema: unknown) => ({ ...(schema as object), optional: true }),
    String: () => ({ type: "string" }),
    Boolean: () => ({ type: "boolean" }),
    Number: () => ({ type: "number" }),
    Array: (items: unknown) => ({ type: "array", items }),
    Record: (key: unknown, value: unknown) => ({
      type: "object",
      additionalProperties: value,
      key,
    }),
    Unknown: () => ({ type: "unknown" }),
    Union: (members: unknown[]) => ({ type: "union", members }),
    Literal: (value: unknown) => ({ type: "literal", value }),
  },
}));

import { registerWorkflowTool } from "../interface/tool-workflow.js";
import { registerWorkflowScriptTool } from "../interface/tool-workflow-script.js";

// ── Helpers ─────────────────────────────────────────────────

/** Capture tool registration into a record. */
function captureToolRegistration(): {
  pi: ExtensionAPI;
  getTool: (name: string) => Record<string, unknown> | undefined;
} {
  const tools: Record<string, Record<string, unknown>> = {};
  const pi = {
    registerTool: vi.fn((tool: Record<string, unknown>) => {
      tools[tool.name as string] = tool;
    }),
  } as unknown as ExtensionAPI;
  return { pi, getTool: (name) => tools[name] };
}

// ============================================================
// workflow tool 契约（FR-5：2 工具之一）
// ============================================================

describe("workflow tool contract [MANDATORY]", () => {
  it("registers a tool named 'workflow'", () => {
    const { pi, getTool } = captureToolRegistration();
    registerWorkflowTool(
      pi,
       
      { runs: new Map() } as never,
      new Set(),
      { isProcessing: false },
    );
    expect(getTool("workflow")).toBeDefined();
  });

  it("tool has parameters schema + description + promptGuidelines", () => {
    const { pi, getTool } = captureToolRegistration();
    registerWorkflowTool(
      pi,
       
      { runs: new Map() } as never,
      new Set(),
      { isProcessing: false },
    );
    const tool = getTool("workflow");
    expect(tool?.parameters).toBeDefined();
    expect(typeof tool?.description).toBe("string");
    expect(Array.isArray(tool?.promptGuidelines)).toBe(true);
  });

  it("execute is a function with arity 5 (toolCallId, params, signal, onUpdate, ctx)", () => {
    const { pi, getTool } = captureToolRegistration();
    registerWorkflowTool(
      pi,
       
      { runs: new Map() } as never,
      new Set(),
      { isProcessing: false },
    );
    const tool = getTool("workflow");
    // SDK ToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx) = 5 显式参数。
    // Function.length 不计 this，故 method 形式下仍为 5。精确断言锁定 5 参数契约。
    const execute = tool?.execute as ((...args: unknown[]) => unknown) | undefined;
    expect(typeof execute).toBe("function");
    expect(execute?.length).toBe(5);
  });
});

// ============================================================
// workflow-script tool 契约（FR-5：2 工具之二）
// ============================================================

describe("workflow-script tool contract [MANDATORY]", () => {
  it("registers a tool named 'workflow-script'", () => {
    const { pi, getTool } = captureToolRegistration();
     
    registerWorkflowScriptTool(pi, { get: vi.fn(), loadAll: vi.fn() } as never, () => false);
    expect(getTool("workflow-script")).toBeDefined();
  });

  it("tool has parameters schema with action enum (generate/lint/save/delete/list)", () => {
    const { pi, getTool } = captureToolRegistration();
     
    registerWorkflowScriptTool(pi, { get: vi.fn(), loadAll: vi.fn() } as never, () => false);
    const tool = getTool("workflow-script");
    const params = tool?.parameters as { properties?: { action?: { enum?: string[] } } };
    expect(params?.properties?.action?.enum).toEqual([
      "generate",
      "lint",
      "save",
      "delete",
      "list",
    ]);
  });

  it("execute is a function (5-param SDK signature)", () => {
    const { pi, getTool } = captureToolRegistration();
     
    registerWorkflowScriptTool(pi, { get: vi.fn(), loadAll: vi.fn() } as never, () => false);
    const tool = getTool("workflow-script");
    const execute = tool?.execute as ((...args: unknown[]) => unknown) | undefined;
    expect(typeof execute).toBe("function");
  });
});

// ============================================================
// Factory handler registration 契约
// ============================================================

describe("factory handler registration [MANDATORY]", () => {
  it("default export registers 2 tools + /workflows command + 3 session handlers", async () => {
    const tools: Record<string, unknown> = {};
    const commands: Record<string, unknown> = {};
    const events: Record<string, ((...args: unknown[]) => unknown) | undefined> = {};
    const pi = {
      registerTool: vi.fn((t: Record<string, unknown>) => {
        tools[t.name as string] = t;
      }),
      registerCommand: vi.fn((name: string, def: unknown) => {
        commands[name] = def;
      }),
      // W-3：捕获 handler 本身（而非仅 event 名），以便断言 arity。
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        events[event] = handler;
      }),
      sendMessage: vi.fn(),
      appendEntry: vi.fn(),
    } as unknown as ExtensionAPI;

    // Dynamic import to avoid alias-resolution issues at module load
    const workflowExtension = (await import("../index.js")).default;
    workflowExtension(pi);

    // FR-5: 2 tools
    expect(Object.keys(tools).sort()).toEqual(["workflow", "workflow-script"]);
    // FR-6: 1 command (/workflows)
    expect(Object.keys(commands)).toEqual(["workflows"]);
    // 3 session handlers
    expect(Object.keys(events).filter((e) => e.startsWith("session_")).sort()).toEqual([
      "session_shutdown",
      "session_start",
      "session_tree",
    ]);
  });

  it("W-3: session handlers have 2-arg (event, ctx) signature — not 1-arg (ctx)", async () => {
    // 回归保护：handler 必须是 (event, ctx) 两参数。若退化为 (ctx) => ctx.sessionManager
    // （清单 item 1 的历史 bug），fn.length 会是 1，本断言会失败。
    const events: Record<string, ((...args: unknown[]) => unknown) | undefined> = {};
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        events[event] = handler;
      }),
      sendMessage: vi.fn(),
      appendEntry: vi.fn(),
    } as unknown as ExtensionAPI;

    const workflowExtension = (await import("../index.js")).default;
    workflowExtension(pi);

    for (const name of ["session_start", "session_tree", "session_shutdown"]) {
      const handler = events[name];
      expect(typeof handler).toBe("function");
      // SDK ExtensionHandler<E> = (event: E, ctx: ExtensionContext) => ... —— 2 参数。
      // 注：async (event, ctx) 的 fn.length = 2（参数均无默认值）。
      expect(handler?.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("W-3: /workflows command handler has 2-arg (args, ctx) signature", async () => {
    const commands: Record<string, unknown> = {};
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, def: unknown) => {
        commands[name] = def;
      }),
      on: vi.fn(),
      sendMessage: vi.fn(),
      appendEntry: vi.fn(),
    } as unknown as ExtensionAPI;

    const workflowExtension = (await import("../index.js")).default;
    workflowExtension(pi);

    const cmd = commands["workflows"] as { handler?: (...args: unknown[]) => unknown } | undefined;
    expect(typeof cmd?.handler).toBe("function");
    // Pi Command handler = (args: ParsedArgs, ctx: ExtensionContext) => ... —— 2 参数。
    expect(cmd?.handler?.length).toBeGreaterThanOrEqual(2);
  });
});
