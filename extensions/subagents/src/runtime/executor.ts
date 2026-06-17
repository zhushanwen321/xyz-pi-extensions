// src/runtime/executor.ts
//
// 统一执行入口。sync/background 的唯一分叉点集中在此函数顶部 ~20 行，
// SessionRunner.run 完全不感知 mode。
//
// 这是旧实现 runAgent + startBackground 两份重复逻辑的收敛点：
//   - state 创建/更新：唯一在 SessionRunner（通过 record）
//   - history 写入：唯一在此函数完成阶段
//   - aborted → status 判定：唯一在此函数
//   - 仅 4 处真正的 mode 差异（见下方框图）

import { completeRecord, createRecord, project } from "../core/execution-record.ts";
import { run, type SessionRunnerContext } from "../core/session-runner.ts";
import type {
  ExecuteOptions,
  ExecutionHandle,
  ExecutionRecord,
} from "../types.ts";
import type { SubagentRuntime } from "./runtime.ts";

/** sync linger 时间（completed map 保留时长）。 */

/** bg FIFO 上限（绝不淘汰 running）。 */


/**
 * 统一执行入口。被 SubagentRuntime.execute 委托调用。
 *
 *   ╔════════════════════════════════════════════════════════════════════╗
//   ║  EXECUTE(opts, ctx):                                                ║
//   ║                                                                     ║
//   ║  ── 1. IDENTITY 解析（一次确定）────────────────────────────────── ║
//   ║     resolveAgent + inferCategory + resolveModelForAgent             ║
//   ║       → { agent, model, thinkingLevel } 写入 record，不再变         ║
//   ║                                                                     ║
//   ║  ── 2. RECORD 创建 + 注册 ─────────────────────────────────────── ║
//   ║     id = opts.mode==="background" ? `bg-${seq}-${ts}` : `run-${seq}`║
//   ║     controller = opts.mode==="background" ? new AbortController()   ║
//   ║                                          : undefined                ║
//   ║     record = createRecord(id, {...identity, mode, controller})      ║
//   ║     store.register(record)                              ◄── onChange║
//   ║                                                                     ║
//   ║  ── 3. MODE 分叉（仅此 4 处差异）──────────────────────────────── ║
//   ║     ┌─────────────────────┬────────────────────────┐               ║
//   ║     │ sync                │ background              │               ║
//   ║     ├─────────────────────┼────────────────────────┤               ║
//   ║     │ signal = opts.signal│ signal = ctrl.signal    │ ◄── 差异④     ║
//   ║     │ priority = 0        │ priority = 1000         │ ◄── 差异②     ║
//   ║     │ 调用方 await        │ 立即返回 backgroundId    │ ◄── 差异①     ║
//   ║     │ 无 notifier         │ notifier.notify(record) │ ◄── 差异③     ║
//   ║     └─────────────────────┴────────────────────────┘               ║
//   ║     ★ 其余完全共用 ★                                               ║
//   ║                                                                     ║
//   ║  ── 4. 执行（共用）SessionRunner.run ──────────────────────────── ║
//   ║     pool.acquire(priority)                                          ║
//   ║     await run(record, task, { resolved, agentConfig, signal,        ║
//   ║              appendSystemPrompt, skillPath, schema, maxTurns,       ║
//   ║              graceTurns, onEvent: throttledOnUpdate }, ctx)         ║
//   ║       └─ run 内部: event → updateFromEvent(record)  ◄── 唯一更新点  ║
//   ║       └─ run 内部: event → opts.onUpdate(project(record))（节流）   ║
//   ║     pool.release()                              ◄── finally 无条件  ║
//   ║                                                                     ║
//   ║  ── 5. FINALIZE（共用）───────────────────────────────────────── ║
//   ║     status = result.success ? "done"                                ║
//   ║            : (signal.aborted ? "cancelled" : "failed") ◄── 唯一判定 ║
//   ║     completeRecord(record, result, status)                          ║
//   ║     store.archive(record)                              ◄── onChange ║
//   ║     history.append(toPersisted(record))         ◄── 统一持久化      ║
//   ║                                                                     ║
//   ║  ── 6. BACKGROUND 回注（差异③）──────────────────────────────── ║
//   ║     if (mode==="background") notifier.notify(snapshot(record))      ║
//   ║                                                                     ║
//   ║  ── 7. 返回 ──────────────────────────────────────────────────── ║
//   ║     sync: { mode:"sync", record: snapshot(record) }                 ║
//   ║     bg:   { mode:"background", backgroundId: record.id }            ║
//   ╚════════════════════════════════════════════════════════════════════╝
 *
 * background 的 detached：sync 走 await，background 把步骤 4-6 包进
 * promise.then().catch() 不 await，步骤 7 立即返回 handle。
 */
export async function execute(
  opts: ExecuteOptions,
  runtime: SubagentRuntime,
  ctx: SessionRunnerContext,
): Promise<ExecutionHandle> {
  //  见上方框图。background 分支不 await 内部 run，立即返回 handle。
  void completeRecord; void createRecord; void project; void run; void opts; void runtime; void ctx;
  throw new Error("not implemented");
}

// ============================================================
// Background detached 完成处理（共享 helper）
// ============================================================

/**
 * background 完成时的副作用（.then/.catch 共用）。
 * sync 不调用此函数（sync 在 execute 内同步处理完成）。
 *
 *   ╔══════════════════════════════════════════════════════════════╗
//   ║  finalizeBackground(record, result, runtime):                  ║
//   ║    1. status 判定（唯一）：aborted ? cancelled                  ║
//   ║       : (success ? done : failed)                              ║
//   ║    2. completeRecord(record, result, status)                   ║
//   ║    3. store.archive(record)                                    ║
//   ║    4. history.append(toPersisted(record, mode:"background"))   ║
//   ║    5. opts.onComplete?.(snapshot(record))                      ║
//   ║    6. notifier.notify(snapshot(record))   ◄── 回注主对话        ║
//   ║    7. _settled 守卫：cancelBackground 已 settle 则跳过 4-6       ║
//   ╚══════════════════════════════════════════════════════════════╝
 */
export function finalizeBackground(
  record: ExecutionRecord,
  result: import("../types.ts").AgentResult,
  runtime: SubagentRuntime,
): void {
  void record; void result; void runtime;
  throw new Error("not implemented");
}

// ============================================================
// 取消（仅 background）
// ============================================================

/**
 * 取消 background record。runtime 持有 controller，可真正 abort。
 * _settled 标记防止 .then/.catch 重复触发副作用。
 */
export function cancelBackground(record: ExecutionRecord, runtime: SubagentRuntime): boolean {
  //  1. record.controller?.abort()
  //  2. record.status = "cancelled"; record._settled = true
  //  3. notifier.notify（用户主动取消，理应知道结果）
  //  4. 不写 history（用户意图，不计入执行记录）
  void record; void runtime;
  throw new Error("not implemented");
}
