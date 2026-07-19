// src/core/path-encoding.ts
//
// cwd → 安全目录名的编码逻辑。Core 叶子原语（零依赖）。
//
// 被 session-runner（subagent session 持久化目录）与 session-file-gc（清理过期
// session 文件）共用——两处需要相同的编码，否则同一 cwd 会落到两个不同目录。

import * as path from "node:path";

/**
 * cwd → 安全目录名。复用 Pi SDK getDefaultSessionDir 的编码逻辑：
 * 去开头单个分隔符，全量替换剩余分隔符/冒号为 `-`，首尾补 `--`。
 * 例：`/Users/x/proj` → `--Users-x-proj--`。
 */
export function encodeCwd(cwd: string): string {
  return "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
}

/**
 * 获取 subagent session 持久化目录路径。
 *
 * D-004: 用主 cwd 编码——保证同一主 cwd 下所有 subagent 的 session 文件
 * 存放在同一目录，便于 session-file-gc 统一清理。
 *
 * @param agentDir agent 配置目录（如 ~/.pi/agent）
 * @param mainCwd 主 agent 的工作目录（非 subagent 的 effectiveCwd）
 * @returns session 持久化目录绝对路径
 */
export function getSubagentSessionDir(agentDir: string, mainCwd: string): string {
  // [MF#1] 保持既有布局 subagents/<enc>/sessions/——曾改为 subagents/sessions/<enc>/ 会让
  // 升级用户的既有 session 文件全部落到扫描目录外（历史记录消失 + GC 扫不到，双重 orphan）。
  // 本分支未发布，回退到既有布局即无需迁移、无数据丢失。
  return path.join(agentDir, "subagents", encodeCwd(mainCwd), "sessions");
}

/**
 * 获取 subagent records（manifest）持久化目录路径。
 *
 * 与 getSubagentSessionDir 同用 encodeCwd(mainCwd)，保证 records 与 sessions 在同一
 * <enc> 段下物理相邻——worktree 场景三者恒等（init.cwd /
 * buildSessionRunnerContext.mainCwd / record.worktreeHandle.mainCwd 指向同一主 cwd）。
 *
 * D-004 同源：用主 cwd 编码做物理隔离，使 session-file-gc 按 <enc>/records/ 子目录
 * 匹配 manifest .json 时天然限定在当前 cwd 范围内，不会越界清理其他 cwd 的 manifest。
 *
 * @param agentDir agent 配置目录（如 ~/.pi/agent）
 * @param mainCwd 主 agent 的工作目录（非 subagent 的 effectiveCwd）
 * @returns records 持久化目录绝对路径
 */
export function getSubagentRecordsDir(agentDir: string, mainCwd: string): string {
  return path.join(agentDir, "subagents", encodeCwd(mainCwd), "records");
}
