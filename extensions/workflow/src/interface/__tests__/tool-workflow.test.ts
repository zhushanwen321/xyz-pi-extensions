// 测试框架：vitest
// 运行命令：npx vitest run src/interface/__tests__/tool-workflow.test.ts
//
// tool-workflow（7 actions: run/status/pause/resume/abort/retry-node/skip-node）测试。
// 不实际启动 worker——mock deps.runner + deps.workerHost。

/* eslint-disable taste/no-unsafe-cast */

import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { Budget } from "../../engine/models/budget.js";
import type { AgentRunner, RunStore, WorkerHost } from "../../engine/models/ports.js";
import { RunRuntime } from "../../engine/models/run-runtime.js";
import { Trace } from "../../engine/models/trace.js";
import { WorkflowRun } from "../../engine/models/workflow-run.js";
import { WorkflowScript } from "../../engine/models/workflow-script.js";
import type { WorkflowScriptRegistry } from "../../engine/models/workflow-script-registry.js";
import { ConcurrencyGate } from "../../infra/concurrency-gate.js";
import { WorkerHandle } from "../../infra/worker-handle.js";
import { registerWorkflowTool } from "../tool-workflow.js";

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

function makeRun(runId = "wf-test-1"): WorkflowRun {
  const run = new WorkflowRun(
    runId,
    {
      scriptSource: 'agent({ prompt: "hi" });',
      args: {},
      scriptName: "test-wf",
      scriptPath: "/abs/test-wf.js",
    },
    {
      status: "paused",
      budget: new Budget(),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: new Date().toISOString() },
  );
  const worker = new WorkerHandle(asWorker(createFakeWorker()));
  const gate = new ConcurrencyGate({ maxConcurrency: 4 });
  run.assignRuntime(new RunRuntime(worker, gate, new AbortController()));
  return run;
}

function makeDeps(run?: WorkflowRun): {
  store: RunStore;
  workerHost: WorkerHost;
  runner: AgentRunner;
  runs: Map<string, WorkflowRun>;
  registry: WorkflowScriptRegistry;
} {
  const runs = new Map<string, WorkflowRun>();
  if (run) runs.set(run.runId, run);
  return {
    store: { save: vi.fn().mockResolvedValue(undefined), loadAll: vi.fn().mockResolvedValue([]) },
    workerHost: {
      start: vi.fn().mockReturnValue(new WorkerHandle(asWorker(createFakeWorker()))),
    },
    runner: { run: vi.fn().mockResolvedValue({ content: "ok" }) },
    runs,
    registry: {
      loadAll: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(undefined),
      invalidate: vi.fn(),
    },
  };
}

function makeApi(): ExtensionAPI {
  return {
    registerTool: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
}

function makeCtx(hasUI = true): ExtensionContext {
  return {
    hasUI,
    sessionManager: { getSessionId: vi.fn().mockReturnValue("test-session") },
    ui: { confirm: vi.fn().mockResolvedValue(true), notify: vi.fn() },
  } as unknown as ExtensionContext;
}

function makeScript(name = "test-wf", source: "saved" | "tmp" = "saved"): WorkflowScript {
  return new WorkflowScript({
    name,
    source,
    path: `/abs/.pi/workflows/${name}.js`,
    sourceCode: `const meta = { name: "${name}" }; agent({ prompt: "hi" });`,
    meta: { name, description: `desc ${name}`, phases: [] },
    available: true,
  });
}

async function runAction(
  registered: Array<{ execute: (...args: unknown[]) => Promise<unknown> }>,
  params: Record<string, unknown>,
  ctx?: ExtensionContext,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: string; text: string }>; details: unknown; isError?: boolean }> {
  return (await registered[0].execute(
    "call-1",
    params,
    signal ?? undefined,
    undefined,
    ctx ?? makeCtx(),
  )) as { content: Array<{ type: string; text: string }>; details: unknown; isError?: boolean };
}

// ── run action ───────────────────────────────────────────────

describe("workflow run action", () => {
  it("未找到 workflow → error + suggestions", async () => {
    const api = makeApi();
    const deps = makeDeps();
    const registered: Array<{ execute: (...args: unknown[]) => Promise<unknown> }> = [];
    vi.mocked(api.registerTool).mockImplementation((tool: { execute: (...args: unknown[]) => Promise<unknown> }) => {
      registered.push(tool);
    });
    registerWorkflowTool(api, deps as never, new Set(), { isProcessing: false });
    const result = await runAction(registered, { action: "run", name: "missing" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("找到 saved + approved → 直接启动（不需确认）", async () => {
    const api = makeApi();
    const script = makeScript("test-wf");
    const deps = makeDeps();
    deps.registry.get = vi.fn().mockResolvedValue(script);
    const approved = new Set(["test-wf"]);
    const registered: Array<{ execute: (...args: unknown[]) => Promise<unknown> }> = [];
    vi.mocked(api.registerTool).mockImplementation((tool: { execute: (...args: unknown[]) => Promise<unknown> }) => {
      registered.push(tool);
    });
    registerWorkflowTool(api, deps as never, approved, { isProcessing: false });
    const result = await runAction(registered, { action: "run", name: "test-wf" });
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({ action: "run", status: "running", name: "test-wf" });
    expect(deps.workerHost.start).toHaveBeenCalled();
  });

  it("缺 name → error", async () => {
    const api = makeApi();
    const deps = makeDeps();
    const registered: Array<{ execute: (...args: unknown[]) => Promise<unknown> }> = [];
    vi.mocked(api.registerTool).mockImplementation((tool: { execute: (...args: unknown[]) => Promise<unknown> }) => {
      registered.push(tool);
    });
    registerWorkflowTool(api, deps as never, new Set(), { isProcessing: false });
    const result = await runAction(registered, { action: "run" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("name");
  });
});

// ── status action ────────────────────────────────────────────

describe("workflow status action", () => {
  it("空 runs → 'No workflows'", async () => {
    const api = makeApi();
    const deps = makeDeps();
    const registered: Array<{ execute: (...args: unknown[]) => Promise<unknown> }> = [];
    vi.mocked(api.registerTool).mockImplementation((tool: { execute: (...args: unknown[]) => Promise<unknown> }) => {
      registered.push(tool);
    });
    registerWorkflowTool(api, deps as never, new Set(), { isProcessing: false });
    const result = await runAction(registered, { action: "status" });
    expect(result.content[0].text).toContain("No workflows");
  });

  it("有 runs → 列出（含 name + status）", async () => {
    const api = makeApi();
    const run = makeRun("wf-abc123");
    const deps = makeDeps(run);
    const registered: Array<{ execute: (...args: unknown[]) => Promise<unknown> }> = [];
    vi.mocked(api.registerTool).mockImplementation((tool: { execute: (...args: unknown[]) => Promise<unknown> }) => {
      registered.push(tool);
    });
    registerWorkflowTool(api, deps as never, new Set(), { isProcessing: false });
    const result = await runAction(registered, { action: "status" });
    expect(result.content[0].text).toContain("test-wf");
    expect(result.content[0].text).toContain("running");
  });
});

// ── pause/resume/abort ───────────────────────────────────────

describe("workflow pause/resume/abort", () => {
  it("pause → running→paused", async () => {
    const api = makeApi();
    const run = makeRun();
    const deps = makeDeps(run);
    const registered: Array<{ execute: (...args: unknown[]) => Promise<unknown> }> = [];
    vi.mocked(api.registerTool).mockImplementation((tool: { execute: (...args: unknown[]) => Promise<unknown> }) => {
      registered.push(tool);
    });
    registerWorkflowTool(api, deps as never, new Set(), { isProcessing: false });
    const result = await runAction(registered, { action: "pause", runId: run.runId });
    expect(result.isError).toBeUndefined();
    expect(run.state.status).toBe("paused");
    expect(result.content[0].text).toContain("paused");
  });

  it("resume → paused→running（先 pause 再 resume）", async () => {
    const api = makeApi();
    const run = makeRun();
    const deps = makeDeps(run);
    const registered: Array<{ execute: (...args: unknown[]) => Promise<unknown> }> = [];
    vi.mocked(api.registerTool).mockImplementation((tool: { execute: (...args: unknown[]) => Promise<unknown> }) => {
      registered.push(tool);
    });
    registerWorkflowTool(api, deps as never, new Set(), { isProcessing: false });
    await runAction(registered, { action: "pause", runId: run.runId });
    const result = await runAction(registered, { action: "resume", runId: run.runId });
    expect(run.state.status).toBe("running");
    expect(result.content[0].text).toContain("running");
  });

  it("abort → done,aborted", async () => {
    const api = makeApi();
    const run = makeRun();
    const deps = makeDeps(run);
    const registered: Array<{ execute: (...args: unknown[]) => Promise<unknown> }> = [];
    vi.mocked(api.registerTool).mockImplementation((tool: { execute: (...args: unknown[]) => Promise<unknown> }) => {
      registered.push(tool);
    });
    registerWorkflowTool(api, deps as never, new Set(), { isProcessing: false });
    await runAction(registered, {
      action: "abort",
      runId: run.runId,
      error: "user requested",
    });
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("aborted");
    expect(run.state.error).toBe("user requested");
  });

  it("缺 runId → error", async () => {
    const api = makeApi();
    const deps = makeDeps();
    const registered: Array<{ execute: (...args: unknown[]) => Promise<unknown> }> = [];
    vi.mocked(api.registerTool).mockImplementation((tool: { execute: (...args: unknown[]) => Promise<unknown> }) => {
      registered.push(tool);
    });
    registerWorkflowTool(api, deps as never, new Set(), { isProcessing: false });
    const result = await runAction(registered, { action: "pause" });
    expect(result.isError).toBe(true);
  });

  it("runId 不存在 → error", async () => {
    const api = makeApi();
    const deps = makeDeps();
    const registered: Array<{ execute: (...args: unknown[]) => Promise<unknown> }> = [];
    vi.mocked(api.registerTool).mockImplementation((tool: { execute: (...args: unknown[]) => Promise<unknown> }) => {
      registered.push(tool);
    });
    registerWorkflowTool(api, deps as never, new Set(), { isProcessing: false });
    const result = await runAction(registered, { action: "abort", runId: "wf-missing" });
    expect(result.isError).toBe(true);
  });
});

// ── retry-node / skip-node ───────────────────────────────────

describe("workflow retry-node / skip-node", () => {
  it("retry-node 缺 callId → error", async () => {
    const api = makeApi();
    const run = makeRun();
    const deps = makeDeps(run);
    const registered: Array<{ execute: (...args: unknown[]) => Promise<unknown> }> = [];
    vi.mocked(api.registerTool).mockImplementation((tool: { execute: (...args: unknown[]) => Promise<unknown> }) => {
      registered.push(tool);
    });
    registerWorkflowTool(api, deps as never, new Set(), { isProcessing: false });
    const result = await runAction(registered, { action: "retry-node", runId: run.runId });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("callId");
  });

  it("skip-node 缺 runId → error", async () => {
    const api = makeApi();
    const deps = makeDeps();
    const registered: Array<{ execute: (...args: unknown[]) => Promise<unknown> }> = [];
    vi.mocked(api.registerTool).mockImplementation((tool: { execute: (...args: unknown[]) => Promise<unknown> }) => {
      registered.push(tool);
    });
    registerWorkflowTool(api, deps as never, new Set(), { isProcessing: false });
    const result = await runAction(registered, { action: "skip-node", callId: 0 });
    expect(result.isError).toBe(true);
  });
});

// ── reentry guard ────────────────────────────────────────────

describe("workflow reentry guard", () => {
  it("guard 占用时返回 busy", async () => {
    const api = makeApi();
    const deps = makeDeps();
    const registered: Array<{ execute: (...args: unknown[]) => Promise<unknown> }> = [];
    vi.mocked(api.registerTool).mockImplementation((tool: { execute: (...args: unknown[]) => Promise<unknown> }) => {
      registered.push(tool);
    });
    registerWorkflowTool(api, deps as never, new Set(), { isProcessing: true }); // 已占用
    const result = await runAction(registered, { action: "status" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("in progress");
  });
});

// ── signal abort ─────────────────────────────────────────────

describe("workflow signal abort", () => {
  it("signal aborted → 立即返回 error", async () => {
    const api = makeApi();
    const deps = makeDeps();
    const registered: Array<{ execute: (...args: unknown[]) => Promise<unknown> }> = [];
    vi.mocked(api.registerTool).mockImplementation((tool: { execute: (...args: unknown[]) => Promise<unknown> }) => {
      registered.push(tool);
    });
    registerWorkflowTool(api, deps as never, new Set(), { isProcessing: false });
    const controller = new AbortController();
    controller.abort();
    const result = await runAction(registered, { action: "status" }, undefined, controller.signal);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("aborted");
  });
});

// ── 注册 ─────────────────────────────────────────────────────

describe("registerWorkflowTool 注册", () => {
  it("注册名为 'workflow' 的 tool", () => {
    const api = makeApi();
    registerWorkflowTool(api, makeDeps() as never, new Set(), { isProcessing: false });
    expect(api.registerTool).toHaveBeenCalledTimes(1);
  });
});
