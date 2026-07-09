// code-skeleton/types.ts
// [SKELETON] types.ts 骨架 — 验证 QuestionState.draftText 字段加入后签名自洽。
// 与 src/types.ts 同构，仅新增 draftText 字段（D-005 issue #2）。
// createQuestionState() 初始化 draftText: ""（进编辑器时由 component 分流预填覆盖）。
import { type Static, Type } from "@sinclair/typebox";

// ── 常量（与 src/types.ts 保持一致，骨架自包含验证） ──
export const OTHER_LABEL = "Other";
export const HEADER_MAX_CHARS = 12;
export const QUESTION_MAX_CHARS = 1000;
export const SPLIT_PANE_MIN_WIDTH = 84;
export const SPLIT_PANE_SEPARATOR = " │ ";
export const SPLIT_PANE_LEFT_MIN = 32;
export const SPLIT_PANE_RIGHT_MIN = 28;
export const ANSWER_COMMENT_SEPARATOR = " — ";

// ── Input schema（LLM 调用参数） ─────────────────────
export const OptionSchema = Type.Object({
	label: Type.String({ description: "option label" }),
	description: Type.Optional(Type.String({ description: "rationale" })),
});

export const QuestionSchema = Type.Object({
	question: Type.String({ description: "question text" }),
	header: Type.Optional(Type.String({ description: "tab label" })),
	context: Type.Optional(Type.String({ description: "context summary" })),
	options: Type.Array(OptionSchema, { minItems: 2, maxItems: 4 }),
	multiSelect: Type.Optional(Type.Boolean({ description: "multi-select" })),
	allowComment: Type.Optional(Type.Boolean({ description: "allow comment" })),
});

export const InputSchema = Type.Object({
	questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 4 }),
});

// ── 派生类型 ─────────────────────────────────────────
export type Option = Static<typeof OptionSchema>;
export type Question = Static<typeof QuestionSchema>;
export type Input = Static<typeof InputSchema>;

export const ResultSchema = Type.Object({
	questions: Type.Array(QuestionSchema),
	answers: Type.Record(Type.String(), Type.String()),
	cancelled: Type.Boolean(),
});

export type Result = Static<typeof ResultSchema>;

export interface ErrorDetails {
	error: string;
}

export type AskUserDetails = Result | ErrorDetails;

// ── 跨模块共享的交互状态类型 ─────────────────────────
export interface ThemeLike {
	fg(token: string, text: string): string;
	bg(token: string, text: string): string;
	bold(text: string): string;
}

/** 单问题的交互模式 */
export type QuestionMode = "options" | "freeform" | "comment";

/**
 * 单问题的交互状态（每问题一个实例）。
 *
 * [CHANGE #2 draftText 迁移] 新增 draftText 字段，替代 component.ts 的组件级单实例 editorText。
 * 不变式：进入 freeform 编辑器时 state.draftText = state.freeTextValue ?? ""；
 *        进入 comment 编辑器时 state.draftText = state.commentValue ?? ""（分流预填，D-2）。
 *        提交（Enter）/ 退出（Esc）后 draftText 重置为 ""。
 */
export interface QuestionState {
	cursorIndex: number;
	selectedIndex: number | null;
	selectedIndices: Set<number>;
	confirmed: boolean;
	freeTextValue: string | null;
	commentValue: string | null;
	mode: QuestionMode;
	/** [NEW #2] 每问题独立的编辑器草稿（替代组件级 editorText） */
	draftText: string;
}

/** 创建初始 QuestionState。draftText 初始化为 ""（进编辑器时分流预填覆盖）。 */
export function createQuestionState(): QuestionState {
	return {
		cursorIndex: 0,
		selectedIndex: null,
		selectedIndices: new Set<number>(),
		confirmed: false,
		freeTextValue: null,
		commentValue: null,
		mode: "options",
		draftText: "",
	};
}
