// src/answer-format.ts
// 答案文本格式的唯一权威模块。
// TUI 路径（submit-view.ts:getAnswerText）和 RPC 路径（index.ts:protoAnswersToResult）
// 都调 formatAnswer 产出 "label1, label2" 格式，确保两条路径一致。
// renderExpandedOptions（index.ts）调 parseAnswerParts 精确反解析选中项。

/**
 * 把答案各部分拼装为最终文本格式："part1, part2"。
 * parts 为空 → 返回 null（未答）。
 */
export function formatAnswer(parts: string[]): string | null {
	if (parts.length === 0) return null;
	return parts.join(", ");
}

/**
 * 从最终答案文本中精确解析出选中的 labels（不依赖子串匹配）。
 * 用于 renderExpandedOptions 反向判定哪些选项被选中。
 *
 * @param answer 最终答案文本（formatAnswer 产出）
 * @param labels 候选 label 列表（q.options 的 label），精确匹配
 * @returns selected=命中的 labels（按 answer 中出现顺序）；未命中的 tokens 视为 Other 自由文本
 */
export function parseAnswerParts(
	answer: string,
	labels: string[],
): { selected: string[] } {
	const labelSet = new Set(labels);
	const tokens = answer.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
	const selected: string[] = [];
	// 剩余 tokens 不匹配任何 label → 是 Other 自由文本（不返回，调用方自行处理）
	for (const token of tokens) {
		if (labelSet.has(token)) {
			selected.push(token);
		}
	}
	return { selected };
}
