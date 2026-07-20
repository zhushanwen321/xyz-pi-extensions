// src/execution/__tests__/stdin-writer.test.ts
//
// stdin-writer.ts 单元测试——覆盖 respond（UiResponse 4 分支 + 序列化降级）+
// sendPromptCommand + sendGetStateCommand + channel.write 背压/降级。
//
// stdin-writer 是 spawn 改造的叶子 helper，向 rpc 子进程 stdin 写 JSON 命令。
// 与 run-spawn-integration.test.ts 的集成视角不同：本文件只测「给定 channel + 入参，
// stdin 收到的确切字节内容」，逐分支验证协议格式正确性。
//
// [W2] respond/sendPromptCommand/sendGetStateCommand 接受 ChildRpcChannel（取代裸 child）。
// 测试通过 ChildRpcChannel 包裹 PassThrough/fake stdin，验证写入语义。
//
// 测试策略：
//   - 用 PassThrough 模拟 child.stdin（buffered，可事后读出 write 的字节）。
//   - 构造 minimal child (EventEmitter 子类 FakeChild / plain 对象 + on() / stdin: PassThrough)
//     后用 ChildRpcChannel 包裹，再调 respond/sendPrompt/sendGetState。
//   - respond 的 4 分支：value/confirmed/cancelled/ack。ack 不写 stdin（fire-and-forget）。
//   - JSON.stringify 降级（#16）：out.value 含循环引用 → 降级 cancelled + warn。
//   - sendPromptCommand：写 {type:"prompt",message,id} 一行。
//   - sendGetStateCommand：返回 reqId，写 {type:"get_state",id} 一行。
//   - channel.write 背压：mock child.stdin.write 返回 false → warn 但不 throw。
//   - channel.write EPIPE/error 降级：write 同步 throw → warn + dead 置位 + 不抛。

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChildRpcChannel } from "../rpc-channel.ts";
import { respond, sendGetStateCommand, sendPromptCommand } from "../stdin-writer.ts";

// ── helpers ──

/**
 * 构造一个 ChildRpcChannel：内部 child 为 EventEmitter 模拟对潟（含 on() 注册不抛）+
 * PassThrough stdin（buffered，事后可读出写入字节）。
 */
function makeChannel(overrides?: { stdin?: PassThrough }): ChildRpcChannel {
  const child = new EventEmitter() as unknown as { stdin: PassThrough; on: (...args: unknown[]) => unknown; pid?: number };
  // @ts-expect-error: 测试构造——赋 stdin 字段
  child.stdin = overrides?.stdin ?? new PassThrough();
  return new ChildRpcChannel(child as never);
}

/**
 * 读出 channel 内 child.stdin 已缓冲的全部字节（字符串）。
 *
 * PassThrough 默认是 flowing 模式，attach 'data' listener 后会 flush 缓冲。
 * 这里用 readable 状态：pause + read 取出全部缓冲。
 */
function readStdin(channel: ChildRpcChannel): string {
  // @ts-expect-error: 测试访问内部 child.stdin
  const stream = channel.child.stdin as PassThrough;
  stream.pause();
  return stream.read()?.toString() ?? "";
}

/** 从 channel 内 child.stdin 已缓冲内容按行拆分（去空行），返回 JSON.parse 后的对象数组。 */
function readStdinLines(channel: ChildRpcChannel): unknown[] {
  const text = readStdin(channel);
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // stdin-writer 在背压 / 序列化失败时 console.warn；测试 stub 避免 noise，且可断言调用。
  // console.error（manifest 写失败路径）也 stub 静音，但测试不断言其调用。
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// respond：UiResponse 4 分支
// ============================================================

describe("respond — UiResponse 4 分支", () => {
  describe("value 分支", () => {
    it("out={value:'hello'} → stdin 收到 extension_ui_response 含 value 字段", () => {
      const channel = makeChannel();
      respond(channel, "req-1", { value: "hello" });

      const lines = readStdinLines(channel);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({ type: "extension_ui_response", id: "req-1", value: "hello" });
    });

    it("value 为含 JSON 特殊字符的字符串 → 原样透传（不二次转义）", () => {
      // out.value 是字符串，JSON.stringify({value: out.value}) 会正确序列化。
      // 关键：out.value 本身不被 JSON.parse 二次处理——它就是字符串值。
      const channel = makeChannel();
      const payload = JSON.stringify({ q: "ans", n: 1 }); // 合法 JSON 字符串作为 value
      respond(channel, "req-2", { value: payload });

      const lines = readStdinLines(channel);
      expect(lines[0]).toEqual({ type: "extension_ui_response", id: "req-2", value: payload });
    });
  });

  describe("confirmed 分支", () => {
    it("out={confirmed:true} → stdin 收到 confirmed:true", () => {
      const channel = makeChannel();
      respond(channel, "req-3", { confirmed: true });

      const lines = readStdinLines(channel);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({ type: "extension_ui_response", id: "req-3", confirmed: true });
    });

    it("out={confirmed:false} → stdin 收到 confirmed:false（用户拒绝 confirm）", () => {
      const channel = makeChannel();
      respond(channel, "req-4", { confirmed: false });

      const lines = readStdinLines(channel);
      expect(lines[0]).toEqual({ type: "extension_ui_response", id: "req-4", confirmed: false });
    });
  });

  describe("cancelled 分支", () => {
    it("out={cancelled:true} → stdin 收到 cancelled:true", () => {
      const channel = makeChannel();
      respond(channel, "req-5", { cancelled: true });

      const lines = readStdinLines(channel);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({ type: "extension_ui_response", id: "req-5", cancelled: true });
    });
  });

  describe("ack 分支（fire-and-forget）", () => {
    it("out={ack:true} → 不写 stdin（SR-5：fire-and-forget 不期待响应）", () => {
      const channel = makeChannel();
      respond(channel, "req-6", { ack: true });

      // ack 分支 line 保持 undefined → channel.write 不被调 → stdin 无数据
      expect(readStdin(channel)).toBe("");
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});

// ============================================================
// respond：JSON.stringify 降级（#16）
// ============================================================

describe("respond — JSON.stringify 失败降级为 cancelled (#16)", () => {
  it("out.value 含循环引用 → 降级 cancelled:true + warn，不让父进程崩溃", () => {
    // 构造循环引用对象：JSON.stringify 会抛 Converting circular structure to JSON
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    const channel = makeChannel();
    respond(channel, "req-circular", { value: circular } as never);

    // 降级为 cancelled
    const lines = readStdinLines(channel);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      type: "extension_ui_response",
      id: "req-circular",
      cancelled: true,
    });
    // warn 被调用（含 request id）
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnArg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnArg).toContain("req-circular");
    expect(warnArg).toContain("JSON.stringify failed");
  });

  it("out.value 含 BigInt → JSON.stringify 抛 → 降级 cancelled + warn", () => {
    // BigInt 不可 JSON 序列化（JSON.stringify 抛 TypeError: Do not know how to serialize a BigInt）
    const channel = makeChannel();
    respond(channel, "req-bigint", { value: BigInt(123) } as never);

    const lines = readStdinLines(channel);
    expect(lines[0]).toEqual({
      type: "extension_ui_response",
      id: "req-bigint",
      cancelled: true,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("降级后的 cancelled 响应格式与正常 cancelled 分支一致（协议兼容）", () => {
    // 确保降级走的是同一个 cancelled 格式（子进程解析逻辑无需区分「真取消」vs「序列化失败」）
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const channelFail = makeChannel();
    const channelCancel = makeChannel();
    respond(channelFail, "same-id", { value: circular } as never);
    respond(channelCancel, "same-id", { cancelled: true });

    const failLine = readStdinLines(channelFail)[0];
    const cancelLine = readStdinLines(channelCancel)[0];
    expect(failLine).toEqual(cancelLine);
  });
});

// ============================================================
// respond：signal.aborted 守卫
// ============================================================

describe("respond — signal 已 aborted 跳过写入", () => {
  it("signal.aborted=true → 不写 stdin", () => {
    const channel = makeChannel();
    const controller = new AbortController();
    controller.abort();

    respond(channel, "req-aborted", { value: "x" }, controller.signal);

    expect(readStdin(channel)).toBe("");
  });

  it("signal.aborted=false → 正常写入", () => {
    const channel = makeChannel();
    const controller = new AbortController();

    respond(channel, "req-active", { value: "x" }, controller.signal);

    const lines = readStdinLines(channel);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ type: "extension_ui_response", id: "req-active", value: "x" });
  });
});

// ============================================================
// sendPromptCommand
// ============================================================

describe("sendPromptCommand", () => {
  it("写入 {type:'prompt',message,id} 一行，message 含完整 task 文本", () => {
    const channel = makeChannel();
    const task = "Task: do something complex\nwith newline";
    sendPromptCommand(channel, task);

    const lines = readStdinLines(channel);
    expect(lines).toHaveLength(1);
    const cmd = lines[0] as { type: string; message: string; id: string };
    expect(cmd.type).toBe("prompt");
    expect(cmd.message).toBe(task); // 多行 task 原样透传
    expect(typeof cmd.id).toBe("string");
    expect(cmd.id.length).toBeGreaterThan(0); // crypto.randomUUID 生成
  });

  it("每次调用生成不同 id（crypto.randomUUID）", () => {
    const channel = makeChannel();
    sendPromptCommand(channel, "task-1");
    sendPromptCommand(channel, "task-2");

    const lines = readStdinLines(channel);
    expect(lines).toHaveLength(2);
    const id1 = (lines[0] as { id: string }).id;
    const id2 = (lines[1] as { id: string }).id;
    expect(id1).not.toBe(id2);
  });

  it("写入以 \\n 结尾（rpc 子进程按行读 stdin）", () => {
    const channel = makeChannel();
    sendPromptCommand(channel, "task");

    // 直接查 raw 字节，验证末尾换行
    const raw = readStdin(channel);
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("channel 内 child.stdin 已 destroyed → sendPromptCommand 不抛、返回后通道变 dead", () => {
    // 构造一个 stdin 已 destroy 的 channel：channel.write guard 跳过写入并置位 dead。
    // sendPromptCommand 走 channel.write（永不抛），安全返回。
    const stdin = new PassThrough();
    stdin.destroy();
    const channel = makeChannel({ stdin });

    expect(() => sendPromptCommand(channel, "task")).not.toThrow();
    // destroyed stdin 使 channel.write guard 置位 dead
    expect(channel.isDead).toBe(true);
  });

  it("channel 内 child.stdin 为 null → sendPromptCommand 不抛、通道变 dead", () => {
    // 构造一个 stdin 为 null 的 channel：channel.write guard 跳过写入并置位 dead。
    const child = new EventEmitter() as unknown as { stdin: null; on: (...args: unknown[]) => unknown; pid?: number };
    // @ts-expect-error: 测试构造——stdin 为 null
    child.stdin = null;
    const channel = new ChildRpcChannel(child as never);

    expect(() => sendPromptCommand(channel, "task")).not.toThrow();
    expect(channel.isDead).toBe(true);
  });
});

// ============================================================
// sendGetStateCommand
// ============================================================

describe("sendGetStateCommand", () => {
  it("写入 {type:'get_state',id} 一行并返回相同 id（用于匹配 response）", () => {
    const channel = makeChannel();
    const returnedId = sendGetStateCommand(channel);

    const lines = readStdinLines(channel);
    expect(lines).toHaveLength(1);
    const cmd = lines[0] as { type: string; id: string };
    expect(cmd.type).toBe("get_state");
    expect(cmd.id).toBe(returnedId); // 返回值与写入的 id 一致
    expect(typeof cmd.id).toBe("string");
    // get_state 命令不含其他字段（只有 type + id）
    expect(Object.keys(cmd).sort()).toEqual(["id", "type"]);
  });

  it("写入以 \\n 结尾", () => {
    const channel = makeChannel();
    sendGetStateCommand(channel);

    const raw = readStdin(channel);
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("每次调用返回不同 id（crypto.randomUUID）", () => {
    const channel = makeChannel();
    const id1 = sendGetStateCommand(channel);
    const id2 = sendGetStateCommand(channel);
    expect(id1).not.toBe(id2);
  });
});

// ============================================================
// channel.write 背压（间接经 respond 测）
// ============================================================

describe("channel.write 背压 — write 返回 false 时 warn 不 throw", () => {
  it("child.stdin.write 返回 false → respond 不抛、warn 一次（背压告警）", () => {
    // 构造 write 永远返回 false 的假 stream（模拟内核缓冲满/HWM 到达）
    const fakeStdin = {
      write: vi.fn(() => false),
      destroyed: false,
      on: vi.fn(),
    } as unknown as PassThrough;
    const child = new EventEmitter() as unknown as { stdin: PassThrough; on: (...args: unknown[]) => unknown };
    // @ts-expect-error: 测试构造——赋 fakeStdin
    child.stdin = fakeStdin;
    const channel = new ChildRpcChannel(child as never);

    expect(() => respond(channel, "req-backpressure", { value: "x" })).not.toThrow();

    // write 被调一次（写入 command 行）
    expect(fakeStdin.write).toHaveBeenCalledTimes(1);
    const writtenArg = fakeStdin.write.mock.calls[0]?.[0] as string;
    expect(writtenArg).toContain("extension_ui_response");
    expect(writtenArg).toContain("req-backpressure");
    expect(writtenArg.endsWith("\n")).toBe(true);
    // warn 被调（背压告警）
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain("backpressure");
    // 背压不置位 dead（内核缓冲随后会排空）
    expect(channel.isDead).toBe(false);
  });

  it("child.stdin.write 返回 true → 不 warn（正常路径）", () => {
    const fakeStdin = {
      write: vi.fn(() => true),
      destroyed: false,
      on: vi.fn(),
    } as unknown as PassThrough;
    const child = new EventEmitter() as unknown as { stdin: PassThrough; on: (...args: unknown[]) => unknown };
    // @ts-expect-error: 测试构造
    child.stdin = fakeStdin;
    const channel = new ChildRpcChannel(child as never);

    respond(channel, "req-ok", { value: "x" });

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ============================================================
// channel.write 写入抛错降级（[R1]/[R2]/W2 核心场景）
// ============================================================
//
// 触发场景：subagent 子进程在父进程等待 UI 响应期间退出（OOM/被杀/正常退出），
// stdin 写端关闭。父进程调 respond → channel.write → child.stdin.write() 同步抛 EPIPE。
// channel.write 的 try/catch 必须接住并降级 warn，不能让错误冒泡为 uncaughtException。
//
// [W2] writeStdinLine 已被 channel.write 取代。本块从测 respond 间接路径改为直测
// channel.write 的 EPIPE 降级 + dead 置位（任务要求的语义保留）。
describe("channel.write write 抛错 — 同步 EPIPE/error 降级 warn + dead 置位 (W2)", () => {
  it("child.stdin.write 同步 throw EPIPE → channel.write 返回 false、不抛、warn 含 EPIPE、dead=true", () => {
    const fakeStdin = {
      write: vi.fn(() => {
        const e = new Error("write EPIPE");
        (e as NodeJS.ErrnoException).code = "EPIPE";
        throw e;
      }),
      destroyed: false,
      on: vi.fn(),
    } as unknown as PassThrough;
    const child = new EventEmitter() as unknown as { stdin: PassThrough; on: (...args: unknown[]) => unknown };
    // @ts-expect-error: 测试构造
    child.stdin = fakeStdin;
    const channel = new ChildRpcChannel(child as never);

    // channel.write 接住同步 throw EPIPE，返回 false 不冒泡
    let result: boolean | undefined;
    expect(() => {
      result = channel.write("some-command-line");
    }).not.toThrow();
    expect(result).toBe(false);
    expect(fakeStdin.write).toHaveBeenCalledTimes(1);
    // warn 被调一次（降级告警，含 code）
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain("stdin write failed");
    expect(warnMsg).toContain("EPIPE");
    // EPIPE 后通道置位 dead，后续 write 直接 short-circuit
    expect(channel.isDead).toBe(true);
    expect(channel.write("second")).toBe(false);
    expect(fakeStdin.write).toHaveBeenCalledTimes(1); // dead 后不再调
  });

  it("child.stdin.write 同步 throw 非 EPIPE error → 同样降级，warn 含 unknown code", () => {
    // 非预期错误（如 fs 内部故障）也应降级——RPC 通道断了不管什么原因，父进程都不该崩
    const fakeStdin = {
      write: vi.fn(() => {
        throw new Error("something else went wrong");
      }),
      destroyed: false,
      on: vi.fn(),
    } as unknown as PassThrough;
    const child = new EventEmitter() as unknown as { stdin: PassThrough; on: (...args: unknown[]) => unknown };
    // @ts-expect-error: 测试构造
    child.stdin = fakeStdin;
    const channel = new ChildRpcChannel(child as never);

    let result: boolean | undefined;
    expect(() => {
      result = channel.write("cmd");
    }).not.toThrow();
    expect(result).toBe(false);
    expect(fakeStdin.write).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain("stdin write failed");
    expect(warnMsg).toContain("unknown"); // code 缺失时 warn 为 (unknown)
    expect(channel.isDead).toBe(true);
  });
});
