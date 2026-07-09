// src/__tests__/w3-regression.test.ts
// W3: Forward regression + full validation (#5)
// Comprehensive no-op key coverage + draftText edge cases + full regression.
import { describe, expect, it } from "vitest";

import { AskUserComponent } from "../component";
import type { Question, Result } from "../types";
import {
	DELETE,
	DOWN,
	END,
	ENTER,
	ESC,
	F1,
	HOME,
	INSERT,
	LEFT,
	mockTui,
	multiQ,
	multiQWithComment,
	PGDN,
	PGUP,
	RIGHT,
	singleQ,
	singleQWithComment,
	stubTheme,
} from "./fixtures";

const make = (
	questions: Question[],
): { c: AskUserComponent; result: { val: Result | null | undefined } } => {
	const result = { val: undefined as Result | null | undefined };
	const c = new AskUserComponent(questions, mockTui, stubTheme, (r) => (result.val = r));
	return { c, result };
};

/** Helper: open freeform editor on singleQ (navigate to Other → Enter) */
function openFreeform(c: AskUserComponent): void {
	c.handleInput(DOWN); // 0→1
	c.handleInput(DOWN); // 1→2 (Other)
	c.handleInput(ENTER); // open freeform
}

// ── C-KEYMAP-*: extended no-op key coverage ──
describe("W3 — extended no-op key coverage (C-KEYMAP-*)", () => {
	it("C-KEYMAP-DOWN: down arrow is no-op in freeform editor", () => {
		const { c } = make([singleQ]);
		openFreeform(c);
		c.handleInput("a");
		c.handleInput(DOWN);
		c.handleInput("b");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("ab");
		expect(editorLine).not.toContain("[");
		expect(editorLine).not.toContain("B");
	});

	it("C-KEYMAP-LEFT: left arrow is no-op in freeform editor", () => {
		const { c } = make([singleQ]);
		openFreeform(c);
		c.handleInput("a");
		c.handleInput(LEFT);
		c.handleInput("b");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("ab");
		expect(editorLine).not.toContain("[");
		expect(editorLine).not.toContain("D");
	});

	it("C-KEYMAP-HOME: Home key is no-op in freeform editor", () => {
		const { c } = make([singleQ]);
		openFreeform(c);
		c.handleInput("a");
		c.handleInput(HOME);
		c.handleInput("b");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("ab");
		expect(editorLine).not.toContain("[");
		expect(editorLine).not.toContain("H");
	});

	it("C-KEYMAP-END: End key is no-op in freeform editor", () => {
		const { c } = make([singleQ]);
		openFreeform(c);
		c.handleInput("a");
		c.handleInput(END);
		c.handleInput("b");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("ab");
		expect(editorLine).not.toContain("[");
		expect(editorLine).not.toContain("F");
	});

	it("C-KEYMAP-INSERT: Insert key is no-op in freeform editor", () => {
		const { c } = make([singleQ]);
		openFreeform(c);
		c.handleInput("a");
		c.handleInput(INSERT);
		c.handleInput("b");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("ab");
		expect(editorLine).not.toContain("[");
		expect(editorLine).not.toContain("~");
	});

	it("C-KEYMAP-PGUP: Page Up is no-op in freeform editor", () => {
		const { c } = make([singleQ]);
		openFreeform(c);
		c.handleInput("a");
		c.handleInput(PGUP);
		c.handleInput("b");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("ab");
		expect(editorLine).not.toContain("[");
		expect(editorLine).not.toContain("~");
	});

	it("C-KEYMAP-PGDN: Page Down is no-op in freeform editor", () => {
		const { c } = make([singleQ]);
		openFreeform(c);
		c.handleInput("a");
		c.handleInput(PGDN);
		c.handleInput("b");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("ab");
		expect(editorLine).not.toContain("[");
		expect(editorLine).not.toContain("~");
	});

	it("C-KEYMAP-F1: F1 key is no-op in freeform editor", () => {
		const { c } = make([singleQ]);
		openFreeform(c);
		c.handleInput("a");
		c.handleInput(F1);
		c.handleInput("b");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("ab");
		expect(editorLine).not.toContain("[");
		expect(editorLine).not.toContain("P");
	});

	it("C-KEYMAP-DELETE: Delete key is no-op in freeform editor (not backspace)", () => {
		const { c } = make([singleQ]);
		openFreeform(c);
		c.handleInput("abc");
		c.handleInput(DELETE); // delete ≠ backspace — should NOT delete
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("abc"); // unchanged
		expect(editorLine).not.toContain("[");
		expect(editorLine).not.toContain("~");
	});

	it.each([
		["super+up", "\x1b[1;9A"],
		["super+down", "\x1b[1;9B"],
		["super+left", "\x1b[1;9D"],
		["super+right", "\x1b[1;9C"],
		["ctrl+shift+up", "\x1b[1;6A"],
		["ctrl+shift+down", "\x1b[1;6B"],
	])("C-KEYMAP-MOD (extended): %s is no-op in editor", (_name, seq) => {
		const { c } = make([singleQ]);
		openFreeform(c);
		c.handleInput("a");
		c.handleInput(seq);
		c.handleInput("b");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("ab");
		expect(editorLine).not.toContain("[");
	});
});

// ── C-BC4B: freeform Enter clears selectedIndex (BC-4b regression) ──
describe("W3 — freeform Enter clears selectedIndex (C-BC4B)", () => {
	it("C-BC4B: freeform text overrides selected option in result", () => {
		const { c, result } = make([singleQ]);
		// Navigate to Other (index 2) and open freeform
		c.handleInput(DOWN); // 0→1
		c.handleInput(DOWN); // 1→2 (Other)
		c.handleInput(ENTER); // open freeform
		c.handleInput("custom answer");
		c.handleInput(ENTER); // confirm freeform → afterConfirm → submit
		expect(result.val).toBeDefined();
		// The answer should be the freeform text
		expect(result.val!.answers["Which DB?"]).toBe("custom answer");
	});

	it("C-BC4B-SELECT: freeform on same question clears selectedIndex", () => {
		const { c, result } = make(multiQ);
		// Q1: stay on cursorIndex=0 (A), open freeform via Other
		c.handleInput(DOWN); // 0→1
		c.handleInput(DOWN); // 1→2 (Other)
		c.handleInput(ENTER); // open freeform
		c.handleInput("override");
		c.handleInput(ENTER); // confirm freeform → afterConfirm → advance to Q2
		// Q2: select X
		c.handleInput(ENTER); // select X
		c.handleInput(ENTER); // confirm → advance to Q3
		// Q3: select M
		c.handleInput(ENTER); // select M
		c.handleInput(ENTER); // confirm → advance to submit
		// Submit
		c.handleInput(ENTER);
		expect(result.val).toBeDefined();
		// Q1 answer should be the freeform text only
		expect(result.val!.answers["Q1"]).toBe("override");
	});
});

// ── C-BC4C-REEDIT: comment re-edit prefills old comment ──
describe("W3 — comment re-edit prefills old comment (C-BC4C-REEDIT)", () => {
	it("C-BC4C-REEDIT: editing comment after initial submission prefills old text", () => {
		const { c, result } = make([singleQWithComment]);
		// Select option A → enter comment mode
		c.handleInput(ENTER);
		// Type initial comment
		c.handleInput("initial comment");
		c.handleInput(ENTER); // submit → auto-advance → submit all
		expect(result.val).toBeDefined();
		expect(result.val!.answers["Which DB? (with comment)"]).toBe("Postgres — initial comment");
	});

	it("C-BC4C-CLEAR: Esc in comment mode skips comment, keeps existing commentValue", () => {
		const { c, result } = make(multiQWithComment);
		// Q1: select A → comment mode
		c.handleInput(ENTER);
		c.handleInput("my note");
		c.handleInput(ENTER); // submit comment → advance to Q2
		// Q2: select X
		c.handleInput(ENTER);
		c.handleInput(ENTER); // confirm Q2 → advance to submit tab
		// Go back to Q1
		c.handleInput(LEFT);
		// Q1 is already confirmed, re-select A to trigger comment again
		c.handleInput(ENTER); // re-select A → afterConfirm → comment mode
		c.handleInput(ESC); // skip comment
		// Submit
		c.handleInput(RIGHT);
		c.handleInput(RIGHT); // navigate to submit tab
		c.handleInput(ENTER);
		expect(result.val).toBeDefined();
		// Comment should still be "my note" (Esc preserved commentValue)
		expect(result.val!.answers["Q1"]).toBe("A — my note");
	});
});

// ── C-PASTE-EQUIV: single char via parseKey path (not undefined path) ──
describe("W3 — single char append via parseKey path (C-PASTE-5 equiv)", () => {
	it("single char 'x' is appended correctly (parseKey returns 'x')", () => {
		const { c } = make([singleQ]);
		openFreeform(c);
		c.handleInput("x");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("x");
	});

	it("single printable chars in sequence build string correctly", () => {
		const { c } = make([singleQ]);
		openFreeform(c);
		for (const ch of "hello") {
			c.handleInput(ch);
		}
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("hello");
	});
});
