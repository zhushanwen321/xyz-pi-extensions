// src/runtime/session-file-gc.ts
//
// 概率性清理过期 subagent session 文件（TTL 30 天）。
// session_start 时调用，best-effort（失败不影响启动）。

/** 清理 homeDir/.pi/agent/subagents 下超过 TTL 的 session 文件。 */
export function maybeCleanupExpiredSessionFiles(homeDir: string, cwd: string): void {
  //  1. glob ~/.pi/agent/subagents/**/*.jsonl
  //  2. 概率性触发（避免每次 session_start 都全扫）
  //  3. mtime 超 30 天 → unlink
  void homeDir; void cwd;
  throw new Error("not implemented");
}
