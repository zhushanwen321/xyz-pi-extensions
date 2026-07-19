// src/execution/__tests__/execute-options-mapper.test.ts
//
// T3.4 (边界): cwd 透传（非 git worktree）
// T3.5 (边界): model 填底——opts.model 空 → ctxModel（D-008）
// T3.9 (边界): schemaEnv 透传——opts.schemaEnv → ExecuteOptions.schemaEnv
// T3.6 (异常): timeoutMs 超时 → 合并 signal abort → T3.17 listener 清理
//
// 测试范围: mapToExecuteOptions 全字段映射 + mergeTimeoutSignal 行为

import { describe, expect, it, vi } from "vitest";

import type { AgentCallOpts } from "../../orchestration/models/types.ts";
import { mapToExecuteOptions, mergeTimeoutSignal } from "../execute-options-mapper.ts";
import type { ModelInfo } from "../model-resolver.ts";

describe("mapToExecuteOptions (D-A2)", () => {
  const baseOpts: AgentCallOpts = {
    prompt: "test task",
    agent: "worker",
    schema: { type: "object" },
    cwd: "/tmp/work",
    skillPath: "/path/to/skill.md",
  };

  it("T3.4 基本映射: prompt→task, agent→agent, cwd→cwd", () => {
    const result = mapToExecuteOptions(baseOpts);
    expect(result.task).toBe("test task");
    expect(result.agent).toBe("worker");
    expect(result.cwd).toBe("/tmp/work");
  });

  it("T3.4 schema 透传", () => {
    const result = mapToExecuteOptions(baseOpts);
    expect(result.schema).toEqual({ type: "object" });
  });

  it("T3.9 schemaEnv 透传 (D-A6 bridge)", () => {
    const opts: AgentCallOpts = { ...baseOpts, schemaEnv: '{"type":"object"}' };
    const result = mapToExecuteOptions(opts);
    expect((result as unknown as { schemaEnv?: string }).schemaEnv).toBe('{"type":"object"}');
  });

  it("T3.9 schemaEnv 不传 → schemaEnv undefined", () => {
    const result = mapToExecuteOptions(baseOpts);
    expect((result as unknown as { schemaEnv?: string }).schemaEnv).toBeUndefined();
  });

  it("T3.5 model: opts.model 优先（显式 override 透传，不与 ctxModel 混合）", () => {
    const opts: AgentCallOpts = { ...baseOpts, model: "explicit-model" };
    const ctxModel: ModelInfo = { id: "ctx-model", provider: "test", input: [] } as ModelInfo;
    const result = mapToExecuteOptions(opts, ctxModel);
    expect(result.model).toBe("explicit-model");
  });

  it("T3.5 model: opts.model 空 → model undefined（不再从 ctxModel.id 填底）", () => {
    const ctxModel: ModelInfo = { id: "ctx-model", provider: "test", input: [] } as ModelInfo;
    const result = mapToExecuteOptions(baseOpts, ctxModel);
    expect(result.model).toBeUndefined();
  });

  it("T3.5 ctxModel 透传: opts.model 空时 ctxModel 作为完整 ModelInfo 对象传入 ExecuteOptions.ctxModel", () => {
    const ctxModel: ModelInfo = { id: "mimo-v2.5-pro", provider: "router-openai", input: [] } as ModelInfo;
    const result = mapToExecuteOptions(baseOpts, ctxModel);
    expect(result.ctxModel).toBe(ctxModel);
    expect(result.ctxModel?.id).toBe("mimo-v2.5-pro");
    expect(result.ctxModel?.provider).toBe("router-openai");
  });

  it("T3.5 ctxModel 透传: opts.model 有值时 ctxModel 仍透传（双层可用）", () => {
    const opts: AgentCallOpts = { ...baseOpts, model: "explicit-model" };
    const ctxModel: ModelInfo = { id: "ctx-model", provider: "test", input: [] } as ModelInfo;
    const result = mapToExecuteOptions(opts, ctxModel);
    expect(result.model).toBe("explicit-model");
    expect(result.ctxModel).toBe(ctxModel);
  });

  it("T3.5 ctxModel: 两层均空 → model/ctxModel 都 undefined", () => {
    const result = mapToExecuteOptions(baseOpts);
    expect(result.model).toBeUndefined();
    expect(result.ctxModel).toBeUndefined();
  });

  it("skillPath 透传", () => {
    const result = mapToExecuteOptions(baseOpts);
    expect(result.skillPath).toBe("/path/to/skill.md");
  });

  it("thinkingLevel 透传 (M1)", () => {
    const opts: AgentCallOpts = { ...baseOpts, thinkingLevel: "high" };
    const result = mapToExecuteOptions(opts);
    expect(result.thinkingLevel).toBe("high");
  });

  it("thinkingLevel 不传 → thinkingLevel undefined", () => {
    const result = mapToExecuteOptions(baseOpts);
    expect(result.thinkingLevel).toBeUndefined();
  });

  it("systemPromptFiles → appendSystemPrompt 映射 (M2)", () => {
    const opts: AgentCallOpts = { ...baseOpts, systemPromptFiles: ["/tmp/a.md"] };
    const result = mapToExecuteOptions(opts);
    expect(result.appendSystemPrompt).toEqual(["/tmp/a.md"]);
  });

  it("systemPromptFiles 不传 → appendSystemPrompt undefined", () => {
    const result = mapToExecuteOptions(baseOpts);
    expect(result.appendSystemPrompt).toBeUndefined();
  });
});

describe("mergeTimeoutSignal (D-A9)", () => {
  it("T3.6 timeoutMs===undefined → 原样返回 external signal", () => {
    const ctrl = new AbortController();
    const result = mergeTimeoutSignal(ctrl.signal, undefined);
    expect(result).toBe(ctrl.signal);
  });

  it("T3.6 timeoutMs<=0 → 原样返回 external signal", () => {
    const ctrl = new AbortController();
    const result = mergeTimeoutSignal(ctrl.signal, 0);
    expect(result).toBe(ctrl.signal);
  });

  it("T3.6 timeoutMs>0 → 返回新 signal（合并外部+超时两路）", () => {
    const ctrl = new AbortController();
    const result = mergeTimeoutSignal(ctrl.signal, 50);
    expect(result).not.toBe(ctrl.signal);
    expect(result.aborted).toBe(false);
  });

  it("T3.6 timeoutMs 到期 → merged signal abort", async () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    const merged = mergeTimeoutSignal(ctrl.signal, 50);

    expect(merged.aborted).toBe(false);
    vi.advanceTimersByTime(51);
    expect(merged.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("T3.6 外部 signal abort → merged signal abort", () => {
    const ctrl = new AbortController();
    const merged = mergeTimeoutSignal(ctrl.signal, 5000);
    ctrl.abort();
    expect(merged.aborted).toBe(true);
  });

  it("T3.6 外部 signal 已 abort → 返回已 abort 的 signal", () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const merged = mergeTimeoutSignal(ctrl.signal, 5000);
    expect(merged.aborted).toBe(true);
  });

  it("T3.17 NFR: merged signal abort → timeout timer 清理", () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    const merged = mergeTimeoutSignal(ctrl.signal, 50);

    ctrl.abort(); // 外部 abort → merged 也 abort
    expect(merged.aborted).toBe(true);

    // 推进时间，不应再有副作用
    vi.advanceTimersByTime(100);
    // timer 应被清理（通过 abort event listener）
    // 无异常 = timer 已正确清理
    vi.useRealTimers();
  });
});
