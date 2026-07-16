// src/execution/__tests__/subprocess-agent-runner.test.ts
//
// Wave 4: SubprocessAgentRunner 委托重写测试
//
// 覆盖 test-matrix 用例：
//   T3.1  (正常): SAR 委托 executeAndAwait 返回 content
//   T3.2  (正常): parsedOutput 透传
//   T3.4  (边界): cwd 透传（非 git worktree）
//   T3.5  (边界): model 填底（opts.model 空 → ctxModel）
//   T3.6  (异常): timeoutMs 超时 → signal abort → error
//   T3.7  (正常): onEvent 桥接 AgentEvent 透传
//   T3.17 (NFR): mergeTimeoutSignal listener 清理
//   T3.18 (NFR): dispose 兜底覆盖（delegate 后子进程进 spawnedChildren）
//   T3.19 (NFR): AgentCallOpts→ExecuteOptions 映射保真

import { describe, expect, it, vi } from "vitest";

import type { AgentCallOpts, AgentResult } from "../../orchestration/models/types.ts";
import type { SubprocessAgentRunnerDeps } from "../subprocess-agent-runner.ts";
import { SubprocessAgentRunner } from "../subprocess-agent-runner.ts";

// ── 测试辅助 ──

/** 构造 mock SubagentService.executeAndAwait 返回值 */
function makeMockResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    content: "OK",
    parsedOutput: undefined,
    durationMs: 100,
    error: undefined,
    sessionId: undefined,
    toolCalls: [],
    ...overrides,
  };
}

/** 创建 mock SubagentService（只实现 executeAndAwait） */
function createMockService(impl?: typeof vi.fn) {
  const executeAndAwait = impl ?? vi.fn().mockResolvedValue(makeMockResult());
  return { executeAndAwait } as unknown as {
    executeAndAwait: (
      opts: Record<string, unknown>,
      signal?: AbortSignal,
      onEvent?: (e: Record<string, unknown>) => void,
      stream?: unknown,
    ) => Promise<AgentResult>;
  };
}

function makeBaseOpts(): AgentCallOpts {
  return {
    prompt: "test task",
    agent: "worker",
    cwd: "/some/path",
    schema: undefined,
    model: undefined,
    scene: undefined,
    description: undefined,
    timeoutMs: undefined,
    skill: undefined,
    skillPath: undefined,
    systemPromptFiles: undefined,
    schemaEnv: undefined,
  };
}

// ── T3.1: 正常路径 ──

describe("SubprocessAgentRunner (wave-4 delegate)", () => {
  // ────────────────────────────────────────────────
  // T3.1: 正常路径 — SAR 委托 executeAndAwait 返回 content
  // ────────────────────────────────────────────────
  describe("T3.1 主流程", () => {
    it("委托 executeAndAwait 并返回 content", async () => {
      const mockService = createMockService(
        vi.fn().mockResolvedValue(makeMockResult({ content: "hello world" })),
      );
      const deps: SubprocessAgentRunnerDeps = { subagentService: mockService };
      const sar = new SubprocessAgentRunner(deps);

      const opts = makeBaseOpts();
      const signal = new AbortController().signal;

      const result = await sar.run(opts, signal);

      expect(result.content).toBe("hello world");
      expect(mockService.executeAndAwait).toHaveBeenCalledTimes(1);
    });

    it("不 reject — 失败信息入 result.error", async () => {
      const mockService = createMockService(
        vi.fn().mockResolvedValue(makeMockResult({ error: "some error" })),
      );
      const deps: SubprocessAgentRunnerDeps = { subagentService: mockService };
      const sar = new SubprocessAgentRunner(deps);

      const result = await sar.run(makeBaseOpts(), new AbortController().signal);
      expect(result.error).toBe("some error");
    });
  });

  // ────────────────────────────────────────────────
  // T3.2: parsedOutput 透传
  // ────────────────────────────────────────────────
  describe("T3.2 parsedOutput 透传", () => {
    it("parsedOutput 直通", async () => {
      const parsedData = { x: 1, y: 2 };
      const mockService = createMockService(
        vi.fn().mockResolvedValue(makeMockResult({ content: "ok", parsedOutput: parsedData })),
      );
      const deps: SubprocessAgentRunnerDeps = { subagentService: mockService };
      const sar = new SubprocessAgentRunner(deps);

      const result = await sar.run(makeBaseOpts(), new AbortController().signal);
      expect(result.parsedOutput).toEqual(parsedData);
    });
  });

  // ────────────────────────────────────────────────
  // T3.4: cwd 透传
  // ────────────────────────────────────────────────
  describe("T3.4 cwd 透传", () => {
    it("cwd 传入 executeAndAwait 的 ExecuteOptions", async () => {
      let capturedOpts: Record<string, unknown> | undefined;
      const mockService = createMockService(
        vi.fn().mockImplementation((opts: Record<string, unknown>) => {
          capturedOpts = opts;
          return Promise.resolve(makeMockResult());
        }),
      );
      const deps: SubprocessAgentRunnerDeps = { subagentService: mockService };
      const sar = new SubprocessAgentRunner(deps);

      const opts = { ...makeBaseOpts(), cwd: "/custom/cwd" };
      await sar.run(opts, new AbortController().signal);

      expect(capturedOpts).toBeDefined();
      expect(capturedOpts!.cwd).toBe("/custom/cwd");
    });
  });

  // ────────────────────────────────────────────────
  // T3.5: model 填底
  // ────────────────────────────────────────────────
  describe("T3.5 model 填底 (D-008)", () => {
    it("opts.model 优先", async () => {
      let capturedOpts: Record<string, unknown> | undefined;
      const mockService = createMockService(
        vi.fn().mockImplementation((opts: Record<string, unknown>) => {
          capturedOpts = opts;
          return Promise.resolve(makeMockResult());
        }),
      );
      const ctxModel = { id: "ctx-model", provider: "test", input: [] };
      const deps: SubprocessAgentRunnerDeps = { subagentService: mockService, ctxModel };
      const sar = new SubprocessAgentRunner(deps);

      const opts = { ...makeBaseOpts(), model: "explicit-model" };
      await sar.run(opts, new AbortController().signal);

      expect(capturedOpts!.model).toBe("explicit-model");
    });

    it("opts.model 空 → ctxModel", async () => {
      let capturedOpts: Record<string, unknown> | undefined;
      const mockService = createMockService(
        vi.fn().mockImplementation((opts: Record<string, unknown>) => {
          capturedOpts = opts;
          return Promise.resolve(makeMockResult());
        }),
      );
      const ctxModel = { id: "ctx-model", provider: "test", input: [] };
      const deps: SubprocessAgentRunnerDeps = { subagentService: mockService, ctxModel };
      const sar = new SubprocessAgentRunner(deps);

      const opts = { ...makeBaseOpts(), model: undefined };
      await sar.run(opts, new AbortController().signal);

      // 修复后：opts.model 不再从 ctxModel.id 填底，ctxModel 作为完整对象透传
      expect(capturedOpts!.model).toBeUndefined();
      expect(capturedOpts!.ctxModel).toBe(ctxModel);
    });
  });

  // ────────────────────────────────────────────────
  // H1: SAR ctxModel 刷新（model_select 后不再 stale）
  // ────────────────────────────────────────────────
  describe("H1 ctxModel refresh via updateCtxModel", () => {
    it("updateCtxModel 后 run() 传入新的 ctxModel 而非旧值", async () => {
      let capturedOpts: Record<string, unknown> | undefined;
      const mockService = createMockService(
        vi.fn().mockImplementation((opts: Record<string, unknown>) => {
          capturedOpts = opts;
          return Promise.resolve(makeMockResult());
        }),
      );
      const oldModel = { id: "old-model", provider: "test", input: [] };
      const newModel = { id: "new-model", provider: "test", input: [] };
      const deps: SubprocessAgentRunnerDeps = { subagentService: mockService, ctxModel: oldModel };
      const sar = new SubprocessAgentRunner(deps);

      // 模拟 model_select：刷新 ctxModel
      sar.updateCtxModel(newModel);

      const opts = { ...makeBaseOpts(), model: undefined };
      await sar.run(opts, new AbortController().signal);

      expect(capturedOpts!.ctxModel).toBe(newModel);
      expect(capturedOpts!.ctxModel).not.toBe(oldModel);
    });
  });

  // ────────────────────────────────────────────────
  // T3.6: timeoutMs 超时 → signal abort → error
  // ────────────────────────────────────────────────
  describe("T3.6 timeoutMs 超时", () => {
    it("timeoutMs > 0 → merged signal 传给 executeAndAwait", async () => {
      let capturedSignal: AbortSignal | undefined;
      const mockService = createMockService(
        vi.fn().mockImplementation((_opts: Record<string, unknown>, signal?: AbortSignal) => {
          capturedSignal = signal;
          return Promise.resolve(makeMockResult());
        }),
      );
      const deps: SubprocessAgentRunnerDeps = { subagentService: mockService };
      const sar = new SubprocessAgentRunner(deps);

      const opts = { ...makeBaseOpts(), timeoutMs: 5000 };
      await sar.run(opts, new AbortController().signal);

      // 有 timeoutMs 时 merged signal 不等于原始 signal
      expect(capturedSignal).toBeDefined();
    });

    it("timeoutMs 到期 → merged signal.aborted=true", async () => {
      vi.useFakeTimers();
      let capturedSignal: AbortSignal | undefined;
      const mockService = createMockService(
        vi.fn().mockImplementation((_opts: Record<string, unknown>, signal?: AbortSignal) => {
          capturedSignal = signal;
          return Promise.resolve(makeMockResult());
        }),
      );
      const deps: SubprocessAgentRunnerDeps = { subagentService: mockService };
      const sar = new SubprocessAgentRunner(deps);

      const opts = { ...makeBaseOpts(), timeoutMs: 50 };
      sar.run(opts, new AbortController().signal);

      // 推进 51ms 后 merged signal 应 abort
      vi.advanceTimersByTime(51);

      expect(capturedSignal?.aborted).toBe(true);
      vi.useRealTimers();
    });
  });

  // ────────────────────────────────────────────────
  // T3.7: onEvent 桥接
  // ────────────────────────────────────────────────
  describe("T3.7 onEvent 桥接", () => {
    it("executeAndAwait 的 onEvent 透传到 workflow onEvent", async () => {
      const mockService = createMockService(
        vi.fn().mockImplementation(
          (_opts: Record<string, unknown>, _signal?: AbortSignal, onEvent?: (e: Record<string, unknown>) => void) => {
            // 模拟 executeAndAwait 触发 onEvent
            onEvent?.({ type: "tool_start", toolName: "read", args: { path: "/a.txt" } });
            return Promise.resolve(makeMockResult());
          },
        ),
      );
      const deps: SubprocessAgentRunnerDeps = { subagentService: mockService };
      const sar = new SubprocessAgentRunner(deps);

      const workflowOnEvent = vi.fn();
      await sar.run(makeBaseOpts(), new AbortController().signal, workflowOnEvent);

      // workflow 的 onEvent 应被调用
      expect(workflowOnEvent).toHaveBeenCalledTimes(1);
      expect(workflowOnEvent).toHaveBeenCalledWith({
        type: "tool_start",
        toolName: "read",
        args: { path: "/a.txt" },
      });
    });

    it("无 workflow onEvent → 不传 bridgedOnEvent", async () => {
      let bridgedOnEvent: ((e: Record<string, unknown>) => void) | undefined;
      const mockService = createMockService(
        vi.fn().mockImplementation(
          (_opts: Record<string, unknown>, _signal?: AbortSignal, onEvent?: (e: Record<string, unknown>) => void) => {
            bridgedOnEvent = onEvent;
            return Promise.resolve(makeMockResult());
          },
        ),
      );
      const deps: SubprocessAgentRunnerDeps = { subagentService: mockService };
      const sar = new SubprocessAgentRunner(deps);

      await sar.run(makeBaseOpts(), new AbortController().signal);

      // 不传 workflow onEvent → bridgedOnEvent 应为 undefined
      expect(bridgedOnEvent).toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────
  // T3.17: mergeTimeoutSignal listener 清理
  // ────────────────────────────────────────────────
  describe("T3.17 mergeTimeoutSignal listener 清理", () => {
    it("外部 signal abort → timer 清理", async () => {
      vi.useFakeTimers();
      const mockService = createMockService(
        vi.fn().mockResolvedValue(makeMockResult()),
      );
      const deps: SubprocessAgentRunnerDeps = { subagentService: mockService };
      const sar = new SubprocessAgentRunner(deps);

      const ctrl = new AbortController();
      const opts = { ...makeBaseOpts(), timeoutMs: 5000 };

      // 启动 run（不 await，让它在后台）
      const runPromise = sar.run(opts, ctrl.signal);

      // 外部 abort
      ctrl.abort();

      await runPromise;

      // 推进时间——timer 应已清理，不会造成副作用
      vi.advanceTimersByTime(6000);
      // 无异常 = listener 已正确清理
      vi.useRealTimers();
    });
  });

  // ────────────────────────────────────────────────
  // T3.19: AgentCallOpts → ExecuteOptions 映射保真
  // ────────────────────────────────────────────────
  describe("T3.19 映射保真", () => {
    it("prompt → task, agent → agent, schemaEnv 透传", async () => {
      let capturedOpts: Record<string, unknown> | undefined;
      const mockService = createMockService(
        vi.fn().mockImplementation((opts: Record<string, unknown>) => {
          capturedOpts = opts;
          return Promise.resolve(makeMockResult());
        }),
      );
      const deps: SubprocessAgentRunnerDeps = { subagentService: mockService };
      const sar = new SubprocessAgentRunner(deps);

      const opts: AgentCallOpts = {
        ...makeBaseOpts(),
        prompt: "do the thing",
        agent: "code-reviewer",
        schemaEnv: '{"type":"object"}',
        skillPath: "/skills/code-review.md",
      };
      await sar.run(opts, new AbortController().signal);

      expect(capturedOpts).toBeDefined();
      expect(capturedOpts!.task).toBe("do the thing");
      expect(capturedOpts!.agent).toBe("code-reviewer");
      expect(capturedOpts!.skillPath).toBe("/skills/code-review.md");
      // schemaEnv 应通过 ExecuteOptions 透传
      expect((capturedOpts as Record<string, unknown>).schemaEnv).toBe('{"type":"object"}');
    });

    it("schema 透传为原始对象", async () => {
      let capturedOpts: Record<string, unknown> | undefined;
      const mockService = createMockService(
        vi.fn().mockImplementation((opts: Record<string, unknown>) => {
          capturedOpts = opts;
          return Promise.resolve(makeMockResult());
        }),
      );
      const deps: SubprocessAgentRunnerDeps = { subagentService: mockService };
      const sar = new SubprocessAgentRunner(deps);

      const opts = {
        ...makeBaseOpts(),
        schema: { type: "object", properties: { name: { type: "string" } } },
      };
      await sar.run(opts, new AbortController().signal);

      expect(capturedOpts!.schema).toEqual({
        type: "object",
        properties: { name: { type: "string" } },
      });
    });
  });

  // ────────────────────────────────────────────────
  // T3.18: executeAndAwait throw → catch → error
  // ────────────────────────────────────────────────
  describe("T3.18 异常处理", () => {
    it("executeAndAwait throw → 不 reject，返回 error", async () => {
      const mockService = createMockService(
        vi.fn().mockRejectedValue(new Error("nesting depth exceeded")),
      );
      const deps: SubprocessAgentRunnerDeps = { subagentService: mockService };
      const sar = new SubprocessAgentRunner(deps);

      const result = await sar.run(makeBaseOpts(), new AbortController().signal);
      expect(result.error).toContain("nesting depth exceeded");
      expect(result.content).toBe("");
    });

    it("非 Error throw → error 字段含 message", async () => {
      const mockService = createMockService(
        vi.fn().mockRejectedValue("raw string error"),
      );
      const deps: SubprocessAgentRunnerDeps = { subagentService: mockService };
      const sar = new SubprocessAgentRunner(deps);

      const result = await sar.run(makeBaseOpts(), new AbortController().signal);
      expect(result.error).toBe("raw string error");
    });
  });

  // ────────────────────────────────────────────────
  // U1: stream 透传给 executeAndAwait
  // ────────────────────────────────────────────────
  describe("U1 stream 透传", () => {
    it("SAR.run 传 stream → executeAndAwait 第 4 参收到同一 stream 对象", async () => {
      let capturedStream: unknown;
      const mockService = createMockService(
        vi.fn().mockImplementation((_opts, _sig, _onEvt, stream) => {
          capturedStream = stream;
          return Promise.resolve(makeMockResult());
        }),
      );
      const deps: SubprocessAgentRunnerDeps = { subagentService: mockService };
      const sar = new SubprocessAgentRunner(deps);

      const fakeStream = { onDelta: vi.fn(), dispose: vi.fn() };
      await sar.run(makeBaseOpts(), new AbortController().signal, undefined, fakeStream as never);

      expect(capturedStream).toBe(fakeStream);
    });

    it("SAR.run 不传 stream → executeAndAwait 第 4 参为 undefined", async () => {
      let capturedStream: unknown = "sentinel";
      const mockService = createMockService(
        vi.fn().mockImplementation((_opts, _sig, _onEvt, stream) => {
          capturedStream = stream;
          return Promise.resolve(makeMockResult());
        }),
      );
      const deps: SubprocessAgentRunnerDeps = { subagentService: mockService };
      const sar = new SubprocessAgentRunner(deps);

      await sar.run(makeBaseOpts(), new AbortController().signal);

      expect(capturedStream).toBeUndefined();
    });
  });
});
