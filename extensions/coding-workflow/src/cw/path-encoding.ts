// src/cw/path-encoding.ts
//
// cwd → 安全目录名的编码逻辑。零依赖叶子原语。
//
// 与 subagents 的 `extensions/subagents/src/core/path-encoding.ts` 同源（两者都复刻
// Pi SDK `getDefaultSessionDir` 的编码规则）。不直接 import subagents——它是
// `@zhushanwen/pi-subagents` 的内部函数（包公开接口只有 default export），跨扩展
// 源码 import 会形成脆弱耦合。复制这 1 行是最干净的做法（subagents 自己也是复制 SDK 的）。

/**
 * cwd → 安全目录名。复用 Pi SDK `getDefaultSessionDir` 的编码规则：
 * 去开头单个分隔符，全量替换剩余分隔符/冒号为 `-`，首尾补 `--`。
 *
 * 例：`/Users/x/proj` → `--Users-x-proj--`。
 *
 * 被 `resolveCwDbPath` 用：把 workspacePath 编码为 `~/.pi/agent/cw/<encoded-cwd>/`
 * 下的目录名，与 subagents（ADR-027）的 `~/.pi/agent/subagents/<encoded-cwd>/` 同构。
 */
export function encodeCwd(cwd: string): string {
  return "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
}
