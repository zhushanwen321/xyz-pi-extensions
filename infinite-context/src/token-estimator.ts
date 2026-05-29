/**
 * Token 估算器
 *
 * Pi 使用 chars/4 启发式估算 token 数量。
 * 此模块提供一致的 token 估算函数，供 SegmentTracker 和后续的 TreeCompressor 使用。
 */

/**
 * 估算文本的 token 数量
 * 使用 chars/4 启发式（与 Pi 运行时一致）
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
