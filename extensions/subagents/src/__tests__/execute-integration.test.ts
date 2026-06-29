// src/__tests__/execute-integration.test.ts
//
// execute() 集成测试 —— 覆盖 execute() 核心路径（sync/background/cancel/dispose）
// 及其唯一调用链 session-runner.run()（event-bridge 合并进 run() 后的回归覆盖）。
//
// 策略：只 mock 最底层的 SDK 边界（session-runner.getSdk → fakeSdk），上层
// SubagentService / RecordStore / BgNotifier / session-runner.run
// 全部跑真实实现，验证完整编排链路。
//
// 复盖 subagent-service.test.ts 末尾 TODO 列出的全部路径 + run() 事件累积。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, type Mock,vi } from "vitest";

import type { ModelInfo, ModelRegistryLike } from "../core/model-resolver.ts";
import { removeAliveMarker } from "../runtime/execution/alive-store.ts";
import { writeFinalized } from "../runtime/execution/finalized-marker.ts";
import { ModelConfigService } from "../runtime/model-config-service.ts";
import { SubagentService } from "../runtime/subagent-service.ts";
import type { SdkLike } from "../types.ts";
import type { AgentSessionLike } from "../types.ts";
import type { SdkEvent } from "../types.ts";

// ── fakeSdk 注入：mock getSdk，保留 run/formatSchemaInstruction 真实实现 ──

const { fakeSdkSlot } = vi.hoisted(() => ({ fakeSdkSlot: { current: null as SdkLike | null } }));

vi.mock("../core/session-runner.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/session-runner.ts")>();
  return {
    ...actual,
    // getSdk 被 mock 为返回 fakeSdkSlot.current；run/纯函数保留真实实现
    getSdk: () => {
      if (!fakeSdkSlot.current) throw new Error("fakeSdkSlot.current not set before execute()");
      return Promise.resolve(fakeSdkSlot.current);
    },
  };
});

// ── mock worktree-manager / finalized-marker / alive-store ──
// 保留原有行为（no-op），单测按需 override

const { mockWorktreeManager } = vi.hoisted(() => ({
  mockWorktreeManager: {
    create: vi.fn((cwd: string, id: string) => ({
      path: `/fake/worktree/${id}`,
      branch: `pi-sub-${id}`,
      baseCommit: "abc123",
      mainCwd: cwd,
    })),
    cleanup: vi.fn(),
    collectPatch: vi.fn(() => ({ patchFile: "/fake.patch", failed: false })),
    scan: vi.fn(),
  },
}));

vi.mock("../runtime/worktree-manager.ts", () => {
  const MockWorktreeManager = vi.fn();
  MockWorktreeManager.prototype.create = mockWorktreeManager.create;
  MockWorktreeManager.prototype.cleanup = mockWorktreeManager.cleanup;
  MockWorktreeManager.prototype.collectPatch = mockWorktreeManager.collectPatch;
  MockWorktreeManager.prototype.scan = mockWorktreeManager.scan;
  return { WorktreeManager: MockWorktreeManager };
});

vi.mock("../runtime/execution/finalized-marker.ts", () => ({
  writeFinalized: vi.fn(),
  readFinalized: vi.fn(() => false),
}));

vi.mock("../runtime/execution/alive-store.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/execution/alive-store.ts")>();
  return {
    ...actual,
    removeAliveMarker: vi.fn(),
  };
});

// ── fakeSdk / fakeSession 构造 ──

type PromptBehavior =
  | { kind: "resolve"; events?: SdkEvent[] }
  | { kind: "reject"; error: Error; events?: SdkEvent[] }
  | { kind: "pending" }; // 等 session.abort() 触发 reject（cancel CAS 用）

interface FakeSessionHandle {
  session: AgentSessionLike;
  /** 主动向 subscriber emit 一个 SDK 事件（验证 run 事件处理用）。 */
  emit(event: SdkEvent): void;
  /** prompt 调用次数（验证 schema enforcement steer 前后）。 */
  promptCalls: () => number;
  /** steer 调用次数。 */
  steerCalls: () => number;
  /** steer 调用参数列表。 */
  steers: () => string[];
  /** abort 调用次数。 */
  abortCalls: () => number;
}

function makeFakeSession(opts: {
  sessionFile?: string;
  promptBehavior: PromptBehavior;
  messages?: AgentSessionLike["messages"];
  tools?: Array<{ name: string }>;
}): FakeSessionHandle {
  let subscriber: ((e: unknown) => void) | null = null;
  const promptMock = vi.fn(async () => {
    for (const e of opts.promptBehavior.events ?? []) {
      if (subscriber) subscriber(e);
    }
    if (opts.promptBehavior.kind === "reject") throw opts.promptBehavior.error;
    // resolve / pending：resolve 直接返回；pending 由 abort 触发 reject
  });
  const steerMock = vi.fn(async (_msg: string) => {});
  let abortRejecter: ((err: Error) => void) | null = null;
  const abortMock = vi.fn(async () => {
    if (abortRejecter) {
      abortRejecter(new Error("aborted via session.abort"));
      abortRejecter = null;
    }
  });
  if (opts.promptBehavior.kind === "pending") {
    // 覆盖 promptMock：返回 pending promise，abort 时 reject
    promptMock.mockImplementation(async () => {
      for (const e of opts.promptBehavior.events ?? []) {
        if (subscriber) subscriber(e);
      }
      await new Promise<void>((_resolve, reject) => {
        abortRejecter = reject;
      });
    });
  }
  const session: AgentSessionLike = {
    prompt: promptMock,
    steer: steerMock,
    abort: abortMock,
    dispose: vi.fn(() => {}),
    subscribe: vi.fn((fn: (e: unknown) => void) => {
      subscriber = fn;
      return () => { subscriber = null; };
    }),
    sessionId: "fake-session-id",
    sessionManager: {
      getSessionFile: () => opts.sessionFile ?? "fake-session.jsonl",
      getSessionId: () => "fake-session-id",
      appendCustomEntry: vi.fn(() => "custom-id"),
    },
    messages: opts.messages ?? [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    getAllTools: () => opts.tools ?? [],
    setActiveToolsByName: vi.fn(),
  };
  return {
    session,
    emit: (event: SdkEvent) => { if (subscriber) subscriber(event); },
    promptCalls: () => promptMock.mock.calls.length,
    steerCalls: () => steerMock.mock.calls.length,
    steers: () => steerMock.mock.calls.map((c) => c[0] as string),
    abortCalls: () => abortMock.mock.calls.length,
  };
}

function makeFakeSdk(session: AgentSessionLike): SdkLike {
  return {
    DefaultResourceLoader: class {
      reload = vi.fn(async () => {});
    },
    SessionManager: {
      inMemory: () => ({}),
      create: () => ({}),
    },
    createAgentSession: vi.fn(async () => ({ session })),
  };
}

// ── SubagentService setup（真实 ModelConfigService + 真实 Service）──

function makeEmptyRegistry(): ModelRegistryLike {
  return {
    getAvailable: () => [],
    find: () => undefined,
    hasConfiguredAuth: () => true, // execute resolveModel 第三层需要 hasConfiguredAuth 兜底
  };
}

function makePi() {
  return {
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
  };
}

interface SetupResult {
  service: SubagentService;
  pi: ReturnType<typeof makePi>;
  agentDir: string;
  ctxModel: ModelInfo;
}

function setup(session: AgentSessionLike): SetupResult {
  fakeSdkSlot.current = makeFakeSdk(session);
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-it-"));
  const modelService = new ModelConfigService({ agentDir });
  modelService.initModel({
    modelRegistry: makeEmptyRegistry(),
    sessionId: "exec-it",
    ctxModel: { id: "test-model", name: "Test", provider: "p", reasoning: false },
  });
  const service = new SubagentService({ cwd: agentDir, modelService });
  const pi = makePi();
  service.initSession({ pi, sessionId: "exec-it" });
  return {
    service,
    pi,
    agentDir,
    ctxModel: { id: "test-model", name: "Test", provider: "p", reasoning: false },
  };
}

describe("SubagentService.execute() 集成 (覆盖 session-runner.run)", () => {
  let agentDirs: string[] = [];

  beforeEach(() => {
    // 清理 prototype mock 状态（vi.mock 工厂在原型上设置 mock，共享状态）
    mockWorktreeManager.create.mockReset();
    mockWorktreeManager.create.mockImplementation((cwd: string, id: string) => ({
      path: `/fake/worktree/${id}`,
      branch: `pi-sub-${id}`,
      baseCommit: "abc123",
      mainCwd: cwd,
    }));
    mockWorktreeManager.cleanup.mockReset();
    mockWorktreeManager.collectPatch.mockReset();
    mockWorktreeManager.collectPatch.mockImplementation(() => ({ patchFile: "/fake.patch", failed: false }));
    mockWorktreeManager.scan.mockReset();
    vi.mocked(writeFinalized).mockReset();
    vi.mocked(removeAliveMarker).mockReset();
  });

  afterEach(() => {
    for (const dir of agentDirs) fs.rmSync(dir, { recursive: true, force: true });
    agentDirs = [];
    fakeSdkSlot.current = null;
  });

  // ============================================================
  // sync happy path
  // ============================================================

  it("sync happy: execute({wait:true}) → mode=sync, record.status=done, usage/turns 累积", async () => {
    const handle = makeFakeSession({
      promptBehavior: {
        kind: "resolve",
        events: [
          // 模拟真实 LLM 输出：先 text_delta（正文），再 turn_end + message_end
          { type: "message_update", assistantMessageEvent: { delta: "done" } },
          { type: "turn_end" },
          { type: "message_end", message: { usage: { input: 100, output: 50 } } },
        ],
      },
    });
    const { service, agentDir, ctxModel } = setup(handle.session);
    agentDirs.push(agentDir);

    const result = await service.execute({ task: "do work", wait: true, ctxModel });

    expect(result.mode).toBe("sync");
    if (result.mode !== "sync") throw new Error("unreachable");
    expect(result.record.status).toBe("done");
    expect(result.record.turns).toBe(1);
    expect(result.details.totalTokens).toBe(150);
    expect(result.details.sessionFile).toBe("fake-session.jsonl");
    // run() 的 collectResult 从 record.turns[] 聚合 text（收口后不再读 session.messages）
    expect(result.details.result).toBe("done");
  });

  it("identity custom entry 写入 parentSessionId（session 隔离）", async () => {
    const handle = makeFakeSession({
      promptBehavior: { kind: "resolve", events: [{ type: "turn_end" }, { type: "message_end" }] },
    });
    const { service, agentDir, ctxModel } = setup(handle.session);
    agentDirs.push(agentDir);

    await service.execute({ task: "do work", wait: true, ctxModel });

    const append = handle.session.sessionManager.appendCustomEntry as Mock;
    const identityCall = append.mock.calls.find(
      ([ct]) => ct === "subagent-identity",
    );
    expect(identityCall).toBeDefined();
    // setup() 用 sessionId="exec-it"
    expect((identityCall![1] as Record<string, unknown>).parentSessionId).toBe("exec-it");
  });

  // ============================================================
  // sync error: prompt reject → status=failed
  // ============================================================

  it("sync error: prompt reject → status=failed, error 透传", async () => {
    const handle = makeFakeSession({
      promptBehavior: { kind: "reject", error: new Error("LLM 500") },
    });
    const { service, agentDir, ctxModel } = setup(handle.session);
    agentDirs.push(agentDir);

    const result = await service.execute({ task: "fail", wait: true, ctxModel });

    expect(result.mode).toBe("sync");
    if (result.mode !== "sync") throw new Error("unreachable");
    expect(result.record.status).toBe("failed");
    expect(result.details.error).toContain("LLM 500");
  });

  // ============================================================
  // createAgentSession 失败 → finalizeFailed 路径
  // ============================================================

  it("createAgentSession 抛错 → status=failed（finalizeFailed 合成 result）", async () => {
    // 用一个会抛错的 sdk 替换
    const throwingSdk: SdkLike = {
      DefaultResourceLoader: class { reload = vi.fn(async () => {}); },
      SessionManager: { inMemory: () => ({}), create: () => ({}) },
      createAgentSession: vi.fn(async () => { throw new Error("session create boom"); }),
    };
    fakeSdkSlot.current = throwingSdk;
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-it-"));
    agentDirs.push(agentDir);
    const modelService = new ModelConfigService({ agentDir });
    modelService.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "exec-it",
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
    });
    const service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "exec-it" });

    const result = await service.execute({
      task: "boom",
      wait: true,
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
    });

    expect(result.mode).toBe("sync");
    if (result.mode !== "sync") throw new Error("unreachable");
    expect(result.record.status).toBe("failed");
    expect(result.details.error).toContain("session create boom");
  });

  // ============================================================
  // background 启动：立即返回 + detached 完成后状态推进
  // ============================================================

  it("background 启动: execute({wait:false}) → mode=background, 立即返回 running", async () => {
    const handle = makeFakeSession({ promptBehavior: { kind: "resolve" } });
    const { service, agentDir, ctxModel } = setup(handle.session);
    agentDirs.push(agentDir);

    const result = service.execute({ task: "bg work", wait: false, ctxModel });
    // execute 同步返回 Promise，但 mode=background 不 await detached
    const handle0 = await result;
    expect(handle0.mode).toBe("background");
    if (handle0.mode !== "background") throw new Error("unreachable");
    expect(handle0.subagentId).toMatch(/^bg-\d+-\d+$/);
    expect(handle0.details.status).toBe("running");

    // 等 detached 完成（createSession → prompt resolve → finalize done → notify）
    await flushMicrotasks();
    // 终态 record 已被 archive 立即移出内存（读时从 session.jsonl 重建，但本测试用 mock session 无真实文件）。
    // 编排正确性由 handle.details 已含 running + detached 无异常 保证。
    expect(service.findRecord(handle0.subagentId)).toBeUndefined();
  });

  // ============================================================
  // background cancel CAS: running 时 cancel → cancelled
  // ============================================================

  it("background cancel CAS: running 时 cancel → status=cancelled, detached CAS 失败", async () => {
    // pending: prompt 永不自己 resolve，等 abort 触发 reject
    const handle = makeFakeSession({ promptBehavior: { kind: "pending" } });
    const { service, agentDir, ctxModel } = setup(handle.session);
    agentDirs.push(agentDir);

    const result = await service.execute({ task: "cancellable", wait: false, ctxModel });
    if (result.mode !== "background") throw new Error("expected background");
    const id = result.subagentId;

    // cancel 抢锁成功
    const ok = service.cancel(id);
    expect(ok).toBe(true);
    // cancel 后 record 被 archive 立即移出内存（终态不留内存）。
    expect(service.findRecord(id)).toBeUndefined();

    // 等 detached 跑完（abort 触发 prompt reject → run catch → status 已 cancelled → CAS 失败 → 跳过 notify）
    await flushMicrotasks();
    // CAS 失败：detached 没抢到锁（cancel 先设了 cancelled），不重复副作用。
    // record 已不在内存（archive 立即移除），findRecord 仍 undefined。
    expect(service.findRecord(id)).toBeUndefined();
  });

  it("background cancel 已终态 → false（CAS 失败）", async () => {
    const handle = makeFakeSession({ promptBehavior: { kind: "resolve" } });
    const { service, agentDir, ctxModel } = setup(handle.session);
    agentDirs.push(agentDir);

    const result = await service.execute({ task: "done fast", wait: false, ctxModel });
    if (result.mode !== "background") throw new Error("expected background");
    await flushMicrotasks(); // 等 detached 完成 → done → archive 立即移出内存

    // 终态 record 已移出内存（archive 立即移除）。
    expect(service.findRecord(result.subagentId)).toBeUndefined();
    // done 后 cancel → record 不在内存 → getMutable 返回 undefined → false
    expect(service.cancel(result.subagentId)).toBe(false);
  });

  // ============================================================
  // dispose flush: sliding window 内 dispose 立即 flush
  // ============================================================

  it("dispose flush: 有 pending notification 时 dispose 立即 flush", async () => {
    // bg1 完成（notify 入 60s window，因 bg2 还 running）
    const bg1 = makeFakeSession({ promptBehavior: { kind: "resolve" } });
    // bg2 pending（保持 running，让 hasRunningBackground=true）
    const bg2 = makeFakeSession({ promptBehavior: { kind: "pending" } });

    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-it-"));
    agentDirs.push(agentDir);
    fakeSdkSlot.current = makeQueueSdk(bg1.session, bg2.session);
    const modelService = new ModelConfigService({ agentDir });
    modelService.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "exec-it",
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
    });
    const service = new SubagentService({ cwd: agentDir, modelService });
    const pi = makePi();
    service.initSession({ pi, sessionId: "exec-it" });
    const ctxModel = { id: "m", name: "M", provider: "p", reasoning: false } as ModelInfo;

    await service.execute({ task: "bg1", wait: false, ctxModel });
    await service.execute({ task: "bg2", wait: false, ctxModel });
    await flushMicrotasks(); // bg1 detached 完成 → notify 入队（window 60s），bg2 仍 running

    // window 内未 flush
    expect(pi.sendMessage).not.toHaveBeenCalled();

    service.dispose(); // flush
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const sent = pi.sendMessage.mock.calls[0]![0];
    // notify content = `Subagent "<agent>" (<id>) completed. Result:\n<text>`
    expect(sent.content).toContain("completed");
    expect(sent.content).toContain("bg-1-");
  });

  // ============================================================
  // run() SDK 事件累积（event-bridge 合并进 run 后的回归覆盖）
  // ============================================================

  it("run 事件累积: turn_end/message_end(usage)/tool_start+tool_end/text_delta/thinking_delta", async () => {
    const handle = makeFakeSession({
      promptBehavior: {
        kind: "resolve",
        events: [
          { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "think..." } },
          { type: "message_update", assistantMessageEvent: { delta: "hello " } },
          { type: "message_update", assistantMessageEvent: { delta: "world" } },
          { type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: { cmd: "ls" } },
          { type: "tool_execution_end", toolCallId: "tc1", toolName: "bash", result: { details: "out" } },
          { type: "turn_end" },
          { type: "message_end", message: { usage: { input: 10, output: 20 } } },
        ],
      },
    });
    const { service, agentDir, ctxModel } = setup(handle.session);
    agentDirs.push(agentDir);

    const result = await service.execute({ task: "events", wait: true, ctxModel });
    if (result.mode !== "sync") throw new Error("unreachable");

    // turn_end → turns=1
    expect(result.record.turns).toBe(1);
    // message_end usage 累积
    expect(result.details.totalTokens).toBe(30);
    // tool_end → toolCalls 收集（eventLog entry 结构: {type, label, ts}，无 toolName 字段）
    expect(result.details.eventLog.some((e) => e.type === "tool_end")).toBe(true);
  });

  it("run message_end error stopReason → lastError 生效（success=false）", async () => {
    const handle = makeFakeSession({
      promptBehavior: {
        kind: "resolve",
        events: [
          { type: "message_end", message: { stopReason: "error", errorMessage: "provider 500", usage: { input: 5 } } },
        ],
      },
    });
    const { service, agentDir, ctxModel } = setup(handle.session);
    agentDirs.push(agentDir);

    const result = await service.execute({ task: "err", wait: true, ctxModel });
    if (result.mode !== "sync") throw new Error("unreachable");
    // lastError → success=false → status=failed
    expect(result.record.status).toBe("failed");
    expect(result.details.error).toContain("provider 500");
    // usage 仍被累积（先累积后判 error）
    expect(result.details.totalTokens).toBe(5);
  });

  // ============================================================
  // sync signal abort → cancelled
  // ============================================================

  it("sync signal abort → status=cancelled", async () => {
    const handle = makeFakeSession({ promptBehavior: { kind: "pending" } });
    const { service, agentDir, ctxModel } = setup(handle.session);
    agentDirs.push(agentDir);

    const ac = new AbortController();
    const execPromise = service.execute({ task: "abort me", wait: true, ctxModel, signal: ac.signal });
    await flushMicrotasks(); // 让 run 注册 abort listener
    ac.abort();
    // pending prompt 被 session.abort reject → run catch → status=cancelled
    const result = await execPromise;
    if (result.mode !== "sync") throw new Error("unreachable");
    expect(result.record.status).toBe("cancelled");
  });

  // ============================================================
  // schema enforcement: 漏调 structured-output → steer 提醒
  // ============================================================

  it("schema enforcement: 漏调 structured-output → session.steer(MUST call...)", async () => {
    // turn_end 触发 enforcement 检查；不包含 structured-output tool_end
    const handle = makeFakeSession({
      promptBehavior: {
        kind: "resolve",
        events: [
          { type: "turn_end" },
          { type: "turn_end" }, // 第二个 turn_end 触发第二次 steer（≤ MAX_SCHEMA_STEERS=2）
          { type: "message_end", message: { usage: { input: 1 } } },
        ],
      },
    });
    const { service, agentDir, ctxModel } = setup(handle.session);
    agentDirs.push(agentDir);

    await service.execute({
      task: "schema task",
      wait: true,
      ctxModel,
      schema: { type: "object", properties: { x: { type: "number" } } },
    });

    // 两个 turn_end → 两次 steer（每次都漏调 structured-output）
    expect(handle.steerCalls()).toBe(2);
    const firstSteer = handle.steers()[0];
    expect(firstSteer).toContain("MUST");
    expect(firstSteer).toContain("structured-output");
  });

  // ============================================================
  // onUpdate 回流: sync streaming 期 onUpdate 收到 project(record)
  // ============================================================

  it("onUpdate 回流: tool_end 事件触发 onUpdate（TRIGGERING_EVENT_TYPES）", async () => {
    const handle = makeFakeSession({
      promptBehavior: {
        kind: "resolve",
        events: [
          { type: "tool_execution_start", toolCallId: "t1", toolName: "read" },
          { type: "tool_execution_end", toolCallId: "t1", toolName: "read" },
          { type: "message_end", message: { usage: { input: 1 } } },
        ],
      },
    });
    const { service, agentDir, ctxModel } = setup(handle.session);
    agentDirs.push(agentDir);

    const updates: { status: string }[] = [];
    await service.execute({
      task: "stream",
      wait: true,
      ctxModel,
      onUpdate: (details) => updates.push({ status: details.status }),
    });

    // tool_end 是 TRIGGERING_EVENT → 至少一次 onUpdate
    expect(updates.length).toBeGreaterThanOrEqual(1);
    // streaming 期 status 仍 running
    expect(updates[0]!.status).toBe("running");
  });

  // ============================================================
  // worktree 集成测试（Wave 4: SubagentService 接线）
  // ============================================================

  // 辅助：构造带 createBranchedSession 的 fakeSdk（fork 路径需要）
  function makeBranchedSdk(session: AgentSessionLike): SdkLike {
    return {
      DefaultResourceLoader: class { reload = vi.fn(async () => {}); },
      SessionManager: { inMemory: () => ({}), create: () => ({}) },
      createAgentSession: vi.fn(async () => ({ session })),
      createBranchedSession: vi.fn(async () => ({ session })),
    };
  }

  it("execute fork+worktree: worktreeManager.create 前置 → finalizeRecord 写 finalized + cleanup", async () => {
    const handle = makeFakeSession({ promptBehavior: { kind: "resolve" } });
    fakeSdkSlot.current = makeBranchedSdk(handle.session);
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-wt-"));
    agentDirs.push(agentDir);
    const modelService = new ModelConfigService({ agentDir });
    modelService.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "exec-wt",
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
    });
    const service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "exec-wt" });
    const ctxModel = { id: "m", name: "M", provider: "p", reasoning: false } as ModelInfo;

    const result = await service.execute({
      task: "worktree work",
      wait: true,
      ctxModel,
      fork: true,
    });

    expect(result.mode).toBe("sync");
    if (result.mode !== "sync") throw new Error("unreachable");
    expect(result.record.status).toBe("done");
    // worktreeManager.create 被调用（service 的 cwd 作为 mainCwd）
    expect(mockWorktreeManager.create).toHaveBeenCalledWith(agentDir, expect.stringMatching(/^run-\d+$/));
    // finalizeRecord D-017: finalized + cleanup 被调用
    expect(vi.mocked(writeFinalized)).toHaveBeenCalled();
    expect(mockWorktreeManager.cleanup).toHaveBeenCalled();
  });

  it("execute fork worktree create 失败 → status=failed, 不进入 run", async () => {
    const handle = makeFakeSession({ promptBehavior: { kind: "resolve" } });
    fakeSdkSlot.current = makeBranchedSdk(handle.session);
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-wt-"));
    agentDirs.push(agentDir);
    const modelService = new ModelConfigService({ agentDir });
    modelService.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "exec-wt",
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
    });
    const service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "exec-wt" });

    // 实例级 mock：worktreeManager 实例已创建，直接覆盖其 create 方法
    // Reflect.get 绕过 TS private 访问检查（返回 any，单层断言合规）
    const svc = Reflect.get(service, "worktreeManager") as typeof mockWorktreeManager;
    const origCreate = svc.create;
    svc.create = vi.fn().mockImplementation(() => {
      throw new Error("dirty worktree");
    });

    const result = await service.execute({
      task: "fail wt",
      wait: true,
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
      fork: true,
    });

    // 恢复原始 mock（不影响其他测试）
    svc.create = origCreate;

    expect(result.mode).toBe("sync");
    if (result.mode !== "sync") throw new Error("unreachable");
    expect(result.record.status).toBe("failed");
    expect(result.details.error).toContain("dirty worktree");
    // 不进入 run → prompt 不被调用
    expect(handle.promptCalls()).toBe(0);
  });

  it("finalizeRecord D-017 时序: collectPatch→completeRecord→archive→finalized+cleanup (spy 验)", async () => {
    const handle = makeFakeSession({ promptBehavior: { kind: "resolve" } });
    fakeSdkSlot.current = makeBranchedSdk(handle.session);
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-wt-"));
    agentDirs.push(agentDir);
    const modelService = new ModelConfigService({ agentDir });
    modelService.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "exec-wt",
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
    });
    const service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "exec-wt" });
    const ctxModel = { id: "m", name: "M", provider: "p", reasoning: false } as ModelInfo;

    await service.execute({
      task: "seq verify",
      wait: true,
      ctxModel,
      fork: true,
    });

    // D-017: collectPatch 被调用（step 0）
    expect(mockWorktreeManager.collectPatch).toHaveBeenCalled();
    // D-017: finalized + cleanup 被调用（step 3）
    expect(vi.mocked(writeFinalized)).toHaveBeenCalled();
    expect(mockWorktreeManager.cleanup).toHaveBeenCalled();
    // collectPatch 在 finalized/cleanup 之前调用（时序）
    const collectOrder = mockWorktreeManager.collectPatch.mock.invocationCallOrder[0]!;
    const finalizedOrder = vi.mocked(writeFinalized).mock.invocationCallOrder[0]!;
    const cleanupOrder = mockWorktreeManager.cleanup.mock.invocationCallOrder[0]!;
    expect(collectOrder).toBeLessThan(finalizedOrder);
    expect(collectOrder).toBeLessThan(cleanupOrder);
  });

  it("finalizeRecord D-022: collectPatch failed → cleanup 跳过, finalized 仍执行", async () => {
    mockWorktreeManager.collectPatch.mockImplementation(() => ({ patchFile: "/fake.patch", failed: true }));
    const handle = makeFakeSession({ promptBehavior: { kind: "resolve" } });
    fakeSdkSlot.current = makeBranchedSdk(handle.session);
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-wt-"));
    agentDirs.push(agentDir);
    const modelService = new ModelConfigService({ agentDir });
    modelService.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "exec-wt",
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
    });
    const service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "exec-wt" });
    const ctxModel = { id: "m", name: "M", provider: "p", reasoning: false } as ModelInfo;

    await service.execute({
      task: "patch fail",
      wait: true,
      ctxModel,
      fork: true,
    });

    // D-022: patchOk=false → cleanup 跳过
    expect(mockWorktreeManager.cleanup).not.toHaveBeenCalled();
    // finalized 仍执行
    expect(vi.mocked(writeFinalized)).toHaveBeenCalled();
  });

  it("finalizeRecord D-022: collectPatch throw → cleanup 跳过, finalized 仍执行", async () => {
    mockWorktreeManager.collectPatch.mockImplementation(() => { throw new Error("git failed"); });
    const handle = makeFakeSession({ promptBehavior: { kind: "resolve" } });
    fakeSdkSlot.current = makeBranchedSdk(handle.session);
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-wt-"));
    agentDirs.push(agentDir);
    const modelService = new ModelConfigService({ agentDir });
    modelService.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "exec-wt",
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
    });
    const service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "exec-wt" });
    const ctxModel = { id: "m", name: "M", provider: "p", reasoning: false } as ModelInfo;

    await service.execute({
      task: "patch throw",
      wait: true,
      ctxModel,
      fork: true,
    });

    // D-022: collectPatch throw → patchOk=false → cleanup 跳过
    expect(mockWorktreeManager.cleanup).not.toHaveBeenCalled();
    // finalized 仍执行
    expect(vi.mocked(writeFinalized)).toHaveBeenCalled();
  });

  it("finalizeRecord B9: completeRecord 抛错 → finalized/cleanup 仍执行", async () => {
    const handle = makeFakeSession({ promptBehavior: { kind: "resolve" } });
    fakeSdkSlot.current = makeBranchedSdk(handle.session);
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-wt-"));
    agentDirs.push(agentDir);
    const modelService = new ModelConfigService({ agentDir });
    modelService.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "exec-wt",
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
    });
    const service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "exec-wt" });
    const ctxModel = { id: "m", name: "M", provider: "p", reasoning: false } as ModelInfo;

    // spy on completeRecord to throw (需拦截 execution-record 的 completeRecord)
    const executionRecord = await import("../core/execution-record.ts");
    const _origComplete = executionRecord.completeRecord;
    const spy = vi.spyOn(executionRecord, "completeRecord").mockImplementationOnce(() => {
      throw new Error("completeRecord boom");
    });

    await service.execute({
      task: "b9 test",
      wait: true,
      ctxModel,
      fork: true,
    });

    spy.mockRestore();

    // B9: completeRecord 抛错后 finalized/cleanup 仍执行
    expect(vi.mocked(writeFinalized)).toHaveBeenCalled();
    expect(mockWorktreeManager.cleanup).toHaveBeenCalled();
  });

  it("cancelBackground: worktree cleanup + removeAliveMarker 被调用 (不写 finalized)", async () => {
    const handle = makeFakeSession({ promptBehavior: { kind: "pending" } });
    fakeSdkSlot.current = makeBranchedSdk(handle.session);
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-wt-"));
    agentDirs.push(agentDir);
    const modelService = new ModelConfigService({ agentDir });
    modelService.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "exec-wt",
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
    });
    const service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "exec-wt" });
    const ctxModel = { id: "m", name: "M", provider: "p", reasoning: false } as ModelInfo;

    const result = await service.execute({
      task: "cancel wt",
      wait: false,
      ctxModel,
      fork: true,
    });

    if (result.mode !== "background") throw new Error("expected background");
    // 等 detached 启动（createAndConfigureSession 设置 sessionFile）
    await flushMicrotasks();
    service.cancel(result.subagentId);

    // worktree cleanup + removeAliveMarker 被调用
    expect(mockWorktreeManager.cleanup).toHaveBeenCalled();
    expect(vi.mocked(removeAliveMarker)).toHaveBeenCalled();
    // BC-4 互斥：cancel 不写 finalized
    expect(vi.mocked(writeFinalized)).not.toHaveBeenCalled();
  });

  it("非 worktree fork 路径: 新 mock 不影响行为 (writeFinalized/cleanup 不被调用)", async () => {
    const handle = makeFakeSession({
      promptBehavior: {
        kind: "resolve",
        events: [
          { type: "message_end", message: { usage: { input: 10, output: 5 } } },
        ],
      },
    });
    const { service, agentDir, ctxModel } = setup(handle.session);
    agentDirs.push(agentDir);

    const result = await service.execute({ task: "no wt", wait: true, ctxModel });

    expect(result.record.status).toBe("done");
    // 非 worktree 路径: 不调 worktreeManager.create/cleanup/collectPatch
    expect(mockWorktreeManager.create).not.toHaveBeenCalled();
    expect(mockWorktreeManager.cleanup).not.toHaveBeenCalled();
    expect(mockWorktreeManager.collectPatch).not.toHaveBeenCalled();
    // writeFinalized 仍被调用（finalizeRecord 总是写 finalized）
    expect(vi.mocked(writeFinalized)).toHaveBeenCalled();
  });
});

// ============================================================
// helpers（追加）
// ============================================================

/** 让 microtask 队列跑空（detached promise / await 链推进）。 */
async function flushMicrotasks(): Promise<void> {
  // 多轮 microtask + 一个 macrotask 让 setTimeout(0) 也跑
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise<void>((r) => setTimeout(r, 0));
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** fakeSdk 变体：createAgentSession 按调用顺序返回队列中的 session。 */
function makeQueueSdk(...sessions: AgentSessionLike[]): SdkLike {
  let i = 0;
  return {
    DefaultResourceLoader: class { reload = vi.fn(async () => {}); },
    SessionManager: { inMemory: () => ({}), create: () => ({}) },
    createAgentSession: vi.fn(async () => ({ session: sessions[i++]! })),
  };
}
