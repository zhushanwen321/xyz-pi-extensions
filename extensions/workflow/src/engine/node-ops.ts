/**
 * Workflow Extension — node-ops（W3-T20）
 *
 * 单节点操作 free functions（D-12）。取代旧 engine/lifecycle.ts retryRunNode/skipRunNode。
 *
 * 2 个导出函数：
 *   - retryNode(run, callId, deps)  — 重置 call + 主线程重跑（不 replaceRuntime）
 *   - skipNode(run, callId, deps)   — 标记 call done + 占位 result
 *
 * **D.5 修复（方案 A）**：旧 retryRunNode 的语义混淆——它调 terminateWorker + startWorker
 * （整个 worker 重启），但 retryNode 的语义应是「重试单个失败 call」。worker 重启是
 * worker-error-retry（T19 handleWorkerError）的语义。本实现只重置 call 状态 + 主线程
 * 直接调 executeAgentCall，worker 不重启，已完成调用不受影响。
 *
 * **D.6 修复**：删除旧 retryRunNode 的 makeHandlersForRetry no-op stub（worker 重启路径
 * 已移除，无需构造空 handlers）。
 *
 * **G6-001**：retryNode 前置 status==="running"（paused 下拒绝，要 retry 先 resume）。
 *
 * 层归属：Engine。依赖 T2 LifecycleDeps + T16 WorkflowRun + T18 executeAgentCall。
 *
 * 参考：
 *   - domain-models.md §失败处理矩阵（retryNode 语义）
 *   - clarification.md D.5/D.6/G6-001
 *   - 旧 engine/lifecycle.ts retryRunNode/skipRunNode（行为来源）
 */

import { executeAgentCall } from "./execute-agent-call.js";
import type { LifecycleDeps } from "./models/ports.js";
import type { AgentResult } from "./models/types.js";
import type { WorkflowRun } from "./models/workflow-run.js";

// ── skipNode 占位结果 ────────────────────────────────────────

/** skipNode 注入的占位结果（零 usage，避免污染 budget）。 */
const SKIP_PLACEHOLDER: AgentResult = {
  content: "",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  },
};

// ── retryNode ────────────────────────────────────────────────

/**
 * 重试单个失败 agent call。
 *
 * **D.5 修复**：不 replaceRuntime、不重启 worker。只重置 call 状态（status=pending,
 * attempts=0, result=undefined）+ 同步 trace 节点 + 主线程直接调 executeAgentCall。
 * worker 仍在运行，已完成调用不受影响。
 *
 * 与 worker-error-retry（T19 handleWorkerError）的区别：
 *   - handleWorkerError：worker 本身崩溃 → replaceRuntime 重启整个 worker
 *   - retryNode：单个 call 失败 → 主线程重跑该 call，worker 不动
 *
 * **G6-001**：前置 status==="running"。paused 下抛错（要 retry 先 resume）。
 *
 * @param run    WorkflowRun 聚合根
 * @param callId 要重试的 call id（必须已存在于 run.state.calls）
 * @param deps   LifecycleDeps（runner 用于重跑 call）
 * @throws run.state.status !== "running"（G6-001）
 * @throws callId 不存在
 */
export async function retryNode(
  run: WorkflowRun,
  callId: number,
  deps: LifecycleDeps,
): Promise<void> {
  // G6-001：前置 status==="running"
  if (run.state.status !== "running") {
    throw new Error(
      `retryNode: requires status==="running" (current: ${run.state.status}, runId=${run.runId})`,
    );
  }

  const call = run.state.calls.get(callId);
  if (!call) {
    throw new Error(`retryNode: call ${callId} not found in run ${run.runId}`);
  }

  // 重置 call 状态：done → pending（绕过 AgentCall 状态机守卫，因为是显式 reset 语义）
  call.status = "pending";
  call.attempts = 0;
  call.result = undefined;
  call.sessionId = undefined;

  // 同步 trace 节点：回退到 pending
  run.state.trace.update(callId, {
    status: "pending",
    result: undefined,
    error: undefined,
    completedAt: undefined,
    sessionId: undefined,
  });

  // 主线程重跑（不重启 worker）——executeAgentCall 内部 markRunning + runner.run
  // W-5：G6-001 保证 status==="running" ⟺ runtime defined；retryNode 已守 status==="running"
  // 前置，故 run.runtime 必存在。非空断言，不再用 fallback 掩盖不变式违反。
  const signal = run.runtime!.controller.signal;
  await executeAgentCall(call, deps.runner, run.state.budget, signal, run.state.trace);

  // 回发结果给 worker（worker 可能在 pending await）
  if (call.result) {
    run.runtime?.worker.postMessage({
      type: "agent-result",
      callId,
      result: call.result,
      cached: false,
    });
  }

  await deps.store.save(run);
}

// ── skipNode ─────────────────────────────────────────────────

/**
 * 跳过单个 agent call（注入占位 result）。
 *
 * 标记 call.status="done" + 写入 SKIP_PLACEHOLDER result + 同步 trace 节点为 completed。
 * 若 worker 仍活着，立即回发 agent-result（解锁 worker pending await）。
 *
 * 与 retryNode 的区别：skipNode 不重跑——直接用占位结果「假装完成」。
 * 用于用户显式跳过失败节点继续执行的场景。
 *
 * 不要求 status==="running"——paused 下也可 skip（标记后 resume 时该 call 走 callCache
 * replay）。但若 worker 已 terminate（runtime undefined），只标记不回发。
 *
 * @param run    WorkflowRun 聚合根
 * @param callId 要跳过的 call id（若不存在，仅注入到 calls Map 占位）
 * @param deps   LifecycleDeps（store 持久化）
 */
export async function skipNode(
  run: WorkflowRun,
  callId: number,
  deps: LifecycleDeps,
): Promise<void> {
  const call = run.state.calls.get(callId);

  if (call) {
    // 已有 call：标记 done + 占位 result（绕过状态机守卫，显式 skip 语义）
    call.status = "done";
    call.result = SKIP_PLACEHOLDER;
  }

  // 同步 trace 节点
  run.state.trace.update(callId, {
    status: "completed",
    result: SKIP_PLACEHOLDER,
    completedAt: new Date().toISOString(),
  });

  // 若 worker 仍活着，回发 agent-result（解锁 worker pending await）
  if (run.runtime) {
    try {
      run.runtime.worker.postMessage({
        type: "agent-result",
        callId,
        result: SKIP_PLACEHOLDER,
        cached: true,
      });
    } catch (err) {
      // P1-8: worker 可能在 has() 与 postMessage 间 exit——预期竞态，不恢复
      void err;
    }
  }

  await deps.store.save(run);
}
