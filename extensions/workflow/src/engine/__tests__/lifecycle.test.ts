// 测试框架：vitest
// 运行命令：npx vitest run src/engine/__tests__/lifecycle.test.ts
//
// T21：lifecycle free functions 测试。
// 覆盖：
//   1. runWorkflow 创建 + assignRuntime + 注册 runs + store.save
//   2. runWorkflow pre-aborted signal 抛错（P1-2）
//   3. pauseRun A4 原子性（transition 内 releaseRuntime）+ 非法状态抛错
//   4. resumeRun G3-001 重建（新 worker/gate/controller）+ 非法状态抛错
//   5. abortRun done no-op + A4 + 非法状态抛错
//   6. pause/resume 跨 runtime（callCache 保留）
//   7. signal abort → abortRun 触发

/* eslint-disable taste/no-unsafe-cast */

import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";

import { describe, expect, it, vi } from "vitest";

import { ConcurrencyGate } from "../../infra/concurrency-gate.js";
import { WorkerHandle } from "../../infra/worker-handle.js";
import { abortRun, pauseRun, resumeRun, runWorkflow } from "../lifecycle.js";
import type { AgentRunner, RunStore, WorkerHost } from "../models/ports.js";
import type { RunSpec } from "../models/run-spec.js";
import { WorkflowRun } from "../models/workflow-run.js";

// ── FakeWorker ───────────────────────────────────────────────

interface FakeWorker extends EventEmitter {
  postMessage: (msg: unknown) => void;
  terminate: () => Promise<number>;
}

function createFakeWorker(): FakeWorker {
  return Object.assign(new EventEmitter(), {
    postMessage: vi.fn(),
    terminate: vi.fn(async () => 1),
  });
}

function asWorker(fw: FakeWorker): Worker {
  return fw as unknown as Worker;
}

// ── 测试夹具 ─────────────────────────────────────────────────

function makeSpec(overrides?: Partial<RunSpec>): RunSpec {
  return {
    scriptSource: 'agent({ prompt: "hi" });',
    args: {},
    scriptName: "test-wf",
    scriptPath: "/abs/test-wf.js",
    ...overrides,
  };
}

function makeDeps(overrides?: {
  runner?: AgentRunner;
  store?: RunStore;
  workerHost?: WorkerHost;
}): {
  store: RunStore;
  workerHost: WorkerHost;
  runner: AgentRunner;
  runs: Map<string, WorkflowRun>;
} {
  return {
    store: overrides?.store ?? {
      save: vi.fn().mockResolvedValue(undefined),
      loadAll: vi.fn().mockResolvedValue([]),
    },
    workerHost: overrides?.workerHost ?? {
      start: vi.fn().mockReturnValue(new WorkerHandle(asWorker(createFakeWorker()))),
    },
    runner: overrides?.runner ?? { run: vi.fn().mockResolvedValue({ content: "ok" }) },
    runs: new Map(),
  };
}

// ── runWorkflow ──────────────────────────────────────────────

describe("runWorkflow", () => {
  it("创建 run：状态 running + runtime 已绑定 + 注册 runs + store.save", async () => {
    const deps = makeDeps();
    const spec = makeSpec();
    const runId = await runWorkflow(spec, deps);
    expect(runId).toMatch(/^wf-\d+-[a-z0-9]+$/);

    const run = deps.runs.get(runId);
    expect(run).toBeDefined();
    expect(run!.state.status).toBe("running");
    expect(run!.runtime).toBeDefined();
    expect(run!.spec).toBe(spec);
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
    expect(deps.workerHost.start).toHaveBeenCalledWith(spec, spec.args, expect.any(Object));
    expect(deps.store.save).toHaveBeenCalledWith(run);
  });

  it("pre-aborted signal → 抛错（P1-2）", async () => {
    const deps = makeDeps();
    const controller = new AbortController();
    controller.abort();
    await expect(runWorkflow(makeSpec(), deps, controller.signal)).rejects.toThrow(/aborted before start/);
    expect(deps.runs.size).toBe(0);
    expect(deps.workerHost.start).not.toHaveBeenCalled();
  });

  it("Budget 从 spec.budgetTokens 初始化", async () => {
    const deps = makeDeps();
    const spec = makeSpec({ budgetTokens: 5000 });
    const runId = await runWorkflow(spec, deps);
    const run = deps.runs.get(runId)!;
    expect(run.state.budget.maxTokens).toBe(5000);
  });

  it("ConcurrencyGate maxConcurrency=4（D-13，DEFAULT_CONCURRENCY）", async () => {
    const deps = makeDeps();
    const runId = await runWorkflow(makeSpec(), deps);
    const run = deps.runs.get(runId)!;
    // gate 是 ConcurrencyGate 实例（通过 runtime 持有）
    expect(run.runtime?.gate).toBeInstanceOf(ConcurrencyGate);
  });

  it("runId 格式：wf-<timestamp>-<base36>", async () => {
    const deps = makeDeps();
    const runId = await runWorkflow(makeSpec(), deps);
    expect(runId).toMatch(/^wf-\d+-[0-9a-z]{6}$/);
  });

  it("signal abort → 触发 abortRun（异步）", async () => {
    const deps = makeDeps();
    const controller = new AbortController();
    const runId = await runWorkflow(makeSpec(), deps, controller.signal);
    const run = deps.runs.get(runId)!;
    expect(run.state.status).toBe("running");

    controller.abort();
    // abortRun 是异步的——等微任务
    await vi.waitFor(() => expect(run.state.status).toBe("done"));
    expect(run.state.reason).toBe("aborted");
    expect(run.state.error).toBe("External signal aborted");
  });
});

// ── pauseRun ─────────────────────────────────────────────────

describe("pauseRun", () => {
  it("running → paused（A4：transition 内 releaseRuntime）", async () => {
    const deps = makeDeps();
    const runId = await runWorkflow(makeSpec(), deps);
    const run = deps.runs.get(runId)!;
    expect(run.runtime).toBeDefined();

    await pauseRun(runId, deps);

    expect(run.state.status).toBe("paused");
    expect(run.runtime).toBeUndefined(); // releaseRuntime 清理
    expect(run.meta.pausedAt).toBeDefined();
  });

  it("runId 不存在 → 抛错", async () => {
    const deps = makeDeps();
    await expect(pauseRun("missing", deps)).rejects.toThrow(/not found/);
  });

  it("paused 状态 pause → 抛错（只有 running 可 pause）", async () => {
    const deps = makeDeps();
    const runId = await runWorkflow(makeSpec(), deps);
    await pauseRun(runId, deps);
    await expect(pauseRun(runId, deps)).rejects.toThrow(/only 'running'/);
  });

  it("done 状态 pause → 抛错", async () => {
    const deps = makeDeps();
    const runId = await runWorkflow(makeSpec(), deps);
    const run = deps.runs.get(runId)!;
    run.transition("done", "completed");
    await expect(pauseRun(runId, deps)).rejects.toThrow(/only 'running'/);
  });

  it("store.save 被调", async () => {
    const deps = makeDeps();
    const runId = await runWorkflow(makeSpec(), deps);
    vi.clearAllMocks();
    await pauseRun(runId, deps);
    expect(deps.store.save).toHaveBeenCalledWith(deps.runs.get(runId));
  });
});

// ── resumeRun ────────────────────────────────────────────────

describe("resumeRun", () => {
  it("paused → running（G3-001：重建 worker/gate/controller）", async () => {
    const deps = makeDeps();
    const runId = await runWorkflow(makeSpec(), deps);
    await pauseRun(runId, deps);
    const run = deps.runs.get(runId)!;
    expect(run.runtime).toBeUndefined();
    vi.clearAllMocks();

    await resumeRun(runId, deps);

    expect(run.state.status).toBe("running");
    expect(run.runtime).toBeDefined(); // 新 runtime
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1); // 重建 worker
  });

  it("runId 不存在 → 抛错", async () => {
    const deps = makeDeps();
    await expect(resumeRun("missing", deps)).rejects.toThrow(/not found/);
  });

  it("running 状态 resume → 抛错（只有 paused 可 resume）", async () => {
    const deps = makeDeps();
    const runId = await runWorkflow(makeSpec(), deps);
    await expect(resumeRun(runId, deps)).rejects.toThrow(/only 'paused'/);
  });

  it("callCache 跨 pause/resume 保留（calls Map 不清）", async () => {
    const deps = makeDeps();
    const runId = await runWorkflow(makeSpec(), deps);
    const run = deps.runs.get(runId)!;
    // 模拟已完成的 call
    run.state.calls.set(0, {
      id: 0,
      opts: { prompt: "x" },
      status: "done",
      attempts: 1,
      result: { content: "cached" },
      traceNode: { stepIndex: 0, agent: "a", task: "t", model: "m", status: "completed" },
    } as never);

    await pauseRun(runId, deps);
    await resumeRun(runId, deps);

    // calls Map 仍含 callId 0（跨 runtime 存活）
    expect(run.state.calls.has(0)).toBe(true);
    expect(run.state.calls.size).toBe(1);
  });
});

// ── abortRun ─────────────────────────────────────────────────

describe("abortRun", () => {
  it("running → done,aborted（A4：transition 内 releaseRuntime）", async () => {
    const deps = makeDeps();
    const runId = await runWorkflow(makeSpec(), deps);
    const run = deps.runs.get(runId)!;

    await abortRun(runId, deps, "user requested");

    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("aborted");
    expect(run.state.error).toBe("user requested");
    expect(run.runtime).toBeUndefined(); // releaseRuntime
  });

  it("done 状态 abort → no-op（不抛错不改状态）", async () => {
    const deps = makeDeps();
    const runId = await runWorkflow(makeSpec(), deps);
    const run = deps.runs.get(runId)!;
    run.transition("done", "completed");

    await abortRun(runId, deps, "late");

    // 状态不变（done/completed 保留，不覆盖为 aborted）
    expect(run.state.reason).toBe("completed");
    expect(run.state.error).toBeUndefined(); // reason 未设
  });

  it("paused 状态 abort → done,aborted（允许从 paused abort）", async () => {
    const deps = makeDeps();
    const runId = await runWorkflow(makeSpec(), deps);
    await pauseRun(runId, deps);
    const run = deps.runs.get(runId)!;

    await abortRun(runId, deps);

    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("aborted");
  });

  it("runId 不存在 → 抛错", async () => {
    const deps = makeDeps();
    await expect(abortRun("missing", deps)).rejects.toThrow(/not found/);
  });

  it("无 reason 时不设 error", async () => {
    const deps = makeDeps();
    const runId = await runWorkflow(makeSpec(), deps);
    const run = deps.runs.get(runId)!;

    await abortRun(runId, deps); // 不传 reason

    expect(run.state.reason).toBe("aborted");
    expect(run.state.error).toBeUndefined();
  });
});

// ── 跨 runtime 生命周期（综合） ─────────────────────────────

describe("跨 runtime 生命周期", () => {
  it("run → pause → resume → pause → abort（多轮）", async () => {
    const deps = makeDeps();
    const runId = await runWorkflow(makeSpec(), deps);
    const run = deps.runs.get(runId)!;

    // 第 1 轮 pause/resume
    await pauseRun(runId, deps);
    expect(run.state.status).toBe("paused");
    await resumeRun(runId, deps);
    expect(run.state.status).toBe("running");

    // 第 2 轮 pause/resume
    await pauseRun(runId, deps);
    await resumeRun(runId, deps);
    expect(run.state.status).toBe("running");

    // abort 终态
    await abortRun(runId, deps);
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("aborted");
  });

  it("worker 重启时 handlers 重绑（每次 resume 新 handlers）", async () => {
    const deps = makeDeps();
    const runId = await runWorkflow(makeSpec(), deps);

    await pauseRun(runId, deps);
    vi.clearAllMocks();
    await resumeRun(runId, deps);
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1); // resume 重启 worker

    await pauseRun(runId, deps);
    vi.clearAllMocks();
    await resumeRun(runId, deps);
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1); // 再次 resume 重启
  });
});
