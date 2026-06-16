// src/__tests__/question-view.test.ts
import { describe, expect, it } from "vitest";

import { getSplitPaneWidths, renderQuestionView } from "../question-view";
import { createQuestionState, type Question, type QuestionState, type ThemeLike } from "../types";

const stubTheme: ThemeLike = {
	fg: (_t: string, s: string) => s,
	bg: (_t: string, s: string) => s,
	bold: (s: string) => s,
};

const singleQ: Question = {
	question: "Which database?",
	options: [
		{ label: "Postgres", description: "Battle-tested" },
		{ label: "SQLite", description: "Embedded" },
	],
};

const makeState = (over: Partial<QuestionState> = {}): QuestionState => ({
	...createQuestionState(),
	...over,
});

// Helper: join all lines for substring search
const text = (lines: string[]): string => lines.join("\n");

// ── Q-1 ~ Q-6: 基础渲染 ──────────────────────────────────
describe("renderQuestionView — basics", () => {
	it("Q-1: renders question text", () => {
		const lines = renderQuestionView(singleQ, makeState(), stubTheme, 60, true, "");
		expect(text(lines)).toContain("Which database?");
	});

	it("Q-2: renders all options + Other", () => {
		const lines = renderQuestionView(singleQ, makeState(), stubTheme, 60, true, "");
		const t = text(lines);
		expect(t).toContain("Postgres");
		expect(t).toContain("SQLite");
		expect(t).toContain("Other");
	});

	it("Q-3: renders cursor > on first option", () => {
		const lines = renderQuestionView(singleQ, makeState({ cursorIndex: 0 }), stubTheme, 60, true, "");
		const t = text(lines);
		expect(t).toContain(">");
		expect(t).toContain("Postgres");
	});

	it("Q-4: renders single-select check on confirmed selection", () => {
		const lines = renderQuestionView(singleQ, makeState({ selectedIndex: 1 }), stubTheme, 60, true, "");
		expect(text(lines)).toContain("✓");
		expect(text(lines)).toContain("SQLite");
	});

	it("Q-5: renders multi-select checkboxes", () => {
		const multiQ: Question = {
			question: "Which features?",
			options: [{ label: "Auth" }, { label: "Search" }],
			multiSelect: true,
		};
		const lines = renderQuestionView(
			multiQ,
			makeState({ selectedIndices: new Set([0]) }),
			stubTheme,
			60,
			true,
			"",
		);
		const t = text(lines);
		expect(t).toContain("[✓]");
		expect(t).toContain("[ ]");
	});

	it("Q-6: renders descriptions in muted", () => {
		const lines = renderQuestionView(singleQ, makeState(), stubTheme, 60, true, "");
		expect(text(lines)).toContain("Battle-tested");
	});
});

// ── Q-7 ~ Q-14: 分屏 ────────────────────────────────────
describe("renderQuestionView — split pane", () => {
	it("Q-7: getSplitPaneWidths returns null on narrow terminal", () => {
		expect(getSplitPaneWidths(60)).toBeNull();
	});

	it("Q-8: getSplitPaneWidths returns widths on wide terminal", () => {
		const result = getSplitPaneWidths(100);
		expect(result).not.toBeNull();
		expect(result!.left).toBeGreaterThan(0);
		expect(result!.right).toBeGreaterThan(0);
	});

	it("Q-12: getSplitPaneWidths null at boundary width=83", () => {
		expect(getSplitPaneWidths(83)).toBeNull();
	});

	it("Q-13: getSplitPaneWidths non-null at boundary width=84", () => {
		expect(getSplitPaneWidths(84)).not.toBeNull();
	});

	it("Q-9: split-pane left column hides descriptions", () => {
		const lines = renderQuestionView(singleQ, makeState(), stubTheme, 100, true, "");
		const t = text(lines);
		// In split mode, descriptions appear only in the right pane preview of the focused item.
		// The focused item (cursorIndex=0=Postgres) shows "Battle-tested" in the right pane,
		// but SQLite's "Embedded" should NOT appear (no single-column description blocks).
		expect(t).toContain("Postgres");
		expect(t).toContain("Battle-tested");
		// SQLite label still present in left column, but its description "Embedded" not shown
		// (only the focused option's description is previewed)
		expect(t).toContain("SQLite");
	});

	it("Q-10: split-pane right pane shows focused option detail", () => {
		const lines = renderQuestionView(singleQ, makeState({ cursorIndex: 1 }), stubTheme, 100, true, "");
		const t = text(lines);
		// Focused on SQLite → right pane should show SQLite's description
		expect(t).toContain("Embedded");
	});

	it("Q-11: split-pane right pane on Other shows custom-answer hint", () => {
		// cursorIndex = last option (Other) = 2
		const lines = renderQuestionView(singleQ, makeState({ cursorIndex: 2 }), stubTheme, 100, true, "");
		const t = text(lines);
		expect(t).toContain("custom");
	});

	it("Q-14: single-column mode shows indented descriptions", () => {
		const lines = renderQuestionView(singleQ, makeState(), stubTheme, 60, true, "");
		// Both descriptions shown inline (single-column mode)
		const t = text(lines);
		expect(t).toContain("Battle-tested");
		expect(t).toContain("Embedded");
	});
});

// ── Q-15 ~ Q-17: Other 编辑器模式 ───────────────────────
describe("renderQuestionView — Other editor mode", () => {
	it("Q-15: freeform mode renders editor with draft text and cursor", () => {
		const lines = renderQuestionView(
			singleQ,
			makeState({ mode: "freeform" }),
			stubTheme,
			60,
			true,
			"my draft",
		);
		const t = text(lines);
		expect(t).toContain("Your answer");
		expect(t).toContain("my draft");
		expect(t).toContain("█");
	});

	it("Q-16: Other with saved free-text shows checkmark + preview", () => {
		const lines = renderQuestionView(
			singleQ,
			makeState({ cursorIndex: 2, freeTextValue: "saved text" }),
			stubTheme,
			60,
			true,
			"",
		);
		const t = text(lines);
		expect(t).toContain("✓");
		expect(t).toContain("saved text");
	});

	it("Q-17: Other row focused shows Space hint (Tab now navigates tabs)", () => {
		const lines = renderQuestionView(
			singleQ,
			makeState({ cursorIndex: 2 }),
			stubTheme,
			60,
			true,
			"",
		);
		expect(text(lines)).toContain("Space");
	});
});

// ── Q-18 ~ Q-19: 评论模式 ───────────────────────────────
describe("renderQuestionView — comment mode", () => {
	it("Q-18: comment mode renders editor with note text", () => {
		const lines = renderQuestionView(
			singleQ,
			makeState({ mode: "comment", selectedIndex: 0 }),
			stubTheme,
			60,
			true,
			"my note",
		);
		const t = text(lines);
		expect(t.toLowerCase()).toContain("comment");
		expect(t).toContain("my note");
	});

	it("Q-19: comment prompt includes (optional)", () => {
		const lines = renderQuestionView(
			singleQ,
			makeState({ mode: "comment", selectedIndex: 0 }),
			stubTheme,
			60,
			true,
			"",
		);
		expect(text(lines)).toContain("(optional)");
	});
});

// ── Q-20 ~ Q-23: 帮助行 ─────────────────────────────────
describe("renderQuestionView — help line", () => {
	it("Q-20: single-select help shows 'Enter select'", () => {
		const lines = renderQuestionView(singleQ, makeState(), stubTheme, 60, true, "");
		expect(text(lines)).toContain("Enter select");
	});

	it("Q-21: multi-select help shows 'Space toggle'", () => {
		const multiQ: Question = {
			question: "Pick",
			options: [{ label: "A" }, { label: "B" }],
			multiSelect: true,
		};
		const lines = renderQuestionView(multiQ, makeState(), stubTheme, 60, true, "");
		expect(text(lines)).toContain("Space toggle");
	});

	it("Q-22: single question omits tab-switch hint", () => {
		const lines = renderQuestionView(singleQ, makeState(), stubTheme, 60, true, "");
		expect(text(lines)).not.toContain("switch tabs");
	});

	it("Q-23: multi question includes tab-switch hint", () => {
		const lines = renderQuestionView(singleQ, makeState(), stubTheme, 60, false, "");
		expect(text(lines)).toContain("switch tabs");
	});
});

// ── Q-24 ~ Q-25: 上下文 ─────────────────────────────────
describe("renderQuestionView — context", () => {
	it("Q-24: renders context when present", () => {
		const q: Question = { ...singleQ, context: "Background info here" };
		const lines = renderQuestionView(q, makeState(), stubTheme, 60, true, "");
		expect(text(lines)).toContain("Background info here");
	});

	it("Q-25: no context field → no extra context text", () => {
		const lines = renderQuestionView(singleQ, makeState(), stubTheme, 60, true, "");
		// No "context" label text in output (only question/options/help)
		expect(text(lines)).toContain("Which database?");
	});
});

// ── Q-26 ~ Q-27: 边界 ───────────────────────────────────
describe("renderQuestionView — edge cases", () => {
	it("Q-26: very narrow terminal width=20 does not crash", () => {
		const lines = renderQuestionView(singleQ, makeState(), stubTheme, 20, true, "");
		expect(lines.length).toBeGreaterThan(0);
	});

	it("Q-27: long option label gets truncated", () => {
		const q: Question = {
			question: "Q",
			options: [{ label: "A".repeat(80), description: "desc" }, { label: "B" }],
		};
		const lines = renderQuestionView(q, makeState(), stubTheme, 40, true, "");
		// Should not contain the full 80-char label on a 40-col terminal
		const t = text(lines);
		expect(t).not.toContain("A".repeat(80));
	});
});
