// 测试框架：vitest
// 运行命令：npx vitest run src/engine/__tests__/orchestrator-budget.test.ts
//
// Round 4 MF4: checkBudget + scheduleTimeBudgetCheck 零直接测试 → 新增覆盖。
// 重点：MF3 回归（maxTokens>0 守卫）、token/cost 超限、90% 警告只发一次、
// terminal 守卫、time budget 时间比较。

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  checkBudget,
  scheduleTimeBudgetCheck,
  type BudgetCallbacks,
} from "../orchestrator-budget.js";
import {
  type WorkflowInstance,
  type WorkflowBudget,
  createInstance,
} from "../../domain/state.js";

// ── Helpers ─────────────────────────────────────────────────

function makeInstance(
  overrides: Partial<WorkflowBudget> = {},
  status: WorkflowInstance["status"] = "running",
): WorkflowInstance {
  const inst = createInstance({
    runId: "wf-budget-test",
    name: "budget-test",
    worker: "test",
  });
  inst.status = status;
  inst.budget = {
    usedTokens: 0,
    usedCost: 0,
    ...overrides,
  } as WorkflowBudget;
  return inst;
}

function makeCallbacks(): BudgetCallbacks & {
  postMessage: ReturnType<typeof vi.fn>;
  terminateWorker: ReturnType<typeof vi.fn>;
  persistState: ReturnType<typeof vi.fn>;
  onCompletion: ReturnType<typeof vi.fn>;
  cleanupAllTempFiles: ReturnType<typeof vi.fn>;
} {
  return {
    postMessage: vi.fn(),
    terminateWorker: vi.fn(),
    persistState: vi.fn().mockResolvedValue(undefined),
    onCompletion: vi.fn(),
    cleanupAllTempFiles: vi.fn(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// ── checkBudget ─────────────────────────────────────────────

describe("checkBudget — token budget", () => {
  it("MF3 回归: maxTokens=0 不触发 budget_limited（守卫）", async () => {
    const inst = makeInstance({ maxTokens: 0, usedTokens: 999_999 });
    const cb = makeCallbacks();
    await checkBudget(inst, inst.runId, cb);

    expect(inst.status).toBe("running");
    expect(cb.terminateWorker).not.toHaveBeenCalled();
  });

  it("MF3 回归: maxTokens=undefined 不触发 budget_limited（守卫）", async () => {
    const inst = makeInstance({ usedTokens: 999_999 });
    inst.budget.maxTokens = undefined;
    const cb = makeCallbacks();
    await checkBudget(inst, inst.runId, cb);

    expect(inst.status).toBe("running");
    expect(cb.terminateWorker).not.toHaveBeenCalled();
  });

  it("usedTokens >= maxTokens 触发 budget_limited", async () => {
    const inst = makeInstance({ maxTokens: 1000, usedTokens: 1000 });
    const cb = makeCallbacks();
    await checkBudget(inst, inst.runId, cb);

    expect(inst.status).toBe("budget_limited");
    expect(inst.error).toMatch(/Token budget exceeded/);
    expect(cb.terminateWorker).toHaveBeenCalledWith(inst.runId);
    expect(cb.persistState).toHaveBeenCalled();
    expect(cb.onCompletion).toHaveBeenCalledWith(inst.runId);
    expect(cb.postMessage).toHaveBeenCalledWith(
      inst.runId,
      expect.objectContaining({ type: "budget-warning" }),
    );
  });

  it("usedTokens 超过 maxTokens 也触发（>= 比较）", async () => {
    const inst = makeInstance({ maxTokens: 100, usedTokens: 101 });
    const cb = makeCallbacks();
    await checkBudget(inst, inst.runId, cb);

    expect(inst.status).toBe("budget_limited");
  });
});

describe("checkBudget — cost budget", () => {
  it("maxCost 超限触发 budget_limited", async () => {
    const inst = makeInstance({ maxCost: 1.0, usedCost: 1.5, maxTokens: 0 });
    const cb = makeCallbacks();
    await checkBudget(inst, inst.runId, cb);

    expect(inst.status).toBe("budget_limited");
    expect(inst.error).toMatch(/Cost budget exceeded/);
  });

  it("maxCost 守卫: maxCost=0 不触发（即使 usedCost>0）", async () => {
    const inst = makeInstance({ maxCost: 0, usedCost: 999, maxTokens: 0 });
    const cb = makeCallbacks();
    await checkBudget(inst, inst.runId, cb);

    expect(inst.status).toBe("running");
  });
});

describe("checkBudget — 90% warning", () => {
  it("达到 90% 阈值时发一次 budget-warning 消息", async () => {
    const inst = makeInstance({ maxTokens: 1000, usedTokens: 900 });
    const cb = makeCallbacks();
    await checkBudget(inst, inst.runId, cb);

    expect(inst.status).toBe("running");
    expect(cb.postMessage).toHaveBeenCalledTimes(1);
    const msg = cb.postMessage.mock.calls[0]![1] as { type: string; reason: string };
    expect(msg.type).toBe("budget-warning");
    expect(msg.reason).toMatch(/Token budget warning/);
    expect(inst.budget._budgetWarningSent).toBe(true);
  });

  it("90% 警告只发一次：第二次调用不再发", async () => {
    const inst = makeInstance({ maxTokens: 1000, usedTokens: 900 });
    const cb = makeCallbacks();
    await checkBudget(inst, inst.runId, cb);
    cb.postMessage.mockClear();
    await checkBudget(inst, inst.runId, cb);

    expect(cb.postMessage).not.toHaveBeenCalled();
  });

  it("未达 90% 时不发送警告", async () => {
    const inst = makeInstance({ maxTokens: 1000, usedTokens: 500 });
    const cb = makeCallbacks();
    await checkBudget(inst, inst.runId, cb);

    expect(cb.postMessage).not.toHaveBeenCalled();
  });
});

describe("checkBudget — terminal guard", () => {
  it("terminal 状态短路：completed 实例不发警告、不终止", async () => {
    const inst = makeInstance({ maxTokens: 100, usedTokens: 999 }, "completed");
    const cb = makeCallbacks();
    await checkBudget(inst, inst.runId, cb);

    expect(inst.status).toBe("completed");
    expect(cb.terminateWorker).not.toHaveBeenCalled();
  });

  it("terminal 状态短路：failed 实例同理", async () => {
    const inst = makeInstance({ maxTokens: 100, usedTokens: 999 }, "failed");
    const cb = makeCallbacks();
    await checkBudget(inst, inst.runId, cb);

    expect(inst.status).toBe("failed");
  });
});

// ── scheduleTimeBudgetCheck ─────────────────────────────────

describe("scheduleTimeBudgetCheck", () => {
  it("elapsed >= maxTimeMs 时触发 time_limited", async () => {
    const inst = makeInstance({ maxTimeMs: 1000 });
    // startedAt 设置为 2000ms 前，elapsed 2000 > 1000
    const startedAt = new Date(Date.now() - 2000);
    inst.startedAt = startedAt.toISOString();

    const getInstance = vi.fn(() => inst);
    const cb = makeCallbacks();
    scheduleTimeBudgetCheck(getInstance, inst.runId, 1000, cb);

    // 推进 setTimeout
    await vi.advanceTimersByTimeAsync(1000);
    // 等异步 cb 执行
    await vi.runAllTimersAsync();

    expect(inst.status).toBe("time_limited");
    expect(inst.error).toMatch(/Time budget exceeded/);
    expect(cb.terminateWorker).toHaveBeenCalledWith(inst.runId);
    expect(cb.postMessage).toHaveBeenCalled();
    expect(cb.persistState).toHaveBeenCalled();
    expect(cb.onCompletion).toHaveBeenCalledWith(inst.runId);
  });

  it("elapsed < maxTimeMs 时不触发", async () => {
    const inst = makeInstance({ maxTimeMs: 120_000 });
    // startedAt = now，elapsed 0
    inst.startedAt = new Date().toISOString();

    const getInstance = vi.fn(() => inst);
    const cb = makeCallbacks();
    scheduleTimeBudgetCheck(getInstance, inst.runId, 120_000, cb);

    // 推进但不超过 budget（不能 runAllTimersAsync，那个会触发所有 timer）
    await vi.advanceTimersByTimeAsync(60_000);

    // status 仍是 running（未超限）
    expect(inst.status).toBe("running");
  });

  it("terminal 状态短路：completed 实例不触发", async () => {
    const inst = makeInstance({ maxTimeMs: 1000 }, "completed");
    inst.startedAt = new Date(Date.now() - 2000).toISOString();

    const getInstance = vi.fn(() => inst);
    const cb = makeCallbacks();
    scheduleTimeBudgetCheck(getInstance, inst.runId, 1000, cb);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.runAllTimersAsync();

    expect(inst.status).toBe("completed");
    expect(cb.terminateWorker).not.toHaveBeenCalled();
  });

  it("instance 为 undefined 时不抛错", async () => {
    const getInstance = vi.fn(() => undefined);
    const cb = makeCallbacks();
    scheduleTimeBudgetCheck(getInstance, "missing", 1000, cb);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.runAllTimersAsync();

    expect(cb.terminateWorker).not.toHaveBeenCalled();
  });
});
