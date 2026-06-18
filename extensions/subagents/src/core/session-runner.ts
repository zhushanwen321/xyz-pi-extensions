// src/core/session-runner.ts
//
// 唯一的一次性 session 执行编排器。零 mode 感知——只负责"跑一次 session + 更新 record"。
//
// 这是 sync/background 两路径完全共用的核心。mode 分叉在 Runtime.execute 顶部，
// 不渗透到此处。Core 不知道谁调用它、是否 await、是否回注通知。
//
// 编排层（Orchestration）：站在基础层三件套（session-factory / output-collector /
// event-bridge）之上，负责执行时序与清理。不持有 Pi SDK 实例，只通过 factory 间接用。
// 长生命周期变体见 managed-session.ts（平级编排器，互不 import）。
// 设计信息见 docs/subagents/session-runner.md。

import type {
  AgentEvent,
  AgentResult,
  ExecutionRecord,
  WorktreeOutcome,
} from "../types.ts";
import { updateFromEvent } from "./execution-record.ts";
import type { AgentConfig, ResolvedModel } from "./model-resolver.ts";
import { collectResult, toUsageTotal } from "./output-collector.ts";
import type {
  BuiltSession,
  CreateSessionInput,
  SdkLike,
  SessionFactoryContext,
} from "./session-factory.ts";
import { createAndConfigureSession } from "./session-factory.ts";
import type { WorktreeResult } from "./worktree.ts";

// ============================================================
// 依赖注入容器 + 入参
// ============================================================

/** SessionRunner 的依赖注入容器（由 Runtime 提供，解耦 Core 与 Pi SDK 实例）。 */
export interface SessionRunnerContext {
  /** 进程当前工作目录（传给 createAgentSession）。 */
  cwd: string;
  /** agent 配置目录（~/.pi/agent）。 */
  agentDir: string;
  /** home 目录（worktree baseDir / session 持久化目录）。 */
  homeDir: string;
  /** session 工厂上下文（modelRegistry/resolveAgent/cwd/agentDir/homeDir）。
   *  由 Runtime 装配后注入——run() 必须把它传给 createAndConfigureSession，
   *  因此提升到 context，避免在 run() 内部重新构造。 */
  factoryCtx: SessionFactoryContext;
  /** Pi SDK 实例（由 Runtime 在 session_start 时 dynamic import 一次后注入）。
   *  注入而非 run() 内 import——Core 层保持副作用自由（无顶层 dynamic import）。 */
  sdk: SdkLike;
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

// ============================================================
// Schema 指令
// ============================================================

/** formatSchemaInstruction 的 JSON pretty-print 缩进。 */
const SCHEMA_JSON_INDENT = 2;

/**
 * 构造 schema 指令模板（拼入 task 末尾 + steer reminder 复用）。
 * 指令明确要求 agent 调用 structured-output tool，而非直接输出 JSON 文本。
 */
export function formatSchemaInstruction(schema: Record<string, unknown>): string {
  //  return [
  //    "MANDATORY: Structured Output Requirement",
  //    "You MUST call the `structured-output` tool with your final answer.",
  //    "Do NOT output the JSON directly in your text response ...",
  //    "The schema for the structured output is:",
  //    "```json",
  //    JSON.stringify(schema, null, SCHEMA_JSON_INDENT),
  //    "```",
  //  ].join("\n")
  void schema; void SCHEMA_JSON_INDENT;
  throw new Error("not implemented");
}

// ============================================================
// run 编排骨架的叶子（全部 throw not implemented）
// ============================================================

/**
 * 隔离判定 + worktree 创建。封装 run() 的步骤 a：
 *   - isolation !== "worktree" → 返回 undefined（cwd 内执行）
 *   - isolation === "worktree" → createWorktree(cwd, randomHex, tmpdir)
 *
 * ⚠ createWorktree 返回 undefined（非 git / worktree add 失败）时必须 throw——
 *   不能静默回退到 cwd：那会让 agent 污染用户工作区，违背 isolation:worktree 的意图。
 *   （设计意图说明，留注释不翻译成代码）
 */
function createWorktreeForIsolation(
  opts: RunOptions,
  ctx: SessionRunnerContext,
): WorktreeResult | undefined {
  //  1. opts.agentConfig?.isolation !== "worktree" → return undefined
  //  2. agentId = crypto.randomBytes(4).toString("hex")
  //  3. wt = createWorktree(ctx.cwd, agentId, os.tmpdir())
  //  4. wt === undefined → throw new Error("worktree isolation requested but creation failed")
  //  5. return wt
  void opts; void ctx;
  throw new Error("not implemented");
}

/**
 * turn_end 旁路钩子（turnLimiter + schema enforcement）的统一挂载句柄。
 *
 *   ╔══════════════════════════════════════════════════════════════╗
 *   ║  run() 通过包装 built 的 onEvent 链把 turn_end 喂给本句柄：    ║
//   ║    onTurnEnd(currentTurns):                                    ║
//   ║      ① turnLimiter.onTurnEnd(currentTurns)   ← soft/hard 限制 ║
//   ║      ② schema enforcement: bridge.toolCalls 无 structured-output ║
//   ║         且 schemaSteerCount < MAX_SCHEMA_STEERS → session.steer ║
//   ║  unsubscribe(): 移除 signal→abort 监听（一次性 listener）       ║
//   ╚══════════════════════════════════════════════════════════════╝
 *
 * prompt 生命周期钩子集中在此，避免三个独立 subscribe 的时序碎片。
 */
export interface RunHooks {
  /** 收到 turn_end 时调用（currentTurns 已递增）。 */
  onTurnEnd(currentTurns: number): void;
  /** 卸载 signal→session.abort 监听。 */
  unsubscribe(): void;
}

/**
 * 把 turnLimiter + schema enforcement + signal-abort 绑定到已就绪的 session。
 *
 *   ╔══════════════════════════════════════════════════════════════╗
//   ║  1. turnLimiter = createTurnLimiter({                          ║
//   ║       maxTurns: opts.maxTurns ?? 0,                            ║
//   ║       graceTurns: opts.graceTurns ?? DEFAULT_GRACE_TURNS,      ║
//   ║       steer: msg => built.session.steer(msg),                  ║
//   ║       abort: () => built.session.abort(),                      ║
//   ║     })                                                          ║
//   ║  2. signal→abort：opts.signal?.addEventListener("abort",       ║
//   ║       () => built.session.abort(), { once: true })             ║
//   ║  3. onTurnEnd(n): turnLimiter.onTurnEnd(n) + schemaSteer(...)  ║
//   ║  4. unsubscribe(): signal?.removeEventListener("abort", ...)   ║
//   ╚══════════════════════════════════════════════════════════════╝
 */
export function attachRunHooks(built: BuiltSession, opts: RunOptions): RunHooks {
  void built; void opts;
  throw new Error("not implemented");
}

/**
 * 执行结果失败/正常收尾的 worktree 清理。封装 run() 的步骤 i。
 * 成功或失败都调 cleanupWorktree——失败时 cleanupWorktree 内部走 preserveOnFailure
 * 保留变更（不静默丢弃）。
 */
function cleanupWorktreeForOutcome(
  worktree: WorktreeResult,
  cwd: string,
  task: string,
  _success: boolean,
): WorktreeOutcome {
  //  return cleanupWorktree(cwd, worktree, task.slice(0, 200))
  //  （_success 不改变清理策略——cleanupWorktree 自身按 hasChanges 决定 commit/preserve）
  void worktree; void cwd; void task; void _success;
  throw new Error("not implemented");
}

// ============================================================
// run —— 唯一执行入口
// ============================================================

/**
 * 唯一执行入口。返回 AgentResult（成功/失败统一形状，不抛错）。
 *
 *   ╔══════════════════════════════════════════════════════════════════╗
//   ║  pool.acquire(priority)                          ◄── 外层调用方负责   ║
//   ║       │                                                            ║
//   ║       ▼                                                            ║
//   ║  run(record, task, opts, ctx)                                     ║
//   ║       │                                                            ║
//   ║       ├─ a. isolation:worktree? → createWorktree(tmpdir)           ║
//   ║       │      └─ 失败 throw（不静默回退到 cwd）                      ║
//   ║       ├─ b. createAndConfigureSession(model, tools, skills, cwd)   ║
//   ║       ├─ c. EventBridge.subscribe(session)                        ║
//   ║       │      └─ event → updateFromEvent(record)  ◄── 唯一更新点    ║
//   ║       │      └─ event → opts.onEvent(event)     ◄── 回流调用方     ║
//   ║       ├─ d. turnLimiter.attach(session)                           ║
//   ║       ├─ e. signal → session.abort 监听（一次性）                   ║
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
  const startTime = Date.now();

  // a. isolation:worktree? → createWorktree（失败 throw 不回退）
  const worktree = createWorktreeForIsolation(opts, ctx);

  // b/c. createAnd configure session + EventBridge 订阅。
  // onEvent wrapper 把两条流挂上：① updateFromEvent(record)（唯一 record 更新点）
  // ② opts.onEvent（回流调用方 widget/notify）。turn_end 还需喂给 hooks，
  // 但 hooks 依赖 built（鸡生蛋）—— 先用闭包变量在 prompt 前接上线。
  let hooks: RunHooks | undefined;
  const onEvent: CreateSessionInput["onEvent"] = (event: AgentEvent): void => {
    updateFromEvent(record, event);
    if (event.type === "turn_end") hooks?.onTurnEnd(record.turns);
    opts.onEvent?.(event);
  };

  let built: BuiltSession | undefined;
  try {
    built = await createAndConfigureSession(
      {
        resolved: opts.resolved,
        appendSystemPrompt: opts.appendSystemPrompt,
        skillPath: opts.skillPath,
        agentConfig: opts.agentConfig,
        onEvent,
      },
      ctx.factoryCtx,
      ctx.sdk,
    );

    // d/e/f. turnLimiter + signal-abort + schema enforcement 统一挂载
    hooks = attachRunHooks(built, opts);

    // g. session.prompt（schema 指令拼到 task 末尾）
    let success = true;
    let error: string | undefined;
    try {
      const instruction = opts.schema ? formatSchemaInstruction(opts.schema) : "";
      await built.session.prompt(task + instruction);
      // h. 双来源 success 判定：prompt 成功但 bridge.lastError 非空也算失败
      if (built.bridge.lastError) {
        success = false;
        error = built.bridge.lastError;
      }
    } catch (err) {
      success = false;
      error = err instanceof Error ? err.message : String(err);
    }

    // h. collectResult 组装 AgentResult（i. worktree 清理在 collectResult 前完成）
    return collectResult(built.session, built.bridge, {
      startTime,
      success,
      error,
      sessionId: built.session.sessionId,
      sessionFile: built.session.sessionManager.getSessionFile() ?? undefined,
      turns: built.bridge.turnCount,
      usage: toUsageTotal(built.bridge.usage),
      toolCalls: built.bridge.toolCalls.slice(),
      worktree: worktree
        ? cleanupWorktreeForOutcome(worktree, ctx.cwd, task, success)
        : undefined,
    });
  } finally {
    // j. 清理：hooks（signal listener）→ unsubscribe（session.subscribe）→ dispose
    hooks?.unsubscribe();
    built?.unsubscribe();
    built?.session.dispose();
  }
}
