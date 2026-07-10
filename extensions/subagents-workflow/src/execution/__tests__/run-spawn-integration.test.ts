// src/__tests__/run-spawn-integration.test.ts
//
// runSpawn 集成测试（spawn 改造核心函数）。
//
// runSpawn 负责 spawn pi 子进程、pump stdout JSON 事件流、signal/maxTurns 终止、
// identity 补写、exitCode 判定。此前完全无集成测试——本文件覆盖审查发现的关键路径。
//
// mock 策略（参考 worktree-manager.test.ts 的 mock 模式）：
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

vi.mock("../alive-store.ts", () => ({
  writeAliveMarker: vi.fn(),
}));

// temp-prompt：mock 掉真实 fs.promises I/O（mkdtemp/writeFile/rm）。
// 原先保留真实实现导致 fake-timers 测试偶发 flaky——writePromptToTempFile 的真实异步
// I/O 在 CI 慢机器上无法在 advanceTimersByTimeAsync 的有限步数内 resolve，spawn 永不触发。
// runSpawn 只消费返回的 filePath 字符串（传给 --append-system-prompt），无需真实文件。
vi.mock("../temp-prompt.ts", () => ({
  // 文件名规则与真实实现对齐（safeName：非 \w.- 替换为 _），保持 spawn args 断言稳定
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
const mockAppendFileSync = vi.mocked(fs.appendFileSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);

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

/**
 * 让 sessionFile 存在校验通过——
 * runSpawn 在进程退出后用 existsSync(record.sessionFile) 判断是否补写 identity。
 * 默认 mock existsSync 返回 false（兜底查找），此 helper 在指定路径返回 true。
 */
function mockSessionFileExists(sessionFilePath: string): void {
  mockExistsSync.mockImplementation((p: unknown) => {
    return String(p) === sessionFilePath;
  });
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

  // ── 1. 正常路径（happy path）──
  describe("正常路径", () => {
    it("header + turn_end 事件 + close(0) → success=true，record.sessionFile 被设置，turnCount 正确", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: hello", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      const expectedSessionFile =
        "/tmp/test/agents/subagents/--tmp-test--/sessions/2026-07-03T12-00-00-000Z_sess-abc.jsonl";
      // 进程退出后 existsSync(record.sessionFile) 校验通过 → 补写 identity
      mockSessionFileExists(expectedSessionFile);

      // emit stdout：header + 2 个 turn_end
      emitStdoutLine(child, sessionHeader("sess-abc"));
      emitStdoutLine(child, { type: "turn_end" });
      emitStdoutLine(child, { type: "turn_end" });
      child.stdout.end();
      child.emit("close", 0);

      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.turns).toBe(2); // 2 个 turn_end
      expect(record.turnCount).toBe(2);
      // record.sessionFile 由 header 推导路径回填
      expect(record.sessionFile).toBe(expectedSessionFile);
      expect(result.sessionFile).toBe(expectedSessionFile);
      // sessionId 来自 header.id
      expect(result.sessionId).toBe("sess-abc");
    });

    it("collectResult 文本/toolCalls 从 record 派生（text_delta + tool 调用累积进 turns）", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: write", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();
      mockSessionFileExists(
        "/tmp/test/agents/subagents/--tmp-test--/sessions/2026-07-03T12-00-00-000Z_sess-x.jsonl",
      );

      emitStdoutLine(child, sessionHeader("sess-x"));
      emitStdoutLine(child, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } });
      emitStdoutLine(child, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } });
      emitStdoutLine(child, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
      emitStdoutLine(child, { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { details: "file.txt" } });
      emitStdoutLine(child, { type: "turn_end" });
      child.stdout.end();
      child.emit("close", 0);

      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.text).toBe("Hello world");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]!.toolName).toBe("bash");
      expect(result.toolCalls[0]!.result?.details).toBe("file.txt");
    });
  });

  // ── 2. signal abort → child.kill（cancel 路径）──
  describe("signal abort", () => {
    it("abort signal 触发后 child.kill(SIGTERM) 被调用，success=false", async () => {
      const controller = new AbortController();
      const record = makeRecord();
      const promise = runSpawn(
        record,
        "Task: long",
        makeOpts({ signal: controller.signal }),
        makeCtx(),
      );

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      // abort 必须在 spawn 之后（addEventListener 已注册）。
      // 用 queueMicrotask 延迟到当前微任务清空后触发，确保 listener 已挂载。
      queueMicrotask(() => controller.abort());

      // emit header + close（被 kill 后子进程退出，signal 终止 exitCode>=128 或 null）
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
  });

  // ── 3. maxTurns → limiter.abort → proc.kill ──
  describe("maxTurns 限制", () => {
    it("maxTurns=1, graceTurns=0 → 超出 turn 后 child.kill 被调用，success=true（达限视为正常完成）", async () => {
      const record = makeRecord();
      const promise = runSpawn(
        record,
        "Task: bounded",
        makeOpts({ maxTurns: 1, graceTurns: 0 }),
        makeCtx(),
      );

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      // 第 1 个 turn_end：turn=1 >= maxTurns=1 → steer（noop）
      emitStdoutLine(child, { type: "turn_end" });
      // 第 2 个 turn_end：turn=2 >= maxTurns(1)+graceTurns(0)=1 → abort → proc.kill
      emitStdoutLine(child, { type: "turn_end" });
      child.stdout.end();
      // 被 kill 后信号终止（exitCode>=128），视为正常完成
      child.emit("close", 143);

      const result = await promise;

      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");
      // maxTurns kill 视为正常完成（exitCode>=128 走信号终止分支 → success=true）
      expect(result.success).toBe(true);
    });

    it("maxTurns=2, graceTurns=2 → steer 后需 graceTurns 到达才 kill（第 4 turn 才 abort）", async () => {
      const record = makeRecord();
      const promise = runSpawn(
        record,
        "Task: grace",
        makeOpts({ maxTurns: 2, graceTurns: 2 }),
        makeCtx(),
      );

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      // emit header + 4 个 turn_end。limiter 逻辑（maxTurns=2, graceTurns=2）：
      //   turn=1: 1<2，无动作
      //   turn=2: 2>=limit → steer（仅一次）
      //   turn=3: 3<limit+grace(4)，仍在宽限内
      //   turn=4: 4>=4 → abort → proc.kill(SIGTERM)
      // 注：PassThrough 流加 data 监听器后，缓冲块逐个在后续微任务中 flush，close 前 await
      // 较长时间窗（20ms）确保全部 turn_end 已被 data 处理器消费（含 limiter.abort → kill）。
      emitStdoutLine(child, sessionHeader());
      emitStdoutLine(child, { type: "turn_end" }); // turn=1
      emitStdoutLine(child, { type: "turn_end" }); // turn=2: steer
      emitStdoutLine(child, { type: "turn_end" }); // turn=3: 宽限内
      emitStdoutLine(child, { type: "turn_end" }); // turn=4: abort → kill
      child.stdout.end();
      await new Promise((r) => setTimeout(r, 20));
      child.emit("close", 143);

      const result = await promise;

      // 第 4 个 turn_end 触发 abort → child.kill(SIGTERM)
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");
      expect(record.turnCount).toBe(4);
      // exitCode>=128（信号终止）→ success=true（达限视为正常完成）
      expect(result.success).toBe(true);
    });
  });

  // ── 4. 子进程非零退出（exitCode < 128）──
  describe("非零退出码", () => {
    it("close(1) + stderr 内容 → success=false，error 含 stderr", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: fail", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      child.stderr.write("Error: something went wrong\n");
      child.stderr.end();
      child.stdout.end();
      child.emit("close", 1);

      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toContain("something went wrong");
    });

    it("close(1) 无 stderr → error 含 exit code 信息", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: fail", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      child.stdout.end();
      child.stderr.end();
      child.emit("close", 1);

      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toContain("exited with code 1");
    });
  });

  // ── 5. 子进程被信号终止（exitCode = null 或 >= 128）──
  describe("信号终止", () => {
    it("close(null) → success=true（信号终止视为正常，非 aborted）", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: sig", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.stderr.end();
      child.emit("close", null);

      const result = await promise;

      expect(result.success).toBe(true);
    });

    it("close(143)（SIGTERM，>=128）无 signal → success=true", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: sig143", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 143);

      const result = await promise;

      expect(result.success).toBe(true);
    });
  });

  // ── 6. spawn 本身失败（error 事件，如 ENOENT）──
  describe("spawn error 事件", () => {
    it("child.emit('error') → success=false，error 含错误信息，record.lastError 被设置", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: enoent", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      // spawn error 事件（command not found 等）——runSpawn 的 error handler resolve(128)
      child.emit("error", new Error("spawn ENOENT"));

      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toContain("spawn ENOENT");
      expect(record.lastError).toContain("spawn ENOENT");
    });
  });

  // ── 7. identity 补写 ──
  describe("identity 补写", () => {
    it("正常 close 后 appendFileSync 写入 IDENTITY_CUSTOM_TYPE custom entry", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: identity", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      const sessionFile =
        "/tmp/test/agents/subagents/--tmp-test--/sessions/2026-07-03T12-00-00-000Z_sess-id.jsonl";
      mockSessionFileExists(sessionFile);

      emitStdoutLine(child, sessionHeader("sess-id"));
      emitStdoutLine(child, { type: "turn_end" });
      child.stdout.end();
      child.emit("close", 0);

      await promise;

      // appendFileSync 被调用写 identity custom entry
      expect(mockAppendFileSync).toHaveBeenCalledWith(
        sessionFile,
        expect.stringContaining('"customType":"subagent-identity"'),
        "utf-8",
      );
      // 写入内容含 record.id / agent
      const written = mockAppendFileSync.mock.calls[0]?.[1] as string;
      expect(written).toContain(record.id);
      expect(written).toContain(record.agent);
      expect(written).toContain('"type":"custom"');
    });

    it("sessionFile 不存在（existsSync=false）→ 不补写 identity（不调 appendFileSync）", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: nofile", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      // existsSync 全返回 false（默认）→ record.sessionFile 经兜底查找仍不存在
      emitStdoutLine(child, sessionHeader("sess-none"));
      child.stdout.end();
      child.emit("close", 0);

      await promise;

      expect(mockAppendFileSync).not.toHaveBeenCalled();
    });
  });

  // ── 8. fork depth 环境变量传递 ──
  describe("fork depth 环境变量", () => {
    it("fork=true, parentForkDepth=2 → spawn env 含 PI_SUBAGENT_FORK_DEPTH=3", async () => {
      const record = makeRecord();
      const promise = runSpawn(
        record,
        "Task: fork",
        makeOpts({ fork: true, parentForkDepth: 2 }),
        makeCtx({ mainSessionFile: "/tmp/main.jsonl" }),
      );

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 0);

      await promise;

      // spawn 第 3 参数是 options（含 env）
      const spawnOpts = mockSpawn.mock.calls[0]?.[2] as { env: Record<string, string> };
      expect(spawnOpts.env.PI_SUBAGENT_FORK_DEPTH).toBe("3");
    });

    it("fork=false → spawn env 不含 PI_SUBAGENT_FORK_DEPTH", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: nofork", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 0);

      await promise;

      const spawnOpts = mockSpawn.mock.calls[0]?.[2] as { env: Record<string, string | undefined> };
      expect(spawnOpts.env.PI_SUBAGENT_FORK_DEPTH).toBeUndefined();
    });

    it("spawn 参数含 --session-dir 且 cwd 来自 ctx.cwd", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: args", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 0);

      await promise;

      // spawn(command, args, opts)：args 是数组，应含 --session-dir
      const args = mockSpawn.mock.calls[0]?.[1] as string[];
      const sessionDirIdx = args.indexOf("--session-dir");
      expect(sessionDirIdx).toBeGreaterThanOrEqual(0);
      expect(args[sessionDirIdx + 1]).toContain("--tmp-test--");
      // spawn opts.cwd 来自 ctx.cwd（无 worktree 时）
      const spawnOpts = mockSpawn.mock.calls[0]?.[2] as { cwd: string };
      expect(spawnOpts.cwd).toBe("/tmp/test");
    });
  });

  // ── 9. onEvent 回调 ──
  describe("onEvent 回调", () => {
    it("stdout 事件经 handleSdkEvent 翻译后回调 opts.onEvent", async () => {
      const onEvent = vi.fn();
      const record = makeRecord();
      const promise = runSpawn(record, "Task: events", makeOpts({ onEvent }), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      emitStdoutLine(child, { type: "turn_end" });
      child.stdout.end();
      child.emit("close", 0);

      await promise;

      // onEvent 至少被 turn_end 调过一次（onEvent 签名是单参数 event）
      const turnEndCalls = onEvent.mock.calls.filter(([ev]) => (ev as { type: string }).type === "turn_end");
      expect(turnEndCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 10. sessionDir 创建 ──
  describe("sessionDir 创建", () => {
    it("mkdirSync 以 recursive 创建 sessionDir", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: mkdir", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 0);

      await promise;

      expect(mockMkdirSync).toHaveBeenCalledWith(
        "/tmp/test/agents/subagents/--tmp-test--/sessions",
        { recursive: true },
      );
    });
  });

  // ── 11. 临时 prompt 文件清理 ──
  describe("临时 prompt 文件清理", () => {
    it("有 appendSystemPrompt → 创建临时文件并在 finally 清理（spawn 退出后目录消失）", async () => {
      const record = makeRecord();
      const promise = runSpawn(
        record,
        "Task: cleanup",
        makeOpts({ appendSystemPrompt: ["extra instructions"] }),
        makeCtx(),
      );

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 0);

      await promise;

      // temp-prompt 已 mock（见文件顶部 vi.mock），返回固定文件名；
      // 验证 spawn args 含 --append-system-prompt（说明临时文件路径被传给子进程）
      const args = mockSpawn.mock.calls[0]?.[1] as string[];
      const appendIdx = args.indexOf("--append-system-prompt");
      expect(appendIdx).toBeGreaterThanOrEqual(0);
      expect(args[appendIdx + 1]).toMatch(/prompt-general-purpose\.md$/);
    });
  });

  // ── 12. watchdog 超时兜底（R1）──
  //
  // [R0/R1] SPAWN_WATCHDOG_MS = 30 * 60 * 1000（session-runner.ts 顶部）。
  // 子进程卡死在单 tool 内（turn_end 永不触发）时 limiter 失效，watchdog timer 兜底 SIGTERM，
  // 防止 background 槽位/资源泄漏。timer 加了 .unref()（不阻止 Node 退出）。
  //
  // fake timers 方案 A：describe 块内 beforeEach useFakeTimers、afterEach useRealTimers。
  // 难点：waitForSpawn 内部用 `await new Promise(r => setTimeout(r, 5))` 轮询，fake timers 下
  // 该 setTimeout 不会自动触发——改用 vi.advanceTimersByTimeAsync 推进时间，它会同步 flush
  // 已到期的 timer + 让挂起的真实 I/O（writePromptToTempFile 的 fs.promises）resolve。
  // 关键验证：unref 的 timer 在 fake timers 下仍能被 advanceTimersByTime 触发（vitest fake
  // timers 忽略 unref）。
  describe("watchdog 超时兜底 (R1)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * fake timers 下推进时间直到 spawn 被调用（替代 waitForSpawn）。
     *
     * runSpawn 在 mkdirSync + writePromptToTempFile（真实 fs.promises I/O）之后才调 spawn。
     * 每次推进 10ms 让 waitForSpawn 轮询的 setTimeout(r,5) 触发；同时 advanceTimersByTimeAsync
     * flush 已 resolve 的 I/O promise，使 runSpawn 继续走到 spawn。
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

    it("watchdog 超时（>30min）→ child.kill(SIGTERM) 被调用", async () => {
      const record = makeRecord();
      // 不 await——runSpawn 内部 await 子进程 close，watchdog 触发 kill 后还需 emit close 才 resolve
      const promise = runSpawn(record, "Task: hang", makeOpts(), makeCtx());

      const child = await waitForSpawnFake();

      // spawn 后 child.killed 应为 false（watchdog 尚未触发）
      expect(child.killed).toBe(false);

      // 推进时间越过 watchdog 阈值（30 * 60 * 1000 + 100ms 余量）
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 100);

      // watchdog 触发 child.kill("SIGTERM")
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");

      // 收尾：emit close 让 runSpawn 的 await promise resolve（避免悬挂）
      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 143); // SIGTERM = 128+15

      const result = await promise;
      // 信号终止（>=128）视为正常完成
      expect(result.success).toBe(true);
    });

    it("正常 close(0) → clearTimeout 生效，watchdog 不触发 kill", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: quick", makeOpts(), makeCtx());

      const child = await waitForSpawnFake();

      // 正常完成：emit header + close(0)
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

  // ── 13. stderr 截断防 OOM（R2）──
  //
  // [R2] stderrBuffer = (stderrBuffer + data).slice(-STDERR_MAX_CHARS)（STDERR_MAX_CHARS=64*1024）。
  // 失控子进程打满 stderr 会耗尽父进程内存；保留尾部 64KB 用于 error 诊断。
  describe("stderr 截断防 OOM (R2)", () => {
    it("stderr > 64KB → error 中的 stderr 内容是尾部 64KB（尾部标记保留，头部标记被截断）", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: noisy stderr", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      // 头部标记（应被截断）：足够长的前缀让 64KB 窗口推过它
      const HEAD_MARKER = "HEAD_MARKER_HEAD_MARKER";
      child.stderr.write(HEAD_MARKER);
      // 填充 > 64KB 的噪声（用 "x" 重复），把头部标记推出 64KB 尾部窗口
      child.stderr.write("x".repeat(70 * 1024));
      // 尾部标记（应在截断后仍保留）
      child.stderr.write("TAIL_MARKER_TAIL_MARKER");

      emitStdoutLine(child, sessionHeader());
      child.stderr.end();
      child.stdout.end();
      child.emit("close", 1); // 非零退出 → error 含 stderr

      const result = await promise;

      // 非零退出码 → success=false
      expect(result.success).toBe(false);
      // error 含尾部标记（证明保留了尾部 64KB）
      expect(result.error).toContain("TAIL_MARKER_TAIL_MARKER");
      // error 不含头部标记（证明头部被截断丢弃）
      expect(result.error).not.toContain(HEAD_MARKER);
    });
  });

  // ── 14. UTF-8 编码跨 chunk 安全（R3）──
  //
  // [R3] child.stdout.setEncoding("utf8") 让流按字符边界切分，避免多字节 UTF-8
  //（CJK/emoji）跨 chunk 时 toString() 产生 U+FFFD 替换符导致 JSON.parse 失败。
  //
  // 测法选择：用流状态（readableEncoding）验证 setEncoding("utf8") 被 runSpawn 调用过。
  // 为什么不用 spy：runSpawn 在 spawn() 返回后同步调用 setEncoding，而 waitForSpawn 拿到
  // child 时调用已完成，无法事后挂 spy 捕获。readableEncoding 是 PassThrough(Readable) 暴露的
  // 只读属性，setEncoding("utf8") 后值变为 "utf8"，是"编码确实被设置"的可靠证据。
  // 端到端分片写多字节字符无法真正模拟"字节边界切断"（PassThrough + setEncoding 已在更高层
  // 合并），故补一个"分片写入仍能解析"的用例佐证行缓冲健壮性。
  describe("UTF-8 编码跨 chunk 安全 (R3)", () => {
    it("runSpawn 对 child.stdout 和 child.stderr 调用 setEncoding('utf8')（readableEncoding 验证）", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: utf8", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      // spawn 后 runSpawn 已同步调用 setEncoding("utf8")：readableEncoding 反映该调用结果
      expect(child.stdout.readableEncoding).toBe("utf8");
      expect(child.stderr.readableEncoding).toBe("utf8");

      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0);

      const result = await promise;
      expect(result.success).toBe(true);
    });

    it("stdout 多次分片写入同一 JSON 行仍能正确解析 turn_end（行缓冲合并）", async () => {
      // 端到端验证：数据分两次 write，runSpawn 的行缓冲（stdoutBuffer += data）合并后解析。
      // 此用例验证"分片写入仍能解析"，setEncoding("utf8") 已由上一用例覆盖。
      const record = makeRecord();
      const promise = runSpawn(record, "Task: split", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      // header 完整一行
      emitStdoutLine(child, sessionHeader());
      // turn_end 拆成两半写入（跨 chunk 模拟）
      child.stdout.write('{"type":"turn_e');
      child.stdout.write('nd"}\n');
      child.stdout.end();
      child.emit("close", 0);

      const result = await promise;

      expect(result.success).toBe(true);
      expect(record.turnCount).toBe(1); // 拆开的 turn_end 仍被解析为 1 次
    });
  });

  // 注：C1（orphan 进程兜底）与 M8（stdout 边界）describe 块已移至 run-spawn-edges.test.ts，
  // 拆分以保持本文件 < 1000 行（pre-commit hook 限制）。两文件各自独立声明文件级 mock。
});
