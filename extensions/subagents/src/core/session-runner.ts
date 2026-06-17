// src/core/session-runner.ts
//
// 唯一的 session 执行入口。零 mode 感知——只负责"跑一次 session + 更新 record"。
//
// 这是 sync/background 两路径完全共用的核心。mode 分叉在 Runtime.execute 顶部，
// 不渗透到此处。Core 不知道谁调用它、是否 await、是否回注通知。

import type { AgentEvent, AgentResult, ExecutionRecord } from "../types.ts";
import type { AgentConfig, ResolvedModel } from "./model-resolver.ts";

/** SessionRunner 的依赖注入容器（由 Runtime 提供，解耦 Core 与 Pi SDK 实例）。 */
export interface SessionRunnerContext {
  /** 进程当前工作目录（传给 createAgentSession）。 */
  cwd: string;
  /** agent 配置目录（~/.pi/agent）。 */
  agentDir: string;
  /** home 目录（worktree baseDir / session 持久化目录）。 */
  homeDir: string;
}

/** SessionRunner.run 的入参。 */
export interface RunOptions {
  /** 已 resolve 的模型（Runtime 在调用前解析，Core 不重复解析）。 */
  resolved: ResolvedModel;
  /** agent 配置（含 systemPrompt/tools/isolation）。 */
  agentConfig: AgentConfig | undefined;
  /** 注入到子 session 的额外 system prompt 片段。 */
  appendSystemPrompt: string[] | undefined;
  /** 注入到子 session 的 skill 路径。 */
  skillPath: string | undefined;
  /** 结构化输出 schema（存在时 enforcement：漏调 structured-output 则 steer）。 */
  schema: Record<string, unknown> | undefined;
  /** hard turn limit。 */
  maxTurns: number | undefined;
  /** soft limit 后宽限轮数（默认 2）。 */
  graceTurns: number | undefined;
  /** 中断信号（Runtime 创建，来源：sync=Pi tool 框架 / bg=controller.signal）。 */
  signal: AbortSignal | undefined;
  /** event 回流——SessionRunner 内部 updateFromEvent 后，再回调调用方（widget/notify）。 */
  onEvent: ((event: AgentEvent) => void) | undefined;
}

/**
 * 唯一执行入口。返回 AgentResult（成功/失败统一形状，不抛错）。
 *
 *   ╔══════════════════════════════════════════════════════════════════╗
//   ║  pool.acquire(priority)                          ◄── 外层调用方负责   ║
//   ║       │                                                            ║
//   ║       ▼                                                            ║
//   ║  SessionRunner.run(record, task, opts, ctx)                       ║
//   ║       │                                                            ║
//   ║       ├─ a. isolation:worktree? → createWorktree(tmpdir)           ║
//   ║       │      └─ 失败 throw（不静默回退到 cwd）                      ║
//   ║       ├─ b. createAgentSession(model, tools, skills, cwd)         ║
//   ║       ├─ c. EventBridge.subscribe(session)                        ║
//   ║       │      └─ event → updateFromEvent(record)  ◄── 唯一更新点    ║
//   ║       │      └─ event → opts.onEvent(event)     ◄── 回流调用方     ║
//   ║       ├─ d. turnLimiter.attach(session)                           ║
//   ║       ├─ e. signal → session.abort 监听                            ║
//   ║       ├─ f. schema enforcement: turn_end 时漏调 structured-output   ║
//   ║       │      则 session.steer(reminder)（≤ MAX_SCHEMA_STEERS）     ║
//   ║       ├─ g. session.prompt(task + schemaInstruction)               ║
//   ║       ├─ h. collectResult(bridge) → AgentResult                    ║
//   ║       ├─ i. cleanupWorktree → commit/branch（或 preserveOnFailure） ║
//   ║       └─ j. session.dispose()                                     ║
//   ║                                                                    ║
//   ║  finally: pool.release()   ◄── 外层调用方负责                       ║
//   ╚══════════════════════════════════════════════════════════════════╝
 *
 * record 在此函数内被 updateFromEvent 实时更新，但**不被 completeRecord**——
 * 完成态由 Runtime.execute 统一写（保证 status 判定逻辑单点）。
 */
export async function run(
  record: ExecutionRecord,
  task: string,
  opts: RunOptions,
  ctx: SessionRunnerContext,
): Promise<AgentResult> {
  //  a. isolation:worktree? → createWorktree(ctx.cwd, randomHex, ctx.homeDir)
  //  b. createAgentSession({ model: opts.resolved.model, thinkingLevel, resourceLoader, tools })
  //  c. EventBridge.subscribe(session, (event) => {
  //       updateFromEvent(record, event);
  //       opts.onEvent?.(event);
  //     })
  //  d. createTurnLimiter({ maxTurns, graceTurns, steer, abort }).attach(session)
  //  e. opts.signal → session.abort 监听（一次性）
  //  f. schema enforcement: subscribe turn_end，漏调 structured-output 则 steer
  //  g. task + formatSchemaInstruction(opts.schema) → session.prompt()
  //  h. catch → success=false, error
  //  i. collectResult(session, bridge, startTime, success, error, sessionFile, worktreeResult)
  //  j. finally: unsubscribe + session.dispose()
  //  outer finally: cleanupWorktree（兜底）+ pool.release（外层）
  void record; void task; void opts; void ctx;
  throw new Error("not implemented");
}

// ============================================================
// Result 收集（共享 helper）
// ============================================================

/**
 * 从 EventBridge 累积的状态构造 AgentResult。
 * sync（run-agent）和 background 都复用此函数——杜绝两份 collectResult。
 */
export function collectResult(args: {
  startTime: number;
  success: boolean;
  error: string | undefined;
  sessionId: string;
  sessionFile: string | undefined;
  turns: number;
  usage: import("../types.ts").AgentUsageTotal | undefined;
  toolCalls: import("../types.ts").ToolCall[];
  worktree?: import("../types.ts").WorktreeOutcome;
}): AgentResult {
  //  1. durationMs = Date.now() - startTime
  //  2. 组装 AgentResult（text 由 bridge 累积，此处拼接 turns/usage/toolCalls/worktree）
  void args;
  throw new Error("not implemented");
}

/** 动态 import Pi SDK（测试可 mock）。 */
export async function getSdk(): Promise<unknown> {
  //  return await import("@mariozechner/pi-coding-agent")
  throw new Error("not implemented");
}
