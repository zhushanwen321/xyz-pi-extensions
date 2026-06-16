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
// description 用英文：这些字符串会进 LLM 的 tool schema，英文更利于模型理解。
export const OptionSchema = Type.Object({
	label: Type.String({ description: "Option label; also the answer value returned to the LLM" }),
	description: Type.Optional(
		Type.String({ description: "Explanation shown under the label and in the split-pane preview" }),
	),
});

export const QuestionSchema = Type.Object({
	question: Type.String({ description: "Full question text" }),
	header: Type.Optional(
		Type.String({
			description: "Tab label, <=12 chars. Required for multi-question (questions.length>1); optional for single question",
		}),
	),
	context: Type.Optional(Type.String({ description: "Context summary shown above the question" })),
	options: Type.Array(OptionSchema, {
		minItems: 2,
		maxItems: 4,
		description: "2-4 options",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Default false. true = multi-select checkbox" }),
	),
	allowComment: Type.Optional(
		Type.Boolean({ description: "Default false. true = append a free-text comment after selecting" }),
	),
});

export const InputSchema = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: 4,
		description: "1-4 questions",
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

/** execute 意外异常时返回的错误 details（区别于 Result.cancelled 的业务取消） */
export interface ErrorDetails {
	error: string;
}

/** execute 返回的 details 联合：正常/取消/校验失败走 Result，意外异常走 ErrorDetails */
export type AskUserDetails = Result | ErrorDetails;

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
