// src/validate.ts
import { QUESTION_MAX_CHARS, type Question } from "./types";

/** 控制字符（含 \n \r \t 等）：question 文本禁止包含，避免 answers key 含不可见字符（spec FR-2） */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/**
 * 校验输入参数。通过返回 null，失败返回错误消息字符串。
 * 校验项（spec FR-2）：
 * - question 文本长度上限与无控制字符（保证 answers key 有界、可预测）
 * - question 文本在数组内唯一
 * - 同问题内 option label 唯一
 * - 多问题（questions.length > 1）时每个 question 必须有非空 header
 */
export function validateInput(questions: Question[]): string | null {
	const seenQuestions = new Set<string>();

	for (const q of questions) {
		const qt = q.question;

		// 1a. question 文本长度上限（key 有界）
		if (qt.length > QUESTION_MAX_CHARS) {
			return `Question text exceeds ${QUESTION_MAX_CHARS} chars: "${qt.slice(0, 20)}..."`;
		}
		// 1b. question 文本无控制字符（key 可预测，不影响下游渲染/解析）
		if (CONTROL_CHAR_RE.test(qt)) {
			return `Question text must not contain control characters (incl. newlines): "${qt.slice(0, 20)}..."`;
		}

		// 1c. question 文本唯一
		if (seenQuestions.has(qt)) {
			return `Duplicate question: "${qt}"`;
		}
		seenQuestions.add(qt);

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
