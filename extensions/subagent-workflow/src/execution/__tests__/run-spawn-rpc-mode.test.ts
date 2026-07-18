// src/__tests__/run-spawn-rpc-mode.test.ts
//
// runSpawn 的 RPC mode 集成测试（从 run-spawn-integration.test.ts 拆出，保持该文件 < 1000 行）。
//
// 本文件覆盖 FR-4: RPC mode（pi --mode rpc）无 header 场景——record.sessionFile 无法靠
// stdout header 推导，必须通过 get_state RPC 握手回填。验证修复后的握手逻辑：
//   - 握手移出 header 块、spawn 后无条件启动、close handler 主动 settle 不阻塞。
//   - get_state response 到达 → finishHandshake 回填 sessionFile → identity 写入成功。
//   - get_state 无响应 → close 主动 settle 不阻塞，identity 不写入。
//
// mock 策略（与 run-spawn-integration.test.ts 一致，vi.mock 是文件作用域，每文件需独立声明）：
//   - node:child_process.spawn → 返回 FakeChild（EventEmitter + PassThrough）。
//   - node:child_process.execFileSync → 返回空串（buildEnvBlock 的 git branch 调用避免副作用）。
//   - node:fs 同步方法 → mock，避免触碰真实文件系统。
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
  class FakeChild extends EventEmitter {
    pid = 12345;
    stdout = new PassThrough();
    stderr = new PassThrough();
    stdin = new PassThrough();
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
const mockAppendFileSync = vi.mocked(fs.appendFileSync);

/**
 * spawn mock 返回的 fake child 类型（结构子集，FakeChild 定义在 vi.mock 工厂内）。
 */
interface FakeChild {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
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
 * runSpawn 是 async，spawn 在 mkdirSync + writePromptToTempFile 之后才调。
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

/** 向 stdout 写一行（自动补换行，runSpawn 按 \n split 行）。 */
function emitStdoutLine(child: FakeChild, obj: Record<string, unknown>): void {
  child.stdout.write(`${JSON.stringify(obj)}\n`);
}

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

/** 让 sessionFile 存在校验通过——runSpawn 退出后用 existsSync 判断是否补写 identity。 */
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
    mockExec.mockReturnValue("");
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── FR-4: RPC mode 无 header（get_state 握手回填 sessionFile）──
  //
  // RPC mode（pi --mode rpc）不向 stdout 输出 header 行，record.sessionFile 无法靠
  // header 推导，必须通过 get_state RPC 握手回填。json mode 测试 emit sessionHeader()
  // 模拟 header；本组测试不 emit header，靠 get_state response 回填，验证修复后的握手逻辑
  //（握手移出 header 块、spawn 后无条件启动、close handler 主动 settle 不阻塞）。
  describe("RPC mode 无 header（FR-4 get_state 握手）", () => {
    /**
     * 捕获握手发出的 get_state 命令并 emit 对应 response。
     *
     * 握手在 spawn 后发 get_state 到 child.stdin（id 随机）。测试监听 stdin 捕获 id，
     * emit get_state response 到 stdout，经 stdout pump 匹配 get_stateListeners 触发
     * finishHandshake 回填 record.sessionFile。
     */
    function captureAndRespondGetState(
      child: FakeChild,
      sessionFile: string,
      sessionId = "rpc-sess",
    ): void {
      child.stdin.on("data", (data: Buffer | string) => {
        const text = typeof data === "string" ? data : data.toString();
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const cmd = JSON.parse(line) as { type?: string; id?: string };
            if (cmd.type === "get_state" && cmd.id) {
              emitStdoutLine(child, {
                type: "response",
                command: "get_state",
                success: true,
                id: cmd.id,
                data: { sessionFile, sessionId },
              });
            }
          } catch {
            // 非 JSON 行（prompt 命令等）忽略
          }
        }
      });
    }

    it("无 header + get_state response 回填 sessionFile → identity 写入成功", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: rpc-no-header", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      const expectedSessionFile =
        "/tmp/test/agents/subagents/--tmp-test--/sessions/rpc-session.jsonl";
      // 进程退出后 existsSync(record.sessionFile) 校验通过 → 补写 identity
      mockSessionFileExists(expectedSessionFile);
      captureAndRespondGetState(child, expectedSessionFile);

      // 等待 stdin listener 触发 + response 经 stdout pump 处理 → finishHandshake 回填。
      // PassThrough attach data listener 后在 nextTick flush 缓冲，setTimeout(20) 足够覆盖。
      await new Promise((r) => setTimeout(r, 20));

      // RPC mode：只 emit 事件，不 emit header
      emitStdoutLine(child, { type: "turn_end" });
      child.stdout.end();
      child.emit("close", 0);

      const result = await promise;

      expect(result.success).toBe(true);
      expect(record.sessionFile).toBe(expectedSessionFile);
      expect(result.sessionFile).toBe(expectedSessionFile);
      // identity 经握手回填的 sessionFile 写入（不再依赖 sessionHeader 条件）
      expect(mockAppendFileSync).toHaveBeenCalledWith(
        expectedSessionFile,
        expect.stringContaining('"customType":"subagent-identity"'),
        "utf-8",
      );
    });

    it("无 header + get_state 无响应 → close 主动 settle 不阻塞，identity 不写入", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: rpc-no-response", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      // 消费 stdin 避免背压；不 emit get_state response（模拟握手超时/失败）
      child.stdin.on("data", () => {});

      emitStdoutLine(child, { type: "turn_end" });
      child.stdout.end();
      child.emit("close", 0);

      const result = await promise;

      // close handler 主动 settle，不等握手内部 6s 超时 → 测试不超时（5s 默认上限）
      expect(result.success).toBe(true);
      // 握手未完成 → sessionFile 未回填
      expect(record.sessionFile).toBeUndefined();
      // identity 不写入
      expect(mockAppendFileSync).not.toHaveBeenCalled();
    });
  });
});
