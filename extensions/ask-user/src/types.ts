// src/types.ts
import { type Static, Type } from "@sinclair/typebox";

// ── 常量 ─────────────────────────────────────────────
export const OTHER_LABEL = "Other";
export const HEADER_MAX_CHARS = 12;
/** question 文本长度上限：保证 details.answers 的 key 有界、可预测（spec FR-2） */
export const QUESTION_MAX_CHARS = 1000;
export const SPLIT_PANE_MIN_WIDTH = 84;
export const SPLIT_PANE_SEPARATOR = " │ ";
export const SPLIT_PANE_LEFT_MIN = 32;
export const SPLIT_PANE_RIGHT_MIN = 28;
export const ANSWER_COMMENT_SEPARATOR = " — ";

// ── Input schema（LLM 调用参数） ─────────────────────
export const OptionSchema = Type.Object({
	label: Type.String({ description: "选项标签，同时也是返回给 LLM 的答案值" }),
	description: Type.Optional(
		Type.String({ description: "选项说明，显示在 label 下方及分屏预览中" }),
	),
});

export const QuestionSchema = Type.Object({
	question: Type.String({ description: "完整问题文本" }),
	header: Type.Optional(
		Type.String({
			description: "Tab 标签，≤12 字符。多问题（questions.length>1）时必填，单问题可省略",
		}),
	),
	context: Type.Optional(Type.String({ description: "问题前的上下文摘要" })),
	options: Type.Array(OptionSchema, {
		minItems: 2,
		maxItems: 4,
		description: "2-4 个选项",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "默认 false。true=多选 checkbox" }),
	),
	allowComment: Type.Optional(
		Type.Boolean({ description: "默认 false。true=选中后追加自由文本评论" }),
	),
});

export const InputSchema = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: 4,
		description: "1-4 个问题",
	}),
});

// ── 派生类型 ─────────────────────────────────────────
export type Option = Static<typeof OptionSchema>;
export type Question = Static<typeof QuestionSchema>;
export type Input = Static<typeof InputSchema>;

// ── Result schema（details，renderResult 数据源） ─────
export const ResultSchema = Type.Object({
	questions: Type.Array(QuestionSchema),
	answers: Type.Record(Type.String(), Type.String()),
	cancelled: Type.Boolean(),
});

export type Result = Static<typeof ResultSchema>;

// ── 跨模块共享的交互状态类型 ─────────────────────────
// 放这里（而非 component.ts）是为了让 question-view.ts / submit-view.ts
// 这两个纯渲染函数只依赖 types.ts，不反向依赖 component.ts（消除循环依赖）。

/** TUI 颜色主题的最小接口（满足真实 Theme 和测试 stub） */
export interface ThemeLike {
	fg(token: string, text: string): string;
	bg(token: string, text: string): string;
	bold(text: string): string;
}

/** 单问题的交互模式 */
export type QuestionMode = "options" | "freeform" | "comment";

/** 单问题的交互状态（每问题一个实例） */
export interface QuestionState {
	/** 光标位置（高亮的选项，≠ 已选答案） */
	cursorIndex: number;
	/** 单选：显式选中的选项 index；null=未选 */
	selectedIndex: number | null;
	/** 多选：已 toggle 的选项 index 集合 */
	selectedIndices: Set<number>;
	/** 是否已确认（Submit 门的条件） */
	confirmed: boolean;
	/** Other 自由文本答案；null=未输入 */
	freeTextValue: string | null;
	/** 可选评论；null=未输入 */
	commentValue: string | null;
	/** 当前交互模式 */
	mode: QuestionMode;
}

/** 创建初始 QuestionState */
export function createQuestionState(): QuestionState {
	return {
		cursorIndex: 0,
		selectedIndex: null,
		selectedIndices: new Set<number>(),
		confirmed: false,
		freeTextValue: null,
		commentValue: null,
		mode: "options",
	};
}
