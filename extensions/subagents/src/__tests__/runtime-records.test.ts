// src/__tests__/runtime-records.test.ts
import { describe, expect, it } from "vitest";

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
