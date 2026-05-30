/**
 * Token 估算器
 *
 * Pi 使用 chars/4 启发式估算 token 数量。
 * 此模块提供一致的 token 估算函数。
 * 与 ContextAssembler.estimateTreeContext 使用相同的 chars/4 口径。
 */

/**
 * 估算文本的 token 数量（chars/4 启发式，与 Pi 一致）
 *
 * 注意：单个 message 场景下 Math.ceil(length/4) 与批量场景下
 * Math.ceil(totalChars/4) 在粒度上有微小差异，但所有调用方统一
 * 使用此函数可保证一致性。
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
