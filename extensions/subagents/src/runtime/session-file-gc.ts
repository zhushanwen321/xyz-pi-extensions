// src/runtime/session-file-gc.ts
//
// 概率性清理过期 subagent session 文件（TTL 30 天）。
// session_start 时调用，best-effort（失败不影响启动）。

import * as fs from "node:fs";
import * as path from "node:path";

/** 30 天 TTL（毫秒）。 */
const TTL_DAYS = 30;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const TTL_MS = TTL_DAYS * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** 触发概率（1/20 = 5%，避免每次 session_start 都全扫）。 */
const CLEANUP_PROBABILITY_DIVISOR = 20;
const CLEANUP_PROBABILITY = 1 / CLEANUP_PROBABILITY_DIVISOR;

/** subagent session 文件目录（相对 agentDir）。 */
const SUBAGENTS_DIR = "subagents";

/**
 * 概率性清理过期 session 文件。best-effort——任何异常不外抛。
 *
 *   1. 概率性触发（CLEANUP_PROBABILITY）
 *   2. 递归扫描 <agentDir>/subagents 下所有 .jsonl 文件
 *   3. mtime 超 TTL → unlink
 */
export function maybeCleanupExpiredSessionFiles(agentDir: string, cwd: string): void {
  void cwd;
  try {
    if (Math.random() >= CLEANUP_PROBABILITY) return;
    const dir = path.join(agentDir, SUBAGENTS_DIR);
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    walkAndClean(dir, now);
  } catch (_e) {
    // best-effort：任何异常不阻断 session_start
    void _e;
  }
}

/** 递归扫描目录，unlink 超 TTL 的 .jsonl 文件。 */
function walkAndClean(dir: string, now: number): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_e) {
    void _e;
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAndClean(full, now);
    } else if (entry.name.endsWith(".jsonl")) {
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > TTL_MS) {
          fs.unlinkSync(full);
        }
      } catch (_e) {
        // 文件可能已被删除，忽略
        void _e;
      }
    }
  }
}
