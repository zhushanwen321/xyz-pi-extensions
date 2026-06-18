// src/core/managed-session.ts
//
// 长生命周期 session 变体。复用 session-runner 的 createAndConfigureSession，
// 但支持多次 prompt/steer/abort，共享 session 上下文。
//
// 与一次性 run 的差异（详见 docs/subagents/session-runner.md §7）：
//   - session 创建：首次 prompt() 懒创建（ensureSession），非进入即创建
//   - bridge 复用：每轮 prompt 前 resetForPrompt（清零跨轮累积）
//   - steer：session 未就绪时缓存到 pendingSteers，ensureSession 时 flush
//   - prompt 串行化：Pi session 不支持并发 prompt（activePrompt 互斥）
//   - 不支持 worktree：长生命周期无法界定 worktree 归属

import type { ManagedSession, ManagedSessionOptions } from "../types.ts";
import type { AgentConfig, ResolvedModel } from "./model-resolver.ts";
import { collectResult } from "./output-collector.ts";
import {
  type BuiltSession,
  type CreateSessionInput,
  type SessionFactoryContext,
} from "./session-factory.ts";

/** 默认 grace turns（soft turn limit 后的宽限轮数）。 */
const DEFAULT_GRACE_TURNS = 2;

/** ManagedSession 的依赖注入容器（与 SessionRunnerContext 对齐 + Runtime 提供的解析能力）。 */
export interface ManagedSessionContext {
  /** 已 resolve 的模型（Runtime 在调用前解析）。 */
  resolved: ResolvedModel;
  /** agent 配置。 */
  agentConfig: AgentConfig | undefined;
  /** session 工厂上下文（cwd/agentDir/homeDir + modelRegistry + resolveAgent）。 */
  factoryCtx: SessionFactoryContext;
}

/**
 * 创建长生命周期 session（首次 prompt 时懒创建 Pi session）。
 *
//   ╔══════════════════════════════════════════════════════════════════╗
//   ║  内部状态：                                                        ║
//   ║    disposed: boolean                                              ║
//   ║    held: BuiltSession | null     （懒创建，null=未创建）          ║
//   ║    activePrompt: Promise | null  （串行化互斥锁）                  ║
//   ║    pendingSteers: string[]       （session 就绪前缓存的 steer）   ║
//   ║                                                                    ║
//   ║  ensureSession():                                                 ║
//   ║    if disposed → throw                                            ║
//   ║    if held → return held                                          ║
//   ║    held = createAndConfigureSession(input, factoryCtx, sdk)       ║
//   ║    flush pendingSteers（held.session.steer(msg) 逐条）            ║
//   ║    return held                                                    ║
//   ║                                                                    ║
//   ║  prompt(task, opts) ─ 串行化：                                    ║
//   ║    if activePrompt → return activePrompt（第二个并发调用复用）     ║
//   ║    activePrompt = (async () => {                                  ║
//   ║      built = ensureSession()                                      ║
//   ║      bridge.resetForPrompt()  ◄── 清零跨轮累积（关键）            ║
//   ║      turnLimiter.attach(session, opts.maxTurns, graceTurns)       ║
//   ║      opts.signal → session.abort 监听                             ║
//   ║      session.prompt(task)                                         ║
//   ║      success 双判定（prompt 抛错 + bridge.lastError）              ║
//   ║      collectResult(session, bridge, { startTime, ... })           ║
//   ║    })()                                                           ║
//   ║    return await activePrompt; finally activePrompt = null         ║
//   ║                                                                    ║
//   ║  steer(message):                                                  ║
//   ║    held ? held.session.steer(message)                             ║
//   ║          : pendingSteers.push(message)  ◄── 缓存到 ensureSession ║
//   ║                                                                    ║
//   ║  abort():  held?.session.abort()                                  ║
//   ║  dispose(): 幂等；unsubscribe + session.dispose(); held = null    ║
//   ╚══════════════════════════════════════════════════════════════════╝
 */
export function createManagedSession(
  options: ManagedSessionOptions,
  ctx: ManagedSessionContext,
): ManagedSession {
  //  见上方框图。返回 ManagedSession 对象字面量（sessionId/alive getter + 4 方法）。
  void options; void ctx; void ensureSession; void collectResult;
  void DEFAULT_GRACE_TURNS; void buildCreateInput;
  throw new Error("not implemented");
}

// ============================================================
// 内部 helper（session 创建参数组装）
// ============================================================

/** 从 ManagedSessionOptions 组装 createAndConfigureSession 的输入。 */
function buildCreateInput(options: ManagedSessionOptions): CreateSessionInput {
  //  return {
  //    resolved: ?,  // 注意：resolved 在 ctx 内，此处仅透传 appendSystemPrompt/skillPath/agentConfig/onEvent
  //    appendSystemPrompt: options.appendSystemPrompt,
  //    skillPath: options.skillPath,
  //    agentConfig: ?,
  //    onEvent: options.onEvent,
  //  }
  //  ⚠ resolved/agentConfig 来自 ctx 不在 options；此 helper 签名需重新设计
  //  ——实际实现时直接在 ensureSession 内联组装，或调整为 (options, ctx) 双参
  void options;
  throw new Error("not implemented");
}

/** 懒创建 session（闭包内私有）。首次调用 createAndConfigureSession，后续复用 held。 */
async function ensureSession(
  options: ManagedSessionOptions,
  ctx: ManagedSessionContext,
  heldRef: { held: BuiltSession | null },
  pendingSteers: string[],
): Promise<BuiltSession> {
  //  1. if (!heldRef.held) heldRef.held = createAndConfigureSession(input, ctx.factoryCtx, sdk)
  //  2. flush pendingSteers → heldRef.held.session.steer(msg)
  //  3. return heldRef.held
  void options; void ctx; void heldRef; void pendingSteers;
  throw new Error("not implemented");
}
