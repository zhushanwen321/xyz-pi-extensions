// code-skeleton/core/path-encoding.ts — ⑤骨架（依赖桩，#3 SCR 复用）
// encodeCwd：把 cwd 编码为安全的目录名（现有实现，骨架提供签名供 SCR import 通过）。
// 实际实现见 extensions/subagents/src/core/path-encoding.ts。

/**
 * 把 cwd 编码为安全目录名（现有逻辑）。
 * 用于 sessionDir 路径拼接（getSubagentSessionDir → subagents/<encoded-cwd>/sessions）。
 */
export function encodeCwd(cwd: string): string {
  // 现有实现：Base64URL 或替换路径分隔符（骨架桩，保持签名一致供 tsc 通过）
  return cwd.replace(/[/\\:]/g, "_");
}
