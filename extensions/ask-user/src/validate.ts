// src/validate.ts
import { HEADER_MAX_CHARS, type Question, QUESTION_MAX_CHARS } from "./types";

/** 控制字符（含 \n \r \t 等）：question 文本禁止包含，避免 answers key 含不可见字符（spec FR-2） */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/**
 * 校验输入参数。通过返回 null，失败返回错误消息字符串。
 * 校验项（spec FR-2）：
 * - question 文本长度上限与无控制字符（保证 answers key 有界、可预测）
 * - question 文本在数组内唯一
 * - 同问题内 option label 唯一
 * - 多问题（questions.length > 1）时每个 question 必须有非空 header
 *
 * 错误消息面向 LLM：除描述违规外，附带一句修复指引（如何改）。
 */
export function validateInput(questions: Question[]): string | null {
	const seenQuestions = new Set<string>();

	for (const q of questions) {
		const qt = q.question;

		// 1a. question 文本长度上限（key 有界）
		if (qt.length > QUESTION_MAX_CHARS) {
			return `Question text exceeds ${QUESTION_MAX_CHARS} chars: "${qt.slice(0, 20)}...". Shorten it to a single concise decision; move extra context into the context field.`;
		}
		// 1b. question 文本无控制字符（key 可预测，不影响下游渲染/解析）
		if (CONTROL_CHAR_RE.test(qt)) {
			return `Question text must not contain control characters (incl. newlines): "${qt.slice(0, 20)}...". Use plain single-line text; split multi-part questions into separate entries.`;
		}

		// 1c. question 文本唯一
		if (seenQuestions.has(qt)) {
			return `Duplicate question: "${qt}". Each question text must be unique; merge duplicates or rephrase one to differ.`;
		}
		seenQuestions.add(qt);

		// 2. option label 唯一且非空（空 label 会污染 details.answers 的值）
		const seenLabels = new Set<string>();
		for (const opt of q.options) {
			if (opt.label.trim() === "") {
				return `Option label must not be empty in question "${q.question}". Give every option a distinct, descriptive label.`;
			}
			if (seenLabels.has(opt.label)) {
				return `Duplicate option label "${opt.label}" in question "${q.question}". Options must be mutually exclusive — reword one so each label maps to a distinct choice.`;
			}
			seenLabels.add(opt.label);
		}
	}

	// 3. 多问题时 header 必填且非空
	if (questions.length > 1) {
		for (const q of questions) {
			if (!q.header || q.header.trim() === "") {
				return `Question "${q.question}" requires a non-empty header in multi-question mode (it labels the tab). Provide a header of <=12 chars.`;
			}
		}
	}

	// 4. header 长度上限（若提供）。单/多问题均校验：超出会在 tab 栏被静默截断，
	//    这里提前拒绝，让 LLM 拿到可修复错误而非残缺 UI（兑现 schema description 的 ≤12 契约）。
	for (const q of questions) {
		if (q.header !== undefined && q.header.length > HEADER_MAX_CHARS) {
			return `Header exceeds ${HEADER_MAX_CHARS} chars: "${q.header.slice(0, 20)}..." in question "${q.question}". Shorten it; longer headers are truncated in the tab bar.`;
		}
	}

	return null;
}
