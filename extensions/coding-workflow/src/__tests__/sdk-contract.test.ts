// src/__tests__/sdk-contract.test.ts
//
// SDK 契约测试：验证 CW 扩展对 Pi SDK 的消费符合 [MANDATORY] checklist。
//
// 核心断言：
//   1. codingWorkflowExtension 注册单个 tool 名为 "coding-workflow"
//   2. ToolDefinition 必填字段齐全（name/label/description/parameters/execute）
//   3. parameters schema 含 action 字段且枚举 8 个值
//   4. execute 是函数（三参数签名由编译期保证）
//
// 不导入 dispatch 的真业务逻辑（那由 actions/__tests__ 覆盖）；只验证 SDK 接线契约。

// SDK 值导入（StringEnum/Type）走 vitest alias 指向真实 pi-ai/typebox，无需 mock。
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import codingWorkflowExtension, { registerCodingWorkflowTool } from "../index.js";

/**
 * 最小 ExtensionAPI mock：Proxy 把所有未 override 的方法短路为 no-op，
 * 结构兼容 ExtensionAPI（避免 unsafe cast）。
 */
function mockExtensionApi(overrides: Record<string, unknown> = {}): ExtensionAPI {
  const noop = (): void => { /* test mock */ };
  return new Proxy<ExtensionAPI>(overrides as unknown as ExtensionAPI, {
    get(target, prop: string | symbol): unknown {
      if (prop in target) return target[prop as keyof ExtensionAPI];
      return noop;
    },
  });
}

describe("coding-workflow SDK contract [MANDATORY]", () => {
  it("registers a single tool named 'coding-workflow'", () => {
    const registered: { name: string }[] = [];
    const pi = mockExtensionApi({
      registerTool: (tool: { name: string }) => { registered.push(tool); },
    });
    codingWorkflowExtension(pi);
    expect(registered).toHaveLength(1);
    expect(registered[0]!.name).toBe("coding-workflow");
  });

  it("tool definition has all required fields", () => {
    let captured: Record<string, unknown> | undefined;
    const pi = mockExtensionApi({
      registerTool: (tool: Record<string, unknown>) => { captured = tool; },
    });
    registerCodingWorkflowTool(pi);
    expect(captured).toBeDefined();
    expect(typeof captured!.name).toBe("string");
    expect(typeof captured!.label).toBe("string");
    expect(typeof captured!.description).toBe("string");
    expect(captured!.parameters).toBeDefined();
    expect(typeof captured!.execute).toBe("function");
  });

  it("parameters schema includes action enum with 8 values", () => {
    let capturedSchema: { properties?: Record<string, unknown> } | undefined;
    const pi = mockExtensionApi({
      registerTool: (tool: { parameters: { properties?: Record<string, unknown> } }) => {
        capturedSchema = tool.parameters;
      },
    });
    registerCodingWorkflowTool(pi);
    const actionProp = capturedSchema!.properties!.action as { enum?: string[] };
    expect(actionProp.enum).toEqual([
      "create", "plan", "clarify", "detail", "dev", "test", "retrospect", "closeout",
    ]);
  });

  it("execute returns content array + details object on valid action", async () => {
    let capturedExecute: ((...args: unknown[]) => Promise<unknown>) | undefined;
    const pi = mockExtensionApi({
      registerTool: (tool: { execute: (...args: unknown[]) => Promise<unknown> }) => {
        capturedExecute = tool.execute;
      },
    });
    registerCodingWorkflowTool(pi);
    expect(capturedExecute).toBeDefined();

    // create action：构造临时 workspace，让 CwStore 能建 _cw.db。
    // execute 内部会 new CwStore(workspacePath/.xyz-harness/_cw.db)。
    const workspacePath = `/tmp/cw-sdk-contract-${Date.now()}`;
    const fs = await import("node:fs");
    fs.mkdirSync(`${workspacePath}/.xyz-harness`, { recursive: true });
    try {
      const result = await capturedExecute!(
        "call-1",
        { action: "create", slug: "sdk-test", tier: "lite", objective: "contract test", workspacePath },
        undefined,
      ) as { content: unknown[]; details: { topicId: string; status: string } };
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(typeof result.details).toBe("object");
      expect(result.details.topicId).toMatch(/^cw-\d{4}-\d{2}-\d{2}-sdk-test$/);
      expect(result.details.status).toBe("created");
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("execute throws when action unknown", async () => {
    let capturedExecute: ((...args: unknown[]) => Promise<unknown>) | undefined;
    const pi = mockExtensionApi({
      registerTool: (tool: { execute: (...args: unknown[]) => Promise<unknown> }) => {
        capturedExecute = tool.execute;
      },
    });
    registerCodingWorkflowTool(pi);
    const workspacePath = `/tmp/cw-sdk-contract-err-${Date.now()}`;
    const fs = await import("node:fs");
    fs.mkdirSync(`${workspacePath}/.xyz-harness`, { recursive: true });
    try {
      await expect(
        capturedExecute!("call-2", { action: "bogus", workspacePath }, undefined),
      ).rejects.toThrow(/unknown action/);
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
