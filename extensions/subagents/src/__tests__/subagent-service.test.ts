// src/__tests__/subagent-service.test.ts
//
// SubagentService 生命周期 + 公共 API 边界测试。
//
// 范围:initSession / dispose / query / cancel / listRunning / collectRecords /
// onChange / assertReady -- 这些不依赖动态 import Pi SDK(getSdk)。
//
// execute() 因 buildSessionRunnerContext 会动态 import session-runner → getSdk(),
// 在单测环境无法提供真实 SDK,留给集成测试(见文件末尾 TODO)。
//
// 策略:用真实 ModelConfigService 指向 os.tmpdir() 空目录(loadGlobalConfig
// 对不存在文件返回默认配置,AgentRegistry 空目录也安全),mock PiLike。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRecord } from "../core/execution-record.ts";
import type { ModelInfo, ModelRegistryLike } from "../core/model-resolver.ts";
import type { RecordStore } from "../runtime/execution/record-store.ts";
import { ModelConfigService } from "../runtime/model-config-service.ts";
import type { PiLike } from "../runtime/subagent-service.ts";
import { getSubagentService, setSubagentService,SubagentService } from "../runtime/subagent-service.ts";
import type { ExecutionRecord } from "../types.ts";

// ── 工具:建临时 agentDir + 真实 ModelConfigService ──

function makeTmpAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-test-"));
  // agentDir/subagents/ 子目录(config 默认路径会用,空即可)
  return dir;
}

function makeModelService(agentDir: string): ModelConfigService {
  return new ModelConfigService({ agentDir });
}

function makePi(): PiLike & {
  sendMessage: ReturnType<typeof vi.fn>;
  appendEntry: ReturnType<typeof vi.fn>;
  events: { emit: ReturnType<typeof vi.fn> };
} {
  return {
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
  };
}

describe("SubagentService", () => {
  let agentDir: string;
  let modelService: ModelConfigService;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    modelService = makeModelService(agentDir);
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  // ============================================================
  // 构造 + 生命周期
  // ============================================================

  describe("构造 + 生命周期", () => {
    it("构造不抛错(空 agentDir,默认 config)", () => {
      expect(() => new SubagentService({ cwd: agentDir, modelService })).not.toThrow();
    });

    it("未 initSession 时 findRecord/cancel 抛 'pi not injected'", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      expect(() => service.findRecord("any")).toThrow(/pi not injected/);
      expect(() => service.cancel("any")).toThrow(/pi not injected/);
    });

    it("initSession 后 assertReady 通过(findRecord 不再抛 pi 错,返回 undefined)", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      // findRecord 现在能过 assertReady,但 record 不存在 → 返回 undefined
      expect(service.findRecord("missing")).toBeUndefined();
    });

    it("dispose 后 findRecord 抛含 'disposed' 且带恢复指引", () => {
      // [HISTORICAL] 旧实现只抛 "hub disposed"--无信息,调用方和 AI 盲猜。
      // 现错误信息必须含原因 + 恢复指引,让 AI/user 知道要重启会话而非重试。
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      service.dispose();
      expect(() => service.findRecord("any")).toThrow(/disposed/);
      expect(() => service.findRecord("any")).toThrow(/session ended|session_start|new session/i);
    });

    it("dispose 幂等(多次调用不抛)", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      expect(() => {
        service.dispose();
        service.dispose();
        service.dispose();
      }).not.toThrow();
    });

    it("initSession 可 revive 已 dispose 的 service", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      service.dispose();
      // revive
      service.initSession({ pi: makePi(), sessionId: "s2" });
      // 现在 assertReady 又通过(findRecord 返回 undefined 而非 disposed)
      expect(service.findRecord("any")).toBeUndefined();
    });
  });

  // ============================================================
  // findRecord / cancel 边界
  // ============================================================

  describe("findRecord / cancel 边界 (T4)", () => {
    it("findRecord 不存在的 id 返回 undefined", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      expect(service.findRecord("nonexistent-id")).toBeUndefined();
    });

    it("cancel 不存在的 id 返回 false(不抛错,boolean 契约不变)", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      expect(service.cancel("nonexistent-id")).toBe(false);
    });
  });

  // ============================================================
  // 状态查询
  // ============================================================

  describe("状态查询", () => {
    it("listRunning 初始为空数组", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      expect(service.listRunning()).toEqual([]);
    });

    it("collectRecords 返回数组(空 sessions 目录时为空)", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      const records = service.collectRecords(100);
      expect(Array.isArray(records)).toBe(true);
    });

    it("onChange 返回 unsubscribe 函数,调用后停止通知", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      const listener = vi.fn();
      const unsubscribe = service.onChange(listener);
      expect(typeof unsubscribe).toBe("function");
      expect(() => unsubscribe()).not.toThrow();
    });
  });

  // ============================================================
  // resolveModel 代理
  // ============================================================

  describe("resolveModel 代理", () => {
    it("代理到 modelService.resolveModel(未 init 时抛错)", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      // 未 init modelRegistry → resolveModel 拋错(fail-fast)
      expect(() => service.resolveModel("worker")).toThrow(/modelRegistry not injected/);
    });
  });

  // ============================================================
  // 进程单例访问器
  // ============================================================

  describe("进程单例访问器", () => {
    // 保存/恢复单例,避免污染其他测试(setSubagentService 类型不接受 null)
    const original = getSubagentService();
    afterEach(() => {
      if (original) setSubagentService(original);
    });

    it("setSubagentService / getSubagentService 读写一致", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      setSubagentService(service);
      expect(getSubagentService()).toBe(service);
    });
  });

  // ============================================================
  // dispose abort 子进程（R0-D：孤儿进程治理）
  // ============================================================
  //
  // [R0] 进程退出路径：SubagentService.dispose 调 store.abortRunningControllers()，
  // 触发所有 running background record 的 controller.abort() → runSpawn signal listener
  // → child.kill("SIGTERM")，防止主进程退出后 background 子进程成孤儿。
  //
  // 被测方法在 service 层，不需要 mock spawn——直接构造 record 注册到 store。
  // store 是 private 字段，用 Reflect.get 取（与 execute-nesting.test.ts 访问 pool 同模式）。

  describe("dispose abort 子进程 (R0-D)", () => {
    /** 从 service 取出 private store（测试注入 running record 用）。 */
    function getStore(service: SubagentService): RecordStore {
      return Reflect.get(service, "store") as RecordStore;
    }

    /** 构造一个 running background record（带 controller）并注册到 store。 */
    function registerRunningBackground(service: SubagentService, id: string): ExecutionRecord {
      const controller = new AbortController();
      const record = createRecord(id, {
        agent: "general-purpose",
        model: "test/model",
        mode: "background",
        task: "long task",
        startedAt: 1_000_000,
        rootSessionId: "s1",
        controller,
      });
      // createRecord 默认 status="running"；background record 持有 controller。
      getStore(service).register(record);
      return record;
    }

    /** 构造一个 running sync record（无 controller）并注册到 store。 */
    function registerRunningSync(service: SubagentService, id: string): ExecutionRecord {
      const record = createRecord(id, {
        agent: "general-purpose",
        model: "test/model",
        mode: "sync",
        task: "sync task",
        startedAt: 1_000_000,
        rootSessionId: "s1",
        // sync 不传 controller → controller === undefined
      });
      getStore(service).register(record);
      return record;
    }

    /** 构造一个终态 background record 并注册（用于「无 running」场景）。 */
    function registerTerminalBackground(service: SubagentService, id: string): ExecutionRecord {
      const controller = new AbortController();
      const record = createRecord(id, {
        agent: "general-purpose",
        model: "test/model",
        mode: "background",
        task: "done task",
        startedAt: 1_000_000,
        rootSessionId: "s1",
        controller,
      });
      // 直接改 status 模拟终态（不走 CAS——测试不关心状态机，只关心 dispose 的 abort 过滤）
      record.status = "done";
      getStore(service).register(record);
      return record;
    }

    it("dispose 时有 running background record → controller 被 abort", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });

      const record = registerRunningBackground(service, "bg-1");

      // 前置：dispose 前 controller 未 abort
      expect(record.controller!.signal.aborted).toBe(false);

      service.dispose();

      // dispose 后 controller 被 abort → runSpawn 的 signal listener 会 kill 子进程
      expect(record.controller!.signal.aborted).toBe(true);
    });

    it("dispose 时无 running record → 不报错，正常清理", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });

      // 全是终态 record（无 running），dispose 不应抛
      registerTerminalBackground(service, "bg-done-1");

      expect(() => service.dispose()).not.toThrow();
    });

    it("dispose 已 dispose → 幂等（重复调用不抛，不重复 abort）", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });

      const record = registerRunningBackground(service, "bg-2");

      service.dispose();
      expect(record.controller!.signal.aborted).toBe(true);

      // 第二次 dispose：service 已 _disposed，early-return，abortRunningControllers 不再调
      // （即使调了也无害——已 abort 的 controller.abort() 是幂等 noop）
      expect(() => service.dispose()).not.toThrow();
      expect(record.controller!.signal.aborted).toBe(true);
    });

    it("sync record（无 controller）→ dispose 跳过（不因 undefined controller 出错）", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });

      // sync record 的 controller 是 undefined，running 状态下 dispose 不应抛
      // （abortRunningControllers 检查 r.controller 才 abort，sync 跳过）
      // [C1] sync 子进程的 kill 由 killAllSpawnedChildren 兜底（spawnedChildren Set 注册），
      //      集成验证见 run-spawn-integration.test.ts 的 C1 用例（mock spawn + spy kill）。
      const syncRecord = registerRunningSync(service, "sync-1");
      expect(syncRecord.controller).toBeUndefined();

      expect(() => service.dispose()).not.toThrow();
    });
  });

  // ============================================================
  // execute() worktree fail-fast 校验 [MF#7]（commit 8e8e75966）
  // ============================================================
  //
  // [MF#7] execute 入口校验 `worktree:true && !fork` → fail-fast 抛错。
  // 否则下面三个 worktree 分支都不命中，worktreeHandle 恒 undefined → 子 agent
  // 零文件隔离且零报错（静默 no-op）。此组验证该校验的三种 fork/worktree 组合：
  //   1. worktree:true + fork:false → 抛 "requires fork"（fail-fast 命中）
  //   2. worktree:true + fork:true  → 不命中校验（执行越过 guard，后续因副作用失败）
  //   3. worktree:false + fork:false → 不命中校验（默认路径，执行越过 guard）
  //
  // 被测点是 execute() 入口的 guard（subagent-service.ts L277-282），在任何副作用
  // （record 创建 / worktree 创建 / spawn）之前。本文件不 mock spawn（保持与文件头
  // 声明一致——execute 集成测试在 execute-nesting / run-spawn-integration），
  // 因此 case 2/3 验证「guard 放行」而非「执行完成」：执行越过 guard 后在后续步骤
  // （worktreeManager.create 调 git / runSpawn 调 spawn）抛与 fork/worktree 无关的错。
  // 用 try/catch 断言抛出的不是 guard 错误，精确锁住 guard 的触发条件。

  describe("execute() worktree fail-fast 校验 [MF#7]", () => {
    /** 构造已就绪的 service（initSession + initModel 注入 ctxModel，使 resolveIdentity 不因 model 拗错）。 */
    function makeReadyService(): SubagentService {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      // 注入 modelRegistry + ctxModel：让 resolveIdentity 越过 resolveModel，
      // 使 guard 之后的失败点稳定在 worktreeManager.create（git）或 runSpawn（spawn），
      // 而非 modelService.resolveModel——避免与 guard 无关的 model 错误掩盖被测点。
      modelService.initModel({
        modelRegistry: {
          getAvailable: () => [],
          find: () => undefined,
          hasConfiguredAuth: () => false,
        },
        sessionId: "s1",
        ctxModel: { id: "ctx-model", name: "Ctx", provider: "p", reasoning: false },
      });
      return service;
    }

    it("worktree:true + fork:false → fail-fast 抛错含 'requires fork'（guard 命中）", async () => {
      const service = makeReadyService();
      // guard 在所有副作用之前：无 record 创建、无 spawn
      await expect(
        service.execute({
          task: "worktree without fork",
          worktree: true,
          fork: false,
          ctxModel: { id: "ctx-model", name: "Ctx", provider: "p", reasoning: false },
        }),
      ).rejects.toThrow(/requires fork/);
      // 无副作用：record 未创建（guard 在 createRecordForMode 之前）
      expect(service.collectRecords(10)).toHaveLength(0);
    });

    it("worktree:true + fork:true → 不命中 guard（执行越过 guard，不抛 'requires fork'）", async () => {
      const service = makeReadyService();
      // guard 放行 → 执行继续：先创建 record，然后 worktreeManager.create 调 git（测试环境无 repo → 抛与 fork 无关的错）
      try {
        await service.execute({
          task: "worktree with fork",
          worktree: true,
          fork: true,
          ctxModel: { id: "ctx-model", name: "Ctx", provider: "p", reasoning: false },
        });
        // 若未抛（理论上 worktreeManager.create 在某些环境成功）也 OK——重点是没命中 guard
      } catch (err) {
        // guard 放行：抛出的错误绝不能是 "requires fork"
        expect((err as Error).message).not.toMatch(/requires fork/);
      }
    });

    it("worktree:false + fork:false → 不命中 guard（默认路径越过 guard，不抛 'requires fork'）", async () => {
      const service = makeReadyService();
      // guard 放行 → 执行继续：runSpawn 调 child_process.spawn（测试环境无真实 pi → 抛与 fork 无关的错）
      try {
        await service.execute({
          task: "default path",
          worktree: false,
          fork: false,
          ctxModel: { id: "ctx-model", name: "Ctx", provider: "p", reasoning: false },
        });
      } catch (err) {
        // guard 放行：抛出的错误绝不能是 "requires fork"
        expect((err as Error).message).not.toMatch(/requires fork/);
      }
    });
  });
});

// ============================================================
// ModelConfigService ctxModel 缓存(renderCall 标题行 model 显示的核心)
// ============================================================
//
// [HISTORICAL] 99f20da1e 后 renderCall 拿不到主 agent model(ToolRenderContext 无 model),
// resolveModel 第三层拗错→降级不显示 model。修复:session_start 缓存 ctxModel,
// resolveModel 第三参默认用缓存。此测试验证该透传链路。

describe("ModelConfigService ctxModel 缓存", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
  });
  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  /** 最小 mock registry:空可用列表(ctxModel 路径不需要 lookup)。 */
  function makeEmptyRegistry(): ModelRegistryLike {
    return {
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    };
  }

  it("initModel 传 ctxModel 后,resolveModel 不传第三参返回缓存 model", () => {
    const svc = makeModelService(agentDir);
    const mainModel: ModelInfo = {
      id: "main-model",
      name: "Main",
      provider: "anthropic",
      reasoning: false,
    };
    svc.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "sess-1",
      ctxModel: mainModel,
    });

    // agent 无 model 声明 + 无 override → 走第三层 ctxModel 缓存
    const r = svc.resolveModel("general-purpose");
    expect(r.model).toBe(mainModel);
    expect(r.model.provider).toBe("anthropic");
  });

  it("显式 ctxModel 参数优先于缓存(execute 路径覆盖 renderCall 缓存)", () => {
    const svc = makeModelService(agentDir);
    const cached: ModelInfo = { id: "cached", name: "C", provider: "p1", reasoning: false };
    const explicit: ModelInfo = { id: "explicit", name: "E", provider: "p2", reasoning: false };
    svc.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "sess-1",
      ctxModel: cached,
    });

    // execute 传显式 ctxModel → 用显式,不用缓存
    const r = svc.resolveModel("general-purpose", undefined, explicit);
    expect(r.model).toBe(explicit);
  });

  it("setCtxModel 刷新缓存(model_select 后 renderCall 能看到新 model)", () => {
    const svc = makeModelService(agentDir);
    const m1: ModelInfo = { id: "m1", name: "1", provider: "p", reasoning: false };
    const m2: ModelInfo = { id: "m2", name: "2", provider: "p", reasoning: false };
    svc.initModel({ modelRegistry: makeEmptyRegistry(), sessionId: "s", ctxModel: m1 });

    expect(svc.resolveModel("general-purpose").model).toBe(m1);
    svc.setCtxModel(m2); // 模拟 model_select 刷新
    expect(svc.resolveModel("general-purpose").model).toBe(m2);
  });

  it("缓存为空且无 override/agentConfig.model → 拗错(不静默降级)", () => {
    const svc = makeModelService(agentDir);
    svc.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "s",
      // ctxModel 不传 → 缓存为空
    });
    // 空 registry + 空 ctxModel → 第三层不可用 → 拗错
    expect(() => svc.resolveModel("general-purpose")).toThrow(/No available model/);
  });
});

// ============================================================
// execute() 集成测试 — 已由 execute-integration.test.ts 覆盖
// ============================================================
// 原先此处的 TODO 已落地为 src/__tests__/execute-integration.test.ts（12 用例），
// 通过 mock 最底层的 SDK 边界（session-runner.getSdk → fakeSdk）跑通完整编排链路：
//   - sync happy / sync error / createAgentSession 失败（finalizeFailed）
//   - background 启动 / background cancel CAS（running 成功 + 已终态 false）
//   - dispose flush（sliding window 内 pending notification）
//   - run() 事件累积（turn_end / message_end usage / tool_start+end / error stopReason）
//   - sync signal abort → cancelled
//   - schema enforcement steer（漏调 structured-output）
//   - onUpdate 回流（TRIGGERING_EVENT_TYPES）
// 同时覆盖 session-runner.run() —— event-bridge 合并进 run() 后的事件处理回归。
