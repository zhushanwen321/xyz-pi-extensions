// src/core/run-agent.ts
import * as crypto from "node:crypto";

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

/** V7: agentId 随机字节数（纯 hex，不嵌用户可控的 agentName） */
const AGENT_ID_RANDOM_BYTES = 4;
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
  /** ADR-024 L2: homeDir，传给 SessionFactoryContext 用于计算 session 持久化目录 */
  homeDir: string;
}

/**
 * FR-1.1: runAgent — 一次性执行 agent，返回 AgentResult。
 * 在主线程调用（Worker 线程无 Pi SDK 上下文）。
 *
 * 流程：参数解析 → 并发 acquire → createAndConfigureSession（共享 helper）
 *      → 绑定 turn-limiter + AbortSignal → session.prompt → collectResult
 *      → dispose session → pool.release。
 *
 * V3：worktree 清理在 outer finally，保证 createAndConfigureSession 抛错时 worktree
 * 不泄漏（既有实现的 inner finally 不覆盖 session 创建前的异常路径）。
 */
export async function runAgent(opts: RunAgentOptions, ctx: RunAgentContext): Promise<AgentResult> {
  const startTime = Date.now();

  // 步骤 2: 并发控制（提前 acquire，保持原有行为）
  const pool = opts.pool ?? ctx.globalPool;
  await pool.acquire(opts.priority);

  // V3：worktree 提到 outer scope，outer finally 统一清理（覆盖 session 创建失败路径）
  let worktree: WorktreeResult | undefined;

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
    let effectiveCwd = ctx.cwd;
    if (agentConfig?.isolation === "worktree") {
      // V7：agentId 用随机 hex，不嵌用户可控的 agentName（路径注入防御）
      const agentId = crypto.randomBytes(AGENT_ID_RANDOM_BYTES).toString("hex");
      // P5: 用 ctx.homeDir 作为 worktree baseDir，生产环境 = os.tmpdir()（homeDir 默认），
      // 测试可用独立子目录隔离，避免并行测试的 pi-agent-* 残留互相干扰。
      worktree = createWorktree(ctx.cwd, agentId, ctx.homeDir);
      // V1：createWorktree 失败（非 git / worktree add 失败）必须 throw，
      // 不能静默回退到 ctx.cwd（那会让 agent 污染用户工作区，违背隔离意图）
      if (!worktree) {
        throw new Error(
          `Failed to create isolated worktree for agent "${agentName}". ` +
            "Aborting to avoid polluting the user workspace (isolation:worktree was requested).",
        );
      }
      effectiveCwd = worktree.workPath;
    }

    const factoryCtx: SessionFactoryContext = {
      modelRegistry: ctx.modelRegistry,
      resolveAgent: ctx.resolveAgent,
      cwd: effectiveCwd,
      agentDir: ctx.agentDir,
      homeDir: ctx.homeDir,
    };

    // 创建 + 配置session（共享 helper）
    const { session, bridge, unsubscribe, sessionFile } = await createAndConfigureSession(
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

    // V4：worktree cleanup 结果（含 branch），传给 collectResult 写入 AgentResult.worktree
    let worktreeResult: WorktreeResult | undefined;
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

      // V4：worktree cleanup 在 inner finally 提前执行，捕获结果传给 collectResult
      if (worktree) {
        worktreeResult = cleanupWorktree(ctx.cwd, worktree, opts.task.slice(0, COMMIT_MSG_MAX));
        worktree = undefined; // 标记已清理，outer finally 不再重复清理
      }

      return collectResult(
        session,
        bridge,
        startTime,
        success,
        error,
        sessionFile,
        worktreeResult ? { branch: worktreeResult.branch, hasChanges: worktreeResult.hasChanges } : undefined,
      );
    } finally {
      unsubscribe();
      session.dispose();
    }
  } catch (err) {
    // createAgentSession 本身失败（如模型不可用）。V1 的 throw 也走这里。
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
    // V3：outer finally 兜底清理 —— 覆盖 createAndConfigureSession 抛错（worktree 尚未
    // 在 inner 路径清理）以及 V1 throw 的场景。worktree 在 inner 正常清理后置 undefined。
    if (worktree) {
      cleanupWorktree(ctx.cwd, worktree, opts.task.slice(0, COMMIT_MSG_MAX));
    }
    pool.release();
  }
}
