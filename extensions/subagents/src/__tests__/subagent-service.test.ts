// src/__tests__/subagent-service.test.ts
//
// SubagentService 生命周期 + 公共 API 边界测试。
//
// 范围：initSession / dispose / query / cancel / listRunning / collectRecords /
// onChange / assertReady —— 这些不依赖动态 import Pi SDK（getSdk）。
//
// execute() 因 buildSessionRunnerContext 会动态 import session-factory → getSdk()，
// 在单测环境无法提供真实 SDK，留给集成测试（见文件末尾 TODO）。
//
// 策略：用真实 ModelConfigService 指向 os.tmpdir() 空目录（loadGlobalConfig
// 对不存在文件返回默认配置，AgentRegistry 空目录也安全），mock PiLike。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelConfigService } from "../runtime/model-config-service.ts";
import type { PiLike } from "../runtime/subagent-service.ts";
import { getSubagentService, setSubagentService,SubagentService } from "../runtime/subagent-service.ts";

// ── 工具：建临时 agentDir + 真实 ModelConfigService ──

function makeTmpAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-test-"));
  // agentDir/subagents/ 子目录（config 默认路径会用，空即可）
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
    it("构造不抛错（空 agentDir，默认 config）", () => {
      expect(() => new SubagentService({ cwd: agentDir, modelService })).not.toThrow();
    });

    it("未 initSession 时 findRecord/cancel 抛 'pi not injected'", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      expect(() => service.findRecord("any")).toThrow(/pi not injected/);
      expect(() => service.cancel("any")).toThrow(/pi not injected/);
    });

    it("initSession 后 assertReady 通过（findRecord 不再抛 pi 错，返回 undefined）", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      // findRecord 现在能过 assertReady，但 record 不存在 → 返回 undefined
      expect(service.findRecord("missing")).toBeUndefined();
    });

    it("dispose 后 findRecord 抛含 'disposed' 且带恢复指引", () => {
      // [HISTORICAL] 旧实现只抛 "hub disposed"——无信息，调用方和 AI 盲猜。
      // 现错误信息必须含原因 + 恢复指引，让 AI/user 知道要重启会话而非重试。
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      service.dispose();
      expect(() => service.findRecord("any")).toThrow(/disposed/);
      expect(() => service.findRecord("any")).toThrow(/session ended|session_start|new session/i);
    });

    it("dispose 幂等（多次调用不抛）", () => {
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
      // 现在 assertReady 又通过（findRecord 返回 undefined 而非 disposed）
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

    it("cancel 不存在的 id 返回 false（不抛错，boolean 契约不变）", () => {
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

    it("collectRecords 返回数组（空 history 时也为空或仅含历史）", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      const records = service.collectRecords(100);
      expect(Array.isArray(records)).toBe(true);
    });

    it("onChange 返回 unsubscribe 函数，调用后停止通知", () => {
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
    it("代理到 modelService.resolveModel（未 init 时抛错）", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      // 未 init modelRegistry → resolveModel 拋错（fail-fast）
      expect(() => service.resolveModel("worker")).toThrow(/modelRegistry not injected/);
    });
  });

  // ============================================================
  // 进程单例访问器
  // ============================================================

  describe("进程单例访问器", () => {
    // 保存/恢复单例，避免污染其他测试（setSubagentService 类型不接受 null）
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
// TODO: execute() 集成测试
// ============================================================
// execute() 的完整测试需要 mock session-factory.getSdk() 返回的 SdkLike +
// createAndConfigureSession 的全套依赖（session.subscribe / session.prompt /
// session.dispose）。当前单测环境无法提供，建议：
//   1. 在 mocks/ 下建 session-factory mock（vi.mock "../core/session-factory.ts"）
//   2. 覆盖三条主路径：
//      - sync happy path: execute({wait:true}) → handle.mode="sync", record.status=done
//      - background: execute({wait:false}) → handle.mode="background", subagentId 非空, status=running
//      - dispose flush: background 运行中 dispose → notifier.flushPendingNotifications 被调
//   3. 验证 cancel CAS：background running 时 cancel → status=cancelled + durationMs>0
//   4. findRecord: register 后可见 / archive 后仍可见（内存三源）
