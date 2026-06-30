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

import type { ModelInfo, ModelRegistryLike } from "../core/model-resolver.ts";
import { ModelConfigService } from "../runtime/model-config-service.ts";
import type { PiLike } from "../runtime/subagent-service.ts";
import { getSubagentService, setSubagentService,SubagentService } from "../runtime/subagent-service.ts";

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
