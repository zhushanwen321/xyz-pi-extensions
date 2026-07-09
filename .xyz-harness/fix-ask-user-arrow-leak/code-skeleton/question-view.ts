// code-skeleton/question-view.ts
// [SKELETON] question-view.ts 骨架 — editorText 参数链保持（从 state.draftText 透传）。
// 纯渲染函数，签名与 src/question-view.ts 一致（editorText 参数名保留，调用方传 state.draftText）。
// 提示行（#4）改动在 buildEditorBlock / renderQuestionView freeform help 行，骨架仅标位置。
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

function addWrappedInput(
	push: (s: string) => void,
	lead: string,
	content: string,
	availWidth: number,
	maxLines: number,
): void {
	throw new Error("SKELETON: addWrappedInput impl not in scope (unchanged from src)");
}

/** 把选项数组末尾追加 Other 自由输入项。 */
export function allOptions(q: Question): DisplayOption[] {
	return [...q.options, { label: OTHER_LABEL, isOther: true }];
}

/** 宽终端（≥SPLIT_PANE_MIN_WIDTH）计算左右分屏宽度。窄终端返回 null（单列模式）。 */
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

/**
 * 构建选项列表行（不含分屏预览）。
 * [#2] editorText 参数保留（从 state.draftText 透传，调用方传 state.draftText）。
 * freeform 模式下 Other 行原地变 [ ] <input>█，editorText 驱动光标行内容。
 */
function buildOptionLines(
	q: Question,
	state: QuestionState,
	theme: ThemeLike,
	width: number,
	hideDescriptions: boolean,
	editorText: string = "",
): string[] {
	throw new Error("SKELETON: buildOptionLines impl not in scope (unchanged, editorText param from state.draftText)");
}

/** 构建分屏右侧 Markdown 详情预览。 */
function buildPreviewLines(
	q: Question,
	state: QuestionState,
	theme: ThemeLike,
	width: number,
	maxLines: number,
): string[] {
	throw new Error("SKELETON: buildPreviewLines impl not in scope");
}

/**
 * comment 模式独立编辑块。
 * [#4 提示行] 扩展 help 行为 "Type to add · Backspace deletes · Enter submit · Esc back"。
 */
function buildEditorBlock(
	theme: ThemeLike,
	width: number,
	mode: "freeform" | "comment",
	editorText: string,
): string[] {
	throw new Error("SKELETON: buildEditorBlock impl — #4 expand help line to append-only hint");
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
	throw new Error("SKELETON: buildSplitPane impl not in scope (unchanged, editorText from state.draftText)");
}

/**
 * 渲染单个问题视图。
 * [#2] editorText 参数保留（从 state.draftText 传入，component.render 透传）。
 * [#4] freeform help 行扩展为 append-only 提示。
 */
export function renderQuestionView(
	q: Question,
	state: QuestionState,
	theme: ThemeLike,
	width: number,
	isSingle: boolean,
	editorText: string,
): string[] {
	throw new Error("SKELETON: renderQuestionView impl — #4 freeform help line append-only hint");
}
