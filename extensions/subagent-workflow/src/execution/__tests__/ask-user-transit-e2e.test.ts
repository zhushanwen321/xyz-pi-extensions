// src/execution/__tests__/ask-user-transit-e2e.test.ts
//
// #34 跨进程 ask_user transit 完整 e2e 测试。
//
// 验证完整链路：
//   FakeChild.stdout emit extension_ui_request
//     → runSpawn stdout pump（parseSpawnLine 解析）
//     → createUiRequestQueue 入队 + handleUiRequest
//     → ctx.uiRequestHandler（由 createUiRequestHandlerForMode 构造）
//     → channel registry 命中 'ask_user' → channel handler 返回固定答案
//     → respond 回写 child.stdin（extension_ui_response）
//
// 与单元测试的差异：ui-request-handler.test.ts 只测 parseSpawnLine + parseChannel +
// createUiRequestQueue 各层独立；本文件串起**所有层**（adapter → queue → factory →
// channel handler → respond），覆盖跨进程协议透传的真实链路，是 ask_user 功能的
// 端到端契约验证。
//
// 关键被测对象：
//   1. spawn-event-adapter.parseSpawnLine：识别 extension_ui_request 行
//   2. session-runner.runSpawn 的 stdout pump：调 enqueueUiRequest
//   3. ui-request-queue.createUiRequestQueue：FIFO + handleUiRequest
//   4. ui-request-handler-factory.createUiRequestHandlerForMode：channel 路由 + 默认转发
//   5. stdin-writer.respond：回写 extension_ui_response
//
// mock 策略：与 run-spawn-integration.test.ts 一致（共享 helpers/spawn-mock.ts），
// 额外注入 ctx.uiRequestHandler + ctx.dialogQueue + channel registry。

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mock modules（与 run-spawn-*.test.ts 一致）──

vi.mock("node:child_process", async () => {
  const { FakeChild } = await import("./helpers/spawn-mock.ts");
  return {
    spawn: vi.fn(() => new FakeChild()),
    execFileSync: vi.fn(() => ""),
  };
});

vi.mock("node:fs", async () => {
  const actual = await import("node:fs");
  return {
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => false),
      appendFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      readdirSync: vi.fn(() => []),
    },
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
    appendFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    promises: actual.promises,
  };
});

vi.mock("../alive-store.ts", () => ({
  writeAliveMarker: vi.fn(),
}));

vi.mock("../temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import { DialogGlobalQueue } from "../dialog-queue.ts";
import { runSpawn, type SessionRunnerContext } from "../session-runner.ts";
import { type ChannelHandler,createUiChannelRegistry } from "../ui-channels.ts";
import { createUiRequestHandlerForMode } from "../ui-request-handler-factory.ts";
import {
  emitStdoutLine,
  type FakeChild,
  lastSpawnedChild as lastSpawnedChildOf,
  makeCtx as makeCtxBase,
  makeOpts,
  makeRecord,
  sessionHeader,
  waitForSpawn as waitForSpawnOf,
} from "./helpers/spawn-mock.ts";

const mockSpawn = vi.mocked(spawn);
const mockExec = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);

const lastSpawnedChild = (): FakeChild => lastSpawnedChildOf(mockSpawn);
const waitForSpawn = (timeoutMs = 1000): Promise<void> => waitForSpawnOf(mockSpawn, timeoutMs);

// ── ask_user 协议样本（真实 Pi 格式）──

const ASK_USER_MARKER = "\0XYZ_ASK_USER";

interface AskUserPayload {
  questions: Array<{
    question: string;
    options: Array<{ label: string }>;
  }>;
  allowCancel: boolean;
}

const askUserPayload: AskUserPayload = {
  questions: [
    {
      question: "What is your preference?",
      options: [{ label: "Option A" }, { label: "Option B" }],
    },
  ],
  allowCancel: true,
};

/** 构造 Pi 原生 extension_ui_request stdout 行（ask_user 借道 select 通道）。 */
function askUserLine(id: string): string {
  return JSON.stringify({
    type: "extension_ui_request",
    id,
    method: "select",
    title: ASK_USER_MARKER,
    options: [JSON.stringify(askUserPayload)],
  });
}

/** 读出 child.stdin 已缓冲的全部字节。 */
function readStdin(child: FakeChild): string {
  child.stdin.pause();
  return child.stdin.read()?.toString() ?? "";
}

/** 从 child.stdin 按行拆分（去空行 + JSON.parse）。 */
function readStdinLines(child: FakeChild): unknown[] {
  return readStdin(child)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/** 构造 ctx，注入 uiRequestHandler（由 createUiRequestHandlerForMode 构建）。 */
function makeAskUserCtx(
  registry: ReturnType<typeof createUiChannelRegistry>,
  dialogQueue: DialogGlobalQueue,
  overrides: Partial<SessionRunnerContext> = {},
): SessionRunnerContext {
  // ctx.ui / ctx.mode 是 createUiRequestHandlerForMode 的入参。
  // mode='rpc' → hostMode='gui'（全透传），dialog 进 dialogQueue 串行。
  // ctx.ui 在 channel 命中时不被调用（channel handler 直接返回），故 ui 用 stub 即可。
  const ctx = {
    cwd: "/tmp/test",
    mode: "rpc" as const,
    sessionManager: {
      getSessionId: () => "s1",
      getSessionFile: () => undefined,
      getSessionDir: () => "/tmp/test/sessions",
    },
    modelRegistry: undefined,
    model: undefined,
  } as SessionRunnerContext;
  const handler = createUiRequestHandlerForMode(ctx as never, registry, dialogQueue);
  return makeCtxBase({
    ...overrides,
    uiRequestHandler: handler,
    dialogQueue,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExec.mockReturnValue("");
  mockExistsSync.mockReturnValue(false);
  // 静默 stdin-writer / factory 的 warn（序列化失败降级等场景）
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// E2E：完整 transit 链路（adapter → queue → factory → channel → respond）
// ============================================================

describe("ask_user 跨进程 transit e2e (#34)", () => {
  it("channel handler 命中 ask_user → 返回的 value 经 respond 回写 child.stdin", async () => {
    // 1. 注册 ask_user channel handler，返回固定答案（模拟用户选了 Option A）
    const registry = createUiChannelRegistry();
    const answer = JSON.stringify({ q0: "Option A" });
    const channelHandler: ChannelHandler = vi.fn(async () => ({ value: answer }));
    registry.register("ask_user", channelHandler);

    const dialogQueue = new DialogGlobalQueue();
    const ctx = makeAskUserCtx(registry, dialogQueue);

    // 2. 启动 runSpawn（不 await，spawn 后异步 emit 请求）
    const record = makeRecord();
    const promise = runSpawn(record, "Task: ask-user-e2e", makeOpts(), ctx);

    await waitForSpawn();
    const child = lastSpawnedChild();

    // 3. emit session header（runSpawn 需要 header 才能完成 close 路径）+ ask_user 请求
    emitStdoutLine(child, sessionHeader("sess-ask-1"));
    child.stdout.write(askUserLine("req-ask-1") + "\n");

    // 4. 给 stdout pump + channel handler (async) + respond 时间执行
    //    PassThrough data listener flush + microtask + handler promise resolve 需若干 tick。
    await new Promise((r) => setTimeout(r, 30));

    // 5. 收尾：让 runSpawn resolve
    child.stdout.end();
    child.emit("close", 0);
    await promise;

    // 6. 断言 child.stdin 收到 extension_ui_response（value 分支）
    const responseLines = readStdinLines(child).filter(
      (l): l is { type: string; id: string; value?: string } =>
        typeof l === "object" && l !== null && (l as { type?: string }).type === "extension_ui_response",
    );
    expect(responseLines.length).toBe(1);
    expect(responseLines[0]!.id).toBe("req-ask-1");
    expect(responseLines[0]!.value).toBe(answer);

    // 7. channel handler 被调用一次，入参是 UiRequest（含 channel='ask_user' + payload）
    expect(channelHandler).toHaveBeenCalledTimes(1);
    const handlerArg = (channelHandler as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      method: string;
      channel: string;
      channelPayload: AskUserPayload;
      id: string;
    };
    expect(handlerArg.method).toBe("select");
    expect(handlerArg.channel).toBe("ask_user");
    expect(handlerArg.id).toBe("req-ask-1");
    expect(handlerArg.channelPayload).toEqual(askUserPayload);
  });

  it("channel handler 返回 {confirmed:true} → respond 写 confirmed 分支", async () => {
    const registry = createUiChannelRegistry();
    const channelHandler: ChannelHandler = vi.fn(async () => ({ confirmed: true }));
    registry.register("ask_user", channelHandler);

    const dialogQueue = new DialogGlobalQueue();
    const ctx = makeAskUserCtx(registry, dialogQueue);

    const record = makeRecord();
    const promise = runSpawn(record, "Task: confirm-e2e", makeOpts(), ctx);

    await waitForSpawn();
    const child = lastSpawnedChild();

    emitStdoutLine(child, sessionHeader("sess-confirm"));
    child.stdout.write(askUserLine("req-confirm") + "\n");
    await new Promise((r) => setTimeout(r, 30));

    child.stdout.end();
    child.emit("close", 0);
    await promise;

    const responseLines = readStdinLines(child).filter(
      (l): l is { type: string; id: string; confirmed?: boolean } =>
        typeof l === "object" && l !== null && (l as { type?: string }).type === "extension_ui_response",
    );
    expect(responseLines).toHaveLength(1);
    expect(responseLines[0]!.id).toBe("req-confirm");
    expect(responseLines[0]!.confirmed).toBe(true);
  });

  it("channel handler 返回 {cancelled:true} → respond 写 cancelled 分支", async () => {
    const registry = createUiChannelRegistry();
    // 模拟用户取消（allowCancel 场景）
    const channelHandler: ChannelHandler = vi.fn(async () => ({ cancelled: true }));
    registry.register("ask_user", channelHandler);

    const dialogQueue = new DialogGlobalQueue();
    const ctx = makeAskUserCtx(registry, dialogQueue);

    const record = makeRecord();
    const promise = runSpawn(record, "Task: cancel-e2e", makeOpts(), ctx);

    await waitForSpawn();
    const child = lastSpawnedChild();

    emitStdoutLine(child, sessionHeader("sess-cancel"));
    child.stdout.write(askUserLine("req-cancel") + "\n");
    await new Promise((r) => setTimeout(r, 30));

    child.stdout.end();
    child.emit("close", 0);
    await promise;

    const responseLines = readStdinLines(child).filter(
      (l): l is { type: string; id: string; cancelled?: boolean } =>
        typeof l === "object" && l !== null && (l as { type?: string }).type === "extension_ui_response",
    );
    expect(responseLines).toHaveLength(1);
    expect(responseLines[0]!.id).toBe("req-cancel");
    expect(responseLines[0]!.cancelled).toBe(true);
  });

  it("多个 ask_user 请求 FIFO 串行 → 按到达顺序回写，channel handler 不并发", async () => {
    // L1 per-child 队列（createUiRequestQueue）保证同子进程内 FIFO 串行。
    // 验证：连续 emit 两个 ask_user，channel handler 按顺序被调，response 按顺序写回。
    const registry = createUiChannelRegistry();
    const callOrder: string[] = [];
    const channelHandler: ChannelHandler = vi.fn(async (req: { id: string }) => {
      callOrder.push(req.id);
      // 加延迟让两个请求有机会并发（若队列没串行）
      await new Promise((r) => setTimeout(r, 15));
      return { value: `ans-${req.id}` };
    });
    registry.register("ask_user", channelHandler);

    const dialogQueue = new DialogGlobalQueue();
    const ctx = makeAskUserCtx(registry, dialogQueue);

    const record = makeRecord();
    const promise = runSpawn(record, "Task: fifo-e2e", makeOpts(), ctx);

    await waitForSpawn();
    const child = lastSpawnedChild();

    emitStdoutLine(child, sessionHeader("sess-fifo"));
    child.stdout.write(askUserLine("req-fifo-1") + "\n");
    child.stdout.write(askUserLine("req-fifo-2") + "\n");
    // 等两个 handler 都执行完（每个 ~15ms + overhead）
    await new Promise((r) => setTimeout(r, 80));

    child.stdout.end();
    child.emit("close", 0);
    await promise;

    // 串行：handler 按到达顺序被调，无并发
    expect(callOrder).toEqual(["req-fifo-1", "req-fifo-2"]);
    expect(channelHandler).toHaveBeenCalledTimes(2);

    // 两个 response 都写回，按 id 可找到
    const responses = readStdinLines(child).filter(
      (l): l is { type: string; id: string; value?: string } =>
        typeof l === "object" && l !== null && (l as { type?: string }).type === "extension_ui_response",
    );
    const ids = responses.map((r) => r.id).sort();
    expect(ids).toEqual(["req-fifo-1", "req-fifo-2"]);
    const r1 = responses.find((r) => r.id === "req-fifo-1");
    const r2 = responses.find((r) => r.id === "req-fifo-2");
    expect(r1?.value).toBe("ans-req-fifo-1");
    expect(r2?.value).toBe("ans-req-fifo-2");
  });

  it("channel 未注册 → defaultDialogForward 回 cancelled（ask_user 扩展未安装兜底）", async () => {
    // 不注册 ask_user channel → channelHandler 为 undefined → defaultDialogForward
    // defaultDialogForward 调 ctx.ui.select（这里 ctx.ui 是 stub，select 返 undefined → cancelled）
    const registry = createUiChannelRegistry();
    const dialogQueue = new DialogGlobalQueue();

    // ctx.ui.select 返回 undefined（模拟用户取消 / stub）
    const selectSpy = vi.fn(async () => undefined);
    const ctxBase = makeCtxBase();
    const fakeCtx = {
      cwd: "/tmp/test",
      mode: "rpc" as const,
      sessionManager: {
        getSessionId: () => "s1",
        getSessionFile: () => undefined,
        getSessionDir: () => "/tmp/test/sessions",
      },
      modelRegistry: undefined,
      model: undefined,
      ui: { select: selectSpy },
    } as never;
    const handler = createUiRequestHandlerForMode(fakeCtx, registry, dialogQueue);
    const ctx = { ...ctxBase, uiRequestHandler: handler, dialogQueue };

    const record = makeRecord();
    const promise = runSpawn(record, "Task: no-channel", makeOpts(), ctx);

    await waitForSpawn();
    const child = lastSpawnedChild();

    emitStdoutLine(child, sessionHeader("sess-nochannel"));
    child.stdout.write(askUserLine("req-nochannel") + "\n");
    await new Promise((r) => setTimeout(r, 30));

    child.stdout.end();
    child.emit("close", 0);
    await promise;

    // ctx.ui.select 被调（defaultDialogForward 兜底）
    expect(selectSpy).toHaveBeenCalledTimes(1);
    // response 是 cancelled（select 返 undefined → cancelled）
    const responses = readStdinLines(child).filter(
      (l): l is { type: string; id: string; cancelled?: boolean } =>
        typeof l === "object" && l !== null && (l as { type?: string }).type === "extension_ui_response",
    );
    expect(responses).toHaveLength(1);
    expect(responses[0]!.id).toBe("req-nochannel");
    expect(responses[0]!.cancelled).toBe(true);
  });

  it("channel handler 抛错 → respond 写 cancelled（队列不卡死）", async () => {
    const registry = createUiChannelRegistry();
    const channelHandler: ChannelHandler = vi.fn(async () => {
      throw new Error("handler boom");
    });
    registry.register("ask_user", channelHandler);

    const dialogQueue = new DialogGlobalQueue();
    const ctx = makeAskUserCtx(registry, dialogQueue);

    const record = makeRecord();
    const promise = runSpawn(record, "Task: handler-throws", makeOpts(), ctx);

    await waitForSpawn();
    const child = lastSpawnedChild();

    emitStdoutLine(child, sessionHeader("sess-throws"));
    child.stdout.write(askUserLine("req-throws") + "\n");
    await new Promise((r) => setTimeout(r, 30));

    child.stdout.end();
    child.emit("close", 0);
    await promise;

    // ui-request-queue 的 handleUiRequest catch handler 抛错 → respond cancelled
    const responses = readStdinLines(child).filter(
      (l): l is { type: string; id: string; cancelled?: boolean } =>
        typeof l === "object" && l !== null && (l as { type?: string }).type === "extension_ui_response",
    );
    expect(responses).toHaveLength(1);
    expect(responses[0]!.id).toBe("req-throws");
    expect(responses[0]!.cancelled).toBe(true);
  });

  it("child close 后 pending ask_user 的 handler 完成 → 不再写 stdin（signal aborted）", async () => {
    // 验证 R3：子进程退出时 AbortController.abort，handler 完成后 respond 跳过写入。
    // 构造：channel handler 在 child close 后才 resolve（模拟慢用户响应 + 子进程先退出）。
    const registry = createUiChannelRegistry();
    let resolveHandler: ((v: { value: string }) => void) | undefined;
    const channelHandler: ChannelHandler = vi.fn(
      () => new Promise<{ value: string }>((resolve) => {
        resolveHandler = resolve;
      }),
    );
    registry.register("ask_user", channelHandler);

    const dialogQueue = new DialogGlobalQueue();
    const ctx = makeAskUserCtx(registry, dialogQueue);

    const record = makeRecord();
    const promise = runSpawn(record, "Task: abort-pending", makeOpts(), ctx);

    await waitForSpawn();
    const child = lastSpawnedChild();

    emitStdoutLine(child, sessionHeader("sess-abort"));
    child.stdout.write(askUserLine("req-abort") + "\n");
    // 让 handler 入队（但未 resolve）
    await new Promise((r) => setTimeout(r, 20));

    // 子进程先退出（handler 仍 pending）→ onClose abort
    child.stdout.end();
    child.emit("close", 0);
    await promise;

    // 现在 handler 仍 pending；resolve 它（模拟延迟响应）
    expect(resolveHandler).toBeDefined();
    resolveHandler!({ value: "late-answer" });
    // 给 finally 块执行时间
    await new Promise((r) => setTimeout(r, 20));

    // child.stdin 不应收到 extension_ui_response（signal.aborted → respond 跳过）
    const responses = readStdinLines(child).filter(
      (l): l is { type: string; id: string } =>
        typeof l === "object" && l !== null && (l as { type?: string }).type === "extension_ui_response",
    );
    expect(responses).toHaveLength(0);
  });
});
