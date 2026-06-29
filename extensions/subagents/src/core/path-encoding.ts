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
 * [MF#4] worktree branch → sessionFile 映射 sidecar 路径。
 *
 * reaper 从 worktree 注册表目录名只能拿到 recordId（branch=pi-sub-<recordId>），
 * 但 session 文件由 SDK 命名为 <date>-<uuid>.jsonl，recordId 仅存在于文件内部 identity entry。
 * 故 session-runner 在 sessionFile 就绪后写此 sidecar（内容=sessionFile 绝对路径），
 * reaper 直接读取，避免遍历全量 .jsonl 反查 identity。
 */
export function worktreeMappingFile(sessionsDir: string, branch: string): string {
  return path.join(sessionsDir, `${branch}.session`);
}
