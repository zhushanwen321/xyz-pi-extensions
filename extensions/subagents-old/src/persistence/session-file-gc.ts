// src/persistence/session-file-gc.ts
//
// ADR-024 L2: subagent session 文件 TTL 清理。
//
// session 文件含完整 messages + tool calls，体积远大于 history 行。
// 清理策略：扫描 sessions/ 目录，删除 mtime 超过 SESSION_FILE_TTL_DAYS 的文件。
// 与 history GC 解耦——history 可保留更久（行小），session 文件按 TTL 清。
//
// 触发时机：session_start 时惰性执行（概率性，避免每次启动都扫描）。

import * as fs from "node:fs";

import { getSessionsDir } from "../config/config-path.ts";
import { SESSION_FILE_TTL_DAYS } from "../types.ts";

/** ms per day */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 清理过期的 subagent session 文件。
 *
 * @param homeDir 用户主目录
 * @param cwd 项目目录
 * @returns 删除的文件数（失败静默，返回 0）
 */
export function cleanupExpiredSessionFiles(homeDir: string, cwd: string): number {
  const dir = getSessionsDir(homeDir, cwd);
  let deleted = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // 目录不存在或不可读 → 无需清理
    return 0;
  }

  const now = Date.now();
  const ttlMs = SESSION_FILE_TTL_DAYS * MS_PER_DAY;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".jsonl")) continue;
    const filePath = `${dir}/${entry.name}`;
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > ttlMs) {
        fs.unlinkSync(filePath);
        deleted++;
      }
    } catch {
      // 单文件 stat/unlink 失败跳过
    }
  }
  return deleted;
}

/**
 * 概率性触发 GC（session_start 时调用）。
 *
 * @param probability 触发概率（0-1，默认 0.1 = 10%）
 * @returns 删除的文件数（未触发返回 0）
 */
export function maybeCleanupExpiredSessionFiles(
  homeDir: string,
  cwd: string,
  probability = 0.1,
): number {
  if (Math.random() >= probability) return 0;
  return cleanupExpiredSessionFiles(homeDir, cwd);
}
