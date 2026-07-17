// src/__tests__/ui-request-queue.test.ts
//
// W3 测试：UI 请求队列机制
// 1. 多个请求按 FIFO 顺序处理
// 2. 第一个请求未完成时第二个不开始
//
// 直接测试 createUiRequestQueue 的队列逻辑（纯函数，不需要 mock runSpawn）。
// 用 fake child（PassThrough stdin）+ 手动控制 Promise resolve 时序。

import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createUiRequestQueue } from "../session-runner.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeFakeChild(): ChildProcess {
  const stdin = new PassThrough();
  return {
    stdin,
    killed: false,
    pid: 10001,
    on: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as ChildProcess;
}

function makeReq(id: string, question: string): Record<string, unknown> {
  return {
    questions: [{ question, options: [{ label: "A" }] }],
    context: `ctx-${id}`,
  };
}

describe("UI 请求队列", () => {
  it("多个 extension_ui_request 按 FIFO 顺序处理", async () => {
    const callOrder: string[] = [];
    // 每个请求返回独立的可控 Promise
    const resolvers: Array<(v: unknown) => void> = [];

    const handler = vi.fn((questions: Record<string, unknown>[]) => {
      const q = (questions[0] as Record<string, unknown>).question as string;
      callOrder.push(q);
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    });

    const child = makeFakeChild();
    const ctx = { uiRequestHandler: handler } as Parameters<
      typeof createUiRequestQueue
    >[1];
    const enqueue = createUiRequestQueue(child, ctx);

    // 快速入队三个请求（handler 被调用但不 resolve）
    enqueue("r1", { ...makeReq("r1", "Q1") });
    enqueue("r2", { ...makeReq("r2", "Q2") });
    enqueue("r3", { ...makeReq("r3", "Q3") });

    // 第一个请求立即开始处理
    expect(handler).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["Q1"]);

    // resolve 第一个 → 第二个开始处理
    resolvers[0]("a1");
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual(["Q1", "Q2"]);

    // resolve 第二个 → 第三个开始处理
    resolvers[1]("a2");
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(callOrder).toEqual(["Q1", "Q2", "Q3"]);
  });

  it("第一个请求未 resolve 时第二个不调用 uiRequestHandler", async () => {
    const callOrder: string[] = [];
    let firstResolve: (v: unknown) => void;

    const handler = vi.fn((questions: Record<string, unknown>[]) => {
      const q = (questions[0] as Record<string, unknown>).question as string;
      callOrder.push(q);
      if (q === "Q1") {
        return new Promise((resolve) => {
          firstResolve = resolve;
        });
      }
      return Promise.resolve("done");
    });

    const child = makeFakeChild();
    const ctx = { uiRequestHandler: handler } as Parameters<
      typeof createUiRequestQueue
    >[1];
    const enqueue = createUiRequestQueue(child, ctx);

    enqueue("r1", { ...makeReq("r1", "Q1") });
    enqueue("r2", { ...makeReq("r2", "Q2") });

    // 只有 Q1 被调用，Q2 还在队列里
    expect(handler).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["Q1"]);

    // 等一下，Q2 仍然不应该被调用
    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["Q1"]);

    // resolve Q1 → Q2 才开始
    firstResolve!("a1");
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual(["Q1", "Q2"]);
  });
});
