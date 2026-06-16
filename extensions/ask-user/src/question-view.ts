// src/question-view.ts
import { truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

import {
	OTHER_LABEL,
	type Question,
	type QuestionState,
	SPLIT_PANE_LEFT_MIN,
	SPLIT_PANE_MIN_WIDTH,
	SPLIT_PANE_RIGHT_MIN,
	SPLIT_PANE_SEPARATOR,
	type ThemeLike,
} from "./types";

export interface DisplayOption {
	label: string;
	description?: string;
	isOther?: boolean;
}

/** 在选项数组末尾追加 Other 自由输入项。 */
export function allOptions(q: Question): DisplayOption[] {
	return [...q.options, { label: OTHER_LABEL, isOther: true }];
}

/**
 * 宽终端（≥SPLIT_PANE_MIN_WIDTH）计算左右分屏宽度。窄终端返回 null（单列模式）。
 */
export function getSplitPaneWidths(width: number): { left: number; right: number } | null {
	if (width < SPLIT_PANE_MIN_WIDTH) return null;
	const available = width - SPLIT_PANE_SEPARATOR.length;
	if (available < SPLIT_PANE_LEFT_MIN + SPLIT_PANE_RIGHT_MIN) return null;
	const preferredLeft = Math.floor(available * 0.42);
	const left = Math.max(
		SPLIT_PANE_LEFT_MIN,
		Math.min(preferredLeft, available - SPLIT_PANE_RIGHT_MIN),
	);
	const right = available - left;
	if (right < SPLIT_PANE_RIGHT_MIN) return null;
	return { left, right };
}

/** 构建选项列表行（不含分屏预览）。hideDescriptions 用于分屏模式左列。
 *  freeform 模式下，Other 行**原地**变 [ ] <input>█（多选）/ <input>█（单选），
 *  不再依赖 buildEditorBlock 的下方独立编辑块。 */
function buildOptionLines(
	q: Question,
	state: QuestionState,
	theme: ThemeLike,
	width: number,
	hideDescriptions: boolean,
	editorText: string = "",
): string[] {
	const t = theme;
	const opts = allOptions(q);
	const lines: string[] = [];
	const add = (s: string): void => {
		lines.push(truncateToWidth(s, width));
	};

	for (let i = 0; i < opts.length; i++) {
		const opt = opts[i]!;
		const isSelected = i === state.cursorIndex;
		const isOther = opt.isOther === true;
		const prefix = isSelected ? t.fg("accent", ">") : " ";

		if (isOther) {
			if (state.mode === "freeform") {
				// 原地编辑：与多选普通选项的 [ ] 框视觉对齐（单选无勾选语义则留空）
				const box = q.multiSelect ? t.fg("dim", "[ ]") : "  ";
				const inputText = editorText.length > 0 ? editorText : "";
				const inputLine = `${inputText}${t.fg("accent", "█")}`;
				add(`${prefix} ${box} ${t.fg("text", inputLine)}`);
			} else {
				const hasFreeText = state.freeTextValue !== null;
				const check = hasFreeText ? t.fg("success", "✓") : " ";
				const labelColor = isSelected ? "accent" : "muted";
				const num = i + 1;
				add(`${prefix} ${check} ${t.fg(labelColor, `${num}. ${opt.label}`)}`);
				if (hasFreeText) {
					const preview = truncateToWidth(state.freeTextValue ?? "", width - 5);
					add(`     ${t.fg("dim", `"${preview}"`)}`);
				}
			}
		} else if (q.multiSelect) {
			const checked = state.selectedIndices.has(i);
			const box = checked ? t.fg("accent", "[✓]") : t.fg("dim", "[ ]");
			const labelColor = isSelected ? "accent" : "text";
			const num = i + 1;
			add(`${prefix} ${box} ${t.fg(labelColor, `${num}. ${opt.label}`)}`);
			if (opt.description && !hideDescriptions) {
				const wrapped = wrapTextWithAnsi(t.fg("muted", opt.description), width - 7);
				for (const line of wrapped) add(`       ${line}`);
			}
		} else {
			const isConfirmed = state.selectedIndex === i;
			const check = isConfirmed ? t.fg("success", "✓") : " ";
			const labelColor = isSelected ? "accent" : "text";
			const num = i + 1;
			add(`${prefix} ${check} ${t.fg(labelColor, `${num}. ${opt.label}`)}`);
			if (opt.description && !hideDescriptions) {
				const wrapped = wrapTextWithAnsi(t.fg("muted", opt.description), width - 5);
				for (const line of wrapped) add(`     ${line}`);
			}
		}
	}
	return lines;
}

/** 构建分屏右侧 Markdown 详情预览。 */
function buildPreviewLines(
	q: Question,
	state: QuestionState,
	theme: ThemeLike,
	width: number,
	maxLines: number,
): string[] {
	const t = theme;
	const opts = allOptions(q);
	const opt = opts[state.cursorIndex];
	if (!opt) return [t.fg("dim", "—")];

	let text = "";
	if (opt.isOther) {
		text = `${opt.label}: enter a custom answer not listed above.`;
	} else {
		text = opt.label;
		if (opt.description?.trim()) text += `\n\n${opt.description}`;
	}

	const wrapped = wrapTextWithAnsi(t.fg("muted", text), Math.max(10, width));
	const lines = wrapped.slice(0, maxLines);
	if (wrapped.length > maxLines) lines.push(t.fg("dim", "…"));
	return lines;
}

/**
 * 渲染单个问题视图（spec FR-4）。
 * isSingle: 单问题模式（无 Tab 提示）。
 * editorText: freeform/comment 模式下当前编辑器文本（纯 string，由 component 持有）。
 */
/**
 * freeform 模式：editor 已在 buildOptionLines 中原地渲染（[ ] <input>█ 行），
 * buildEditorBlock 在此模式下不重复输出，**仅留出与正常 help 行同位置的视觉空隙**。
 * comment 模式：保留独立编辑块（与 normal help 行解耦：comment 行有更长的 prompt）。
 */
function buildEditorBlock(
	theme: ThemeLike,
	width: number,
	mode: "freeform" | "comment",
	editorText: string,
): string[] {
	if (mode === "freeform") {
		return [""];
	}
	const t = theme;
	const lines: string[] = [];
	const add = (s: string): void => {
		lines.push(truncateToWidth(s, width));
	};
	add("");
	const prompt = t.fg("muted", " Your comment (optional):");
	add(prompt);
	// 渲染当前编辑器文本（单行；多行时按 \n 拆分）
	for (const line of editorText.split("\n")) add(` ${line}`);
	// 光标行
	add(` ${t.fg("accent", "█")}`);
	add("");
	add(t.fg("dim", " Enter submit · Esc back"));
	return lines;
}

/** 渲染分屏模式下的左右双列（选项列表 + 详情预览）。 */
function buildSplitPane(
	q: Question,
	state: QuestionState,
	theme: ThemeLike,
	split: { left: number; right: number },
	width: number,
	editorText: string = "",
): string[] {
	const t = theme;
	const lines: string[] = [];
	const add = (s: string): void => {
		lines.push(truncateToWidth(s, width));
	};
	const leftLines = buildOptionLines(q, state, theme, split.left, true, editorText);
	const rightLines = buildPreviewLines(q, state, theme, split.right, Math.max(leftLines.length, 8));
	const rowCount = Math.max(leftLines.length, rightLines.length);
	const sep = t.fg("dim", SPLIT_PANE_SEPARATOR);
	for (let i = 0; i < rowCount; i++) {
		const left = truncateToWidth(leftLines[i] ?? "", split.left, "", true);
		const right = truncateToWidth(rightLines[i] ?? "", split.right);
		add(`${left}${sep}${right}`);
	}
	return lines;
}

export function renderQuestionView(
	q: Question,
	state: QuestionState,
	theme: ThemeLike,
	width: number,
	isSingle: boolean,
	editorText: string,
): string[] {
	const t = theme;
	const lines: string[] = [];
	const add = (s: string): void => {
		lines.push(truncateToWidth(s, width));
	};
	const divider = (): void => add(t.fg("dim", "─".repeat(Math.max(0, width))));

	// 问题文本（word-wrap）
	const wrapped = wrapTextWithAnsi(t.fg("text", ` ${q.question}`), width - 2);
	for (const line of wrapped) add(line);

	// 上下文（如有）
	if (q.context?.trim()) {
		divider();
		const ctxWrapped = wrapTextWithAnsi(t.fg("muted", q.context), width - 2);
		for (const line of ctxWrapped) add(line);
	}

	// 分屏判断
	const split = getSplitPaneWidths(width);

	// 选项模式下：question/context 与 options 之间加分割线（三段式）
	// 编辑器模式不加（编辑器块自带视觉边界）
	if (state.mode !== "freeform" && state.mode !== "comment") {
		divider();
	}

	// 编辑器/评论模式：选项列表 + 编辑器块（freeform 模式下编辑器块为空，由 buildOptionLines 原地渲染）
	if (state.mode === "freeform" || state.mode === "comment") {
		add("");
		const optionLines = buildOptionLines(q, state, theme, split ? split.left : width, !!split, editorText);
		for (const line of optionLines) add(line);
		const editorBlock = buildEditorBlock(theme, width, state.mode, editorText);
		lines.push(...editorBlock);
		if (state.mode === "freeform") {
			// freeform 模式 help 行：光标锁在 Other 上，正在输入
			add(t.fg("dim", " Enter submit · Esc back"));
		}
		return lines;
	}

	if (!split) {
		// 单列模式
		const optionLines = buildOptionLines(q, state, theme, width, false, editorText);
		for (const line of optionLines) add(line);
	} else {
		// 分屏模式
		lines.push(...buildSplitPane(q, state, theme, split, width, editorText));
	}

	add("");

	// 帮助行（上下文相关）
	const opts = allOptions(q);
	const onOther = state.cursorIndex === opts.length - 1;
	const tabHint = isSingle ? "" : " · Tab switch tabs";
	const actionHint = onOther
		? "Enter open editor"
		: q.multiSelect
			? "Space toggle · Enter confirm"
			: "Enter select";
	add(t.fg("dim", ` ↑↓ navigate · ${actionHint}${tabHint} · Esc back`));

	return lines;
}
