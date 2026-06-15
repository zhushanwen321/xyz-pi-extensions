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

describe("renderQuestionView", () => {
	it("renders question text", () => {
		const lines = renderQuestionView(singleQ, makeState(), stubTheme, 60, true, "");
		expect(lines.some((l) => l.includes("Which database?"))).toBe(true);
	});

	it("renders all options + Other", () => {
		const lines = renderQuestionView(singleQ, makeState(), stubTheme, 60, true, "");
		expect(lines.some((l) => l.includes("Postgres"))).toBe(true);
		expect(lines.some((l) => l.includes("SQLite"))).toBe(true);
		expect(lines.some((l) => l.includes("Other"))).toBe(true);
	});

	it("renders cursor > on first option", () => {
		const lines = renderQuestionView(singleQ, makeState({ cursorIndex: 0 }), stubTheme, 60, true, "");
		expect(lines.some((l) => l.includes(">") && l.includes("Postgres"))).toBe(true);
	});

	it("renders single-select check on confirmed selection", () => {
		const lines = renderQuestionView(
			singleQ,
			makeState({ selectedIndex: 1 }),
			stubTheme,
			60,
			true,
			"",
		);
		expect(lines.some((l) => l.includes("✓") && l.includes("SQLite"))).toBe(true);
	});

	it("renders multi-select checkboxes", () => {
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
		expect(lines.some((l) => l.includes("[✓]") && l.includes("Auth"))).toBe(true);
		expect(lines.some((l) => l.includes("[ ]") && l.includes("Search"))).toBe(true);
	});

	it("renders descriptions in muted", () => {
		const lines = renderQuestionView(singleQ, makeState(), stubTheme, 60, true, "");
		expect(lines.some((l) => l.includes("Battle-tested"))).toBe(true);
	});

	it("shows comment prompt in comment mode", () => {
		const lines = renderQuestionView(
			singleQ,
			makeState({ mode: "comment", selectedIndex: 0 }),
			stubTheme,
			60,
			true,
			"some draft",
		);
		expect(lines.some((l) => l.toLowerCase().includes("comment"))).toBe(true);
		// editor draft text rendered
		expect(lines.some((l) => l.includes("some draft"))).toBe(true);
	});
});

describe("getSplitPaneWidths", () => {
	it("returns null on narrow terminal", () => {
		expect(getSplitPaneWidths(60)).toBeNull();
	});

	it("returns widths on wide terminal", () => {
		const result = getSplitPaneWidths(100);
		expect(result).not.toBeNull();
		expect(result!.left).toBeGreaterThan(0);
		expect(result!.right).toBeGreaterThan(0);
	});
});
