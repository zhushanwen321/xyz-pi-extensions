// code-skeleton/submit-view.ts
// [SKELETON] submit-view.ts 骨架 — 本次无改动，仅放签名供 component.ts import 编译通过。
import { truncateToWidth } from "@mariozechner/pi-tui";

import {
	ANSWER_COMMENT_SEPARATOR,
	HEADER_MAX_CHARS,
	type Question,
	type QuestionState,
	type Result,
	type ThemeLike,
} from "./types";

export function getAnswerText(q: Question, s: QuestionState): string | null {
	throw new Error("SKELETON: getAnswerText impl not in scope (unchanged)");
}

export function renderSubmitView(
	questions: Question[],
	states: QuestionState[],
	theme: ThemeLike,
	width: number,
	focus: "submit" | "cancel" = "submit",
): string[] {
	throw new Error("SKELETON: renderSubmitView impl not in scope (unchanged)");
}

export function buildResult(questions: Question[], states: QuestionState[]): Result {
	throw new Error("SKELETON: buildResult impl not in scope (unchanged)");
}
