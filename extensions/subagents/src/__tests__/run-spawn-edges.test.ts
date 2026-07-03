// src/__tests__/run-spawn-edges.test.ts
//
// runSpawn 的 stdout 边界与 orphan 进程兜底集成测试（从 run-spawn-integration.test.ts 拆出）。
//
// 本文件覆盖：
//   - [C1] orphan 进程兜底：killAllSpawnedChildren 对未退出 child 发 SIGTERM。
//   - [M8] stdout 边界：损坏行（非法 JSON / 缺 type）静默忽略 + 残留尾行（close 前无 \n）
//     由 close handler 再 parse。
//
// mock 策略（与 run-spawn-integration.test.ts 一致，vi.mock 是文件作用域，每文件需独立声明）：
//   - node:child_process.spawn → 返回 FakeChild（EventEmitter + PassThrough），
//     测试用控制器 emit data/close/error 控制时序。
//   - node:child_process.execFileSync → 返回空串（buildEnvBlock 的 git branch 调用避免副作用）。
//   - node:fs 同步方法 → mock（mkdirSync/existsSync/appendFileSync/writeFileSync 等），
//     避免 sessionDir/sessionFile 触碰真实文件系统。
//   - fs.promises.* → 保留真实实现（temp-prompt 整体被 mock，不触发真实 I/O）。
//   - temp-prompt → mock（writePromptToTempFile 返回固定路径，消除 fake-timers flaky）。
//   - alive-store.writeAliveMarker → mock（避免写 .alive sidecar）。

import type { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mock modules ──
//
// vitest 会把 vi.mock 提升到文件顶部（早于其他 import / 声明）。mock 工厂若要引用
// FakeChild，需在工厂内部 import（async 工厂可用 await import），而非引用顶部
// 顶层 import（它们在 vi.mock 执行时尚未绑定）。

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");

  // FakeChild：模拟 ChildProcess（EventEmitter + PassThrough streams）。
  // 测试通过 mockSpawn.mock.results.at(-1).value 取回实例，控制 emit data/close/error 时序。
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
    execFileSync: vi.fn(() => ""), // buildEnvBlock 的 git branch 调用，返回空避免副作用
  };
});

// node:fs：同步方法 mock（runSpawn 用到的全部），promises 保留真实实现（temp-prompt 用）。
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
    // 具名导出与 default 保持一致
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
    appendFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    // promises 保留真实实现——temp-prompt 已被 mock（见下方 vi.mock），不再触发真实 I/O
    promises: actual.promises,
  };
});

vi.mock("../runtime/execution/alive-store.ts", () => ({
  writeAliveMarker: vi.fn(),
}));

// temp-prompt：mock 掉真实 fs.promises I/O，消除 fake-timers 下的 flaky 竞态
// （详见 run-spawn-integration.test.ts 同名 mock 的注释）。
vi.mock("../core/temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";

import { createRecord } from "../core/execution-record.ts";
import { killAllSpawnedChildren, type RunOptions, runSpawn, type SessionRunnerContext } from "../core/session-runner.ts";

const mockSpawn = vi.mocked(spawn);
const mockExec = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);

/**
 * spawn mock 返回的 fake child 类型。
 * 由于 FakeChild 定义在 vi.mock 工厂内部（作用域隔离），此处用结构子集类型描述，
 * 测试代码通过此类型访问 stdout/stderr/kill 等成员。
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

/** 从最近一次 spawn 调用取回返回的 FakeChild（测试控制器）。 */
function lastSpawnedChild(): FakeChild {
  const result = mockSpawn.mock.results.at(-1);
  if (!result) throw new Error("spawn was not called yet");
  return result.value as FakeChild;
}

/**
 * 等待 runSpawn 内部调到 spawn（拿到 child 控制器）。
 *
 * runSpawn 是 async，spawn 在 mkdirSync + writePromptToTempFile 之后才调（均有微任务/
 * I/O 延迟）。用 setInterval 轮询 mockSpawn.mock.results，比 vi.waitFor 在该 vitest 版本
 * 下更可靠（vi.waitFor 偶发过早 resolve 导致后续读取竞态）。
 */
async function waitForSpawn(timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (mockSpawn.mock.results.length === 0) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`spawn was not called within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ============================================================
// 辅助：向 stdout 写一行（自动补换行，runSpawn 按 \n split 行）
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

// ============================================================
// 测试
// ============================================================

describe("runSpawn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // execFileSync 默认返回空串（git branch 兜底）
    mockExec.mockReturnValue("");
    // existsSync 默认 false（sessionFile 不存在兜底路径）
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 1. orphan 进程兜底（C1）──
  //
  // [C1] runSpawn 把每个 spawned child（sync + background）注册到模块级 spawnedChildren Set。
  // SubagentService.dispose 调 killAllSpawnedChildren 遍历该 Set 对仍存活的子进程发 SIGTERM，
  // 覆盖 sync 子进程（controller=undefined，abortRunningControllers 跳过它）。
  //
  // 关键验证：
  //   1. child 退出（close/error）后从 Set 移除 → killAllSpawnedChildren 不重复 kill。
  //   2. child 未退出时 killAllSpawnedChildren → child.kill("SIGTERM") 被调。
  //   3. 已 kill 的 child 二次调用无害（killAllSpawnedChildren 跳过 killed=true 的）。
  describe("orphan 进程兜底 (C1)", () => {
    it("未退出的 child → killAllSpawnedChildren 对它发 SIGTERM", async () => {
      const record = makeRecord();
      // 不 await——runSpawn 内部 await 子进程 close，killAllSpawnedChildren 测试在 close 前
      const promise = runSpawn(record, "Task: orphan", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      // spawn 后 child.killed 应为 false（尚未被 kill）
      expect(child.killed).toBe(false);

      // dispose 兜底：killAllSpawnedChildren 应 kill 未退出的 child
      const n = killAllSpawnedChildren();
      expect(n).toBeGreaterThanOrEqual(1);
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");

      // 收尾：emit close 让 runSpawn resolve（避免悬挂）
      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 143);

      const result = await promise;
      expect(result.success).toBe(true); // 信号终止视为正常完成
    });

    it("已 close 的 child → 从 Set 移除，killAllSpawnedChildren 不重复 kill", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: closed", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      // 子进程正常退出
      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 0);

      await promise;
      expect(child.killed).toBe(false); // 正常退出未触发 kill

      // close 后 child 已从 Set 移除；再调 killAllSpawnedChildren 不会 kill 它
      const n = killAllSpawnedChildren();
      expect(n).toBe(0);
      expect(child.killed).toBe(false);
    });

    it("多个未退出 child（sync + bg）→ killAllSpawnedChildren 全部 kill", async () => {
      // spawn 两个 child（模拟 sync + background 并发），都未退出。
      // 注意：waitForSpawn 等待 results.length===0→非0 转换，只适用于首次 spawn。
      // 第二次 spawn 需等待 results.length 递增到 2，否则 lastSpawnedChild 取回的是 c1。
      const beforeCount = mockSpawn.mock.results.length;

      const rec1 = makeRecord();
      const p1 = runSpawn(rec1, "Task: c1", makeOpts(), makeCtx());
      await waitForSpawn();
      const c1 = lastSpawnedChild();

      const rec2 = makeRecord();
      const p2 = runSpawn(rec2, "Task: c2", makeOpts(), makeCtx());
      // 等待第二次 spawn：results.length 从 beforeCount+1 涨到 beforeCount+2
      const start = Date.now();
      while (mockSpawn.mock.results.length < beforeCount + 2) {
        if (Date.now() - start > 1000) throw new Error("second spawn not called");
        await new Promise((r) => setTimeout(r, 5));
      }
      const c2 = lastSpawnedChild();

      // c1 和 c2 是不同实例
      expect(c1).not.toBe(c2);
      expect(c1.killed).toBe(false);
      expect(c2.killed).toBe(false);

      // dispose 兜底 kill 两个
      const n = killAllSpawnedChildren();
      expect(n).toBeGreaterThanOrEqual(2);
      expect(c1.killed).toBe(true);
      expect(c2.killed).toBe(true);

      // 收尾
      for (const { child, promise } of [
        { child: c1, promise: p1 },
        { child: c2, promise: p2 },
      ]) {
        emitStdoutLine(child, sessionHeader());
        child.stdout.end();
        child.emit("close", 143);
        const r = await promise;
        expect(r.success).toBe(true);
      }
    });
  });

  // ── 2. stdout 边界：损坏行 + 残留尾行 (M8) ──
  //
  // [M8] runSpawn 的 stdout 解析容错：
  //   - parseSpawnLine 对「非法 JSON」「合法 JSON 但缺 type 字段」归为 kind:"invalid"。
  //   - runSpawn 的 data 处理器只认 header/event 两类，invalid 行静默忽略（L559 注释
  //     "invalid 行忽略"）——单行损坏不应中断整个事件流。
  //   - close 前 stdoutBuffer 若残留未以 \n 结尾的合法 event 行，close handler 会再 parse
  //     一次（L574-579）——覆盖子进程末行漏 \n 的场景。
  describe("stdout 边界：损坏行 + 残留尾行 (M8)", () => {
    it("stdout 夹杂非法 JSON 行 → 该行被忽略，合法 turn_end 正常计数（不抛错）", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: garbage", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      // 非法 JSON 行（如 pi 的调试输出 / 进度条残片）—— parseSpawnLine 归为 invalid
      child.stdout.write("this is not json\n");
      // 合法 turn_end 事件
      emitStdoutLine(child, { type: "turn_end" });
      child.stdout.end();
      child.emit("close", 0);

      const result = await promise;

      expect(result.success).toBe(true);
      expect(record.turnCount).toBe(1); // 非法行被忽略，仅 turn_end 计数
    });

    it("stdout 夹杂合法 JSON 但缺 type 字段 → 该行被忽略，不抛错", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: notype", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      // 合法 JSON 但无 type 字段 —— parseSpawnLine 归为 invalid（"missing string 'type'"）
      child.stdout.write('{"foo":"bar"}\n');
      emitStdoutLine(child, { type: "turn_end" });
      child.stdout.end();
      child.emit("close", 0);

      const result = await promise;

      expect(result.success).toBe(true);
      expect(record.turnCount).toBe(1); // 无 type 行被忽略
    });

    it("残留尾行（close 前未以 \\n 结尾的合法 event）→ close handler 再 parse 处理", async () => {
      // 覆盖 session-runner.ts L574-579：close 前 stdoutBuffer 残留的合法 event 行。
      //
      // 关键：不能用 emitStdoutLine（它会补 \n，残留行在 data 处理器就被 split 消费了，
      // 走不到 close handler 的残留 parse 分支）。需同步 emit data（无 \n）确保该行
      // 残留在 stdoutBuffer 直到 close handler 处理。
      //
      // 同步 emit 的必要性：PassThrough 的 .write() 会把 data flush 排到后续微任务，
      // 若先 .write() 再 emit("close")，close listener 同步执行时 stdoutBuffer 仍为空
      // → 残留逻辑被跳过 → turnCount=0（测出真实 bug 风险）。直接 emit("data", ...) 同步
      // 触发 data 处理器，使行残留在 buffer（split("\n") 无换行 → pop 回 buffer），close
      // handler 才能捕到它。
      const record = makeRecord();
      const promise = runSpawn(record, "Task: tail", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      // 合法 turn_end 但不带末尾 \n：同步 emit（绕过 write 的异步 flush）。
      // data 处理器把它整体留在 stdoutBuffer（无 \n → split 后 pop 回 buffer），
      // 由 close handler 的残留 parse 逻辑（L574-579）处理。
      child.stdout.emit("data", JSON.stringify({ type: "turn_end" }));
      child.emit("close", 0);

      const result = await promise;

      expect(result.success).toBe(true);
      expect(record.turnCount).toBe(1); // 残留尾行被 close handler 正确解析
    });

    it("同一 JSON 行跨 3 次 data 事件分片 → stdoutBuffer 字符串拼接后正确解析", async () => {
      // 覆盖 stdoutBuffer += data 的字符串拼接（setEncoding("utf8") 后 data 收到 string，
      // 非 Buffer）。拆成 3 片写入（跨 type 字段名边界 + 跨 turn_end 值边界），验证拼接无误。
      // .write() 的异步 flush 在 await promise（resolve 排在 data 微任务之后）前完成。
      const record = makeRecord();
      const promise = runSpawn(record, "Task: split3", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      child.stdout.write('{"typ');
      child.stdout.write('e":"turn_en');
      child.stdout.write('d"}\n');
      child.stdout.end();
      child.emit("close", 0);

      const result = await promise;

      expect(result.success).toBe(true);
      expect(record.turnCount).toBe(1); // 3 片拼接后解析为 1 次 turn_end
    });
  });
});
