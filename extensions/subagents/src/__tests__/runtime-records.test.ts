// src/__tests__/runtime-records.test.ts
import { describe, expect, it, vi } from "vitest";

import { SubagentRuntime } from "../runtime.ts";
import { COMPLETED_AGENTS_MAX } from "../types.ts";

function makeRuntime(): SubagentRuntime {
  return new SubagentRuntime({ cwd: "/tmp", homeDir: "/tmp", agentDir: "/tmp/.pi/agent" });
}

describe("SubagentRuntime — record retention (FR-3.0)", () => {
  it("_completedAgents initially empty", () => {
    const rt = makeRuntime();
    expect(rt.listCompleted().length).toBe(0);
  });

  it("archiveSyncAgent stores and listCompleted returns it", () => {
    const rt = makeRuntime();
    rt.archiveSyncAgent({
      id: "run-1", agent: "worker", status: "done", startedAt: Date.now(), endedAt: Date.now(),
      eventLog: [], turns: 3,
    });
    expect(rt.listCompleted()).toHaveLength(1);
    expect(rt.listCompleted()[0].id).toBe("run-1");
  });

  it("archiveBackgroundAgent persists eventLog + agent to BgRecord", () => {
    const rt = makeRuntime();
    // 模拟 BgRecord 已存在（实际由 startBackground 创建）
    rt["_bgRecords"].set("bg-1", { id: "bg-1", status: "running", startedAt: Date.now() });
    rt.archiveBackgroundAgent("bg-1", {
      eventLog: [{ type: "tool_start", label: "read foo.ts", ts: 0, status: "running" }],
      agent: "reviewer",
    });
    const record = rt.getBackground("bg-1");
    expect(record?.eventLog).toHaveLength(1);
    expect(record?.agent).toBe("reviewer");
  });

  it("FIFO eviction when _completedAgents exceeds COMPLETED_AGENTS_MAX", () => {
    const rt = makeRuntime();
    for (let i = 0; i < COMPLETED_AGENTS_MAX + 5; i++) {
      rt.archiveSyncAgent({
        id: `run-${i}`, agent: "x", status: "done", startedAt: i, endedAt: i, eventLog: [],
      });
    }
    expect(rt.listCompleted().length).toBe(COMPLETED_AGENTS_MAX);
    // 5 个最旧的被驱逐（run-0..run-4）
    expect(rt.listCompleted()[0].id).toBe("run-5");
  });

  it("archiveSyncAgent triggers notifyChange", () => {
    const rt = makeRuntime();
    const fn = (rt as never as { onChange: (f: () => void) => () => void }).onChange;
    const spy = (() => { const calls: number[] = []; return { spy: () => calls.push(1), calls }; })();
    const unsub = fn.call(rt, () => spy.spy());
    rt.archiveSyncAgent({
      id: "run-1", agent: "x", status: "done", startedAt: 0, endedAt: 0, eventLog: [],
    });
    expect(spy.calls.length).toBe(1);
    unsub();
  });
});

// ============================================================
// FR-4.7.1: restoreFromEntries round-trip（状态持久化往返一致性）
// 验证 toggleYolo / setSessionAgentModel / setSessionCategoryModel 写入的
// appendEntry data 能被新 runtime 的 restoreFromEntries 正确读回。
// ============================================================

function makeMockPi() {
  return {
    appendEntry: vi.fn<(customType: string, data?: unknown) => void>(),
    events: { emit: vi.fn<(channel: string, data: unknown) => void>() },
  };
}

describe("SubagentRuntime — restoreFromEntries round-trip (FR-4.7.1)", () => {
  it("persisted state restores into a fresh runtime (yolo + per-agent + per-category)", () => {
    const pi = makeMockPi();
    const rt = makeRuntime();
    rt.injectPi(pi);

    // 1. 执行三类状态变更，每次都会 appendEntry
    rt.toggleYolo(); // yoloByDefault=false → true
    rt.setSessionAgentModel("worker", "p/m", "high");
    rt.setSessionCategoryModel("coding", "p/m2", "low");

    // 2. 从 appendEntry.mock.calls 提取最后一次 subagent-model-state 的 data
    const stateCalls = pi.appendEntry.mock.calls.filter(
      ([customType]) => customType === "subagent-model-state",
    );
    expect(stateCalls.length).toBe(3);
    const lastData = stateCalls[stateCalls.length - 1][1];
    expect(lastData).toBeDefined();

    // 3. 构造 Pi custom entry 形状，喂给新 runtime
    const entries: unknown[] = [
      { type: "custom", customType: "subagent-model-state", data: lastData },
    ];
    const rt2 = makeRuntime();
    (rt2 as unknown as { restoreFromEntries(entries: unknown[]): void }).restoreFromEntries(entries);

    // 4. 断言新 runtime 状态与原 runtime 一致
    expect(rt2.sessionState.yoloMode).toBe(rt.sessionState.yoloMode);
    expect(rt2.sessionState.yoloMode).toBe(true);
    expect(rt2.sessionState.perAgent).toEqual(rt.sessionState.perAgent);
    expect(rt2.sessionState.perAgent.worker).toEqual({ model: "p/m", thinkingLevel: "high" });
    expect(rt2.sessionState.perCategory).toEqual(rt.sessionState.perCategory);
    expect(rt2.sessionState.perCategory.coding).toEqual({ model: "p/m2", thinkingLevel: "low" });
  });

  it("keeps default sessionState when no subagent-model-state entry present", () => {
    const rt = makeRuntime();
    const defaultYolo = rt.globalConfig.yoloByDefault; // false

    // 初始状态即默认
    expect(rt.sessionState.yoloMode).toBe(defaultYolo);

    (rt as unknown as { restoreFromEntries(entries: unknown[]): void }).restoreFromEntries([
      { type: "custom", customType: "unrelated-type", data: { foo: 1 } },
      { type: "message", role: "user" }, // 非 custom entry
      { type: "custom", customType: "subagent-bg-record", data: { id: "bg-1" } },
    ]);

    // 无 subagent-model-state → 保持默认
    expect(rt.sessionState.yoloMode).toBe(defaultYolo);
    expect(rt.sessionState.perAgent).toEqual({});
    expect(rt.sessionState.perCategory).toEqual({});
  });

  it("restoreState data is an object snapshot (not a JSON string)", () => {
    // 直接验证 appendEntry 收到的是 object —— 防止 serializeState 退化为
    // JSON.stringify（会与 restoreState 的 typeof data !== "object" 判断冲突）
    const pi = makeMockPi();
    const rt = makeRuntime();
    rt.injectPi(pi);
    rt.toggleYolo();

    const [, data] = pi.appendEntry.mock.calls[0];
    expect(data).toBeTypeOf("object");
    expect(data).toHaveProperty("yoloMode", true);
  });
});
