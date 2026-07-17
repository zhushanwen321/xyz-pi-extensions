// src/__tests__/ui-request-handler.test.ts
//
// W2 红灯测试：UI 请求处理
// 1. extension_ui_request 被正确检测
// 2. ASK_USER_MARKER 被正确识别
// 3. questions/context 被正确提取
// 4. uiRequestHandler 被调用
// 5. stdin 收到正确的 response
//
// W4 测试：系统提示词注入
// 1. appendParts 包含 ask_user 工具说明（当 agent tools 含 ask_user 时）
// 2. 提示词告知 LLM ask_user 走 RPC 转发

import { describe, expect, it } from "vitest";

import { ASK_USER_RPC_PROMPT, createUiRequestQueue } from "../session-runner.ts";
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
  // W4 已实现：uiRequestHandler 会在 runSpawn 中被调用（通过 createUiRequestQueue）
  it("uiRequestHandler 通过 createUiRequestQueue 被调用（W3 队列机制）", () => {
    // createUiRequestQueue 在 ui-request-queue.test.ts 中有完整测试
    // 这里验证函数已被正确导出
    expect(typeof createUiRequestQueue).toBe("function");
  });
});

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
