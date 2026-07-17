// src/__tests__/ui-request-handler-factory.test.ts
//
// C1 测试：ui-request-handler-factory.ts — createUiRequestHandlerForMode 透传矩阵。
//
// 透传矩阵（createUiRequestHandlerForMode 返回的 handler 行为）：
//   - headless（json/print/undefined）：返回 undefined（不注入 handler）
//   - TUI：fire-and-forget 回 ack 不透传；dialog 进 dialogQueue 串行
//   - GUI（rpc）：fire-and-forget 直接调 realHandler；dialog 进 dialogQueue 串行
// realHandler 路由：channel 命中 → channelHandler（经 coerceUiResponse 形变）；未命中 → defaultDialogForward（cancelled）。
// 测接口契约，不测实现细节。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionContext, ExtensionMode } from "@mariozechner/pi-coding-agent";

import { createUiRequestHandlerForMode } from "../ui-request-handler-factory.ts";
import { createUiChannelRegistry, type ChannelHandler } from "../ui-channels.ts";
import { DialogGlobalQueue, type UiRequest } from "../dialog-queue.ts";

// mock ExtensionContext 已补 mode 字段（host-mode.ts 读它分流）。最小形状构造。
function makeCtx(mode: ExtensionMode): ExtensionContext {
  return {
    cwd: "/tmp/test",
    mode,
    sessionManager: {
      getSessionId: () => "s1",
      getSessionFile: () => undefined,
      getSessionDir: () => "/tmp/test/sessions",
    },
    modelRegistry: undefined,
    model: undefined,
  } as ExtensionContext;
}

function dialogReq(id: string, channel?: string): UiRequest {
  return { method: "select", id, title: `q-${id}`, ...(channel ? { channel } : {}) };
}

function fireAndForgetReq(id: string): UiRequest {
  return { method: "notify", id, message: `n-${id}` };
}

// dialog 路径用 fake timers 推进 processNext；静默 console.warn/error（stub 故意 warn）。
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createUiRequestHandlerForMode — headless 返回 undefined", () => {
  it("mode='json' → undefined（不注入 handler）", () => {
    const queue = new DialogGlobalQueue();
    expect(createUiRequestHandlerForMode(makeCtx("json"), createUiChannelRegistry(), queue))
      .toBeUndefined();
  });

  it("mode='print' → undefined", () => {
    const queue = new DialogGlobalQueue();
    expect(createUiRequestHandlerForMode(makeCtx("print"), createUiChannelRegistry(), queue))
      .toBeUndefined();
  });
});

describe("createUiRequestHandlerForMode — TUI 模式透传", () => {
  it("fire-and-forget（notify）→ {ack:true}，不调 realHandler / 不入队", async () => {
    const registry = createUiChannelRegistry();
    const queue = new DialogGlobalQueue();
    const enqueueSpy = vi.spyOn(queue, "enqueue");

    const handler = createUiRequestHandlerForMode(makeCtx("tui"), registry, queue)!;
    const resp = await handler(fireAndForgetReq("f1"));

    expect(resp).toEqual({ ack: true });
    expect(console.warn).not.toHaveBeenCalled(); // realHandler（defaultDialogForward）未走
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("dialog（select 无 channel）→ 进 dialogQueue（enqueue 被调，defaultDialogForward stub cancelled）", async () => {
    const registry = createUiChannelRegistry();
    const queue = new DialogGlobalQueue();
    const enqueueSpy = vi.spyOn(queue, "enqueue");

    const handler = createUiRequestHandlerForMode(makeCtx("tui"), registry, queue)!;
    const pending = handler(dialogReq("d1"));

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toEqual({ cancelled: true });
  });
});

describe("createUiRequestHandlerForMode — GUI（rpc）模式透传", () => {
  it("fire-and-forget（notify）→ 直接调 realHandler，不入队", async () => {
    const registry = createUiChannelRegistry();
    const queue = new DialogGlobalQueue();
    const enqueueSpy = vi.spyOn(queue, "enqueue");

    const handler = createUiRequestHandlerForMode(makeCtx("rpc"), registry, queue)!;
    // notify 无 channel → realHandler → defaultDialogForward（cancelled）
    const resp = await handler(fireAndForgetReq("f1"));

    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(resp).toEqual({ cancelled: true });
  });

  it("dialog（select 无 channel）→ 进 dialogQueue", async () => {
    const registry = createUiChannelRegistry();
    const queue = new DialogGlobalQueue();
    const enqueueSpy = vi.spyOn(queue, "enqueue");

    const handler = createUiRequestHandlerForMode(makeCtx("rpc"), registry, queue)!;
    const pending = handler(dialogReq("d1"));

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toEqual({ cancelled: true });
  });
});

describe("createUiRequestHandlerForMode — channel 业务路由", () => {
  it("channel 命中 registry → 调注册的 channelHandler（不走 defaultDialogForward）", async () => {
    const registry = createUiChannelRegistry();
    const channelHandler: ChannelHandler = vi.fn(async () => ({ value: "from-channel" }));
    registry.register("ask_user", channelHandler);

    // GUI fire-and-forget 直接调 realHandler，绕过队列；channel 命中立即生效
    const handler = createUiRequestHandlerForMode(makeCtx("rpc"), registry, new DialogGlobalQueue())!;
    const resp = await handler({ method: "notify", id: "f1", message: "m", channel: "ask_user" });

    expect(channelHandler).toHaveBeenCalledTimes(1);
    expect(resp).toEqual({ value: "from-channel" });
  });

  it("channel 未命中 → defaultDialogForward（stub cancelled）", async () => {
    const handler = createUiRequestHandlerForMode(
      makeCtx("rpc"), createUiChannelRegistry(), new DialogGlobalQueue())!;
    const resp = await handler({ method: "notify", id: "f1", message: "m", channel: "unknown" });
    expect(resp).toEqual({ cancelled: true });
  });
});

// coerceUiResponse 形变（通过 channelHandler 返回不同 shape 间接测）
describe("createUiRequestHandlerForMode — coerceUiResponse 形变", () => {
  async function callWithChannel(raw: unknown) {
    const registry = createUiChannelRegistry();
    registry.register("ask_user", (async () => raw) as ChannelHandler);
    const handler = createUiRequestHandlerForMode(makeCtx("rpc"), registry, new DialogGlobalQueue())!;
    return handler({ method: "notify", id: "f1", message: "m", channel: "ask_user" });
  }

  it("channelHandler 返回 {value:'x'} → {value:'x'}", async () => {
    expect(await callWithChannel({ value: "x" })).toEqual({ value: "x" });
  });

  it("channelHandler 返回 {confirmed:true} → {confirmed:true}", async () => {
    expect(await callWithChannel({ confirmed: true })).toEqual({ confirmed: true });
  });

  it("channelHandler 返回 null（非法）→ 降级 {cancelled:true}", async () => {
    expect(await callWithChannel(null)).toEqual({ cancelled: true });
  });
});
