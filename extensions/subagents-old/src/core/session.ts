// src/core/session.ts
import { inferCategory } from "../category.ts";
import { resolveModelForAgent } from "../resolution/model-resolver.ts";
import type { AgentResult,ManagedSession, ManagedSessionOptions } from "../types.ts";
import type { RunAgentContext } from "./run-agent.ts";
// namespace import：测试可通过 vi.spyOn(sessionFactory, "createAndConfigureSession") 替换
import * as sessionFactory from "./session-factory.ts";
import {
  type BuiltSession,
  collectResult,
  type SessionFactoryContext,
} from "./session-factory.ts";
import { createTurnLimiter } from "./turn-limiter.ts";

/** 动态 import Pi SDK（与 run-agent 一致）。测试时由 sessionFactory.getSdk mock 覆盖。 */
async function getSdk() {
  return await sessionFactory.getSdk();
}

/** 默认 grace turns（soft turn limit 后的宽限轮数） */
const DEFAULT_GRACE_TURNS = 2;

/**
 * FR-1.2: createManagedSession — 创建长生命周期 session，支持多次 prompt/steer/abort。
 *
 * V2 改造：首次 prompt() 时调用 createAndConfigureSession() 创建 Pi session 并缓存，
 * 之后所有 prompt()/steer()/abort() 复用同一 session。这样：
 *   - steer() 真实调用 session.steer(msg)，在运行中的 prompt 内注入消息（FR-1.2 真实生效）
 *   - sessionId 稳定（可用于定位 JSONL 日志）
 *   - 多步 chain 共享上下文
 *
 * prompt() 串行化（Pi session 不支持并发 prompt）。并发调用时第二个返回首个的 Promise。
 *
 * @param onSessionReady 可选，session 首次创建后回调（测试/观测用）
 */
export function createManagedSession(
  options: ManagedSessionOptions,
  ctx: RunAgentContext,
): ManagedSession {
  let disposed = false;
  let held: BuiltSession | null = null;
  let activePrompt: Promise<AgentResult> | null = null;
  // steer 在 session 创建前到达 → 缓存，ensureSession 后 flush（tintinweb pendingSteers 模式）
  const pendingSteers: string[] = [];

  /** 懒创建 session：首次调用时 createAndConfigureSession，后续复用 held */
  async function ensureSession(): Promise<BuiltSession> {
    if (disposed) throw new Error("ManagedSession disposed");
    if (held) return held;

    // 解析 agent 配置 + category + 模型
    const agentConfig = options.agent ? ctx.resolveAgent(options.agent) : undefined;
    const agentName = options.agent ?? "default";
    const category = inferCategory(agentName, agentConfig, ctx.globalConfig.agentCategoryOverrides);
    const resolved = resolveModelForAgent({
      agentName,
      agentConfig,
      category,
      globalConfig: ctx.globalConfig,
      sessionState: ctx.sessionState,
      modelRegistry: ctx.modelRegistry,
      paramOverride: { model: options.model, thinkingLevel: options.thinkingLevel },
    });

    const sdk = await getSdk();
    const factoryCtx: SessionFactoryContext = {
      modelRegistry: ctx.modelRegistry,
      resolveAgent: ctx.resolveAgent,
      cwd: ctx.cwd,
      agentDir: ctx.agentDir,
      homeDir: ctx.homeDir,
    };

    held = await sessionFactory.createAndConfigureSession(
      {
        resolved,
        appendSystemPrompt: options.appendSystemPrompt,
        skillPath: options.skillPath,
        agentConfig,
        onEvent: options.onEvent,
      },
      factoryCtx,
      sdk,
    );

    // flush 缓存的 steer（创建前到达的消息）
    if (pendingSteers.length > 0) {
      for (const msg of pendingSteers) {
        void held.session.steer(msg);
      }
      pendingSteers.length = 0;
    }

    return held;
  }

  const session: ManagedSession = {
    get sessionId() {
      return held?.session.sessionId ?? "";
    },
    get alive() {
      return !disposed;
    },

    async prompt(task, promptOpts): Promise<AgentResult> {
      if (disposed) throw new Error("ManagedSession disposed");

      // 串行化：Pi session 不支持并发 prompt。并发调用返回进行中的 Promise。
      if (activePrompt) return activePrompt;

      activePrompt = (async () => {
        const built = await ensureSession();
        const sess = built.session;
        const bridge = built.bridge;
        const startTime = Date.now();

        // turn 限制器
        const limiter = createTurnLimiter({
          maxTurns: promptOpts?.maxTurns ?? 0,
          graceTurns: DEFAULT_GRACE_TURNS,
          steer: (msg) => { void sess.steer(msg); },
          abort: () => { void sess.abort(); },
        });
        const limiterUnsub = sess.subscribe((event: unknown) => {
          if ((event as { type: string }).type === "turn_end") {
            limiter.onTurnEnd(bridge.turnCount);
          }
        });

        // AbortSignal（外部 promptOpts.signal）
        let signalListener: (() => void) | undefined;
        if (promptOpts?.signal) {
          if (promptOpts.signal.aborted) {
            void sess.abort();
          } else {
            signalListener = () => { void sess.abort(); };
            promptOpts.signal.addEventListener("abort", signalListener);
          }
        }

        let success = true;
        let error: string | undefined;
        try {
          // 重置 bridge 状态：避免跨 prompt 累计的 turnCount/lastError/usage/toolCalls
          // 污染本次 prompt 的 turn limit 计算和 success 判定
          bridge.resetForPrompt();
          await sess.prompt(task);
        } catch (err) {
          success = false;
          error = err instanceof Error ? err.message : String(err);
        } finally {
          limiterUnsub();
          if (signalListener && promptOpts?.signal) {
            promptOpts.signal.removeEventListener("abort", signalListener);
          }
        }

        // I2: 检查 message_end error 事件
        if (success && bridge.lastError) {
          success = false;
          error = bridge.lastError;
        }

        // 注意：不 dispose、不 unsubscribe —— ManagedSession 复用 session
        return collectResult(sess, bridge, startTime, success, error, built.sessionFile);
      })();

      try {
        return await activePrompt;
      } finally {
        activePrompt = null;
      }
    },

    steer(message: string): void {
      if (disposed) return;
      if (held) {
        // session 已创建 → 真实注入（运行中=中途 steer，空闲=入队下次 prompt）
        void held.session.steer(message);
      } else {
        // session 未创建 → 缓存，ensureSession 时 flush
        pendingSteers.push(message);
      }
    },

    abort(): void {
      if (disposed) return;
      if (held) {
        void held.session.abort(); // Promise<void>
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (held) {
        held.unsubscribe();
        // Pi session 可能已被内部 dispose（abort 后）。dispose 设计为 best-effort：
        // 抛出无意义（调用方已放弃 session），此处直接调用；若失败由 Pi 内部处理。
        held.session.dispose();
      }
      held = null;
    },
  };

  return session;
}
