// src/core/path-encoding.ts
//
// cwd → 安全目录名的编码逻辑。Core 叶子原语（零依赖）。
//
// 被 session-runner（subagent session 持久化目录）与 session-file-gc（清理过期
// session 文件）共用——两处需要相同的编码，否则同一 cwd 会落到两个不同目录。

/**
 * cwd → 安全目录名。复用 Pi SDK getDefaultSessionDir 的编码逻辑：
 * 去开头单个分隔符，全量替换剩余分隔符/冒号为 `-`，首尾补 `--`。
 * 例：`/Users/x/proj` → `--Users-x-proj--`。
 */
export function encodeCwd(cwd: string): string {
  return "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
}
