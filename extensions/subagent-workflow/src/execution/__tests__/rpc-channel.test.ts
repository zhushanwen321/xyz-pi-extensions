// src/execution/__tests__/rpc-channel.test.ts
//
// W5 契约测试：ChildRpcChannel 直测——锁定 write total function 契约、dead 标志三路置位、
// stdin error listener 吸收语义、isDead 永不复位。
//
// 与 stdin-writer.test.ts 的间接路径（经 respond 测 channel.write）互补：本文件直接构造
// ChildRpcChannel + fake child/stdin，逐契约断言，不依赖 respond/handleUiRequest 等高层函数。
//
// 详见 docs/evolution/006-subagent-rpc-channel-error-boundary.md。

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChildRpcChannel } from "../rpc-channel.ts";

// ── helpers ──

/**
 * 可控的 fake stdin：既是 EventEmitter（支持 on/emit "error"，构造时由 ChildRpcChannel
 * 注册 error listener）又有 Writable 接口（write / destroyed）。write 行为通过 impl 定制
 * （返回值或同步 throw），用于精确触发 EPIPE / 背压 / 正常等路径。
 */
class FakeWritable extends EventEmitter {
  destroyed = false;
  private readonly writeImpl: (chunk: string) => boolean;
  constructor(writeImpl: (chunk: string) => boolean) {
    super();
    this.writeImpl = writeImpl;
  }
  /** Writable 接口：转发到 impl，便于断言调用次数（vi.fn 在 impl 闭包内即可 spy）。 */
  write(chunk: string): boolean {
    return this.writeImpl(chunk);
  }
}

/** fake child + stdin 的组合类型（EventEmitter 提供 on/emit，stdin 可为 PassThrough/FakeWritable/null）。 */
type FakeChild = EventEmitter & {
  stdin: PassThrough | FakeWritable | null;
  pid?: number;
};

/** 构造一个使用 PassThrough stdin 的 fake child（PassThrough 天然支持 on/emit + write/destroyed）。 */
function childWithPassThrough(pid = 4242): { child: FakeChild; stdin: PassThrough } {
  const stdin = new PassThrough();
  const child = new EventEmitter() as FakeChild;
  child.stdin = stdin;
  child.pid = pid;
  return { child, stdin };
}

/** 构造一个使用 FakeWritable stdin 的 fake child，write 行为可控（用于 throw / 背压 / spy 场景）。 */
function childWithFakeStdin(
  writeImpl: (chunk: string) => boolean,
  pid = 9999,
): { child: FakeChild; stdin: FakeWritable } {
  const stdin = new FakeWritable(writeImpl);
  const child = new EventEmitter() as FakeChild;
  child.stdin = stdin;
  child.pid = pid;
  return { child, stdin };
}

/** 构造一个 stdin 为 null 的 fake child（ChildRpcChannel 构造时 child.stdin?.on 不挂 listener）。 */
function childWithNullStdin(pid = 7): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = null;
  child.pid = pid;
  return child;
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // channel.write 降级路径会 console.warn；stub 静音 + 断言调用次数。
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// write — total function 契约
// ============================================================
//
// write() 是 total function：永不抛，成功返回 true，通道断/写失败返回 false。
// 覆盖：正常 / dead 短路 / stdin.destroyed / stdin=null / write throw EPIPE /
// write throw 非 EPIPE / 背压（write 返回 false 但通道仍存活）。

describe("ChildRpcChannel.write — total function 契约", () => {
  it("正常 write 返回 true，child.stdin 收到 line + \\n", () => {
    const { child, stdin } = childWithPassThrough();
    const channel = new ChildRpcChannel(child as unknown as ChildProcess);

    expect(channel.write('{"type":"ping"}')).toBe(true);

    // PassThrough 暂停后从内部缓冲读出（与 stdin-writer.test.ts 同样手法）
    stdin.pause();
    expect(stdin.read()?.toString()).toBe('{"type":"ping"}\n');
  });

  it("isDead 后 write 返回 false 且不再调 child.stdin.write（短路）", () => {
    const writeSpy = vi.fn(() => true);
    const { child } = childWithFakeStdin(writeSpy);
    const channel = new ChildRpcChannel(child as unknown as ChildProcess);

    // 先触发 dead（close 事件）
    child.emit("close", 0, null);
    expect(channel.isDead).toBe(true);

    // 再次 write 短路返回 false，且 stdin.write 一次都没被调
    expect(channel.write("anything")).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("child.stdin.destroyed → write 返回 false + isDead 变 true", () => {
    const { child, stdin } = childWithPassThrough();
    const channel = new ChildRpcChannel(child as unknown as ChildProcess);

    stdin.destroy();
    expect(channel.write("x")).toBe(false);
    expect(channel.isDead).toBe(true);
  });

  it("child.stdin 为 null → write 返回 false + isDead 变 true", () => {
    const child = childWithNullStdin();
    const channel = new ChildRpcChannel(child as unknown as ChildProcess);

    expect(channel.write("x")).toBe(false);
    expect(channel.isDead).toBe(true);
  });

  it("child.stdin.write 同步 throw EPIPE → write 返回 false + isDead true + warn 含 EPIPE", () => {
    const { child } = childWithFakeStdin(() => {
      const e = new Error("write EPIPE");
      (e as NodeJS.ErrnoException).code = "EPIPE";
      throw e;
    });
    const channel = new ChildRpcChannel(child as unknown as ChildProcess);

    expect(channel.write("cmd")).toBe(false);
    expect(channel.isDead).toBe(true);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain("stdin write failed");
    expect(msg).toContain("EPIPE");
  });

  it("child.stdin.write 同步 throw 非 EPIPE → write 返回 false + isDead true + warn 含 unknown", () => {
    const { child } = childWithFakeStdin(() => {
      throw new Error("something else went wrong");
    });
    const channel = new ChildRpcChannel(child as unknown as ChildProcess);

    expect(channel.write("cmd")).toBe(false);
    expect(channel.isDead).toBe(true);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain("stdin write failed");
    expect(msg).toContain("unknown");
  });

  it("child.stdin.write 返回 false（背压）→ warn 含 backpressure，但 isDead 保持 false（背压不死）", () => {
    const { child } = childWithFakeStdin(() => false);
    const channel = new ChildRpcChannel(child as unknown as ChildProcess);

    // channel.write 返回 true（写入成功，仅内核缓冲满）
    expect(channel.write("cmd")).toBe(true);
    // 背压不死：channel 仍可写
    expect(channel.isDead).toBe(false);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain("backpressure");
  });
});

// ============================================================
// dead 标志三路置位（W2 引入但未测的核心契约）
// ============================================================
//
// dead 由三路同步置位：child close/error 事件 + child.stdin stream error + write catch。
// 三路任一路触发后，dead=true 且永不复位，后续 write 短路。

describe("ChildRpcChannel dead 标志三路置位", () => {
  it("child emit close → isDead 变 true，后续 write 返回 false", () => {
    const { child } = childWithPassThrough();
    const channel = new ChildRpcChannel(child as unknown as ChildProcess);
    expect(channel.isDead).toBe(false);

    child.emit("close", 0, null);

    expect(channel.isDead).toBe(true);
    expect(channel.write("x")).toBe(false);
  });

  it("child emit error → isDead 变 true，后续 write 返回 false", () => {
    const { child } = childWithPassThrough();
    const channel = new ChildRpcChannel(child as unknown as ChildProcess);
    expect(channel.isDead).toBe(false);

    child.emit("error", new Error("child crashed"));

    expect(channel.isDead).toBe(true);
    expect(channel.write("x")).toBe(false);
  });

  it("child.stdin emit error → isDead 变 true，后续 write 返回 false", () => {
    const { child, stdin } = childWithPassThrough();
    const channel = new ChildRpcChannel(child as unknown as ChildProcess);
    expect(channel.isDead).toBe(false);

    // PassThrough 派生自 EventEmitter；构造时 channel 已注册 stdin 'error' listener
    stdin.emit("error", Object.assign(new Error("stream broke"), { code: "ENOTCONN" }));

    expect(channel.isDead).toBe(true);
    expect(channel.write("x")).toBe(false);
  });

  it("三路任一路触发后，write 短路不再碰 child.stdin.write", () => {
    const writeSpy = vi.fn(() => true);
    const { child } = childWithFakeStdin(writeSpy);
    const channel = new ChildRpcChannel(child as unknown as ChildProcess);

    // 触发一路：close
    child.emit("close", 0, null);
    expect(channel.isDead).toBe(true);

    // 多次 write 都短路，stdin.write 一次都不应被调
    channel.write("a");
    channel.write("b");
    channel.write("c");
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

// ============================================================
// stdin error listener 吸收（防 uncaughtException 的核心）
// ============================================================
//
// 构造时挂 child.stdin 'error' listener，保证 stream error 一定被吸收——根治
// stream error 升级为 uncaughtException 冲垮父进程。EPIPE 静默（write catch 已 warn 过）；
// 其他 error warn 但不抛。

describe("ChildRpcChannel stdin error listener 吸收", () => {
  it("child.stdin emit error EPIPE → 不抛 + isDead true + 不 warn（EPIPE 静默）", () => {
    const { child, stdin } = childWithPassThrough();
    const channel = new ChildRpcChannel(child as unknown as ChildProcess);

    const e = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

    // 关键断言：emit 不抛（若无 listener，EventEmitter 默认 throw → uncaughtException）
    expect(() => stdin.emit("error", e)).not.toThrow();

    expect(channel.isDead).toBe(true);
    // EPIPE 静默：不 warn（write catch 路径才 warn，stream error EPIPE 路径静默避免重复噪音）
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("child.stdin emit error 无 code → 不抛 + isDead true + warn", () => {
    const { child, stdin } = childWithPassThrough();
    const channel = new ChildRpcChannel(child as unknown as ChildProcess);

    expect(() => stdin.emit("error", new Error("unknown stream fault"))).not.toThrow();

    expect(channel.isDead).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain("stdin stream error");
  });

  it("child.stdin emit error 其他 code（ENOTCONN）→ 不抛 + isDead true + warn", () => {
    const { child, stdin } = childWithPassThrough();
    const channel = new ChildRpcChannel(child as unknown as ChildProcess);

    const e = Object.assign(new Error("other"), { code: "ENOTCONN" });
    expect(() => stdin.emit("error", e)).not.toThrow();

    expect(channel.isDead).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain("stdin stream error");
  });
});

// ============================================================
// isDead 永不复位
// ============================================================
//
// dead 标志一旦置 true 永不复位（子进程死了不会复活）。触发 dead 后多次 write（短路返回 false）
// 不应让 isDead 回到 false。

describe("ChildRpcChannel isDead 永不复位", () => {
  it("isDead 一旦 true 不会回 false：触发 dead 后多次 write 仍 dead", () => {
    const { child } = childWithFakeStdin(() => true);
    const channel = new ChildRpcChannel(child as unknown as ChildProcess);
    expect(channel.isDead).toBe(false);

    child.emit("error", new Error("boom"));
    expect(channel.isDead).toBe(true);

    // 多次 write（短路返回 false）不应复位
    for (let i = 0; i < 5; i++) {
      expect(channel.write("cmd")).toBe(false);
      expect(channel.isDead).toBe(true);
    }
  });
});
