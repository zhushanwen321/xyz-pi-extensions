// src/config/config-path.ts
import * as path from "node:path";

/** FR-4.6.1: config.json 路径 */
export function getConfigDir(homeDir: string): string {
  return path.join(homeDir, ".pi", "agent", "extensions", "subagents");
}

export function getConfigPath(homeDir: string): string {
  return path.join(getConfigDir(homeDir), "config.json");
}

// ============================================================
// ADR-024: 执行记录与会话持久化路径
// ============================================================

/**
 * subagents 数据根目录：`~/.pi/agent/subagents/`。
 * 与主 session（`~/.pi/agent/sessions/`）物理隔离。
 */
export function getSubagentsDataRoot(homeDir: string): string {
  return path.join(homeDir, ".pi", "agent", "subagents");
}

/**
 * 按 cwd 隔离的 subagents 数据目录。
 * encoded-cwd 复用主 session 的编码约定（路径分隔符 → `-`），
 * 保证同一项目的主 session 与 subagent 数据在同一编码下可对应。
 */
export function getCwdScopedDir(homeDir: string, cwd: string): string {
  const encoded = encodeCwd(cwd);
  return path.join(getSubagentsDataRoot(homeDir), encoded);
}

/** L1: 执行记录 jsonl 路径 */
export function getHistoryFilePath(homeDir: string, cwd: string): string {
  return path.join(getCwdScopedDir(homeDir, cwd), "history.jsonl");
}

/** L2: subagent 会话文件目录（每个 subagent 一个 jsonl） */
export function getSessionsDir(homeDir: string, cwd: string): string {
  return path.join(getCwdScopedDir(homeDir, cwd), "sessions");
}

/**
 * cwd → 安全目录名。复用 Pi SDK getDefaultSessionDir 的编码逻辑：
 * 先去开头单个分隔符，再全量替换剩余分隔符为 `-`，首尾补 `--`。
 * 例：`/Users/x/proj` → `--Users-x-proj--`。
 */
function encodeCwd(cwd: string): string {
  return "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
}
