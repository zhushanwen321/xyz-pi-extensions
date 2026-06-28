// src/core/session-context-resolver.ts
//
// resolveSessionContext 纯函数——解析 fork/worktree 意图，返回执行上下文。
// D-014: 零副作用，零 Pi import。只返回意图，不调 forkFrom/不创建 sessionDir。

import * as os from "node:os";
import * as path from "node:path";

import type { ResolvedSessionContext, SessionResolveInput } from "../types.ts";
import { ForkDepthExceededError } from "../types.ts";
import { getSubagentSessionDir } from "./path-encoding.ts";

/** fork 深度硬限。 */
const MAX_FORK_DEPTH = 10;

/**
 * 纯函数：解析 fork/worktree 意图 → 执行上下文。
 *
 * 只返回意图（shouldFork/forkSource/effectiveCwd/sessionDir），
 * 不调 forkFrom / 不创建 sessionDir / 不 git worktree add。
 *
 * @throws {ForkDepthExceededError} fork=true 且 parentForkDepth >= 10
 */
export function resolveSessionContext(input: SessionResolveInput): ResolvedSessionContext {
  const { fork, worktree, cwd, mainCwd, mainSessionFile, parentForkDepth, agentDir, recordId } =
    input;

  // fork 深度检查（D-007）
  if (fork && (parentForkDepth ?? 0) >= MAX_FORK_DEPTH) {
    throw new ForkDepthExceededError(
      `fork depth ${parentForkDepth ?? 0} >= ${MAX_FORK_DEPTH}, refusing to fork`,
    );
  }

  const shouldFork = fork === true;
  const forkSource = shouldFork ? mainSessionFile : undefined;

  // effectiveCwd: worktree=true 时用临时隔离目录，否则用显式 cwd 或 mainCwd
  const effectiveCwd =
    worktree && recordId ? path.join(os.tmpdir(), `pi-sub-${recordId}`) : (cwd ?? mainCwd);

  // sessionDir 用 mainCwd 编码（D-004: 同一主 cwd 下所有 subagent 存同一目录）
  const sessionDir = getSubagentSessionDir(agentDir, mainCwd);

  return { shouldFork, forkSource, effectiveCwd, sessionDir };
}
