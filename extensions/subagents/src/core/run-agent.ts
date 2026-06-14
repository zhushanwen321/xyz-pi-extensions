// src/core/run-agent.ts
import { inferCategory } from "../category.ts";
import { type ModelRegistryLike, resolveModelForAgent } from "../resolution/model-resolver.ts";
import type {
  AgentConfig,
  AgentResult,
  ConcurrencyPool,
  RunAgentOptions,
  SessionModelState,
  SubagentsGlobalConfig,
} from "../types.ts";
import {
  collectResult,
  createAndConfigureSession,
  formatSchemaInstruction,
  getSdk,
  type SessionFactoryContext,
} from "./session-factory.ts";
import { createTurnLimiter } from "./turn-limiter.ts";
import { cleanupWorktree, createWorktree, type WorktreeResult } from "./worktree.ts";

/** background id 时间戳进制 */
const BG_ID_RADIX = 36;
/** commit message 最大长度 */
const COMMIT_MSG_MAX = 200;

/** 默认 grace turns（soft turn limit 后的宽限轮数） */
const DEFAULT_GRACE_TURNS = 2;

/** runAgent 的依赖注入容器（由 SubagentRuntime 提供） */
export interface RunAgentContext {
  modelRegistry: ModelRegistryLike;
  resolveAgent: (name: string) => AgentConfig | undefined;
  globalConfig: SubagentsGlobalConfig;
  sessionState: SessionModelState;
  globalPool: ConcurrencyPool;
  /** cwd（传给 createAgentSession） */
  cwd: string;
  /** agentDir（传给 createAgentSession） */
  agentDir: string;
}

/**
 * FR-1.1: runAgent — 一次性执行 agent，返回 AgentResult。
 * 在主线程调用（Worker 线程无 Pi SDK 上下文）。
 *
 * 流程：参数解析 → 并发 acquire → createAndConfigureSession（共享 helper）
 *      → 绑定 turn-limiter + AbortSignal → session.prompt → collectResult
 *      → dispose session → pool.release。
 */
export async function runAgent(opts: RunAgentOptions, ctx: RunAgentContext): Promise<AgentResult> {
  const startTime = Date.now();

  // 步骤 2: 并发控制（提前 acquire，保持原有行为）
  const pool = opts.pool ?? ctx.globalPool;
  await pool.acquire(opts.priority);

  try {
    // 步骤 1: 解析 agent 配置 + category + 模型（在 try 内，确保异常被捕获）
    const agentConfig = opts.agent ? ctx.resolveAgent(opts.agent) : undefined;
    const agentName = opts.agent ?? "default";
    const category = inferCategory(agentName, agentConfig, ctx.globalConfig.agentCategoryOverrides);
    const resolved = resolveModelForAgent({
      agentName,
      agentConfig,
      category,
      globalConfig: ctx.globalConfig,
      sessionState: ctx.sessionState,
      modelRegistry: ctx.modelRegistry,
      paramOverride: { model: opts.model, thinkingLevel: opts.thinkingLevel },
    });

    const sdk = await getSdk();

    // Worktree 隔离：agent 要求 isolation:worktree 时在临时副本中执行
    let worktree: WorktreeResult | undefined;
    let effectiveCwd = ctx.cwd;
    if (agentConfig?.isolation === "worktree") {
      worktree = createWorktree(ctx.cwd, `${agentName}-${Date.now().toString(BG_ID_RADIX)}`);
      if (worktree) effectiveCwd = worktree.workPath;
    }

    const factoryCtx: SessionFactoryContext = {
      modelRegistry: ctx.modelRegistry,
      resolveAgent: ctx.resolveAgent,
      cwd: effectiveCwd,
      agentDir: ctx.agentDir,
    };

    // 创建 + 配置 session（共享 helper）
    const { session, bridge, unsubscribe } = await createAndConfigureSession(
      {
        resolved,
        appendSystemPrompt: opts.appendSystemPrompt,
        skillPath: opts.skillPath,
        agentConfig,
        onEvent: opts.onEvent,
      },
      factoryCtx,
      sdk,
    );

    try {
      // turn 限制器
      const limiter = createTurnLimiter({
        maxTurns: opts.maxTurns ?? 0,
        graceTurns: opts.graceTurns ?? DEFAULT_GRACE_TURNS,
        steer: (msg) => { void session.steer(msg); },
        abort: () => { void session.abort(); },
      });

      // bridge.turnCount 由 createAndConfigureSession 内 subscribe 累计；
      // 此处额外监听 turn_end 触发 limiter（需在 unsubscribe 前追加监听）
      const limiterUnsub = session.subscribe((event: unknown) => {
        if ((event as { type: string }).type === "turn_end") {
          limiter.onTurnEnd(bridge.turnCount);
        }
      });

      // AbortSignal
      let signalListener: (() => void) | undefined;
      if (opts.signal) {
        if (opts.signal.aborted) {
          void session.abort();
        } else {
          signalListener = () => { void session.abort(); };
          opts.signal.addEventListener("abort", signalListener);
        }
      }

      let success = true;
      let error: string | undefined;

      try {
        // 构建 task（schema 拼入）
        let task = opts.task;
        if (opts.schema) {
          task = task + "\n\n" + formatSchemaInstruction(opts.schema);
        }
        await session.prompt(task);
      } catch (err) {
        success = false;
        error = err instanceof Error ? err.message : String(err);
      } finally {
        limiterUnsub();
        if (signalListener && opts.signal) opts.signal.removeEventListener("abort", signalListener);
      }

      // I2: 检查 event-bridge 捕获的 message_end error 事件
      if (success && bridge.lastError) {
        success = false;
        error = bridge.lastError;
      }

      return collectResult(session, bridge, startTime, success, error);
    } finally {
      unsubscribe();
      session.dispose();
      // Worktree 清理：有变更则提交到分支
      if (worktree) {
        cleanupWorktree(ctx.cwd, worktree, opts.task.slice(0, COMMIT_MSG_MAX));
      }
    }
  } catch (err) {
    // createAgentSession 本身失败（如模型不可用）
    return {
      text: "",
      turns: 0,
      durationMs: Date.now() - startTime,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      sessionId: "",
      toolCalls: [],
    };
  } finally {
    pool.release();
  }
}
