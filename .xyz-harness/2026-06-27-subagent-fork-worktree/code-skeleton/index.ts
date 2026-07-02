// code-skeleton/index.ts — ⑤骨架（#9 修改）
// session_start 挂 WorktreeManager.scan（reaper）+ 缓存 mainSessionFile。
// AC-6 grep 验：session_start 含 WorktreeManager.scan 调用（非 WorktreeReaper.scan）。

import { WorktreeManager } from "./runtime/worktree-manager.ts";

/**
 * session_start 钩子（#9 ✎）。
 * D-013④: session_start 挂 WorktreeManager.scan（reaper，best-effort）。
 * #9: 缓存 ctx.sessionManager.getSessionFile() → mainSessionFile（供 fork source）。
 *
 * 数据流：session_start → [cache mainSessionFile → SessionRunnerContext] + WorktreeManager.scan(reaper)
 * 失败路径：scan 抛错 best-effort catch（不阻断 session_start，service 已注册）
 */
export function onSessionStart(
  ctx: { cwd: string; sessionManager: { getSessionFile(): string | undefined; getSessionId(): string } },
  agentDir: string,
): void {
  // #9: 缓存 mainSessionFile（fork source，供 SessionRunnerContext）
  const mainSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
  void mainSessionFile; // → buildSessionRunnerContext.mainSessionFile（骨架省略注入）

  // D-013④: best-effort 清理（GC + reaper）。顺序：service 注册后（骨架省略 service 装配）
  try {
    // 现有 GC（骨架省略 maybeCleanupExpiredSessionFiles 调用）
    // D-013④: reaper —— AC-6 grep 验含 WorktreeManager.scan
    const reaper = new WorktreeManager();
    reaper.scan(ctx.cwd, agentDir);
  } catch (err) {
    // best-effort：reaper 失败不阻断 session_start
    void err;
  }
}
