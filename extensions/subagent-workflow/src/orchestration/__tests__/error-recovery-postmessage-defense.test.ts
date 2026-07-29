// src/orchestration/__tests__/error-recovery-postmessage-defense.test.ts
//
// W2: 主线程层 postMessage 防御测试。
//
// 背景：主线程有 3 处 run.runtime?.worker.postMessage(...) 调用（经 helper 函数），
// 全部没有 try/catch。若 result 对象含不可克隆成员（function/Symbol/循环引用），
// postMessage 同步抛 DataCloneError：
// - postAgentResult：result 是 agent 返回值，不可克隆概率最高。DataCloneError 冒泡到
//   dispatchAgentCall 的 .then 回调，中断后续 postBudgetUpdate/store.save/budget 检查，
//   run 卡在 running。
// - postBudgetUpdate：payload 是 number，风险低但无兜底。
// - dispatchWorkflowCall 的 postResult：result 是子 workflow 任意返回值。
//
// 修复后三处均包 try/catch + fallback。本测试通过 mock worker.postMessage 抛
// DataCloneError，验证：
// 1. 调用方不抛错（流程不中断）
// 2. fallback result（纯字符串，必可克隆）被发送
// 3. console.error 记录诊断

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { handleWorkerMessage, postBudgetUpdate } from "../error-recovery.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import type { WorkflowRun } from "../models/workflow-run.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ERROR_RECOVERY_SRC = readFileSync(
  join(__dirname, "../error-recovery.ts"),
  "utf-8",
);

// ── helpers ──────────────────────────────────────────────────

/** flush microtask 队列，让 void .then().catch() 链路跑完。 */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 构造一个 postMessage mock：前 n 次抛 DataCloneError，之后正常（模拟 fallback 成功）。 */
function makeFailingPostMessage(failTimes: number): ReturnType<typeof vi.fn> {
  let calls = 0;
  return vi.fn(() => {
    calls += 1;
    if (calls <= failTimes) {
      const err = new Error("Could not clone object: function found");
      err.name = "DataCloneError";
      throw err;
    }
    // fallback 成功路径：no-op
  });
}

/** 构造一个永远抛 DataCloneError 的 postMessage mock（fallback 也失败）。 */
function makeAlwaysFailingPostMessage(): ReturnType<typeof vi.fn> {
  return vi.fn(() => {
    const err = new Error("Could not clone object");
    err.name = "DataCloneError";
    throw err;
  });
}

/** 构造 status="running" 的 mock WorkflowRun，postMessage 由调用方注入。 */
function makeRunningRun(postMessage: ReturnType<typeof vi.fn>): WorkflowRun {
  return {
    state: { status: "running" },
    runtime: { worker: { postMessage } },
  } as unknown as WorkflowRun;
}

/** LifecycleDeps 只需 onWorkflowCall（dispatchWorkflowCall 唯一消费的 dep）。 */
function makeDeps(onWorkflowCall?: LifecycleDeps["onWorkflowCall"]): LifecycleDeps {
  return { onWorkflowCall } as unknown as LifecycleDeps;
}

/** WorkerHandlers 占位（workflow-call 路径不触发 handler 回调）。 */
function makeHandlers(): WorkerHandlers {
  return {
    onMessage: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
    onExit: vi.fn(async () => {}),
  } as unknown as WorkerHandlers;
}

interface PostedMsg {
  type: string;
  callId?: number;
  result?: { content: string; error?: string };
  budget?: { usedTokens: number; usedCost: number };
  cached?: boolean;
}

/** 从 postMessage mock 取第 idx 次调用的第 0 参。 */
function postedAt(postMessage: ReturnType<typeof vi.fn>, idx: number): PostedMsg {
  return postMessage.mock.calls[idx]![0] as PostedMsg;
}

/** 静默 console.error（防御路径会打印诊断，避免污染测试输出）。 */
function silenceConsoleError(): () => void {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => spy.mockRestore();
}

// ── W2a: postBudgetUpdate try/catch ──

describe("W2a: postBudgetUpdate 防御 DataCloneError", () => {
  it("postMessage 抛错时不向上传播（流程不中断）", () => {
    const restore = silenceConsoleError();
    try {
      const postMessage = makeAlwaysFailingPostMessage();
      const run = {
        state: {
          status: "running",
          budget: { usedTokens: 42, usedCost: 0.5 },
        },
        runtime: { worker: { postMessage } },
      } as unknown as WorkflowRun;

      // 不应抛错——防御性兜底
      expect(() => postBudgetUpdate(run)).not.toThrow();
    } finally {
      restore();
    }
  });

  it("postMessage 失败时记录 console.error 诊断", () => {
    const restore = silenceConsoleError();
    try {
      const postMessage = makeAlwaysFailingPostMessage();
      const run = {
        state: {
          status: "running",
          budget: { usedTokens: 42, usedCost: 0.5 },
        },
        runtime: { worker: { postMessage } },
      } as unknown as WorkflowRun;

      postBudgetUpdate(run);

      expect(console.error).toHaveBeenCalledTimes(1);
      const diag = (console.error as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(diag).toContain("postBudgetUpdate failed");
      expect(diag).toContain("Could not clone object");
    } finally {
      restore();
    }
  });

  it("正常 payload（纯 number）成功发送", () => {
    const postMessage = vi.fn();
    const run = {
      state: {
        status: "running",
        budget: { usedTokens: 42, usedCost: 0.5 },
      },
      runtime: { worker: { postMessage } },
    } as unknown as WorkflowRun;

    postBudgetUpdate(run);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postedAt(postMessage, 0)).toEqual({
      type: "budget-update",
      budget: { usedTokens: 42, usedCost: 0.5 },
    });
  });
});

// ── W2b: dispatchWorkflowCall postResult 闭包防御 ──

describe("W2b: dispatchWorkflowCall postResult 防御 DataCloneError", () => {
  it("result 不可克隆 → 回发纯字符串 fallback result", async () => {
    const restore = silenceConsoleError();
    try {
      // 第 1 次 postMessage 抛 DataCloneError（原始 result 不可克隆），
      // 第 2 次（fallback）成功。
      const postMessage = makeFailingPostMessage(1);
      const onWorkflowCall = vi.fn(async () => ({ nonCloneable: () => {} }));
      const run = makeRunningRun(postMessage);
      const deps = makeDeps(onWorkflowCall);

      await handleWorkerMessage(
        run,
        { type: "workflow-call", callId: 9, name: "sub", args: {} },
        deps,
        makeHandlers(),
      );
      await flushMicrotasks();

      // 调用两次：1 原始（失败）+ 1 fallback（成功）
      expect(postMessage).toHaveBeenCalledTimes(2);
      const fallback = postedAt(postMessage, 1);
      expect(fallback.type).toBe("workflow-result");
      expect(fallback.callId).toBe(9);
      expect(fallback.result?.content).toBe("");
      expect(fallback.result?.error).toContain("Workflow result serialization failed");
    } finally {
      restore();
    }
  });

  it("postResult 不抛错到调用方（不中断 onWorkflowCall 链路）", async () => {
    const restore = silenceConsoleError();
    try {
      const postMessage = makeAlwaysFailingPostMessage();
      const onWorkflowCall = vi.fn(async () => ({ bad: () => {} }));
      const run = makeRunningRun(postMessage);
      const deps = makeDeps(onWorkflowCall);

      // handleWorkerMessage 自身不应抛——postResult 内部已 catch
      await expect(
        handleWorkerMessage(
          run,
          { type: "workflow-call", callId: 10, name: "sub", args: {} },
          deps,
          makeHandlers(),
        ),
      ).resolves.toBeUndefined();
      await flushMicrotasks();
    } finally {
      restore();
    }
  });

  it("fallback 也失败 → console.error 记录 worker pending 将挂起", async () => {
    const restore = silenceConsoleError();
    try {
      const postMessage = makeAlwaysFailingPostMessage();
      const onWorkflowCall = vi.fn(async () => ({ bad: () => {} }));
      const run = makeRunningRun(postMessage);
      const deps = makeDeps(onWorkflowCall);

      await handleWorkerMessage(
        run,
        { type: "workflow-call", callId: 11, name: "sub", args: {} },
        deps,
        makeHandlers(),
      );
      await flushMicrotasks();

      // 至少 2 次尝试（原始 + fallback），fallback 失败也记日志
      expect(postMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
      const errorCalls = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
      expect(errorCalls.some((s) => s.includes("fallback also failed"))).toBe(true);
    } finally {
      restore();
    }
  });
});

// ── W2c: postAgentResult 防御（经 handleWorkerMessage 触发） ──
//
// postAgentResult 是私有函数，通过 workflow-call 路径无法触发——但它与 postResult
// 闭包采用完全一致的防御模式（try/catch + 纯字符串 fallback）。
// postResult 路径的测试（W2b）已充分覆盖该模式的正确性。
// 这里补充：验证 error-recovery.ts 源码中三处 postMessage 调用点都有 try/catch 包裹，
// 防止未来重构误删防御（类似 worker-script-builder.test.ts 的源码字符串断言模式）。

describe("W2c: postAgentResult 防御（源码结构断言）", () => {
  /** 校验：给定函数体内的 postMessage 调用被 try/catch 包裹。
   *  简化策略——在函数体片段中确认存在 try { ... postMessage ... } catch。 */
  function hasTryCatchAroundPostMessage(funcBody: string): boolean {
    return /try\s*\{[\s\S]*?postMessage[\s\S]*?\}\s*catch/.test(funcBody);
  }

  it("postAgentResult 包含 try/catch + fallback result", () => {
    const match = ERROR_RECOVERY_SRC.match(/function postAgentResult\([\s\S]*?\n\}/);
    expect(match, "postAgentResult 函数定义应存在").toBeTruthy();
    expect(hasTryCatchAroundPostMessage(match![0])).toBe(true);
    // fallback 回发纯字符串 result（必可克隆）
    expect(match![0]).toContain('result: { content: "", error:');
    expect(match![0]).toContain("Result serialization failed");
  });

  it("postBudgetUpdate 包含 try/catch", () => {
    const match = ERROR_RECOVERY_SRC.match(/export function postBudgetUpdate\([\s\S]*?\n\}/);
    expect(match, "postBudgetUpdate 函数定义应存在").toBeTruthy();
    expect(hasTryCatchAroundPostMessage(match![0])).toBe(true);
  });

  it("dispatchWorkflowCall postResult 闭包包含 try/catch + fallback", () => {
    // postResult 是 const 闭包，匹配到下一个 }; 结尾
    const match = ERROR_RECOVERY_SRC.match(/const postResult = \(result[\s\S]*?\n  \};/);
    expect(match, "postResult 闭包定义应存在").toBeTruthy();
    expect(hasTryCatchAroundPostMessage(match![0])).toBe(true);
    expect(match![0]).toContain("Workflow result serialization failed");
    // 防御变量名遮蔽：错误变量用 err 而非 msg（外层参数名 msg）
    expect(match![0]).toMatch(/catch \(err\)/);
  });
});
