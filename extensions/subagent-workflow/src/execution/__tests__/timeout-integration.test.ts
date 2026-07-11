// src/__tests__/timeout-integration.test.ts
//
// timeoutMs / signal abort → child.kill 端到端路径测试。
//
// 背景：session-runner.ts 无独立 timeoutMs 字段——超时机制是 watchdog（基于
// computeWatchdogMs(opts.maxTurns) 动态计算的下限 30min timer，兜底 SIGTERM）；
// 外部取消通过 opts.signal (AbortSignal) 传播：onAbort → child.kill("SIGTERM")。
// 故「timeout 端到端路径」实际是 watchdog timer + signal abort → child.kill 两条链路。
//
// 本文件聚焦三条终止语义路径（与 run-spawn-integration.test.ts §12 watchdog 测试互补，
// 该文件关注 timer 边界值，本文件关注端到端 kill 语义 + 外部 signal 场景）：
//   1. watchdog 到期 → child.kill（maxTurns 驱动的整体超时兜底）
//   2. 正常完成先于 watchdog 到期 → clearTimeout 生效，不 kill
//   3. 外部 signal abort（运行中 abort / spawn 前已 aborted）→ child.kill
//
// mock 策略（与 run-spawn-integration.test.ts / run-spawn-edges.test.ts 一致）：
//   - node:child_process.spawn → 返回 FakeChild（EventEmitter + PassThrough）。
//   - node:child_process.execFileSync → 返回空串（buildEnvBlock git branch 兜底）。
//   - node:fs 同步方法 → mock（避免触碰真实文件系统），promises 保留真实实现。
//   - temp-prompt → mock（返回固定路径，消除 fake-timers flaky）。
//   - alive-store.writeAliveMarker → mock。

import type { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mock modules ──
// vitest 把 vi.mock 提升到文件顶部，工厂内部引用模块用 await import。

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");

  // FakeChild：模拟 ChildProcess（EventEmitter + PassThrough streams）。
  class FakeChild extends EventEmitter {
    pid = 12345;
    stdout = new PassThrough();
    stderr = new PassThrough();
    killed = false;
    killSignal: string | undefined;
    kill(sig?: string): boolean {
      this.killed = true;
      this.killSignal = sig;
      return true;
    }
  }

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

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";

import { createRecord } from "../execution-record.ts";
import { type RunOptions, runSpawn, type SessionRunnerContext } from "../session-runner.ts";

const mockSpawn = vi.mocked(spawn);
const mockExec = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);

/**
 * spawn mock 返回的 fake child 类型（结构子集）。
 * FakeChild 定义在 vi.mock 工厂内部（作用域隔离），测试代码通过此类型访问成员。
 */
interface FakeChild {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  killSignal: string | undefined;
  kill(sig?: string): boolean;
  emit(event: string, ...args: unknown[]): boolean;
}

/** 从最近一次 spawn 调用取回返回的 FakeChild。 */
function lastSpawnedChild(): FakeChild {
  const result = mockSpawn.mock.results.at(-1);
  if (!result) throw new Error("spawn was not called yet");
  return result.value as FakeChild;
}

// ============================================================
// 辅助：向 stdout 写一行（自动补换行）
// ============================================================

function emitStdoutLine(child: FakeChild, obj: Record<string, unknown>): void {
  child.stdout.write(`${JSON.stringify(obj)}\n`);
}

/** 构造 session header 行（stdout 首行）。 */
function sessionHeader(id = "sess-abc"): Record<string, unknown> {
  return {
    type: "session",
    id,
    timestamp: "2026-07-03T12-00-00-000Z",
    cwd: "/tmp/test",
  };
}

// ============================================================
// 辅助：构造最小合法的 record / opts / ctx
// ============================================================

function makeRecord() {
  return createRecord("run-1", {
    agent: "general-purpose",
    model: "test-model",
    mode: "sync",
    task: "do something",
    startedAt: 1_000_000,
    rootSessionId: "root-session",
    parentRecordId: undefined,
    depth: 0,
  });
}

function makeOpts(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    resolved: {
      model: {
        id: "test-model",
        name: "Test Model",
        provider: "test",
        reasoning: false,
      },
      thinkingLevel: undefined,
    },
    agentConfig: undefined,
    appendSystemPrompt: undefined,
    skillPath: undefined,
    schema: undefined,
    maxTurns: undefined,
    graceTurns: undefined,
    signal: undefined,
    onEvent: undefined,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<SessionRunnerContext> = {}): SessionRunnerContext {
  return {
    cwd: "/tmp/test",
    agentDir: "/tmp/test/agents",
    skillDirs: [],
    mainCwd: "/tmp/test",
    mainSessionFile: undefined,
    ...overrides,
  };
}

/**
 * fake timers 下推进时间直到 spawn 被调用。
 *
 * runSpawn 在 mkdirSync + writePromptToTempFile（mock 的 async I/O）之后才调 spawn。
 * 每次推进 10ms 让轮询 setTimeout 触发，advanceTimersByTimeAsync 同时 flush 已 resolve
 * 的 I/O promise，使 runSpawn 继续走到 spawn。
 */
async function waitForSpawnFake(timeoutSteps = 200): Promise<FakeChild> {
  for (let i = 0; i < timeoutSteps; i++) {
    if (mockSpawn.mock.results.length > 0) break;
    await vi.advanceTimersByTimeAsync(10);
  }
  if (mockSpawn.mock.results.length === 0) {
    throw new Error("spawn was not called (fake timers did not progress to spawn)");
  }
  return lastSpawnedChild();
}

/**
 * 真实 timers 下轮询直到 spawn 被调用（用于 signal abort 测试——不需要推进 watchdog，
 * 用 queueMicrotask 触发 abort，真实 timers 下 mock I/O 正常 resolve）。
 *
 * 与 run-spawn-edges.test.ts 的 waitForSpawn 同模式：setInterval 轮询 mockSpawn.mock.results，
 * 比 vi.waitFor 在该 vitest 版本下更可靠（偶发过早 resolve）。
 */
async function waitForSpawnReal(timeoutMs = 1000): Promise<FakeChild> {
  const start = Date.now();
  while (mockSpawn.mock.results.length === 0) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`spawn was not called within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  return lastSpawnedChild();
}

// ============================================================
// 测试
// ============================================================

describe("timeoutMs / signal abort → child.kill 端到端路径", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExec.mockReturnValue("");
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 1. watchdog 到期 → child.kill ──
  //
  // [R1] watchdog = setTimeout(() => child.kill("SIGTERM"), computeWatchdogMs(maxTurns))。
  // computeWatchdogMs 下限 30min（SPAWN_WATCHDOG_FLOOR_MS），maxTurns=6 → max(30min, 30min)=30min。
  // 子进程卡死（turn_end 永不触发）时 limiter 失效，watchdog 兜底 kill 防资源泄漏。
  describe("watchdog 到期 → signal abort → child.kill", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("watchdog 到期（超过 computeWatchdogMs 阈值）→ child.kill(SIGTERM) 被调用", async () => {
      const record = makeRecord();
      // maxTurns=6 → computeWatchdogMs = max(30min, 6*5min) = 30min
      // 不 await：runSpawn 内部 await 子进程 close，watchdog kill 后还需 emit close 才 resolve
      const promise = runSpawn(record, "Task: hang", makeOpts({ maxTurns: 6 }), makeCtx());

      const child = await waitForSpawnFake();

      // spawn 后尚未触发 kill
      expect(child.killed).toBe(false);

      // 推进时间越过 watchdog 阈值（30 * 60 * 1000 + 100ms 余量）
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 100);

      // watchdog 触发 child.kill("SIGTERM")
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");

      // 收尾：emit close 让 runSpawn resolve（避免悬挂）
      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 143); // SIGTERM = 128+15

      const result = await promise;
      // 信号终止（>=128）视为正常完成
      expect(result.success).toBe(true);
    });
  });

  // ── 2. watchdog 到期前正常完成 → clearTimeout 生效，不 kill ──
  describe("watchdog 到期前正常完成 → 不 kill", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("正常 close(0) 先于 watchdog 到期 → clearTimeout 生效，推进时间后 child 未被 kill", async () => {
      const record = makeRecord();
      // maxTurns=6 → watchdog=30min
      const promise = runSpawn(record, "Task: quick", makeOpts({ maxTurns: 6 }), makeCtx());

      const child = await waitForSpawnFake();

      // 正常完成：emit header + close(0)（远早于 30min watchdog）
      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 0);

      const result = await promise;
      expect(result.success).toBe(true);

      // close 后 runSpawn 已 clearTimeout(watchdog)；推进 30+ 分钟验证 watchdog 未触发 kill
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 100);

      expect(child.killed).toBe(false);
      expect(child.killSignal).toBeUndefined();
    });
  });

  // ── 3. 外部 signal abort → child.kill ──
  //
  // [d] onAbort = () => child.kill("SIGTERM")，opts.signal.addEventListener("abort", onAbort, {once:true})。
  // 前置检查：if (opts.signal?.aborted) onAbort()——spawn 前已 aborted 时 addEventListener
  // 不会触发，立即 kill 兑现取消语义。
  describe("外部 signal abort → child.kill", () => {
    it("运行中 abort signal → child.kill(SIGTERM) 被调用，success=false（取消语义）", async () => {
      const controller = new AbortController();
      const record = makeRecord();
      const promise = runSpawn(
        record,
        "Task: cancelled",
        makeOpts({ signal: controller.signal }),
        makeCtx(),
      );

      const child = await waitForSpawnReal();

      // abort 必须在 spawn 之后（addEventListener 已注册）。
      // queueMicrotask 延迟到当前微任务清空后触发，确保 listener 已挂载。
      queueMicrotask(() => controller.abort());

      // emit header + close（被 kill 后子进程退出，signal 终止 exitCode>=128）
      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 143); // SIGTERM = 128+15

      const result = await promise;

      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");
      // signal.aborted 路径：success=false，但 error 为 undefined（取消不算 error）
      expect(result.success).toBe(false);
      expect(result.error).toBeUndefined();
    });

    it("spawn 前已 aborted 的 signal → 前置检查立即 kill，兑现取消语义", async () => {
      // 覆盖 session-runner.ts L570: if (opts.signal?.aborted) onAbort()
      // 已 aborted 的 signal addEventListener("abort") 不会再触发回调，
      // 故 runSpawn 在注册 listener 后立即前置检查，直接 kill 兑现取消。
      const controller = new AbortController();
      controller.abort(); // spawn 前已 abort

      const record = makeRecord();
      const promise = runSpawn(
        record,
        "Task: pre-aborted",
        makeOpts({ signal: controller.signal }),
        makeCtx(),
      );

      const child = await waitForSpawnReal();

      // 前置检查在 spawn 后同步执行 → child 立即被 kill
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");

      // 收尾：emit close 让 runSpawn resolve
      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 143);

      const result = await promise;
      // signal.aborted → success=false，error undefined
      expect(result.success).toBe(false);
      expect(result.error).toBeUndefined();
    });
  });
});
