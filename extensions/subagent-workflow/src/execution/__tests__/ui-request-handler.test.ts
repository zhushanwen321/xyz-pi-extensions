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

import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { ASK_USER_RPC_PROMPT } from "../session-runner.ts";
import { parseSpawnLine } from "../spawn-event-adapter.ts";
import { parseChannel } from "../ui-channels.ts";
import { createUiRequestQueue, type UiRequest, type UiRequestHandler } from "../ui-request-queue.ts";

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

    const handler: UiRequestHandler = vi.fn(
      async (req: UiRequest) => ({ value: `answer-for-${req.id}` }),
    );
    const ctx = { uiRequestHandler: handler } as unknown as Parameters<
      typeof createUiRequestQueue
    >[1];

    const enqueue = createUiRequestQueue(child, ctx);
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

    // handler 抛错（reject）
    const handler: UiRequestHandler = vi.fn(
      async () => Promise.reject(new Error("boom")),
    );
    const ctx = { uiRequestHandler: handler } as unknown as Parameters<
      typeof createUiRequestQueue
    >[1];

    const enqueue = createUiRequestQueue(child, ctx);
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
