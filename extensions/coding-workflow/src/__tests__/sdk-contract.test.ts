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
import { Value } from "@sinclair/typebox/value";
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

  it("parameters schema includes action enum with 9 values", () => {
    let capturedSchema: { properties?: Record<string, unknown> } | undefined;
    const pi = mockExtensionApi({
      registerTool: (tool: { parameters: { properties?: Record<string, unknown> } }) => {
        capturedSchema = tool.parameters;
      },
    });
    registerCodingWorkflowTool(pi);
    const actionProp = capturedSchema!.properties!.action as { enum?: string[] };
    expect(actionProp.enum).toEqual([
      "create", "plan", "clarify", "detail", "dev", "test", "retrospect", "closeout", "replan",
    ]);
  });

  // 回归测试（2026-07-04 bug）：planJson/clarifyJson/detailJson 必须声明 type:object，
  // 不能是 Type.Unknown()（编译成 {} 无 type 字段）。
  // 原因：LLM 看到 schema 无 type 提示，容易把 JSON 内容当 string 传；到 handler 的
  // typeof !== "object" 守卫被拒。显式 type:object 让 LLM 知道传 object，且 string
  // 输入在 Pi validation 层就拒（报 Validation failed，比 handler 的 not an object 更早更清晰）。
  //
  // 2026-07-04 升级（方案 B）：3 个 JSON 字段直接引用 plan-parser 的完整 schema，
  // 不只是 type:object，而是完整字段结构（format literal + waves/testCases/deliverables）。
  // cases 元素引用 TestCaseSubmissionSchema（caseId 必填）。
  it("REGRESSION 2026-07-04: planJson/clarifyJson/detailJson bind to plan-parser schemas (full structure, not ANY_OBJECT)", () => {
    let capturedSchema: { properties?: Record<string, Record<string, unknown>> } | undefined;
    const pi = mockExtensionApi({
      registerTool: (tool: { parameters: { properties?: Record<string, unknown> } }) => {
        capturedSchema = tool.parameters;
      },
    });
    registerCodingWorkflowTool(pi);

    // planJson：LitePlanSchema（format:"lite" + waves + testCases 含 expected）
    const planJson = capturedSchema!.properties!.planJson;
    const planSerialized = JSON.stringify(planJson);
    expect(planSerialized).toContain('"type":"object"');
    expect(planSerialized).toContain('"const":"lite"'); // format literal 锁定
    expect(planSerialized).toContain('"waves"');
    expect(planSerialized).toContain('"testCases"');
    expect(planSerialized).toContain('"expected"'); // lite 特有字段

    // clarifyJson：MidClarifySchema（format:"mid-clarify" + deliverables）
    const clarifyJson = capturedSchema!.properties!.clarifyJson;
    const clarifySerialized = JSON.stringify(clarifyJson);
    expect(clarifySerialized).toContain('"const":"mid-clarify"');
    expect(clarifySerialized).toContain('"deliverables"');
    expect(clarifySerialized).toContain('"requirements"');

    // detailJson：MidDetailSchema（format:"mid-detail" + assertion + issues）
    const detailJson = capturedSchema!.properties!.detailJson;
    const detailSerialized = JSON.stringify(detailJson);
    expect(detailSerialized).toContain('"const":"mid-detail"');
    expect(detailSerialized).toContain('"assertion"'); // mid 特有字段（非 expected）
    expect(detailSerialized).toContain('"issues"'); // mid wave 字段（非 changes）

    // cases：TestCaseSubmissionSchema（caseId 必填 + actual/screenshotPath/commitHash/claimedStatus）
    const cases = capturedSchema!.properties!.cases;
    const casesSerialized = JSON.stringify(cases);
    expect(casesSerialized).toContain('"caseId"');
    expect(casesSerialized).toContain('"required":["caseId"]'); // caseId 必填
    expect(casesSerialized).toContain('"screenshotPath"');
    expect(casesSerialized).toContain('"commitHash"');
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

    // create action：构造临时 workspace，让 CwStore 能建 _cw.json。
    // execute 内部会 new CwStore(resolveCwDbPath(workspacePath))，db 落
    // ~/.pi/agent/cw/<encoded-cwd>/_cw.json（全局，见 index.ts resolveCwDbPath）。
    const workspacePath = `/tmp/cw-sdk-contract-${Date.now()}`;
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    fs.mkdirSync(`${workspacePath}/.xyz-harness`, { recursive: true });
    const { encodeCwd } = await import("../cw/path-encoding.js");
    const globalCwDir = path.join(os.homedir(), ".pi", "agent", "cw", encodeCwd(workspacePath));
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
      // 全局 db 目录也要清，否则 ~/.pi/agent/cw/ 积累测试垃圾
      fs.rmSync(globalCwDir, { recursive: true, force: true });
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
    const path = await import("node:path");
    const os = await import("node:os");
    fs.mkdirSync(`${workspacePath}/.xyz-harness`, { recursive: true });
    const { encodeCwd } = await import("../cw/path-encoding.js");
    const globalCwDir = path.join(os.homedir(), ".pi", "agent", "cw", encodeCwd(workspacePath));
    try {
      await expect(
        capturedExecute!("call-2", { action: "bogus", workspacePath }, undefined),
      ).rejects.toThrow(/unknown action/);
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
      fs.rmSync(globalCwDir, { recursive: true, force: true });
    }
  });

  // 方案 B 核心 value-add：tool schema 直接绑定 plan-parser schema，
  // Pi validation 层（Value.Check）就能拒绝三类常见 LLM 误用，不用到 handler 才报错。
  // 每个用例对应一种 LLM 实际会犯的错误。
  it("schema rejects common LLM misuse at validation layer (not at handler)", () => {
    let capturedSchema: { properties?: Record<string, unknown> } | undefined;
    const pi = mockExtensionApi({
      registerTool: (tool: { parameters: { properties?: Record<string, unknown> } }) => {
        capturedSchema = tool.parameters;
      },
    });
    registerCodingWorkflowTool(pi);
    // 拿到 schema 后用 Value.Check 模拟 Pi validation 层的拒绝行为。
    // typebox 的 ~kind 是非枚举字符串键，Value.Check 能正确读取。
    const planJsonSchema = capturedSchema!.properties!.planJson;
    const casesSchema = capturedSchema!.properties!.cases;

    // 1. 字符串误传（2026-07-04 bug 的核心场景）
    expect(Value.Check(planJsonSchema, '{"format":"lite"}')).toBe(false);

    // 2. format 不匹配（mid-clarify JSON 误传到 planJson 字段）
    expect(
      Value.Check(planJsonSchema, {
        format: "mid-clarify",
        objective: "x",
        deliverables: { requirements: "r.md", systemArchitecture: "a.md" },
      }),
    ).toBe(false);

    // 3. 缺必填字段（testCases 是 lite plan 必填）
    expect(
      Value.Check(planJsonSchema, {
        format: "lite",
        objective: "x",
        waves: [{ id: "W1", changes: ["a.ts"], dependsOn: [] }],
      }),
    ).toBe(false);

    // 4. cases 元素缺 caseId（caseId 是 TestCaseSubmission 必填）
    expect(
      Value.Check(casesSchema, [{ screenshotPath: "/tmp/x.png", claimedStatus: "passed" }]),
    ).toBe(false);

    // 5. 正当输入仍然通过（不能因为收紧而拒合法数据）
    expect(
      Value.Check(planJsonSchema, {
        format: "lite",
        objective: "x",
        waves: [{ id: "W1", changes: ["a.ts"], dependsOn: [] }],
        testCases: [{
          id: "E1", layer: "real", scenario: "s", steps: "st",
          expected: { url: "/dash" }, executor: "vitest",
          requiresScreenshot: true,
        }],
      }),
    ).toBe(true);
    expect(
      Value.Check(casesSchema, [{ caseId: "E1", screenshotPath: "/tmp/x.png" }]),
    ).toBe(true);
  });
});
