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
	label: Type.String({
		description:
			"Short, mutually exclusive option label (also the answer value returned to the LLM — keep it concise, ≤ ~40 chars). To recommend an option, prefix its label with '(Recommended)' and list it first.",
	}),
	description: Type.Optional(
		Type.String({
			description:
				"Short rationale shown under the label and in the split-pane preview. Helps the user decide — explain the tradeoff, don't restate the label.",
		}),
	),
});

export const QuestionSchema = Type.Object({
	question: Type.String({
		description:
			"Full question text. Must be one self-contained decision; avoid multi-part questions. ≤1000 chars; plain single-line text only (no newlines or control characters).",
	}),
	header: Type.Optional(
		Type.String({
			description:
				"Tab label, <=12 chars, required when questions.length > 1. Omit for a single question.",
		}),
	),
	context: Type.Optional(Type.String({ description: "Short context summary shown above the question. Pass what you learned from read/grep so the user can answer without re-explaining." })),
	options: Type.Array(OptionSchema, {
		minItems: 2,
		maxItems: 4,
		description: "2-4 mutually exclusive options. Each must be a defensible standalone answer; do NOT include an 'Other' option — it is added automatically.",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Default false. Set true only when more than one option can validly apply simultaneously; otherwise leave false for a single best answer." }),
	),
	allowComment: Type.Optional(
		Type.Boolean({ description: "Default false. Set true to let the user append a short free-text comment after selecting (e.g. to note a constraint)." }),
	),
});

export const InputSchema = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: 4,
		description: "1-4 questions, each a single decision. Batch only related decisions that the user should resolve together; otherwise ask the most important one alone.",
	}),
});

// ── 派生类型 ─────────────────────────────────────────
export type Option = Static<typeof OptionSchema>;
export type Question = Static<typeof QuestionSchema>;

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
	/** freeform Esc 保存的未提交草稿；null=无草稿。
	 *  与 freeTextValue（已提交答案）分离，避免放弃的草稿污染答案、触发 auto-confirm。 */
	freeDraft: string | null;
	/** 可选评论；null=未输入 */
	commentValue: string | null;
	/** 当前交互模式 */
	mode: QuestionMode;
	/** 编辑器草稿文本（每问题独立持有，迁移到 QuestionState 后替代组件级 editorText） */
	draftText: string;
	/** 进入编辑器前保存的 options 光标位置（退出编辑器时恢复） */
	savedOptionsCursorIndex: number;
}

/** 创建初始 QuestionState */
export function createQuestionState(): QuestionState {
	return {
		cursorIndex: 0,
		selectedIndex: null,
		selectedIndices: new Set<number>(),
		confirmed: false,
		freeTextValue: null,
		freeDraft: null,
		commentValue: null,
		mode: "options",
		draftText: "",
		savedOptionsCursorIndex: 0,
	};
}
