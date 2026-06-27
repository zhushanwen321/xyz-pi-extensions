// src/submit-view.ts
import { truncateToWidth } from "@mariozechner/pi-tui";

import {
	ANSWER_COMMENT_SEPARATOR,
	HEADER_MAX_CHARS,
	type Question,
	type QuestionState,
	type Result,
	type ThemeLike,
} from "./types";

/**
 * 获取单问题的答案文本（供 Submit tab 显示）。
 * 返回 null 表示未答。
 */
export function getAnswerText(q: Question, s: QuestionState): string | null {
	if (!s.confirmed) return null;
	const parts: string[] = [];
	if (q.multiSelect) {
		const labels = [...s.selectedIndices]
			.sort((a, b) => a - b)
			.map((idx) => q.options[idx]?.label)
			.filter((l): l is string => !!l);
		parts.push(...labels);
	} else if (s.selectedIndex !== null) {
		const label = q.options[s.selectedIndex]?.label;
		if (label) parts.push(label);
	}
	if (s.freeTextValue !== null) parts.push(s.freeTextValue);
	if (parts.length === 0) return null;
	const base = parts.join(", ");
	return s.commentValue ? `${base}${ANSWER_COMMENT_SEPARATOR}${s.commentValue}` : base;
}

/**
 * 渲染 Submit tab 视图。
 * focus: 当前在 [Submit]/[Cancel] 上的焦点（Tab 切换）。
 *   渲染内嵌按钮栏高亮 focus；help 行更新为 "←/→ navigate · Tab toggle · Enter confirm"。
 */
export function renderSubmitView(
	questions: Question[],
	states: QuestionState[],
	theme: ThemeLike,
	width: number,
	focus: "submit" | "cancel" = "submit",
): string[] {
	const t = theme;
	const lines: string[] = [];
	const add = (s: string): void => {
		lines.push(truncateToWidth(s, width));
	};

	const allDone = states.every((s) => s.confirmed);

	add(
		allDone
			? t.fg("success", t.bold(" Ready to submit"))
			: t.fg("warning", t.bold(" Unanswered questions")),
	);
	add("");

	for (let i = 0; i < questions.length; i++) {
		const q = questions[i]!;
		const answer = getAnswerText(q, states[i]!);
		const headerLabel = truncateToWidth(q.header ?? "", HEADER_MAX_CHARS);
		if (answer !== null) {
			add(` ${t.fg("muted", `${headerLabel}: `)}${t.fg("text", answer)}`);
		} else {
			add(` ${t.fg("dim", `${headerLabel}: `)}${t.fg("warning", "—")}`);
		}
	}

	add("");
	if (allDone) {
		add(t.fg("success", " All questions answered"));
	} else {
		const missing = questions
			.filter((_, i) => !states[i]!.confirmed)
			.map((q) => truncateToWidth(q.header ?? "", HEADER_MAX_CHARS))
			.join(", ");
		add(t.fg("warning", ` Still needed: ${missing}`));
	}

	// 内嵌按钮栏：[ Submit ]   [ Cancel ]，根据 focus 高亮
	add("");
	const isSubmit = focus === "submit";
	const isCancel = focus === "cancel";
	const submitBtn = isSubmit
		? (allDone ? t.fg("success", t.bold(" Submit ")) : t.fg("accent", t.bold(" Submit ")))
		: (allDone ? t.fg("success", " Submit ") : t.fg("dim", " Submit "));
	const cancelBtn = isCancel ? t.fg("accent", t.bold(" Cancel ")) : t.fg("muted", " Cancel ");
	add(`${t.fg("dim", "[")}${submitBtn}${t.fg("dim", "]")}   ${t.fg("dim", "[")}${cancelBtn}${t.fg("dim", "]")}`);

	// Submit tab 帮助行
	add("");
	add(t.fg("dim", " ←/→ navigate · Tab toggle Submit/Cancel · Enter confirm · Esc back"));

	return lines;
}

/**
 * 从 states 构建 Result（供组件 buildResult 调用）。
 */
export function buildResult(questions: Question[], states: QuestionState[]): Result {
	const answers: Record<string, string> = {};
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i]!;
		const s = states[i]!;
		const text = getAnswerText(q, s);
		if (text !== null) answers[q.question] = text;
	}
	return { questions, answers, cancelled: false };
}
