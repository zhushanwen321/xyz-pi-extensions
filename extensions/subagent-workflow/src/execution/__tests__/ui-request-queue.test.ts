// src/__tests__/ui-request-queue.test.ts
//
// W3 红灯测试：UI 请求队列机制
// 1. 多个请求按序处理
// 2. 第一个请求未完成时第二个不开始

import { describe, it } from "vitest";

// 注意：队列机制尚未实现，这些测试预期全部失败

describe("UI 请求队列", () => {
  // W3 红灯测试：队列机制待实现
  it.todo("多个 extension_ui_request 按 FIFO 顺序处理");
  it.todo("第一个请求未 resolve 时第二个不调用 uiRequestHandler");
});
