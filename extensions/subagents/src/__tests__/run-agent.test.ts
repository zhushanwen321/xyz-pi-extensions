// src/__tests__/run-agent.test.ts
//
// runAgent 集成测试。覆盖核心编排路径（FR-1.1）：
//   1. 正常路径：model 解析 → createAndConfigureSession → prompt → AgentResult
//   2. 模型解析失败：外层 catch 返回 success=false，不抛异常
//   3. AbortSignal 已 aborted：session.abort 被触发
//   4. pool acquire/release 成对出现（成功 & 失败路径均释放）
//   5. bridge.lastError（I2 错误捕获）触发失败结果
//
// mock 策略：vi.mock("../core/session-factory.ts") 只替换 createAndConfigureSession
// 和 getSdk；保留 collectResult / formatSchemaInstruction 原实现（纯函数，依赖
// session/bridge 结构，与 mock 对象兼容）。其余依赖（model-resolver、turn-limiter、
// category、worktree）走真实实现，使编排逻辑得到端到端验证。

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CATEGORIES } from "../category.ts";
import { runAgent, type RunAgentContext } from "../core/run-agent.ts";
import {
  type AgentSessionLike,
  type BuiltSession,
  type EventBridge,
} from "../core/session-factory.ts";
import type {
  ConcurrencyPool,
  ModelInfo,
  SessionModelState,
  SubagentsGlobalConfig,
} from "../types.ts";

// ============================================================
// vi.mock: 仅替换 session-factory 的 createAndConfigureSession + getSdk
// ============================================================
const sessionFactoryMocks = vi.hoisted(() => ({
  createAndConfigureSession: vi.fn(),
  getSdk: vi.fn(),
}));

vi.mock("../core/session-factory.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/session-factory.ts")>();
  return {
    ...actual,
    createAndConfigureSession: sessionFactoryMocks.createAndConfigureSession,
    getSdk: sessionFactoryMocks.getSdk,
  };
});

// ============================================================
// mock 工厂
// ============================================================

const AVAILABLE_MODEL: ModelInfo = {
  id: "mimo-v2.5",
  name: "mimo-v2.5",
  provider: "mimo-router",
  reasoning: true,
  thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
};

/** ModelRegistryLike mock（duck-typed）。available=false 时模拟无可用模型。 */
function makeModelRegistry(opts: { available?: boolean } = {}) {
  const available = opts.available ?? true;
  return {
    find: vi.fn((_provider: string, _modelId: string) =>
      available ? AVAILABLE_MODEL : undefined),
    hasConfiguredAuth: vi.fn(() => available),
    getAvailable: vi.fn(() => (available ? [AVAILABLE_MODEL] : [])),
  };
}

/** MockSession：AgentSessionLike 的所有方法替换为 vi.fn，便于断言调用次数/参数 */
type MockSession = AgentSessionLike & {
  prompt: ReturnType<typeof vi.fn>;
  steer: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  getAllTools: ReturnType<typeof vi.fn>;
  setActiveToolsByName: ReturnType<typeof vi.fn>;
};

function makeMockSession(overrides: Partial<MockSession> = {}): MockSession {
  return {
    sessionId: "sess-123",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ],
    prompt: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(() => {}),
    subscribe: vi.fn((_fn: (event: unknown) => void) => () => {}),
    getAllTools: vi.fn(() => []),
    setActiveToolsByName: vi.fn(() => {}),
    ...overrides,
  } as never;
}

/** EventBridge mock：满足 collectResult 读取的 toolCalls/usage/turnCount + runAgent 读取的 lastError */
function makeMockBridge(overrides: Partial<EventBridge> = {}): EventBridge {
  return {
    handle: vi.fn(),
    resetForPrompt: vi.fn(),
    turnCount: 1,
    toolCalls: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    lastError: undefined,
    ...overrides,
  } as never;
}

/** ConcurrencyPool mock，acquire/release 都是 vi.fn */
type MockPool = ConcurrencyPool & {
  acquire: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
};

function makeMockPool(): MockPool {
  return {
    acquire: vi.fn(async () => {}),
    release: vi.fn(() => {}),
    activeCount: 0,
    queueLength: 0,
    maxConcurrent: 4,
  } as MockPool;
}

const globalConfig: SubagentsGlobalConfig = {
  version: 1,
  yoloByDefault: false,
  maxConcurrent: 4,
  categories: { ...DEFAULT_CATEGORIES },
  agentCategoryOverrides: {},
  fallback: { model: "mimo-router/mimo-v2.5", thinkingLevel: "low" },
};

const sessionState: SessionModelState = {
  yoloMode: false,
  perAgent: {},
  perCategory: {},
};

function makeCtx(overrides: Partial<RunAgentContext> = {}): RunAgentContext {
  return {
    modelRegistry: makeModelRegistry() as never,
    resolveAgent: vi.fn(() => undefined),
    globalConfig,
    sessionState,
    globalPool: makeMockPool(),
    cwd: "/tmp",
    agentDir: "/tmp/.pi",
    ...overrides,
  } as RunAgentContext;
}

/** 配置 sessionFactoryMocks 让 createAndConfigureSession 返回指定 session/bridge */
function configureFactory(session: AgentSessionLike, bridge: EventBridge): void {
  sessionFactoryMocks.createAndConfigureSession.mockResolvedValue({
    session,
    bridge,
    unsubscribe: vi.fn(),
  } as BuiltSession);
  sessionFactoryMocks.getSdk.mockResolvedValue({} as never);
}

// ============================================================
// 测试用例
// ============================================================

describe("runAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认配置 factory 成功路径（个别测试会自行覆盖）
    configureFactory(makeMockSession(), makeMockBridge());
  });

  describe("正常路径", () => {
    it("model 解析成功 → session 创建 → prompt 成功 → 返回 success=true AgentResult", async () => {
      const session = makeMockSession();
      const bridge = makeMockBridge({ turnCount: 2 });
      configureFactory(session, bridge);
      const ctx = makeCtx();

      const result = await runAgent({ task: "do work" }, ctx);

      // AgentResult 字段
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.sessionId).toBe("sess-123");
      expect(result.turns).toBe(2);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.text).toBe("hello");
      expect(result.toolCalls).toEqual([]);
      // factory 调用
      expect(sessionFactoryMocks.createAndConfigureSession).toHaveBeenCalledOnce();
      expect(sessionFactoryMocks.getSdk).toHaveBeenCalledOnce();
      // session 生命周期：prompt 接收原始 task；dispose 在 finally 被调用
      expect(session.prompt).toHaveBeenCalledWith("do work");
      expect(session.dispose).toHaveBeenCalledOnce();
    });

    it("schema 拼入 task 末尾（含 MANDATORY: Structured Output Requirement）", async () => {
      const session = makeMockSession();
      configureFactory(session, makeMockBridge());

      await runAgent({ task: "extract data", schema: { type: "object" } }, makeCtx());

      const taskArg = session.prompt.mock.calls[0][0] as string;
      expect(taskArg).toContain("extract data");
      expect(taskArg).toContain("Structured Output Requirement");
    });

    it("pool.acquire 与 pool.release 成对出现（成功路径）", async () => {
      const ctx = makeCtx();
      const pool = ctx.globalPool as MockPool;

      await runAgent({ task: "work" }, ctx);

      expect(pool.acquire).toHaveBeenCalledOnce();
      expect(pool.release).toHaveBeenCalledOnce();
    });

    it("opts.pool 覆盖 ctx.globalPool（自定义并发池生效）", async () => {
      const customPool = makeMockPool();
      const ctx = makeCtx();

      await runAgent({ task: "work", pool: customPool }, ctx);

      expect(customPool.acquire).toHaveBeenCalledOnce();
      expect(customPool.release).toHaveBeenCalledOnce();
      // globalPool 不应被使用
      expect((ctx.globalPool as MockPool).acquire).not.toHaveBeenCalled();
      expect((ctx.globalPool as MockPool).release).not.toHaveBeenCalled();
    });
  });

  describe("模型解析失败", () => {
    it("modelRegistry 无可用模型 → 返回 success=false，不抛异常，pool.release 仍调用", async () => {
      const ctx = makeCtx({
        modelRegistry: makeModelRegistry({ available: false }) as never,
      });
      const pool = ctx.globalPool as MockPool;

      const result = await runAgent({ task: "do work" }, ctx);

      // 外层 catch 返回的结构化失败结果
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/No available model/);
      expect(result.turns).toBe(0);
      expect(result.sessionId).toBe("");
      expect(result.text).toBe("");
      expect(result.toolCalls).toEqual([]);
      // factory 未被调用（模型解析在它之前失败）
      expect(sessionFactoryMocks.createAndConfigureSession).not.toHaveBeenCalled();
      // pool 仍成对调用
      expect(pool.acquire).toHaveBeenCalledOnce();
      expect(pool.release).toHaveBeenCalledOnce();
    });

    it("hasConfiguredAuth=false 时同样降级到失败结果（find 命中但 auth 未配置）", async () => {
      // find 返回模型但 auth 未配置 → resolveModelForAgent 视为不可用
      const registry = {
        find: vi.fn(() => AVAILABLE_MODEL),
        hasConfiguredAuth: vi.fn(() => false),
        getAvailable: vi.fn(() => []),
      };
      const ctx = makeCtx({ modelRegistry: registry as never });

      const result = await runAgent({ task: "do work" }, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/No available model/);
    });
  });

  describe("AbortSignal 已 aborted", () => {
    it("signal.aborted=true → session.abort 被调用，prompt 失败 → success=false", async () => {
      const session = makeMockSession({
        prompt: vi.fn(async () => {
          throw new Error("aborted by signal");
        }),
      });
      configureFactory(session, makeMockBridge());
      const ctx = makeCtx();
      const pool = ctx.globalPool as MockPool;

      const result = await runAgent(
        { task: "do work", signal: AbortSignal.abort() },
        ctx,
      );

      expect(session.abort).toHaveBeenCalledOnce();
      expect(result.success).toBe(false);
      expect(result.error).toBe("aborted by signal");
      // session 仍被 dispose（finally 清理）
      expect(session.dispose).toHaveBeenCalledOnce();
      // pool 成对调用
      expect(pool.acquire).toHaveBeenCalledOnce();
      expect(pool.release).toHaveBeenCalledOnce();
    });

    it("signal 未 aborted，prompt 期间触发 abort → 注册的 listener 调用 session.abort", async () => {
      const controller = new AbortController();
      const session = makeMockSession({
        prompt: vi.fn(async () => {
          // 模拟 prompt 执行过程中外部触发 abort
          controller.abort();
        }),
      });
      configureFactory(session, makeMockBridge());

      await runAgent({ task: "do work", signal: controller.signal }, makeCtx());

      expect(session.abort).toHaveBeenCalledOnce();
    });
  });

  describe("createAndConfigureSession 抛异常", () => {
    it("factory 失败 → 外层 catch 兜底，pool.release 仍调用，prompt 未执行", async () => {
      sessionFactoryMocks.createAndConfigureSession.mockRejectedValue(
        new Error("session boom"),
      );
      sessionFactoryMocks.getSdk.mockResolvedValue({} as never);
      const ctx = makeCtx();
      const pool = ctx.globalPool as MockPool;

      const result = await runAgent({ task: "do work" }, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toBe("session boom");
      expect(result.sessionId).toBe("");
      expect(pool.acquire).toHaveBeenCalledOnce();
      expect(pool.release).toHaveBeenCalledOnce();
    });
  });

  describe("bridge.lastError（I2 错误捕获）", () => {
    it("prompt 成功但 bridge 捕获 message_end error → success=false + error=lastError", async () => {
      const session = makeMockSession();
      const bridge = makeMockBridge({ lastError: "rate limited" });
      configureFactory(session, bridge);

      const result = await runAgent({ task: "do work" }, makeCtx());

      // prompt 自身没抛异常，但 bridge 报告错误 → runAgent 视为失败
      expect(result.success).toBe(false);
      expect(result.error).toBe("rate limited");
    });
  });

  // ── V1：createWorktree 失败必须 throw，不能静默回退到 ctx.cwd ──────
  describe("V1: isolation:worktree 失败应 fail-loud", () => {
    it("非 git cwd + isolation:worktree → success=false + error 提及 worktree（不静默回退）", async () => {
      const agentConfig = { name: "worker", systemPrompt: "", source: "builtin" as const, isolation: "worktree" as const };
      const ctx = makeCtx({
        resolveAgent: vi.fn(() => agentConfig) as never,
        cwd: "/tmp", // 非 git 仓库 → createWorktree 返回 undefined
      });

      const result = await runAgent({ task: "do work", agent: "worker" }, ctx);

      // V1：不应静默回退到原地执行（那会污染用户工作区）
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/worktree/i);
      expect(result.error).toMatch(/polluting/i);
      // session factory 不应被调用（worktree 创建失败应在此之前中止）
      expect(sessionFactoryMocks.createAndConfigureSession).not.toHaveBeenCalled();
    });
  });

  // ── V3：createAndConfigureSession 抛错时 worktree 不应泄漏 ──────
  // 用真实 git 仓库（createWorktree 成功）+ mock factory 抛错，验证 worktree 被清理。
  describe("V3: worktree 不泄漏（createAndConfigureSession 抛错路径）", () => {
    let v3Repo: string;
    // P5: 独立的 worktree baseDir，避免与其它并行测试的 pi-agent-* 残留互相干扰。
    let v3Home: string;

    beforeEach(() => {
      v3Repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-v3-test-"));
      v3Home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-v3-home-"));
      // 初始化 git 仓库 + 一次提交（createWorktree 需要 HEAD）
      const CLEAN_ENV: NodeJS.ProcessEnv = (() => {
        const env: NodeJS.ProcessEnv = {};
        for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
        return env;
      })();
      const g = (args: string[]) => execFileSync("git", args, { cwd: v3Repo, stdio: "ignore", env: CLEAN_ENV });
      g(["init", "-q"]);
      g(["config", "user.email", "test@pi.test"]);
      g(["config", "user.name", "test"]);
      fs.writeFileSync(path.join(v3Repo, "init.txt"), "init\n");
      g(["add", "-A"]);
      g(["commit", "-q", "-m", "init"]);
    });

    afterEach(() => {
      // 兜底：清理可能的 worktree 残留 + 临时仓库 + 独立 home
      try {
        const CLEAN_ENV: NodeJS.ProcessEnv = (() => {
          const env: NodeJS.ProcessEnv = {};
          for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
          return env;
        })();
        execFileSync("git", ["-C", v3Repo, "worktree", "prune"], { stdio: "ignore", env: CLEAN_ENV });
      } catch { /* best effort */ }
      try { fs.rmSync(v3Repo, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(v3Home, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    it("factory 抛错 + isolation:worktree → worktree 被清理（不泄漏到 tmpdir）", async () => {
      // 让 factory 抛错（session 创建失败的高频路径）
      sessionFactoryMocks.createAndConfigureSession.mockRejectedValue(
        new Error("model unavailable"),
      );
      sessionFactoryMocks.getSdk.mockResolvedValue({} as never);

      const agentConfig = { name: "worker", systemPrompt: "", source: "builtin" as const, isolation: "worktree" as const };
      const ctx = makeCtx({
        resolveAgent: vi.fn(() => agentConfig) as never,
        cwd: v3Repo, // 真实 git 仓库 → createWorktree 成功
        homeDir: v3Home, // P5: 独立 home，worktree 创建在此目录下
      });

      // P5: v3Home 在测试开始时为空（刚 mkdtemp），baseline 必然为空集——
      // 无需对比前后快照，直接断言 runAgent 后 v3Home 无 pi-agent-* 残留。
      const result = await runAgent({ task: "do work", agent: "worker" }, ctx);

      // factory 抛错 → 失败结果
      expect(result.success).toBe(false);
      expect(result.error).toBe("model unavailable");

      // V3 核心：本次测试新建的 worktree 不应泄漏（v3Home 独立隔离，无并发干扰）。
      const leaked = fs.readdirSync(v3Home).filter((e) => e.startsWith("pi-agent-"));
      expect(leaked, `泄漏的 worktree 目录: ${leaked.join(", ")}`).toEqual([]);

      // git worktree 注册表也不应有残留
      const CLEAN_ENV: NodeJS.ProcessEnv = (() => {
        const env: NodeJS.ProcessEnv = {};
        for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
        return env;
      })();
      const wtList = execFileSync("git", ["-C", v3Repo, "worktree", "list"], {
        encoding: "utf-8", env: CLEAN_ENV,
      });
      expect(wtList).not.toMatch(/pi-agent-/);
    });
  });
});
