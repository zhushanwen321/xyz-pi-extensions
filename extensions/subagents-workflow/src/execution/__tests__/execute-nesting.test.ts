// src/__tests__/execute-nesting.test.ts
//
// D-030~D-033 嵌套 / 并发池 / 节流回归锁。独立于 execute-integration.test.ts。
//
// 用例：
//   D-032  background 进并发池（分层配额：max(1, maxConcurrent - depth)）
//   D-033  execute 入口通用嵌套护栏（execCtxAls 计 fork+非 fork 嵌套，深度>MAX 拒）
//   嵌套抑制 background onUpdate 恒 undefined（防 spinner 堆叠）
//   节流清理 background finalize 后 throttleState 无残留（clearThrottle 生效）
//
// ── mock 策略 ──
//
// [关键] runSpawn（session-runner.ts）通过 child_process.spawn("pi",...) 启动子进程，
//   事件经 stdout JSON 流回流。它 **不走 getSdk / createAgentSession**。
//   因此本文件 mock 的是 node:child_process.spawn（返回 FakeChild），而非 getSdk/fakeSession
//   （那是对 in-process run() 的旧 mock，在 spawn 改造后是死代码）。
//
//   mock 模式参考 run-spawn-integration.test.ts（该文件是 spawn 改造后的正确 mock 范式）：
//     - node:child_process.spawn → FakeChild（EventEmitter + PassThrough），测试控制器
//       emit stdout JSON 行（header + SdkEvent）/ stderr / close 时序。
//     - node:child_process.execFileSync → ""（buildEnvBlock 的 git branch 调用避免副作用）。
//     - node:fs 同步方法 → mock（mkdirSync/existsSync/appendFileSync/writeFileSync/readdirSync），
//       避免 sessionDir/sessionFile 触碰真实文件系统。
//     - fs.promises.* → 保留真实实现（temp-prompt 整体被 mock，不触发真实 I/O）。
//     - temp-prompt → mock（writePromptToTempFile 返回固定路径，消除 fake-timers flaky）。
//     - alive-store.writeAliveMarker → mock（避免写 .alive sidecar）。
//
//   所有断言语义不变：它们测的是 SubagentService 的 **编排逻辑**
//   （pool.acquire / execCtxAls 深度 / onUpdate 抑制 / throttle 清理），这些逻辑
//   无论事件来自 fakeSession.subscribe 还是 FakeChild.stdout 都一致。

import type { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

// ── mock modules ──
//
// vitest 会把 vi.mock 提升到文件顶部（早于其他 import / 声明）。mock 工厂若要引用
// FakeChild，需在工厂内部 import（async 工厂可用 await import），而非引用顶部
// 顶层 import（它们在 vi.mock 执行时尚未绑定）。

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");

  // FakeChild：模拟 ChildProcess（EventEmitter + PassThrough streams）。
  // 测试通过 lastSpawnedChild() 取回实例，控制 emit stdout JSON 行 / close 时序。
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

// alive-store：mock writeAliveMarker（runSpawn 写 .alive sidecar）+ removeAliveMarker
// （finalizeRecord 收尾删 .alive）。其余导出（readAliveMarker/isProcessAlive）保留真实实现
// （worktree-manager/record-store 用，本组用例不涉及但保留以避免间接报错）。
vi.mock("../alive-store.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/execution/alive-store.ts")>();
  return {
    ...actual,
    writeAliveMarker: vi.fn(),
    removeAliveMarker: vi.fn(),
  };
});

// finalized-marker mock：避免真实 fs 写 sidecar（测试不关心 finalized 行为）
vi.mock("../finalized-marker.ts", () => ({
  writeFinalized: vi.fn(),
  readFinalized: vi.fn(() => false),
}));

// temp-prompt：mock 掉真实 fs.promises I/O，消除 fake-timers 下的 flaky 竞态
// （详见 run-spawn-integration.test.ts 同名 mock 的注释）。
vi.mock("../temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import { spawn } from "node:child_process";

import type { ModelInfo, ModelRegistryLike } from "../model-resolver.ts";
import { MAX_FORK_DEPTH } from "../session-context-resolver.ts";
import { ModelConfigService } from "../model-config-service.ts";
import { SubagentService } from "../subagent-service.ts";

const mockSpawn = vi.mocked(spawn);

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
 * 等待 execute → runSpawn 内部调到 spawn（拿到 child 控制器）。
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
    await new Promise((r) => setTimeout(r, 2));
  }
}

// ============================================================
// 辅助：FakeChild stdout 驱动（替代旧 fakeSession.subscribe 的事件注入）
// ============================================================

/** 构造 session header 行（stdout 首行，runSpawn 据此回填 record.sessionFile）。 */
function sessionHeader(id = "nest-session"): Record<string, unknown> {
  return {
    type: "session",
    id,
    timestamp: "2026-07-03T12-00-00-000Z",
    cwd: "/tmp/test",
  };
}

/** 向 stdout 写一行 JSON（自动补换行，runSpawn 按 \n split 行）。 */
function emitStdoutLine(child: FakeChild, obj: Record<string, unknown>): void {
  child.stdout.write(`${JSON.stringify(obj)}\n`);
}

/**
 * 驱动 FakeChild 完成 session：写 header + 可选事件 + close(0)。
 *
 * 这是「让 runSpawn 自然 resolve」的标准收尾路径。runSpawn 在 close 后判定 success
 * （exitCode=0 → success=true），并跑 identity 补写 + finalizeRecord。
 *
 * @param events  header 之后、close 之前 emit 的 SdkEvent 行（tool/message/turn 等）
 */
async function driveChildToCompletion(child: FakeChild, events: Record<string, unknown>[] = []): Promise<void> {
  emitStdoutLine(child, sessionHeader());
  for (const e of events) emitStdoutLine(child, e);
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0);
}

// ============================================================
// 辅助：service 构造（与旧 setup 等价，但不再装配 fakeSdk）
// ============================================================

function makeEmptyRegistry(): ModelRegistryLike {
  return { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true };
}

function makePi() {
  return { sendMessage: vi.fn(), appendEntry: vi.fn(), events: { emit: vi.fn() } };
}

interface SetupResult {
  service: SubagentService;
}

function setup(): SetupResult {
  const agentDir = "/tmp/nest-it"; // fs 已 mock，路径不需真实存在
  const modelService = new ModelConfigService({ agentDir });
  modelService.initModel({
    modelRegistry: makeEmptyRegistry(),
    sessionId: "nest-it",
    ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
  });
  const service = new SubagentService({
    cwd: agentDir,
    modelService,
    getMainSessionFile: () => "/mock/main-session.jsonl",
  });
  service.initSession({ pi: makePi(), sessionId: "nest-it" });
  return { service };
}

const ctxModel: ModelInfo = { id: "m", name: "M", provider: "p", reasoning: false };

/** execCtxAls.run 的 duck-type（绕过 import AsyncLocalStorage，足够本组用例）。 */
interface ExecCtxAls {
  run: <T>(store: { recordId: string | undefined; depth: number }, cb: () => T) => T;
}

describe("嵌套护栏 / 并发池 / 节流（D-030~D-033 回归锁）", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================
  // D-032: background execute 进并发池（分层配额）
  // ============================================================

  it("[D-032] background execute 调 pool.acquire（进池限流）", async () => {
    const { service } = setup();

    const pool = Reflect.get(service, "pool") as { acquire: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
    const acquireSpy = vi.spyOn(pool, "acquire");

    const execPromise = service.execute({ task: "bg in pool", wait: false, ctxModel });
    // detached runAndFinalize → acquire。等 spawn 拿到 child 再驱动完成。
    await waitForSpawn();
    await driveChildToCompletion(lastSpawnedChild());

    // 等 detached promise 链跑完（kickOffBackground 的 .then notify）
    await new Promise<void>((r) => setTimeout(r, 10));

    expect(acquireSpy).toHaveBeenCalled();
    // background execute 立即返回 handle（不等完成）
    const handle = await execPromise;
    expect(handle.mode).toBe("background");
  });

  // ============================================================
  // D-033: 通用嵌套护栏（execute 入口，execCtxAls 非 fork 路径）
  // ============================================================

  it("[D-033] execCtxAls depth=MAX 时 execute 抛错（nestingDepth=MAX+1 被拒）", async () => {
    const { service } = setup();

    const execCtxAls = Reflect.get(service, "execCtxAls") as ExecCtxAls;

    await expect(
      execCtxAls.run({ recordId: "parent", depth: MAX_FORK_DEPTH }, () =>
        service.execute({ task: "too deep", wait: true, ctxModel }),
      ),
    ).rejects.toThrow(/nesting depth/);

    // 无副作用：guard 在 createRecordForMode 之前，record 未创建
    expect(service.collectRecords(10)).toHaveLength(0);
    // guard 在 spawn 之前——不应 spawn 任何子进程
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("[D-033] execCtxAls depth=MAX-1 时 execute 不抛（nestingDepth=MAX 允许）", async () => {
    const { service } = setup();

    const execCtxAls = Reflect.get(service, "execCtxAls") as ExecCtxAls;

    const execPromise = execCtxAls.run({ recordId: "parent", depth: MAX_FORK_DEPTH - 1 }, () =>
      service.execute({ task: "at limit", wait: true, ctxModel }),
    );
    await waitForSpawn();
    await driveChildToCompletion(lastSpawnedChild(), [
      { type: "turn_end" },
      { type: "message_end", message: { usage: { input: 1 } } },
    ]);
    const result = await execPromise;

    expect(result.mode).toBe("background");
  });

  // ============================================================
  // 嵌套 sync onUpdate 抑制（nestingDepth>0 → onUpdate undefined）
  // ============================================================

  it("[嵌套抑制] 嵌套 sync（execCtxAls depth>0）不回流 onUpdate", async () => {
    const { service } = setup();

    const execCtxAls = Reflect.get(service, "execCtxAls") as ExecCtxAls;

    const updates: unknown[] = [];
    const execPromise = execCtxAls.run({ recordId: "parent", depth: 1 }, () =>
      service.execute({ task: "nested sync", wait: true, ctxModel, onUpdate: (d) => updates.push(d) }),
    );
    await waitForSpawn();
    // emit 会触发 onUpdate 的事件（tool_start/tool_end 是 TRIGGERING_EVENT），
    // 但嵌套层 onUpdate 被抑制（undefined）→ onEventThrottled 包装不挂载 → 0 次
    await driveChildToCompletion(lastSpawnedChild(), [
      { type: "tool_execution_start", toolCallId: "t1", toolName: "read" },
      { type: "tool_execution_end", toolCallId: "t1", toolName: "read" },
      { type: "message_end", message: { usage: { input: 1 } } },
    ]);
    await execPromise;

    // tool_end 是 TRIGGERING_EVENT，但嵌套层 onUpdate 被抑制（undefined）→ 0 次
    expect(updates).toHaveLength(0);
  });

  // ============================================================
  // clearThrottle：sync 完成后 throttleState 清理
  // ============================================================

  it("[节流清理] sync 完成后 throttleState 无残留（clearThrottle 生效）", async () => {
    const { service } = setup();

    const execPromise = service.execute({
      task: "throttle clear",
      wait: true,
      ctxModel,
      onUpdate: () => {},
    });
    await waitForSpawn();
    await driveChildToCompletion(lastSpawnedChild(), [
      { type: "tool_execution_end", toolCallId: "t1", toolName: "read" },
      { type: "message_end", message: { usage: { input: 1 } } },
    ]);
    await execPromise;

    // finalizeRecord → clearThrottle 清掉该 record 的节流 entry（防 Map 无限增长 + trailing 误发陈旧）
    const throttleState = Reflect.get(service, "throttleState") as Map<string, unknown>;
    expect(throttleState.size).toBe(0);
  });
});
