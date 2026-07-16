// src/answer-format.ts
// 答案文本格式的唯一权威模块。
// TUI 路径（submit-view.ts:getAnswerText）和 RPC 路径（index.ts:protoAnswersToResult）
// 都调 formatAnswer 产出 "label1, label2 — comment" 格式，确保两条路径一致。
// renderExpandedOptions（index.ts）调 parseAnswerParts 精确反解析选中项。
import { ANSWER_COMMENT_SEPARATOR } from "./types";

/**
 * 把答案各部分拼装为最终文本格式："part1, part2 — comment"。
 * - parts 为空 → 返回 null（未答）
 * - comment 有值 → 追加 ANSWER_COMMENT_SEPARATOR + comment
 */
export function formatAnswer(parts: string[], comment?: string | null): string | null {
	if (parts.length === 0) return null;
	const base = parts.join(", ");
	return comment ? `${base}${ANSWER_COMMENT_SEPARATOR}${comment}` : base;
}

/**
 * 从最终答案文本中精确解析出选中的 labels（不依赖子串匹配）。
 * 用于 renderExpandedOptions 反向判定哪些选项被选中。
 *
 * @param answer 最终答案文本（formatAnswer 产出）
 * @param labels 候选 label 列表（q.options 的 label），精确匹配
 * @returns selected=命中的 labels（按 answer 中出现顺序），comment=评论文本（如有）
 */
export function parseAnswerParts(
	answer: string,
	labels: string[],
): { selected: string[]; comment?: string } {
	// 先提取 comment（ANSWER_COMMENT_SEPARATOR 之后的部分）
	let body = answer;
	let comment: string | undefined;
	const sepIdx = answer.indexOf(ANSWER_COMMENT_SEPARATOR);
	if (sepIdx >= 0) {
		body = answer.slice(0, sepIdx);
		comment = answer.slice(sepIdx + ANSWER_COMMENT_SEPARATOR.length).trim();
	}

	// body 形如 "label1, label2" → 精确匹配候选 label
	const labelSet = new Set(labels);
	const tokens = body.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
	const selected: string[] = [];
	// 剩余 tokens 不匹配任何 label → 是 Other 自由文本（不返回，调用方自行处理）
	for (const token of tokens) {
		if (labelSet.has(token)) {
			selected.push(token);
		}
	}
	return { selected, comment };
}
