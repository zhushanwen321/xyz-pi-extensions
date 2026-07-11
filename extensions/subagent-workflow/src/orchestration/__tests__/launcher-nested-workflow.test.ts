/**
 * executeNestedWorkflow — workflow() 嵌套调用实现测试。
 *
 * 覆盖 6 个场景：循环检测、registry 未找到、lint 失败、成功执行、budget 同步、
 * 子 workflow 失败。
 *
 * 通过 vi.mock("../lifecycle.ts") 控制 runWorkflow：返回固定 runId + 把预构造的
 * child run 注入 deps.runs，使 pollRunToResult 首轮即命中 done 返回（无需真实 worker）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Budget } from "../models/budget.ts";
import type { RunSpec } from "../models/run-spec.ts";
import type { LauncherDeps } from "../launcher.ts";
import type { LintResult } from "../script-lint.ts";
import type { WorkflowRun } from "../models/workflow-run.ts";
import type { WorkflowScript } from "../models/workflow-script.ts";

// ── module mock：lifecycle.runWorkflow 由各 test 配置 ──────────────────

vi.mock("../lifecycle.ts", () => ({
  runWorkflow: vi.fn(),
  abortRun: vi.fn(async () => {}),
  pauseRun: vi.fn(async () => {}),
  resumeRun: vi.fn(async () => {}),
  scheduleTimeBudget: vi.fn(() => undefined),
}));

// import 在 vi.mock 之后（hoisting 保证拿到 mock 版本）。runWorkflow 从被 mock 的
// lifecycle 模块导入，与 launcher.ts 内部引用的是同一 mock 实例。
import { runWorkflow } from "../lifecycle.ts";
import { executeNestedWorkflow } from "../launcher.ts";

const MOCK_RUN_ID = "wf-test-child";

// ── helpers ──────────────────────────────────────────────────

/** 构造 mock WorkflowScript（validate / toExecutable 可控）。 */
function makeScript(opts: { valid?: boolean; lintErrorMsg?: string } = {}): WorkflowScript {
  const valid = opts.valid ?? true;
  return {
    name: "child-wf",
    path: "/fake/child-wf.js",
    meta: { name: "child-wf", description: "child workflow", phases: [] },
    toExecutable: () => "const meta = {}; execute() {}",
    validate: (): LintResult => ({
      valid,
      findings: valid
        ? []
        : [
            {
              severity: "error",
              line: 3,
              message: opts.lintErrorMsg ?? "lint boom",
              suggestion: "fix it",
            },
          ],
    }),
  } as unknown as WorkflowScript;
}

/**
 * 构造 mock parent WorkflowRun。
 *
 * parentBudget 用真实 Budget 实例（remaining() + 可写 usedTokens/usedCost）。
 * controller 提供 AbortSignal（默认未 abort）。
 */
function makeParentRun(opts: {
  scriptName?: string;
  parentWorkflowChain?: readonly string[];
  budget?: Budget;
  aborted?: boolean;
} = {}): WorkflowRun {
  const controller = new AbortController();
  if (opts.aborted) controller.abort();
  const spec = {
    scriptName: opts.scriptName ?? "parent-wf",
    parentWorkflowChain: opts.parentWorkflowChain,
  };
  return {
    spec,
    state: { budget: opts.budget ?? new Budget({ maxTokens: 10000 }) },
    runtime: { controller },
  } as unknown as WorkflowRun;
}

/**
 * 构造 mock child WorkflowRun（done 终态，pollRunToResult 首轮命中）。
 *
 * childBudget 用普通对象（仅需 usedTokens/usedCost 供 budget 同步读取）。
 */
function makeDoneChildRun(opts: {
  reason?: "completed" | "failed" | "aborted";
  scriptResult?: unknown;
  error?: string;
  usedTokens?: number;
  usedCost?: number;
}): WorkflowRun {
  const reason = opts.reason ?? "completed";
  return {
    runId: MOCK_RUN_ID,
    spec: { scriptName: "child-wf" },
    state: {
      status: "done",
      reason,
      scriptResult: opts.scriptResult,
      error: opts.error,
      budget: { usedTokens: opts.usedTokens ?? 0, usedCost: opts.usedCost ?? 0 },
    },
  } as unknown as WorkflowRun;
}

/** 构造 LauncherDeps mock：registry + runs（Map）+ 占位 port。 */
function makeDeps(opts: {
  script?: WorkflowScript;
  childRun?: WorkflowRun;
  registry?: { get: ReturnType<typeof vi.fn> };
} = {}): LauncherDeps {
  const runs = new Map<string, WorkflowRun>();
  if (opts.childRun) runs.set(MOCK_RUN_ID, opts.childRun);
  const registry = opts.registry ?? {
    get: vi.fn(async () => opts.script),
  };
  return {
    registry,
    runs,
    store: { save: vi.fn(async () => {}), loadAll: vi.fn(async () => []) },
    workerHost: { start: vi.fn(() => ({ postMessage: vi.fn() })) },
    runner: { run: vi.fn(async () => ({})) },
    log: vi.fn(),
    eventBus: { emit: vi.fn() },
  } as unknown as LauncherDeps;
}

/** 配置 runWorkflow mock：把 childRun 注入 deps.runs 并返回 MOCK_RUN_ID。 */
function setupRunWorkflow(childRun: WorkflowRun): void {
  vi.mocked(runWorkflow).mockImplementation(async (_spec, deps) => {
    deps.runs.set(MOCK_RUN_ID, childRun);
    return MOCK_RUN_ID;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── tests ────────────────────────────────────────────────────

describe("executeNestedWorkflow", () => {
  it("returns error result when workflow not found", async () => {
    const parent = makeParentRun();
    const deps = makeDeps({ script: undefined });

    const result = await executeNestedWorkflow("missing", {}, parent, deps);

    expect(result.error).toBe("Workflow 'missing' not found");
    expect(result.content).toBe("");
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it("returns error result on lint failure", async () => {
    const parent = makeParentRun();
    const deps = makeDeps({ script: makeScript({ valid: false, lintErrorMsg: "no entry point" }) });

    const result = await executeNestedWorkflow("child-wf", {}, parent, deps);

    expect(result.error).toContain("has lint errors");
    expect(result.error).toContain("no entry point");
    expect(result.content).toBe("");
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it("detects circular call chain", async () => {
    // parent chain ["a"], parent scriptName "b", target name "a" → a→b→a 循环
    const parent = makeParentRun({
      scriptName: "b",
      parentWorkflowChain: ["a"],
    });
    const deps = makeDeps({ script: makeScript() });

    const result = await executeNestedWorkflow("a", {}, parent, deps);

    expect(result.error).toContain("Circular workflow call detected");
    expect(result.error).toContain("a → b → a");
    expect(result.content).toBe("");
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it("executes child workflow and returns result on success", async () => {
    const parent = makeParentRun();
    const childRun = makeDoneChildRun({
      reason: "completed",
      scriptResult: { summary: "done" },
    });
    const deps = makeDeps({ script: makeScript(), childRun });
    setupRunWorkflow(childRun);

    const result = await executeNestedWorkflow("child-wf", { k: 1 }, parent, deps);

    // content = JSON.stringify(scriptResult)；parsedOutput 原样回传对象
    expect(result.error).toBeUndefined();
    expect(result.content).toBe(JSON.stringify({ summary: "done" }));
    expect(result.parsedOutput).toEqual({ summary: "done" });
    expect(runWorkflow).toHaveBeenCalledTimes(1);
  });

  it("shares parent budget reference with child run (no sync-back)", async () => {
    const parentBudget = new Budget({ maxTokens: 10000 });
    parentBudget.usedTokens = 100;
    const parent = makeParentRun({ budget: parentBudget });
    const childRun = makeDoneChildRun({
      reason: "completed",
      scriptResult: "ok",
    });
    const deps = makeDeps({ script: makeScript(), childRun });

    // 捕获传给 runWorkflow 的 spec——验证 budgetRef 共享父 Budget 引用
    let capturedSpec: RunSpec | undefined;
    vi.mocked(runWorkflow).mockImplementation(async (spec, d) => {
      capturedSpec = spec;
      d.runs.set(MOCK_RUN_ID, childRun);
      return MOCK_RUN_ID;
    });

    await executeNestedWorkflow("child-wf", {}, parent, deps);

    // 子 run 直接复用父 Budget 引用（budgetRef），而非独立 Budget + sync-back
    expect(capturedSpec?.budgetRef).toBe(parentBudget);
    expect(capturedSpec?.budgetTokens).toBeUndefined();
    // 无 sync-back：parent budget 不被 launcher 直接修改（mock 未真实 consume）
    expect(parent.state.budget.usedTokens).toBe(100);
  });

  it("returns error result when child workflow fails", async () => {
    const parent = makeParentRun();
    const childRun = makeDoneChildRun({
      reason: "failed",
      error: "agent exploded",
    });
    const deps = makeDeps({ script: makeScript(), childRun });
    setupRunWorkflow(childRun);

    const result = await executeNestedWorkflow("child-wf", {}, parent, deps);

    expect(result.content).toBe("");
    expect(result.error).toBe("agent exploded");
  });
});
