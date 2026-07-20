// src/__tests__/ui-request-handler.test.ts
//
// W2 测试（TC-W2 / SR-2）：UI 请求处理 —— Pi 原生协议格式。
//
// 测试对象：session-runner.ts 的 handleUiRequest + spawn-event-adapter.ts 的 parseSpawnLine
// 契约来源：.fix-plans/00-master-summary.md §二 2.1（ExtensionUiRequest）+ 2.2（UiRequest/channel）
//          + 2.3（stdin 回写 extension_ui_response 格式）+ §一冲突 2（channel 提取在 session-runner 层）
//
// 修复原因（FR-12/SR-2）：
//   旧测试用错误的 JSON-RPC 2.0 格式 mock（jsonrpc:"2.0" + params.marker:"ASK_USER"
//   + params.questions），测试绿但生产红（Pi 实际发 {type, method, title, options} 平铺）。
//   改为 Pi 真实格式 + channel/channelPayload 断言 + extension_ui_response 回写格式。
//
// 红灯原因：handleUiRequest 签名仍是旧的 (child, id, params, ctx, signal)
//   + parseChannel 未接入 session-runner，编译失败。W2 改完签名后转绿。

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { ChildRpcChannel } from "../rpc-channel.ts";
import { ASK_USER_RPC_PROMPT } from "../session-runner.ts";
import { parseSpawnLine } from "../spawn-event-adapter.ts";
import { parseChannel } from "../ui-channels.ts";
import {
  createUiRequestQueue,
  type UiRequest,
  type UiRequestHandler,
  type UiResponse,
} from "../ui-request-queue.ts";

// ── Pi 原生协议样本构造 ────────────────────────────────────
// 真实格式：{type:"extension_ui_request", id, method:"select",
//           title:"\0XYZ_ASK_USER", options:[JSON.stringify({questions, allowCancel})]}
// 无 jsonrpc 字段、无 params 包裹、method 在顶层（非 method:"extension_ui_request"）。

const ASK_USER_MARKER = "\0XYZ_ASK_USER";
const askUserPayload = {
  questions: [
    {
      question: "What is your preference?",
      options: [{ label: "Option A" }, { label: "Option B" }],
    },
  ],
  allowCancel: true,
};

function askUserLine(id: string): string {
  return JSON.stringify({
    type: "extension_ui_request",
    id,
    method: "select",
    title: ASK_USER_MARKER,
    options: [JSON.stringify(askUserPayload)],
  });
}

// ── 解析：Pi 原生格式 → ExtensionUiRequest（method 平铺，无 params） ─────

describe("parseSpawnLine — ask_user 请求解析（Pi 原生格式）", () => {
  it("ask_user 行被识别为 extension_ui_request kind", () => {
    const result = parseSpawnLine(askUserLine("ui-req-001"));
    expect(result?.kind).toBe("extension_ui_request");
  });

  it("request.method === 'select'（ask_user 借道 select dialog 通道）", () => {
    const result = parseSpawnLine(askUserLine("ui-req-001"));
    if (result?.kind !== "extension_ui_request") {
      expect.fail("expected extension_ui_request kind");
      return;
    }
    expect(result.request.method).toBe("select");
  });

  it("request.title === ASK_USER_MARKER（NUL 前缀 marker 原样保留，由 parseChannel 提取）", () => {
    const result = parseSpawnLine(askUserLine("ui-req-001"));
    if (result?.kind !== "extension_ui_request") return;
    expect(result.request.title).toBe(ASK_USER_MARKER);
  });

  it("id 被正确提取（用于 response 关联）", () => {
    const result = parseSpawnLine(askUserLine("ui-req-001"));
    if (result?.kind !== "extension_ui_request") return;
    expect(result.id).toBe("ui-req-001");
  });
});

// ── channel 提取（session-runner 层消费 parseChannel） ──────────────
// adapter 层只做协议解析（method + 字段平铺），channel 提取在 session-runner 层。
// 对 select.title 的 NUL 前缀解析出 channel='ask_user' + payload={questions, allowCancel}。

describe("parseChannel — ask_user channel 提取（session-runner 层）", () => {
  it("select.title 含 ASK_USER_MARKER → channel='ask_user'", () => {
    const result = parseSpawnLine(askUserLine("ui-req-001"));
    if (result?.kind !== "extension_ui_request") return;
    const channel = parseChannel(result.request);
    expect(channel.channel).toBe("ask_user");
  });

  it("channelPayload 已 parse 为 {questions, allowCancel}", () => {
    const result = parseSpawnLine(askUserLine("ui-req-001"));
    if (result?.kind !== "extension_ui_request") return;
    const channel = parseChannel(result.request);
    expect(channel.channelPayload).toEqual(askUserPayload);
  });
});

// ── stdin 回写格式：extension_ui_response（非 JSON-RPC 2.0 result） ─────

describe("handleUiRequest — stdin 回写 extension_ui_response（Pi 原生格式）", () => {
  it("handler 返回 {value} → stdin 写入 {type:extension_ui_response, id, value}", async () => {
    const stdin = new PassThrough();
    const written: string[] = [];
    stdin.on("data", (chunk: Buffer) => written.push(chunk.toString()));

    const child = { stdin, on: vi.fn(), removeListener: vi.fn() } as unknown as Parameters<
      typeof createUiRequestQueue
    >[0];
    const channel = new ChildRpcChannel(child);

    const handler: UiRequestHandler = vi.fn(
      async (req: UiRequest) => ({ value: `answer-for-${req.id}` }),
    );
    const ctx = { uiRequestHandler: handler } as unknown as Parameters<
      typeof createUiRequestQueue
    >[2];

    const enqueue = createUiRequestQueue(child, channel, ctx);
    // W2 新签名：enqueue(id, request) —— request 是 ExtensionUiRequest（method 平铺）
    enqueue("ui-req-002", {
      method: "select",
      title: ASK_USER_MARKER,
      options: [JSON.stringify(askUserPayload)],
    });

    // 等微任务 + stdin flush
    await new Promise((r) => setImmediate(r));

    const raw = written.join("");
    expect(raw).toContain('"type":"extension_ui_response"');
    expect(raw).toContain('"id":"ui-req-002"');
    expect(raw).toContain('"value":"answer-for-ui-req-002"');
    // 旧 JSON-RPC 2.0 格式不应出现
    expect(raw).not.toContain('"jsonrpc"');
    expect(raw).not.toContain('"result"');
  });
});

// ── handler 抛错兜底（M5）：catch → 回 cancelled → 写 stdin ─────
// session-runner.ts:489-494 的 catch 分支：handler reject 时兜底写 cancelled。

describe("handleUiRequest — handler 抛错兜底回 cancelled", () => {
  it("handler reject(new Error('boom')) → stdin 写入 cancelled:true", async () => {
    const stdin = new PassThrough();
    const written: string[] = [];
    stdin.on("data", (chunk: Buffer) => written.push(chunk.toString()));

    const child = { stdin, on: vi.fn(), removeListener: vi.fn() } as unknown as Parameters<
      typeof createUiRequestQueue
    >[0];
    const channel = new ChildRpcChannel(child);

    // handler 抛错（reject）
    const handler: UiRequestHandler = vi.fn(
      async () => Promise.reject(new Error("boom")),
    );
    const ctx = { uiRequestHandler: handler } as unknown as Parameters<
      typeof createUiRequestQueue
    >[2];

    const enqueue = createUiRequestQueue(child, channel, ctx);
    enqueue("ui-req-err", {
      method: "select",
      title: ASK_USER_MARKER,
      options: [JSON.stringify(askUserPayload)],
    });

    // 等微任务 + stdin flush
    await new Promise((r) => setImmediate(r));

    const raw = written.join("");
    expect(raw).toContain('"type":"extension_ui_response"');
    expect(raw).toContain('"id":"ui-req-err"');
    expect(raw).toContain('"cancelled":true');
  });

  // [W3] 错误边界分离：catch 不再二次 write。旧结构 catch 内调 respond 会导致 stdin 被写两次
  // （handler reject 时），是 uncaughtException 的结构性缺陷。W3 后 catch 只设 result=cancelled，
  // 统一在 try/catch 后调一次 respond。
  it("handler reject 后 stdin.write 恰好调用 1 次（catch 不再二次 write，W3）", async () => {
    const stdin = new PassThrough();
    // 直接 spy stdin.write 计数（不缓冲 data 事件，只验证调用次数）
    const writeSpy = vi.spyOn(stdin, "write");

    const child = { stdin, on: vi.fn(), removeListener: vi.fn() } as unknown as Parameters<
      typeof createUiRequestQueue
    >[0];
    const channel = new ChildRpcChannel(child);

    const handler: UiRequestHandler = vi.fn(
      async () => Promise.reject(new Error("boom")),
    );
    const ctx = { uiRequestHandler: handler } as unknown as Parameters<
      typeof createUiRequestQueue
    >[2];

    const enqueue = createUiRequestQueue(child, channel, ctx);
    enqueue("ui-req-once", {
      method: "select",
      title: ASK_USER_MARKER,
      options: [JSON.stringify(askUserPayload)],
    });

    // 等微任务 + stdin flush
    await new Promise((r) => setImmediate(r));

    // handler 抛错后只应有一次 write（写 cancelled），不再有 catch 内的二次 write
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const writtenArg = writeSpy.mock.calls[0]?.[0] as string;
    expect(writtenArg).toContain('"cancelled":true');
    expect(writtenArg).toContain('"id":"ui-req-once"');
  });
});

// ── W5 竞态场景：handler 在 await 期间 child 退出 ──────────────
//
// 006 文档「验证标准 #3」：handleUiRequest 在 await handler 期间 child 退出 → 不抛、不写、
// handler 结果被丢弃。
//
// 双重保险：(1) createUiRequestQueue 的 child.on("close") 触发 abortController.abort() →
// handleUiRequest 在 await 后 `signal?.aborted` 短路 return；(2) ChildRpcChannel 的
// child.on("close") 触发 dead=true → 即使走到 respond，channel.write 也短路返回 false。
// 两者由同一 child.emit("close") 同步触发（EventEmitter emit 同步调 listener）。
//
// 用真实 EventEmitter 作 child（非 vi.fn() on()），使两路 close listener 都能被 emit 触发。

describe("handleUiRequest — handler 在 await 期间 child 退出（W5 竞态）", () => {
  it("handler resolve 前 child.emit(close) → channel.isDead + signal.aborted 双保险，不写 stdin、不抛", async () => {
    const stdin = new PassThrough();
    const writeSpy = vi.spyOn(stdin, "write");

    // 真实 EventEmitter 作 child：支持 emit，且两路 close listener 都能挂上
    const child = new EventEmitter() as ChildProcess & { stdin: PassThrough };
    // EventEmitter 本身无 stdin 字段，强制造型后挂载（运行时安全）
    Object.assign(child, { stdin });

    const channel = new ChildRpcChannel(child);

    // 可控的慢 Promise：测试外部控制何时 resolve
    let resolveHandler!: (v: UiResponse) => void;
    const handler: UiRequestHandler = vi.fn(
      () =>
        new Promise<UiResponse>((resolve) => {
          resolveHandler = resolve;
        }),
    );
    const ctx = { uiRequestHandler: handler } as unknown as Parameters<
      typeof createUiRequestQueue
    >[2];

    const enqueue = createUiRequestQueue(child, channel, ctx);
    enqueue("ui-req-race", {
      method: "select",
      title: ASK_USER_MARKER,
      options: [JSON.stringify(askUserPayload)],
    });

    // 等微任务让 handler 开始执行
    await new Promise((r) => setImmediate(r));
    expect(handler).toHaveBeenCalledTimes(1);

    // 模拟 child 退出：同步触发 channel + queue 两路 close listener
    child.emit("close", 0, null);

    // 双保险均已生效
    expect(channel.isDead).toBe(true);

    // handler 晚到的 resolve（不应触达 stdin）
    resolveHandler({ value: "late-answer" });

    // 等微任务让 handleUiRequest 的 await 后代码执行
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // 不写 stdin：signal.aborted 短路在前，channel.isDead 短路在后，respond 未被调
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("handler reject 期间 child 退出 → catch 降级 cancelled，但 signal.aborted 仍跳过 write", async () => {
    const stdin = new PassThrough();
    const writeSpy = vi.spyOn(stdin, "write");

    const child = new EventEmitter() as ChildProcess & { stdin: PassThrough };
    Object.assign(child, { stdin });

    const channel = new ChildRpcChannel(child);

    let rejectHandler!: (e: Error) => void;
    const handler: UiRequestHandler = vi.fn(
      () =>
        new Promise<UiResponse>((_resolve, reject) => {
          rejectHandler = reject;
        }),
    );
    const ctx = { uiRequestHandler: handler } as unknown as Parameters<
      typeof createUiRequestQueue
    >[2];

    const enqueue = createUiRequestQueue(child, channel, ctx);
    enqueue("ui-req-race-reject", {
      method: "select",
      title: ASK_USER_MARKER,
      options: [JSON.stringify(askUserPayload)],
    });

    await new Promise((r) => setImmediate(r));

    // child 先退出（abort 触发）
    child.emit("close", 0, null);
    expect(channel.isDead).toBe(true);

    // handler 后 reject → catch 降级 result={cancelled:true}，但 signal.aborted 跳过 write
    expect(() => rejectHandler(new Error("handler boom"))).not.toThrow();

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("handler 返回后 child 才退出（无竞态）→ 正常写一次 stdin", async () => {
    // 对照组：handler 正常 resolve 后 child 退出，write 已发生，不受 close 影响
    const stdin = new PassThrough();
    const written: string[] = [];
    stdin.on("data", (chunk: Buffer) => written.push(chunk.toString()));

    const child = new EventEmitter() as ChildProcess & { stdin: PassThrough };
    Object.assign(child, { stdin });

    const channel = new ChildRpcChannel(child);

    const handler: UiRequestHandler = vi.fn(
      async () => Promise.resolve<UiResponse>({ value: "normal-answer" }),
    );
    const ctx = { uiRequestHandler: handler } as unknown as Parameters<
      typeof createUiRequestQueue
    >[2];

    const enqueue = createUiRequestQueue(child, channel, ctx);
    enqueue("ui-req-normal", {
      method: "select",
      title: ASK_USER_MARKER,
      options: [JSON.stringify(askUserPayload)],
    });

    // handler resolve → write 发生
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // child 才退出（write 已完成）
    child.emit("close", 0, null);

    const raw = written.join("");
    expect(raw).toContain('"id":"ui-req-normal"');
    expect(raw).toContain('"value":"normal-answer"');
  });
});

// ── W4 提示词（保留，不受格式修复影响） ──────────────────────────

describe("W4: ask_user RPC 系统提示词注入", () => {
  it("ASK_USER_RPC_PROMPT 常量已导出且非空", () => {
    expect(ASK_USER_RPC_PROMPT).toBeDefined();
    expect(typeof ASK_USER_RPC_PROMPT).toBe("string");
    expect(ASK_USER_RPC_PROMPT.length).toBeGreaterThan(0);
  });

  it("提示词包含 ask_user 工具说明", () => {
    expect(ASK_USER_RPC_PROMPT).toContain("ask_user");
    expect(ASK_USER_RPC_PROMPT).toContain("Tool Availability");
  });

  it("提示词告知 LLM ask_user 走 RPC 转发", () => {
    expect(ASK_USER_RPC_PROMPT).toContain("RPC");
    expect(ASK_USER_RPC_PROMPT).toContain("main agent");
    expect(ASK_USER_RPC_PROMPT).toContain("forwarded");
  });

  it("提示词说明用户在主 agent 界面回答", () => {
    expect(ASK_USER_RPC_PROMPT).toContain("user");
    expect(ASK_USER_RPC_PROMPT).toContain("answers");
  });
});
