// code-skeleton/core/session-context-resolver.ts — ⑤骨架（#3 NEW 纯函数）
// 解析 fork/worktree 意图 → effectiveCwd + sessionDir。
// D-014: 真纯函数——零副作用（无 execFileSync/writeFileSync/spawn/readFileSync/forkFrom/sdk.）
//   零 Pi import（②§11 AC-1/AC-2 grep 验）。forkFrom 调用留 session-runner（经 ctx.sdk）。
// fork 深度校验在此（读 parentForkDepth，D-007）。

import type { ResolveInput, SessionContext } from "../types.ts";
import { ForkDepthExceededError } from "../types.ts";
import { encodeCwd } from "./path-encoding.ts";

/** fork 深度上限（D-007）。 */
const MAX_FORK_DEPTH = 10;

/** sessionDir 前缀（与现有 getSubagentSessionDir 一致：agentDir/subagents/<encoded-cwd>/sessions）。 */
function buildSessionDir(agentDir: string, cwd: string): string {
  // 纯 path 计算（path.join），不 mkdir（mkdir 由 SessionManager.create/forkFrom 负责）
  // 这里复用 encodeCwd 但避免 import path（保持纯计算可见性）——实际拼接在调用方
  return `${agentDir}/subagents/${encodeCwd(cwd)}/sessions`;
}

/**
 * resolveSessionContext（#3 核心纯函数）。
 * 只返回 fork 意图，不调 forkFrom/不创建 sessionDir/不 git worktree add（D-014）。
 *
 * 边界条件见 code-architecture.md §3 resolveSessionContext 边界表。
 * fork:true + parentForkDepth>=10 → 抛 ForkDepthExceededError（D-007）。
 */
export function resolveSessionContext(
  input: ResolveInput,
  agentDir: string,
): SessionContext {
  // D-007: fork 深度校验
  if (input.fork && (input.parentForkDepth ?? 0) >= MAX_FORK_DEPTH) {
    throw new ForkDepthExceededError(input.parentForkDepth ?? 0);
  }
  // effectiveCwd: worktree 时用 cwd（worktreePath），否则 mainCwd
  const effectiveCwd = input.worktree && input.cwd ? input.cwd : input.mainCwd;
  // sessionDir: 恒用 mainCwd 编码（D-004，不随 effectiveCwd/worktreeCwd 变）
  const sessionDir = buildSessionDir(agentDir, input.mainCwd);
  return {
    shouldFork: input.fork === true && input.mainSessionFile !== undefined,
    forkSource: input.mainSessionFile,
    effectiveCwd,
    sessionDir,
  };
}
