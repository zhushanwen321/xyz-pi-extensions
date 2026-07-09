// src/question-view.ts
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

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

/** Other 自由输入 / 已保存预览的软换行行数上限。超出则截断并加省略号。 */
const MAX_EDITOR_LINES = 5;

/**
 * 把一段带样式的文本按 availWidth 软换行输出为多行，最多 maxLines 行。
 * - 首行前缀 lead（如 "> [ ] "），后续行用等宽空格缩进到 input 起始列对齐。
 * - 超过 maxLines：截断到 maxLines 行，并在最后一行末尾用 ellipsis 提示。
 *   此时末行可能已不含末尾光标字符，用 ellipsis 占位表达「还有更多」。
 *
 * @param push      输出回调（通常为带 truncateToWidth 的 add，提供安全兜底）
 * @param lead      首行前缀（含选中标记 / 勾选框）
 * @param content   待换行展示的已样式化文本（可含 ANSI + 末尾光标 █），为空则只输出 lead
 * @param availWidth 单行可用宽度
 * @param maxLines  最多行数
 */
function addWrappedInput(
	push: (s: string) => void,
	lead: string,
	content: string,
	availWidth: number,
	maxLines: number,
): void {
	const avail = Math.max(1, availWidth);
	const indent = " ".repeat(visibleWidth(lead));
	if (content === "") {
		push(lead);
		return;
	}
	let wrapped = wrapTextWithAnsi(content, avail);
	if (wrapped.length > maxLines) {
		wrapped = wrapped.slice(0, maxLines);
		// 最后一行去掉超出，用省略号占位（光标已被省略号取代）
		const lastIdx = wrapped.length - 1;
		wrapped[lastIdx] = truncateToWidth(wrapped[lastIdx]!, Math.max(1, avail - 1), "…");
	}
	for (let i = 0; i < wrapped.length; i++) {
		const seg = wrapped[i]!;
		push(i === 0 ? `${lead}${seg}` : `${indent}${seg}`);
	}
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
			// 标记位宽度必须与普通选项一致，否则编号列错位：
			//   单选 check = 1 列，多选 box = 3 列。
			//   此前单选 freeform 占位用 "  "(2列)、多选非 freeform 用 check(1列)，
			//   两种情况下 Other 编号都与普通选项错位。
			if (state.mode === "freeform") {
				const marker = q.multiSelect ? t.fg("dim", "[ ]") : " ";
				const num = i + 1;
				const lead = `${prefix} ${marker} `;
				const avail = Math.max(1, width - visibleWidth(lead));
				// 编号 + 文本 + 末尾光标 █ 整体软换行（空 input 时仅编号 + 光标，wrapTextWithAnsi 单行）
				const cursorPos = state.cursorIndex;
			const before = editorText.slice(0, cursorPos);
			const after = editorText.slice(cursorPos);
			const styled = `${t.fg("muted", `${num}. `)}${t.fg("text", before)}${t.fg("accent", "█")}${t.fg("text", after)}`;
				addWrappedInput(add, lead, styled, avail, MAX_EDITOR_LINES);
			} else {
				const hasFreeText = state.freeTextValue !== null;
				const marker = q.multiSelect
					? (hasFreeText ? t.fg("success", "[✓]") : t.fg("dim", "[ ]"))
					: (hasFreeText ? t.fg("success", "✓") : " ");
				const labelColor = isSelected ? "accent" : "text";
				const num = i + 1;
				add(`${prefix} ${marker} ${t.fg(labelColor, `${num}. ${opt.label}`)}`);
				if (hasFreeText) {
					// 预览缩进对齐到 label 起始列：prefix + sp + marker + sp + "N." + sp。
					// 随 num 位数与单/多选 marker 宽度动态变化，硬编码会错位。
					const numStr = `${num}.`;
					const lead = " ".repeat(
						visibleWidth(prefix) + 1 + visibleWidth(marker) + 1 + numStr.length + 1,
					);
					const avail = Math.max(1, width - visibleWidth(lead));
					const styled = t.fg("dim", `"${state.freeTextValue ?? ""}"`);
					addWrappedInput(add, lead, styled, avail, MAX_EDITOR_LINES);
				}
			}
		} else if (q.multiSelect) {
			const checked = state.selectedIndices.has(i);
			const box = checked ? t.fg("accent", "[✓]") : t.fg("dim", "[ ]");
			const labelColor = isSelected ? "accent" : "text";
			const num = i + 1;
			add(`${prefix} ${box} ${t.fg(labelColor, `${num}. ${opt.label}`)}`);
			if (opt.description && !hideDescriptions) {
				const wrapped = wrapTextWithAnsi(t.fg("muted", opt.description), width - 10);
				for (const line of wrapped) add(`          ${line}`);
			}
		} else {
			const isConfirmed = state.selectedIndex === i;
			const check = isConfirmed ? t.fg("success", "✓") : " ";
			const labelColor = isSelected ? "accent" : "text";
			const num = i + 1;
			add(`${prefix} ${check} ${t.fg(labelColor, `${num}. ${opt.label}`)}`);
			if (opt.description && !hideDescriptions) {
				const wrapped = wrapTextWithAnsi(t.fg("muted", opt.description), width - 8);
				for (const line of wrapped) add(`        ${line}`);
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
	cursorIndex?: number,
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
	// 渲染当前编辑器文本，光标在 cursorIndex 位置
	const pos = cursorIndex ?? editorText.length;
	const before = editorText.slice(0, pos);
	const after = editorText.slice(pos);
	add(` ${t.fg("text", before)}${t.fg("accent", "█")}${t.fg("text", after)}`);
	add("");
	add(t.fg("dim", " Type to add · Backspace deletes · Enter submit · Esc back"));
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

	// 编辑器/评论模式：选项列表 + 编辑器块（freeform 模式下编辑器块为空，由 buildOptionLines 原地渲染）。
	// 编辑器模式一律用全 width 单列渲染——分屏左列仅约 42% 宽，Other 自由输入会被压窄换行，
	// 且右侧详情预览在输入自定义内容时无意义。隐藏 descriptions 以避免行数爆炸。
	if (state.mode === "freeform" || state.mode === "comment") {
		add("");
		const optionLines = buildOptionLines(q, state, theme, width, false, editorText);
		for (const line of optionLines) add(line);
		const editorBlock = buildEditorBlock(theme, width, state.mode, editorText, state.cursorIndex);
		lines.push(...editorBlock);
		if (state.mode === "freeform") {
			// freeform 模式 help 行：光标锁在 Other 上，正在输入
			add(t.fg("dim", " Type to add · Backspace deletes · Enter submit · Esc back"));
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
	const tabHint = isSingle ? "" : " · ←/→ switch tabs";
	const actionHint = onOther
		? "Enter open editor"
		: q.multiSelect
			? "Space toggle · Enter confirm"
			: "Enter select";
	add(t.fg("dim", ` ↑↓ navigate · ${actionHint}${tabHint} · Esc back`));

	return lines;
}
