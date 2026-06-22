// 测试框架：vitest
// 运行命令：npx vitest run src/engine/models/__tests__/trace.test.ts

import { describe, expect, it } from "vitest";

import { Trace } from "../trace.js";
import type { ExecutionTraceNode, TracePatch } from "../types.js";

function makeNode(stepIndex: number, overrides: Partial<ExecutionTraceNode> = {}): ExecutionTraceNode {
  return {
    stepIndex,
    agent: "worker",
    task: `task-${stepIndex}`,
    model: "default",
    status: "running",
    startedAt: "2026-06-22T00:00:00.000Z",
    ...overrides,
  };
}

// ── append ──────────────────────────────────────────────────

describe("Trace.append", () => {
  it("追加节点，toArray 反映顺序", () => {
    const trace = new Trace();
    trace.append(makeNode(0));
    trace.append(makeNode(1));
    expect(trace.toArray().map((n) => n.stepIndex)).toEqual([0, 1]);
  });

  it("append-only：不改已有节点", () => {
    const trace = new Trace();
    const n0 = makeNode(0, { task: "original" });
    trace.append(n0);
    trace.append(makeNode(1));
    expect(trace.toArray()[0].task).toBe("original");
  });

  it("length 计数", () => {
    const trace = new Trace();
    expect(trace.length).toBe(0);
    trace.append(makeNode(0));
    expect(trace.length).toBe(1);
  });
});

// ── update ──────────────────────────────────────────────────

describe("Trace.update", () => {
  it("按 stepIndex 更新 status + completedAt", () => {
    const trace = new Trace();
    trace.append(makeNode(0, { status: "running" }));
    const patch: TracePatch = {
      status: "completed",
      completedAt: "2026-06-22T00:01:00.000Z",
    };
    trace.update(0, patch);
    expect(trace.find(0)?.status).toBe("completed");
    expect(trace.find(0)?.completedAt).toBe("2026-06-22T00:01:00.000Z");
  });

  it("更新 result + sessionId", () => {
    const trace = new Trace();
    trace.append(makeNode(0));
    trace.update(0, {
      status: "failed",
      result: { content: "err", error: "boom" },
      sessionId: "01H8X",
    });
    expect(trace.find(0)?.status).toBe("failed");
    expect(trace.find(0)?.result?.error).toBe("boom");
    expect(trace.find(0)?.sessionId).toBe("01H8X");
  });

  it("只改 patch 提供的字段，其他字段保持", () => {
    const trace = new Trace();
    trace.append(makeNode(0, { status: "running", task: "keep-me" }));
    trace.update(0, { status: "completed" });
    expect(trace.find(0)?.status).toBe("completed");
    expect(trace.find(0)?.task).toBe("keep-me"); // 未被覆盖
  });

  it("stepIndex 不存在时 no-op（不抛错）", () => {
    const trace = new Trace();
    trace.append(makeNode(0));
    expect(() => trace.update(999, { status: "completed" })).not.toThrow();
    expect(trace.length).toBe(1); // 未新增
    expect(trace.find(999)).toBeUndefined();
  });

  it("空 patch 不改任何字段", () => {
    const trace = new Trace();
    trace.append(makeNode(0, { status: "running" }));
    trace.update(0, {});
    expect(trace.find(0)?.status).toBe("running");
  });

  it("可多次 update 同一节点（retry 场景）", () => {
    const trace = new Trace();
    trace.append(makeNode(0, { status: "running" }));
    trace.update(0, { status: "failed", error: "first attempt" });
    trace.update(0, { status: "running" }); // retry
    trace.update(0, { status: "completed", completedAt: "2026-06-22T00:02:00.000Z" });
    expect(trace.find(0)?.status).toBe("completed");
    // error 字段在最后一次 patch 未提供，保留前值（调用方负责清理）
    expect(trace.find(0)?.error).toBe("first attempt");
  });
});

// ── 不变式：无 verifyStrategy ─────────────────────────────────

describe("Trace 不变式", () => {
  it("节点不含 verifyStrategy（G-020 删除）", () => {
    const trace = new Trace();
    trace.append(makeNode(0));
    expect("verifyStrategy" in trace.find(0)!).toBe(false);
  });

  it("toArray 返回 readonly 视图", () => {
    const trace = new Trace();
    trace.append(makeNode(0));
    const arr = trace.toArray();
    // readonly 类型在编译期阻止 push，这里只验证运行时是同一份数据
    expect(arr).toHaveLength(1);
  });
});
