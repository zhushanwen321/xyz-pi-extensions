// src/__tests__/execute-nesting.test.ts
//
// D-030~D-033 嵌套 / 并发池 / 节流回归锁。独立于 execute-integration.test.ts
// （该文件已近 1000 行上限），复用相同 fakeSdk mock 模式但只覆盖本组用例所需的最小
// PromptBehavior（resolve）。cancel / pending / worktree / queue 场景仍在 execute-integration。
//
// 用例：
//   D-032  sync 不进并发池（防嵌套死锁）；background 仍进池
//   D-033  execute 入口通用嵌套护栏（execCtxAls 计 fork+非 fork 嵌套，深度>MAX 拒）
//   嵌套抑制 nestingDepth>0 的 sync onUpdate 被置 undefined（防 spinner 堆叠）
//   节流清理 sync finalize 后 throttleState 无残留（clearThrottle 生效）

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, type Mock, vi } from "vitest";

import type { ModelInfo, ModelRegistryLike } from "../core/model-resolver.ts";
import { MAX_FORK_DEPTH } from "../core/session-context-resolver.ts";
import { ModelConfigService } from "../runtime/model-config-service.ts";
import { SubagentService } from "../runtime/subagent-service.ts";
import type { AgentSessionLike, SdkEvent, SdkLike } from "../types.ts";

// ── fakeSdk 注入（与 execute-integration 同模式：mock getSdk，保留 run 真实实现）──

const { fakeSdkSlot } = vi.hoisted(() => ({ fakeSdkSlot: { current: null as SdkLike | null } }));
const { fakeSessionTmps } = vi.hoisted(() => ({ fakeSessionTmps: [] as string[] }));

vi.mock("../core/session-runner.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/session-runner.ts")>();
  return {
    ...actual,
    getSdk: () => {
      if (!fakeSdkSlot.current) throw new Error("fakeSdkSlot.current not set before execute()");
      return Promise.resolve(fakeSdkSlot.current);
    },
  };
});

// finalized-marker mock：避免真实 fs 写 sidecar（测试不关心 finalized 行为）
vi.mock("../runtime/execution/finalized-marker.ts", () => ({
  writeFinalized: vi.fn(),
  readFinalized: vi.fn(() => false),
}));

// ── fakeSdk / fakeSession（精简：只 resolve，无 pending/cancel/queue）──

function makeFakeSession(opts: { promptBehavior: { kind: "resolve"; events?: SdkEvent[] } }): AgentSessionLike {
  const instanceTmp = fs.mkdtempSync(path.join(os.tmpdir(), "nest-session-"));
  fakeSessionTmps.push(instanceTmp);
  let subscriber: ((e: unknown) => void) | null = null;
  const promptMock = vi.fn(async () => {
    for (const e of opts.promptBehavior.events ?? []) {
      if (subscriber) subscriber(e);
    }
  });
  return {
    prompt: promptMock,
    steer: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(() => {}),
    subscribe: vi.fn((fn: (e: unknown) => void) => {
      subscriber = fn;
      return () => { subscriber = null; };
    }),
    sessionId: "fake-session-id",
    sessionManager: {
      getSessionFile: () => path.join(instanceTmp, "fake-session.jsonl"),
      getSessionId: () => "fake-session-id",
      appendCustomEntry: vi.fn(() => "custom-id"),
    },
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    getAllTools: () => [],
    setActiveToolsByName: vi.fn(),
  };
}

function makeFakeSdk(session: AgentSessionLike): SdkLike {
  return {
    DefaultResourceLoader: class { reload = vi.fn(async () => {}); },
    SessionManager: { inMemory: () => ({}), create: () => ({}) },
    createAgentSession: vi.fn(async () => ({ session })),
  };
}

function makeEmptyRegistry(): ModelRegistryLike {
  return { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true };
}

function makePi() {
  return { sendMessage: vi.fn(), appendEntry: vi.fn(), events: { emit: vi.fn() } };
}

interface SetupResult {
  service: SubagentService;
  agentDir: string;
}

function setup(session: AgentSessionLike): SetupResult {
  fakeSdkSlot.current = makeFakeSdk(session);
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "nest-it-"));
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
  return { service, agentDir };
}

const ctxModel: ModelInfo = { id: "m", name: "M", provider: "p", reasoning: false };

/** execCtxAls.run 的 duck-type（绕过 import AsyncLocalStorage，足够本组用例）。 */
interface ExecCtxAls {
  run: <T>(store: { recordId: string | undefined; depth: number }, cb: () => T) => T;
}

describe("嵌套护栏 / 并发池 / 节流（D-030~D-033 回归锁）", () => {
  let agentDirs: string[] = [];

  afterEach(() => {
    for (const d of agentDirs) fs.rmSync(d, { recursive: true, force: true });
    agentDirs = [];
    for (const d of fakeSessionTmps) fs.rmSync(d, { recursive: true, force: true });
    fakeSessionTmps.length = 0;
    fakeSdkSlot.current = null;
  });

  // ============================================================
  // D-032: sync 不进并发池
  // ============================================================

  it("[D-032] sync execute 不调 pool.acquire（不进并发池）", async () => {
    const session = makeFakeSession({
      promptBehavior: { kind: "resolve", events: [{ type: "turn_end" }, { type: "message_end" }] },
    });
    const { service, agentDir } = setup(session);
    agentDirs.push(agentDir);

    const pool = Reflect.get(service, "pool") as { acquire: Mock; release: Mock };
    const acquireSpy = vi.spyOn(pool, "acquire");

    await service.execute({ task: "sync no pool", wait: true, ctxModel });

    // 回退为 always-pooled 会死锁（maxConcurrent=4 → L5 卡死），此断言锁住 D-032
    expect(acquireSpy).not.toHaveBeenCalled();
  });

  it("[D-032] background execute 调 pool.acquire（仍进池限流）", async () => {
    const session = makeFakeSession({ promptBehavior: { kind: "resolve" } });
    const { service, agentDir } = setup(session);
    agentDirs.push(agentDir);

    const pool = Reflect.get(service, "pool") as { acquire: Mock; release: Mock };
    const acquireSpy = vi.spyOn(pool, "acquire");

    await service.execute({ task: "bg in pool", wait: false, ctxModel });
    // detached runAndFinalize → acquire
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(acquireSpy).toHaveBeenCalled();
  });

  // ============================================================
  // D-033: 通用嵌套护栏（execute 入口，execCtxAls 非 fork 路径）
  // ============================================================

  it("[D-033] execCtxAls depth=MAX 时 execute 抛错（nestingDepth=MAX+1 被拒）", async () => {
    const session = makeFakeSession({ promptBehavior: { kind: "resolve" } });
    const { service, agentDir } = setup(session);
    agentDirs.push(agentDir);

    const execCtxAls = Reflect.get(service, "execCtxAls") as ExecCtxAls;

    await expect(
      execCtxAls.run({ recordId: "parent", depth: MAX_FORK_DEPTH }, () =>
        service.execute({ task: "too deep", wait: true, ctxModel }),
      ),
    ).rejects.toThrow(/nesting depth/);

    // 无副作用：guard 在 createRecordForMode 之前，record 未创建
    expect(service.collectRecords(10)).toHaveLength(0);
  });

  it("[D-033] execCtxAls depth=MAX-1 时 execute 不抛（nestingDepth=MAX 允许）", async () => {
    const session = makeFakeSession({
      promptBehavior: { kind: "resolve", events: [{ type: "turn_end" }, { type: "message_end" }] },
    });
    const { service, agentDir } = setup(session);
    agentDirs.push(agentDir);

    const execCtxAls = Reflect.get(service, "execCtxAls") as ExecCtxAls;

    const result = await execCtxAls.run({ recordId: "parent", depth: MAX_FORK_DEPTH - 1 }, () =>
      service.execute({ task: "at limit", wait: true, ctxModel }),
    );

    expect(result.mode).toBe("sync");
  });

  // ============================================================
  // 嵌套 sync onUpdate 抑制（nestingDepth>0 → onUpdate undefined）
  // ============================================================

  it("[嵌套抑制] 嵌套 sync（execCtxAls depth>0）不回流 onUpdate", async () => {
    const session = makeFakeSession({
      promptBehavior: {
        kind: "resolve",
        events: [
          { type: "tool_execution_start", toolCallId: "t1", toolName: "read" },
          { type: "tool_execution_end", toolCallId: "t1", toolName: "read" },
          { type: "message_end", message: { usage: { input: 1 } } },
        ],
      },
    });
    const { service, agentDir } = setup(session);
    agentDirs.push(agentDir);

    const execCtxAls = Reflect.get(service, "execCtxAls") as ExecCtxAls;

    const updates: unknown[] = [];
    await execCtxAls.run({ recordId: "parent", depth: 1 }, () =>
      service.execute({ task: "nested sync", wait: true, ctxModel, onUpdate: (d) => updates.push(d) }),
    );

    // tool_end 是 TRIGGERING_EVENT，但嵌套层 onUpdate 被抑制（undefined）→ 0 次
    expect(updates).toHaveLength(0);
  });

  // ============================================================
  // clearThrottle：sync 完成后 throttleState 清理
  // ============================================================

  it("[节流清理] sync 完成后 throttleState 无残留（clearThrottle 生效）", async () => {
    const session = makeFakeSession({
      promptBehavior: {
        kind: "resolve",
        events: [
          { type: "tool_execution_end", toolCallId: "t1", toolName: "read" },
          { type: "message_end", message: { usage: { input: 1 } } },
        ],
      },
    });
    const { service, agentDir } = setup(session);
    agentDirs.push(agentDir);

    await service.execute({ task: "throttle clear", wait: true, ctxModel, onUpdate: () => {} });

    // finalizeRecord → clearThrottle 清掉该 record 的节流 entry（防 Map 无限增长 + trailing 误发陈旧）
    const throttleState = Reflect.get(service, "throttleState") as Map<string, unknown>;
    expect(throttleState.size).toBe(0);
  });
});
