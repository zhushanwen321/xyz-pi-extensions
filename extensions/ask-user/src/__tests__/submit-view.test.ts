// src/__tests__/submit-view.test.ts
import { describe, expect, it } from "vitest";

import { renderSubmitView } from "../submit-view";
import { createQuestionState, type Question, type QuestionState, type ThemeLike } from "../types";

const stubTheme: ThemeLike = {
	fg: (_t: string, s: string) => s,
	bg: (_t: string, s: string) => s,
	bold: (s: string) => s,
};

const q1: Question = {
	question: "Which DB?",
	header: "Database",
	options: [{ label: "Postgres" }, { label: "SQLite" }],
};

const makeState = (over: Partial<QuestionState> = {}): QuestionState => ({
	...createQuestionState(),
	...over,
});

describe("renderSubmitView", () => {
	it("shows 'Ready to submit' when all confirmed", () => {
		const states = [makeState({ confirmed: true, selectedIndex: 0 })];
		const lines = renderSubmitView([q1], states, stubTheme, 60);
		expect(lines.some((l) => l.includes("Ready to submit"))).toBe(true);
		expect(lines.some((l) => l.includes("Press Enter"))).toBe(true);
	});

	it("shows 'Unanswered' when not all confirmed", () => {
		const states = [makeState({ confirmed: false })];
		const lines = renderSubmitView([q1], states, stubTheme, 60);
		expect(lines.some((l) => l.includes("Unanswered"))).toBe(true);
		expect(lines.some((l) => l.includes("Database"))).toBe(true);
	});

	it("lists answered header: answer", () => {
		const states = [makeState({ confirmed: true, selectedIndex: 0 })];
		const lines = renderSubmitView([q1], states, stubTheme, 60);
		expect(lines.some((l) => l.includes("Database") && l.includes("Postgres"))).toBe(true);
	});

	it("shows dash for unanswered", () => {
		const states = [makeState({ confirmed: false })];
		const lines = renderSubmitView([q1], states, stubTheme, 60);
		expect(lines.some((l) => l.includes("Database") && l.includes("—"))).toBe(true);
	});
});
