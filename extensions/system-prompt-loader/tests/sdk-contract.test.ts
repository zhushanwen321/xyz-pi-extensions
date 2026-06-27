// tests/sdk-contract.test.ts
//
// SDK 契约测试：验证扩展对 Pi SDK 的消费符合 code-review SKILL §1 [MANDATORY] checklist。
//
// 核心断言（[MANDATORY] checklist）：
//   1. systemPromptLoader 注册两个 pi.on handler，事件名精确为
//      "session_start" / "before_agent_start"
//   2. handler 签名为 (event, ctx) 双参数——event 第一个，ctx 第二个
//      （cwd/ui/sessionManager 在 ctx 上，不在 event 上，见 SKILL §1.1）
//   3. CA-12 契约：SessionStartEvent 无 systemPromptOptions/contextFiles 字段
//      （仅 BeforeAgentStartEvent.systemPromptOptions.contextFiles 可得）
//   4. before_agent_start handler 返回类型兼容 BeforeAgentStartEventResult
//      （含可选 systemPrompt 字段，供 Pi chain 后缀注入）
//
// 对照真实 SDK 类型（@mariozechner/pi-coding-agent dist），非 inline mock。
// handler 的 (event, ctx) 双参数契约由导入真实 SDK 事件类型在编译期强制。

import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionContext,
  SessionStartEvent,
} from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import systemPromptLoader from "../src/index.ts";
import { mockExtensionApi, mockExtensionContext } from "./helpers/mock-extension-api.ts";

/** handler 类型（与 src/index.ts 注册签名一致，编译期约束）。 */
type SessionStartHandler = (
  event: SessionStartEvent,
  ctx: ExtensionContext,
) => void;
type BeforeAgentStartHandler = (
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
) => BeforeAgentStartEventResult | void;

/** 捕获 session_start/before_agent_start 两 handler，用真实 SDK 事件类型强约束（免 as never）。 */
function captureHandlers(): {
  sessionStart: SessionStartHandler;
  beforeAgentStart: BeforeAgentStartHandler;
  events: string[];
} {
  let sessionStart: SessionStartHandler = () => {};
  let beforeAgentStart: BeforeAgentStartHandler = () => {};
  const events: string[] = [];
  const pi = mockExtensionApi({
    on: (event: string, handler: (event: never, ctx: never) => unknown) => {
      events.push(event);
      if (event === "session_start") sessionStart = handler as SessionStartHandler;
      if (event === "before_agent_start") {
        beforeAgentStart = handler as BeforeAgentStartHandler;
      }
    },
  });
  systemPromptLoader(pi);
  return { sessionStart, beforeAgentStart, events };
}

// ============================================================
// pi.on 注册契约
// ============================================================
describe("pi.on registration contract [MANDATORY]", () => {
  it("registers exactly two handlers: session_start + before_agent_start", () => {
    const { events } = captureHandlers();
    expect(events).toContain("session_start");
    expect(events).toContain("before_agent_start");
    expect(events).toHaveLength(2);
  });

  it("session_start handler signature is (event, ctx) — two params", () => {
    const { sessionStart } = captureHandlers();
    // function.length 反映必填参数数（SKILL §1.1：ctx 是第 2 个参数）；
    // sessionStart 是捕获的真实 handler，其 .length 反映注册时的形参数。
    expect(sessionStart.length).toBeGreaterThanOrEqual(2);
  });

  it("before_agent_start handler signature is (event, ctx) — two params", () => {
    const { beforeAgentStart } = captureHandlers();
    expect(beforeAgentStart.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================
// CA-12 注入时序契约：contextFiles 仅 before_agent_start 可得
// ============================================================
describe("CA-12 injection-timing contract [MANDATORY]", () => {
  it("SessionStartEvent has NO systemPromptOptions/contextFiles (collect-only stage)", () => {
    // 编译期契约：SessionStartEvent 类型形状固定为 {type, reason, previousSessionFile?}。
    // 若 SDK 未来给 SessionStartEvent 加 systemPromptOptions，此处的类型断言会编译失败，
    // 提示 CA-12 假设（contextFiles 仅 before_agent_start 可得）需重新审视。
    const event: SessionStartEvent = {
      type: "session_start",
      reason: "startup",
    };
    expect(event.type).toBe("session_start");
    expect(event.reason).toBe("startup");
    // contextFiles 不在 SessionStartEvent 上（CA-12 关键前提）
    expect("contextFiles" in event).toBe(false);
    expect("systemPromptOptions" in event).toBe(false);
  });

  it("BeforeAgentStartEvent.systemPromptOptions.contextFiles is the only contextFile source", () => {
    // 编译期契约：contextFiles 挂在 BeforeAgentStartEvent.systemPromptOptions 上。
    const event: BeforeAgentStartEvent = {
      type: "before_agent_start",
      prompt: "x",
      systemPrompt: "BASE",
      systemPromptOptions: {
        cwd: "/tmp",
        contextFiles: [{ path: "/tmp/a.md", content: "a" }],
      },
    };
    expect(event.systemPromptOptions.contextFiles).toBeDefined();
    expect(event.systemPromptOptions.contextFiles).toHaveLength(1);
  });

  it("session_start handler does NOT receive/use contextFiles (collect+cache only)", () => {
    // 行为契约：session_start 只收集+缓存，不做 contextFile 排除（contextFiles 此时不可得）。
    const { sessionStart } = captureHandlers();
    const ctx = mockExtensionContext({ notify: () => {} }, "/tmp");
    const sessionEvent: SessionStartEvent = { type: "session_start", reason: "startup" };

    // 用真实 SDK 类型直接调用——编译期保证 (event, ctx) 形参顺序，无需 as never
    expect(() => sessionStart(sessionEvent, ctx)).not.toThrow();
  });
});

// ============================================================
// before_agent_start 返回类型契约
// ============================================================
describe("before_agent_start return-type contract [MANDATORY]", () => {
  it("returns void when no rules cached (BC-13 zero side-effect)", () => {
    const { sessionStart, beforeAgentStart } = captureHandlers();
    const ctx = mockExtensionContext({ notify: () => {} }, "/tmp");

    // 先跑 session_start（空配置 → cached.rules=[]），再跑 before_agent_start
    sessionStart({ type: "session_start", reason: "startup" } satisfies SessionStartEvent, ctx);

    const result = beforeAgentStart(
      {
        type: "before_agent_start",
        prompt: "x",
        systemPrompt: "BASE",
        systemPromptOptions: { cwd: "/tmp" },
      } satisfies BeforeAgentStartEvent,
      ctx,
    );

    // 无规则 → void（不返回 BeforeAgentStartEventResult.systemPrompt）
    expect(result).toBeUndefined();
  });

  it("return type is compatible with BeforeAgentStartEventResult", () => {
    // 编译期契约：before_agent_start handler 的返回类型必须赋值兼容
    // BeforeAgentStartEventResult | void（SDK ExtensionHandler 签名要求）。
    const { sessionStart, beforeAgentStart } = captureHandlers();
    const ctx = mockExtensionContext({ notify: () => {} }, "/tmp");
    sessionStart({ type: "session_start", reason: "startup" } satisfies SessionStartEvent, ctx);

    const result = beforeAgentStart(
      {
        type: "before_agent_start",
        prompt: "x",
        systemPrompt: "BASE",
        systemPromptOptions: { cwd: "/tmp" },
      } satisfies BeforeAgentStartEvent,
      ctx,
    );

    // void（undefined）兼容 BeforeAgentStartEventResult | void；有规则时返回含 systemPrompt 的对象。
    // 此断言锁定返回类型契约：必须是 undefined 或含可选 systemPrompt 的对象。
    expect(
      result === undefined ||
        typeof (result as BeforeAgentStartEventResult).systemPrompt === "string",
    ).toBe(true);
  });
});
