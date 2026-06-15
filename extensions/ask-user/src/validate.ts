// src/validate.ts
import type { Question } from "./types";

/**
 * 校验输入参数。通过返回 null，失败返回错误消息字符串。
 * 校验项（spec FR-2）：
 * - question 文本在数组内唯一
 * - 同问题内 option label 唯一
 * - 多问题（questions.length > 1）时每个 question 必须有非空 header
 */
export function validateInput(questions: Question[]): string | null {
	const seenQuestions = new Set<string>();

	for (const q of questions) {
		// 1. question 文本唯一
		if (seenQuestions.has(q.question)) {
			return `Duplicate question: "${q.question}"`;
		}
		seenQuestions.add(q.question);

		// 2. option label 唯一
		const seenLabels = new Set<string>();
		for (const opt of q.options) {
			if (seenLabels.has(opt.label)) {
				return `Duplicate option label "${opt.label}" in question "${q.question}"`;
			}
			seenLabels.add(opt.label);
		}
	}

	// 3. 多问题时 header 必填且非空
	if (questions.length > 1) {
		for (const q of questions) {
			if (!q.header || q.header.trim() === "") {
				return `Question "${q.question}" requires a non-empty header in multi-question mode`;
			}
		}
	}

	return null;
}
