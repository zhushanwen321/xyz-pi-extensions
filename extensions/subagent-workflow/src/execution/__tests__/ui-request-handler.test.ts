// src/__tests__/ui-request-handler.test.ts
//
// W2 红灯测试：UI 请求处理
// 1. extension_ui_request 被正确检测
// 2. ASK_USER_MARKER 被正确识别
// 3. questions/context 被正确提取
// 4. uiRequestHandler 被调用
// 5. stdin 收到正确的 response

import { describe, expect, it } from "vitest";

import { parseSpawnLine } from "../spawn-event-adapter.ts";

describe("parseSpawnLine - extension_ui_request", () => {
  const askUserRequest = JSON.stringify({
    jsonrpc: "2.0",
    id: "ui-req-001",
    method: "extension_ui_request",
    params: {
      marker: "ASK_USER",
      questions: [
        {
          question: "What is your preference?",
          options: [{ label: "Option A" }, { label: "Option B" }],
        },
      ],
      context: "Choosing a coding style",
      timeout: 30000,
    },
  });

  it("extension_ui_request 被识别为 extension_ui_request kind", () => {
    const result = parseSpawnLine(askUserRequest);
    expect(result?.kind).toBe("extension_ui_request");
  });

  it("ASK_USER marker 被正确识别", () => {
    const result = parseSpawnLine(askUserRequest);
    if (result?.kind === "extension_ui_request") {
      expect(result.params.marker).toBe("ASK_USER");
    }
  });

  it("questions 被正确提取", () => {
    const result = parseSpawnLine(askUserRequest);
    if (result?.kind === "extension_ui_request") {
      expect(result.params.questions).toHaveLength(1);
      expect(result.params.questions[0].question).toBe("What is your preference?");
      expect(result.params.questions[0].options).toHaveLength(2);
    }
  });

  it("context 被正确提取", () => {
    const result = parseSpawnLine(askUserRequest);
    if (result?.kind === "extension_ui_request") {
      expect(result.params.context).toBe("Choosing a coding style");
    }
  });

  it("id 被正确提取（用于 response 关联）", () => {
    const result = parseSpawnLine(askUserRequest);
    if (result?.kind === "extension_ui_request") {
      expect(result.id).toBe("ui-req-001");
    }
  });
});

describe("uiRequestHandler 回调", () => {
  // 注意：这个测试需要 mock runSpawn 的流程，但因为函数未实现会失败
  // 红灯阶段只测试 parseSpawnLine，handler 调用留到实现后

  // W2 红灯测试：handler 调用依赖 runSpawn 实现
  it.todo("uiRequestHandler 会被调用");
});
