// src/__tests__/component.test.ts
import { describe, expect, it } from "vitest";

import { AskUserComponent } from "../component";
import type { Question, Result, ThemeLike } from "../types";

// The component uses matchesKey against real input data, so tests must send
// the same escape sequences a real terminal would emit.
const ENTER_DATA = "\r";
const SPACE_DATA = " ";
const ESC_DATA = "\x1b";
const DOWN_DATA = "\x1b[B";
const RIGHT_DATA = "\x1b[C";

const stubTheme: ThemeLike = {
	fg: (_t: string, s: string) => s,
	bg: (_t: string, s: string) => s,
	bold: (s: string) => s,
};

const mockTui = { requestRender: (): void => {} };

const singleQ: Question = {
	question: "Which DB?",
	options: [{ label: "Postgres" }, { label: "SQLite" }],
};

const multiQ: Question[] = [
	{ question: "Q1", header: "First", options: [{ label: "A" }, { label: "B" }] },
	{ question: "Q2", header: "Second", options: [{ label: "X" }, { label: "Y" }], multiSelect: true },
];

const make = (
	questions: Question[],
	done: (r: Result | null) => void = (): void => {},
): AskUserComponent => new AskUserComponent(questions, mockTui, stubTheme, done);

describe("AskUserComponent — single question", () => {
	it("renders question without tab bar", () => {
		const c = make([singleQ]);
		const lines = c.render(60);
		expect(lines.some((l) => l.includes("Which DB?"))).toBe(true);
		// No tab bar in single-question mode
		expect(lines.some((l) => l.includes("Submit"))).toBe(false);
	});

	it("confirms first option on Enter and resolves", () => {
		let resolved: Result | null | undefined;
		const c = make([singleQ], (r) => (resolved = r));
		c.handleInput(ENTER_DATA);
		expect(resolved).not.toBeUndefined();
		expect(resolved!.cancelled).toBe(false);
		expect(resolved!.answers["Which DB?"]).toBe("Postgres");
	});

	it("moves cursor down then confirms second option", () => {
		let resolved: Result | null | undefined;
		const c = make([singleQ], (r) => (resolved = r));
		c.handleInput(DOWN_DATA);
		c.handleInput(ENTER_DATA);
		expect(resolved!.answers["Which DB?"]).toBe("SQLite");
	});

	it("resolves cancelled on Esc", () => {
		let resolved: Result | null | undefined;
		const c = make([singleQ], (r) => (resolved = r));
		c.handleInput(ESC_DATA);
		expect(resolved).toBeNull();
	});
});

describe("AskUserComponent — multi question", () => {
	it("renders tab bar with headers + Submit", () => {
		const c = make(multiQ);
		const lines = c.render(80);
		expect(lines.some((l) => l.includes("First"))).toBe(true);
		expect(lines.some((l) => l.includes("Second"))).toBe(true);
		expect(lines.some((l) => l.includes("Submit"))).toBe(true);
	});

	it("navigates tabs and submits all answers", () => {
		let resolved: Result | null | undefined;
		const c = make(multiQ, (r) => (resolved = r));
		// Q1: select A (Enter)
		c.handleInput(ENTER_DATA);
		// Q2: toggle X (Space), confirm (Enter)
		c.handleInput(SPACE_DATA);
		c.handleInput(ENTER_DATA);
		// Submit tab: Enter
		c.handleInput(ENTER_DATA);
		expect(resolved!.answers["Q1"]).toBe("A");
		expect(resolved!.answers["Q2"]).toBe("X");
	});

	it("Submit tab blocks when not all confirmed", () => {
		let resolved: Result | null | undefined;
		const c = make(multiQ, (r) => (resolved = r));
		// Jump to Submit without answering
		c.handleInput(RIGHT_DATA); // -> Q2
		c.handleInput(RIGHT_DATA); // -> Submit
		c.handleInput(ENTER_DATA); // should NOT submit
		expect(resolved).toBeUndefined();
	});
});

describe("AskUserComponent — render cache", () => {
	it("returns same reference on repeated render with same width", () => {
		const c = make([singleQ]);
		const a = c.render(60);
		const b = c.render(60);
		expect(a).toBe(b);
	});

	it("returns new reference after input (invalidate)", () => {
		const c = make([singleQ]);
		const a = c.render(60);
		c.handleInput(DOWN_DATA);
		const b = c.render(60);
		expect(a).not.toBe(b);
	});
});
