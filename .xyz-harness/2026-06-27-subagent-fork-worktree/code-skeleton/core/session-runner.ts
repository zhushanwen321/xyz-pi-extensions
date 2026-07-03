// code-skeleton/core/session-runner.ts — ⑤骨架（#6 修改）
// fork 分流 + alive 写入。adapter 真引 SDK（ctx.sdk）。
// D-018: createBranchedSession 优先（实例 mutate），forkFrom 降级（两级降级链）。
// D-014: SCR 是纯函数，forkFrom 调用在此（经 ctx.sdk）。
// 本骨架聚焦 fork 分流 + alive 接线，其余 run() 逻辑见现有 session-runner.ts。

import type {
  SessionRunnerContext,
  RunOptions,
  SdkLike,
  AgentSessionLike,
} from "../types.ts";
import { resolveSessionContext } from "./session-context-resolver.ts";
import { writeAliveMarker } from "../runtime/execution/alive-store.ts";

/** identity custom entry 类型（与现有 IDENTITY_CUSTOM_TYPE 一致）。 */
const IDENTITY_CUSTOM_TYPE = "subagent-identity";

/**
 * createAndConfigureSession fork 分流（#6/D-018 两级降级）。
 * adapter 真引 SDK：调 ctx.sdk.SessionManager.createBranchedSession/forkFrom/create。
 *
 * 数据流：resolveSessionContext(纯函数) → [createBranchedSession(mutate) | forkFrom(降级) | create]
 *         → createAgentSession(sessionManager, cwd:effectiveCwd)
 *         → writeAliveMarker + appendCustomEntry(identity+forkDepth)
 *
 * 失败路径：createBranchedSession 抛错→降级 forkFrom（AC-6.3 两级）；forkFrom 抛错→向上抛（finalizeFailed）
 */
export async function createAndConfigureSession(
  opts: RunOptions,
  ctx: SessionRunnerContext,
  sdk: SdkLike,
): Promise<{ session: AgentSessionLike }> {
  // 1. SCR 纯函数解析意图（零副作用，D-014）
  const resolved = resolveSessionContext(
    {
      fork: opts.fork,
      worktree: opts.worktree,
      cwd: ctx.effectiveCwd !== ctx.mainCwd ? ctx.effectiveCwd : undefined,
      mainCwd: ctx.mainCwd,
      mainSessionFile: ctx.mainSessionFile,
      parentForkDepth: opts.parentForkDepth,
    },
    ctx.agentDir,
  );

  // 2. sessionManager 分流（D-018 两级降级链）
  let sessionManager: unknown;
  if (resolved.shouldFork && resolved.forkSource) {
    // D-018 优先：createBranchedSession（实例，原地 mutate，体积更小）
    try {
      const sm = sdk.SessionManager.open(resolved.forkSource);
      sm.createBranchedSession(sm.getSessionId()); // 原地 mutate 同一实例
      sessionManager = sm;
    } catch {
      // D-018 降级：forkFrom（静态，全量复制）—— AC-6.3 两级降级链
      sessionManager = sdk.SessionManager.forkFrom(
        resolved.forkSource,
        resolved.effectiveCwd,
        resolved.sessionDir,
      );
    }
  } else {
    // !shouldFork：现有路径（SessionManager.create）
    sessionManager = sdk.SessionManager.create(resolved.effectiveCwd, resolved.sessionDir);
  }

  // 3. createAgentSession（adapter 真引 SDK）
  const { session } = await sdk.createAgentSession({
    cwd: resolved.effectiveCwd,
    sessionManager,
  });

  // 4. identity custom entry + forkDepth（D-007/D-013⑦）
  session.sessionManager.appendCustomEntry(IDENTITY_CUSTOM_TYPE, {
    forkDepth: (opts.parentForkDepth ?? 0) + 1,
  });

  // 5. writeAliveMarker（#12，紧邻 identity entry，session 创建后 prompt 前）
  const sessionFile = session.sessionManager.getSessionFile();
  if (sessionFile) {
    writeAliveMarker(sessionFile, {
      pid: process.pid,
      id: session.sessionId,
      startedAt: Date.now(),
    });
  }

  return { session };
}
