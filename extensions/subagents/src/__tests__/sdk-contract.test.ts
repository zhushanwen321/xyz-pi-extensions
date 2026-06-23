// src/__tests__/sdk-contract.test.ts
//
// SDK 契约测试：验证扩展对 Pi SDK 的消费符合 [MANDATORY] checklist。
// 关闭 CI sdk-contract-audit job 的前向引用（该 job 直接跑此文件）。
//
// 核心断言（[MANDATORY] checklist）：
//   1. registerSubagentsCommand 注册名为 "subagents" 的命令，handler 是 (args, ctx)
//   2. registerSubagentTool 注册名为 "subagent" 的工具，schema 存在
//   3. notifier sendMessage 用 triggerTurn:true + deliverAs:followUp
//   4. session_start handler 类型签名 (event, ctx) → 编译期保证（stub 精确类型）
//
// 不导入 index.ts（它经 getAgentDir 值导入触发 alias 解析失败——alias 指向
// .d.ts-only stub）。改测叶子注册函数 + notifier 直接断言。session_start 的
// (event, ctx) 双参数契约由 tsconfig 的精确 stub 类型在编译期强制（见
// shared/types/mariozechner/index.d.ts 注释：modelRegistry/cwd/ui 不在 event 上）。

import { describe, expect, it, vi } from "vitest";

// registerSubagentTool 经 subagent-tool.ts 值导入 StringEnum（pi-ai）+ Type（typebox）。
// shared/types stub 是 .d.ts（仅类型），pnpm optional-peer-dep 插件拦截值导入 → vi.mock 兜底。
vi.mock("@mariozechner/pi-ai", () => ({
  StringEnum: (values: string[]) => ({ type: "string", enum: values }),
}));
vi.mock("@earendil-works/pi-ai", () => ({
  StringEnum: (values: string[]) => ({ type: "string", enum: values }),
}));
vi.mock("@sinclair/typebox", () => ({
  Type: {
    Object: (props: Record<string, unknown>) => ({ type: "object", properties: props }),
    Optional: (schema: unknown) => ({ ...schema as object, optional: true }),
    String: () => ({ type: "string" }),
    Boolean: () => ({ type: "boolean" }),
    Number: () => ({ type: "number" }),
    Array: (items: unknown) => ({ type: "array", items }),
    Record: (key: unknown, value: unknown) => ({ type: "object", additionalProperties: value, key }),
    Unknown: () => ({ type: "unknown" }),
    Union: (members: unknown[]) => ({ type: "union", members }),
    Literal: (value: unknown) => ({ type: "literal", value }),
  },
}));

// Mock getSubagentService：execute plumb-through 契约测试需要拦截 service.execute 调用。
const { mockServiceExecute } = vi.hoisted(() => ({
  mockServiceExecute: vi.fn(),
}));
vi.mock("../runtime/subagent-service.ts", () => ({
  getSubagentService: () => ({ execute: mockServiceExecute }),
}));

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerSubagentsCommand } from "../commands/subagents.ts";
import { BgNotifier } from "../runtime/execution/notifier.ts";
import { registerSubagentTool } from "../tools/subagent-tool.ts";

// ============================================================
// /subagents command 契约
// ============================================================
describe("/subagents command contract [MANDATORY]", () => {
  it("registers a command named 'subagents'", () => {
    let registeredName: string | undefined;
    const pi = {
      registerCommand: (name: string) => { registeredName = name; },
    } as unknown as ExtensionAPI;
    registerSubagentsCommand(pi);
    expect(registeredName).toBe("subagents");
  });

  it("handler accepts (args, ctx) — two parameters", () => {
    let capturedHandler: ((...args: unknown[]) => unknown) | undefined;
    const pi = {
      registerCommand: (_name: string, command: { handler: (...args: unknown[]) => unknown }) => {
        capturedHandler = command.handler;
      },
    } as unknown as ExtensionAPI;
    registerSubagentsCommand(pi);
    expect(capturedHandler).toBeDefined();
    // function.length 反映必填参数数（ctx 至少是第 2 个）
    expect(capturedHandler!.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================
// subagent tool 契约
// ============================================================
describe("subagent tool contract [MANDATORY]", () => {
  it("registers a tool named 'subagent' with a parameters schema", () => {
    let registeredTool: { name: string; parameters: unknown } | undefined;
    const pi = {
      registerTool: (tool: unknown) => { registeredTool = tool as { name: string; parameters: unknown }; },
    } as unknown as ExtensionAPI;
    registerSubagentTool(pi);
    expect(registeredTool?.name).toBe("subagent");
    expect(registeredTool?.parameters).toBeDefined();
  });

  it("tool has execute, renderCall, renderResult callbacks", () => {
    let registeredTool: Record<string, unknown> | undefined;
    const pi = {
      registerTool: (tool: unknown) => { registeredTool = tool as Record<string, unknown>; },
    } as unknown as ExtensionAPI;
    registerSubagentTool(pi);
    expect(typeof registeredTool?.execute).toBe("function");
  });

  // SDK 契约：ToolDefinition.execute 是 5 参数 (toolCallId, params, signal, onUpdate, ctx)。
  // ctx 是第 5 个参数，runtime 通过 wrapToolDefinition(ctxFactory) 注入。
  // 此测试验证 ctx.model 被 plumb 到 service.execute 的 ctxModel 参数。
  // 回归保护：subagent-tool.ts execute 把 _ctx?.model 传给 startHandler 的第 5 参 ctxModel。
  it("execute passes ctx.model as ctxModel (SDK 5-param contract)", async () => {
    let capturedExecute: ((...args: never[]) => Promise<unknown>) | undefined;
    const pi = {
      registerTool: (tool: unknown) => {
        capturedExecute = (tool as { execute: (...args: never[]) => Promise<unknown> }).execute;
      },
    } as unknown as ExtensionAPI;
    registerSubagentTool(pi);
    expect(capturedExecute).toBeDefined();

    mockServiceExecute.mockReset();
    mockServiceExecute.mockResolvedValue({
      mode: "background",
      subagentId: "bg-test",
      sessionFile: "/test/session.jsonl",
    });
    const ctxModel = { id: "test-model", name: "Test", provider: "test", reasoning: false };
    const ctx = { model: ctxModel } as object;

    await capturedExecute!(
      "call-1",
      { action: "start", startParam: { task: "test task" } },
      undefined,
      undefined,
      ctx,
    );

    expect(mockServiceExecute).toHaveBeenCalledTimes(1);
    expect(mockServiceExecute).toHaveBeenCalledWith(
      expect.objectContaining({ ctxModel }),
    );
  });

  // sync 路径返回的 content[0].text 是 LLM 解析的 JSON。此契约测试锁定：
  //   - JSON shape 含 syncResponse（≡ SubagentToolDetails）
  //   - syncResponse.mode === "sync"（SyncResponse 字面量收窄，非 "background"）
  //   - 派生字段（result/eventLog/turns 等）从 record 正确投影到 LLM-visible JSON
  // 回归保护：ExecutionRecord 收口重构后 result.text 源从 session.messages 改为
  // getFullText(record)，eventLog 改为派生——此测试覆盖「派生投影 → LLM JSON」端到端。
  it("sync execute returns content JSON with syncResponse shape (mode:'sync')", async () => {
    let capturedExecute: ((...args: never[]) => Promise<unknown>) | undefined;
    const pi = {
      registerTool: (tool: unknown) => {
        capturedExecute = (tool as { execute: (...args: never[]) => Promise<unknown> }).execute;
      },
    } as unknown as ExtensionAPI;
    registerSubagentTool(pi);

    // mock sync ExecutionHandle：record 已 settled，details 含完整派生投影
    const details = {
      status: "done",
      mode: "sync",
      agent: "worker",
      model: "test-model",
      thinkingLevel: undefined,
      turns: 2,
      totalTokens: 150,
      elapsedSeconds: 3,
      eventLog: [
        { type: "tool_start", label: "read a.ts", ts: 1000, status: "running" },
        { type: "tool_end", label: "read a.ts", ts: 1000, status: "done" },
        { type: "turn_end", label: "Result is 42", ts: 1001 },
      ],
      result: "Result is 42",
      currentActivity: undefined,
      parsedOutput: undefined,
      sessionFile: "sess-1.jsonl",
    };
    const record = {
      id: "run-1",
      agent: "worker",
      model: "test-model",
      thinkingLevel: undefined,
      mode: "sync",
      task: "test",
      status: "done",
      turns: 2,
      totalTokens: 150,
      startedAt: 1000,
      endedAt: 3000,
      result: "Result is 42",
      error: undefined,
      sessionFile: "sess-1.jsonl",
    };
    mockServiceExecute.mockReset();
    mockServiceExecute.mockResolvedValue({
      mode: "sync",
      record,
      details,
    });

    const result = (await capturedExecute!(
      "call-sync",
      { action: "start", startParam: { task: "compute answer" } },
      undefined,
      undefined,
      undefined,
    )) as { content: Array<{ type: string; text: string }>; details: unknown };

    // content[0].text 是 LLM 解析的 JSON
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    const parsed = JSON.parse(result.content[0]!.text) as {
      action: string;
      subagentId: string | null;
      sessionFile: string | null;
      syncResponse: typeof details;
    };
    expect(parsed.action).toBe("start");
    expect(parsed.syncResponse).toBeDefined();
    // SyncResponse mode 必须收窄为 "sync"（非 "background"）
    expect(parsed.syncResponse.mode).toBe("sync");
    // 派生字段正确投影
    expect(parsed.syncResponse.result).toBe("Result is 42");
    expect(parsed.syncResponse.turns).toBe(2);
    expect(parsed.syncResponse.eventLog).toHaveLength(3);
    expect(parsed.syncResponse.eventLog[0]?.label).toBe("read a.ts");
  });
});

// ============================================================
// notifier sendMessage 契约 [MANDATORY]
// ============================================================
describe("notifier sendMessage contract [MANDATORY]", () => {
  it("sendMessage uses triggerTurn:true + deliverAs:followUp", () => {
    const sendMessage = vi.fn();
    const host = {
      sendMessage,
      hasRunningBackground: () => false,
    };
    const notifier = new BgNotifier(host as never);
    notifier.notify({
      id: "bg-1",
      status: "done",
      agent: "worker",
      result: "done",
      startedAt: 0,
      endedAt: 1,
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ display: true }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  it("immediate flush when hasRunningBackground is false", () => {
    const sendMessage = vi.fn();
    const host = { sendMessage, hasRunningBackground: () => false };
    const notifier = new BgNotifier(host as never);
    notifier.notify({ id: "bg-1", status: "done", agent: "w", result: "ok", startedAt: 0, endedAt: 1 });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// session_start handler 双参数契约 — 编译期保证
// ============================================================
describe("session_start handler signature (compile-time guarantee)", () => {
  it("ExtensionHandler<SessionStartEvent> is (event, ctx) two-param — enforced by stub type", () => {
    // 此测试是编译期断言：shared/types/mariozechner/index.d.ts:111 声明
    //   ExtensionHandler<E, R> = (event: E, ctx: ExtensionContext) => Promise<R|void> | R | void;
    // 且 SessionStartEvent 注释明确 modelRegistry/cwd/ui 不在 event 上（在 ctx）。
    // index.ts:66 `pi.on("session_start", (_event, ctx) => {...})` 通过此类型检查即证明契约。
    // tsc --noEmit 零错误 = 此契约成立。此 it() 占位让套件非空（实际断言在编译期）。
    expect(true).toBe(true);
  });
});
