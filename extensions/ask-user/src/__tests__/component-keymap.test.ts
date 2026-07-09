// src/__tests__/component-keymap.test.ts
// Key leak regression tests (#1 parseKey whitelist interception)
import { describe, expect, it } from "vitest";

import { AskUserComponent } from "../component";
import type { Question, Result } from "../types";
import {
	ALT_DOWN,
	ALT_LEFT,
	ALT_RIGHT,
	ALT_UP,
	BKSP,
	CTRL_DOWN,
	CTRL_LEFT,
	CTRL_RIGHT,
	CTRL_SHIFT_DOWN,
	CTRL_SHIFT_UP,
	CTRL_UP,
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
	multiQWithComment,
	PAGE_DOWN,
	PAGE_UP,
	RIGHT,
	singleQ,
	SHIFT_DOWN,
	SHIFT_LEFT,
	SHIFT_RIGHT,
	SHIFT_UP,
	stubTheme,
	SUPER_DOWN,
	SUPER_LEFT,
	SUPER_RIGHT,
	SUPER_UP,
	UP,
} from "./fixtures";

// Helper: make component with mutable result holder
const make = (
	questions: Question[],
): { c: AskUserComponent; result: { val: Result | null | undefined } } => {
	const result = { val: undefined as Result | null | undefined };
	const c = new AskUserComponent(questions, mockTui, stubTheme, (r) => (result.val = r));
	return { c, result };
};

/** Helper: 打开 comment 编辑器并返回 component（多问题避免单问题 auto-submit） */
function openComment(): AskUserComponent {
	const { c } = make(multiQWithComment);
	// Q1 (allowComment): select A → enters comment mode
	c.handleInput(ENTER);
	return c;
}

/** Helper: 打开 freeform 编辑器并返回 component（不渲染，避免缓存） */
function openFreeform(q: Question[]): AskUserComponent {
	const { c } = make(q);
	// Navigate to Other (last option) and open editor
	for (let i = 0; i < 10; i++) c.handleInput(DOWN); // go to last
	c.handleInput(ENTER); // open freeform
	return c;
}

describe("AskUserComponent — key leak fix (C-ARROW / C-KEYMAP)", () => {
	// ── C-ARROW-1: 连按 3 次右箭头，editorText 不含 [ 或 C ──
	it("C-ARROW-1: arrow keys do not leak escape sequences into editorText", () => {
		const c = openFreeform([singleQ]);
		c.handleInput(RIGHT); // \x1b[C — should be no-op
		c.handleInput(RIGHT);
		c.handleInput(RIGHT);
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toBeDefined();
		// BUG: before fix, [C[C[C would appear. After fix: editorText stays empty.
		expect(editorLine).not.toContain("[");
		expect(editorLine).not.toContain("C");
	});

	// ── C-ARROW-2: 4 方向键夹输入 a/b → editorText === "ab" ──
	it("C-ARROW-2: mixed arrow keys and text input only captures text", () => {
		const c = openFreeform([singleQ]);
		c.handleInput(DOWN);   // no-op
		c.handleInput(RIGHT);  // no-op
		c.handleInput("a");   // append
		c.handleInput(UP);     // no-op
		c.handleInput(LEFT);   // no-op
		c.handleInput("b");   // append
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toBeDefined();
		expect(editorLine).toContain("ab");
		// Ensure no leaked sequences
		expect(editorLine).not.toContain("[");
	});

	// ── C-KEYMAP-UP: up key no-op in editor ──
	it("C-KEYMAP-UP: up arrow is no-op in freeform editor", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("a");
		c.handleInput(UP);
		c.handleInput("b");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("ab");
	});

	// ── C-KEYMAP-DOWN: down key no-op in editor ──
	it("C-KEYMAP-DOWN: down arrow is no-op in freeform editor", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("a");
		c.handleInput(DOWN);
		c.handleInput("b");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("ab");
	});

	// ── C-KEYMAP-LEFT: left key no-op in editor ──
	it("C-KEYMAP-LEFT: left arrow is no-op in freeform editor", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("a");
		c.handleInput(LEFT);
		c.handleInput("b");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("ab");
	});

	// ── C-KEYMAP-HOME: home key no-op ──
	it("C-KEYMAP-HOME: home key is no-op in freeform editor", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("abc");
		c.handleInput(HOME);
		c.handleInput("d");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("abcd");
	});

	// ── C-KEYMAP-END: end key no-op ──
	it("C-KEYMAP-END: end key is no-op in freeform editor", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("abc");
		c.handleInput(END);
		c.handleInput("d");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("abcd");
	});

	// ── C-KEYMAP-INSERT: insert key no-op ──
	it("C-KEYMAP-INSERT: insert key is no-op in freeform editor", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("abc");
		c.handleInput(INSERT);
		c.handleInput("d");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("abcd");
	});

	// ── C-KEYMAP-PGUP: page up no-op ──
	it("C-KEYMAP-PGUP: page up is no-op in freeform editor", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("abc");
		c.handleInput(PAGE_UP);
		c.handleInput("d");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("abcd");
	});

	// ── C-KEYMAP-PGDN: page down no-op ──
	it("C-KEYMAP-PGDN: page down is no-op in freeform editor", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("abc");
		c.handleInput(PAGE_DOWN);
		c.handleInput("d");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("abcd");
	});

	// ── C-KEYMAP-F1: f1 key no-op ──
	it("C-KEYMAP-F1: F1 key is no-op in freeform editor", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("abc");
		c.handleInput(F1);
		c.handleInput("d");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("abcd");
	});

	// ── C-KEYMAP-DELETE: delete key no-op (not backspace) ──
	it("C-KEYMAP-DELETE: delete key is no-op in freeform editor (not backspace)", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("abc");
		c.handleInput(DELETE); // delete ≠ backspace, should be no-op
		c.handleInput("d");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("abcd");
	});

	// ── C-KEYMAP-SPACE: space character appends correctly ──
	it("C-KEYMAP-SPACE: space character is appended (parseKey special case)", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("a");
		c.handleInput(" "); // space — parseKey(" ") returns "space" not a printable char
		c.handleInput("b");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toBeDefined();
		expect(editorLine).toContain("a b");
	});

	// ── C-KEYMAP-ESC: Esc in editor still works (semantic key) ──
	it("C-KEYMAP-ESC: Esc in freeform still discards and returns to options", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("abc");
		c.handleInput(ESC); // should discard and go back to options
		const lines = c.render(60);
		// No more editor (back in options mode)
		expect(lines.some((l) => l.includes("█"))).toBe(false);
	});

	// ── C-KEYMAP-BKSP: backspace still works (semantic key) ──
	it("C-KEYMAP-BKSP: backspace still deletes last char", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("abc");
		c.handleInput(BKSP); // delete 'c'
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("█"));
		expect(editorLine).toContain("ab");
		expect(editorLine).not.toContain("abc");
	});

	// ── C-KEYMAP-COMMENT-UP: arrow key no-op in comment editor too ──
	it("C-KEYMAP-COMMENT-UP: arrow keys are no-op in comment editor", () => {
		const c = openComment();
		c.handleInput("a");
		c.handleInput(UP);
		c.handleInput(RIGHT);
		c.handleInput("b");
		// comment editor renders text and cursor on separate lines;
		// check the text line (before cursor) contains "ab"
		const lines = c.render(60);
		const textLine = lines.find((l) => l.includes("ab"));
		expect(textLine).toBeDefined();
		expect(textLine).toContain("ab");
		// Ensure no leaked bracket characters from arrow escape sequences
		const allText = lines.join("\n");
		expect(allText).not.toMatch(/\[A/); // no leaked UP sequence
		expect(allText).not.toMatch(/\[C/); // no leaked RIGHT sequence
	});

	// ── C-KEYMAP-MOD: modifier key combinations matrix (18 cases) ──
	const modifierCases: Array<{ name: string; seq: string }> = [
		{ name: "ctrl+up", seq: CTRL_UP },
		{ name: "ctrl+down", seq: CTRL_DOWN },
		{ name: "ctrl+left", seq: CTRL_LEFT },
		{ name: "ctrl+right", seq: CTRL_RIGHT },
		{ name: "alt+up", seq: ALT_UP },
		{ name: "alt+down", seq: ALT_DOWN },
		{ name: "alt+left", seq: ALT_LEFT },
		{ name: "alt+right", seq: ALT_RIGHT },
		{ name: "shift+up", seq: SHIFT_UP },
		{ name: "shift+down", seq: SHIFT_DOWN },
		{ name: "shift+left", seq: SHIFT_LEFT },
		{ name: "shift+right", seq: SHIFT_RIGHT },
		{ name: "super+up", seq: SUPER_UP },
		{ name: "super+down", seq: SUPER_DOWN },
		{ name: "super+left", seq: SUPER_LEFT },
		{ name: "super+right", seq: SUPER_RIGHT },
		{ name: "ctrl+shift+up", seq: CTRL_SHIFT_UP },
		{ name: "ctrl+shift+down", seq: CTRL_SHIFT_DOWN },
	];

	for (const { name, seq } of modifierCases) {
		it(`C-KEYMAP-MOD-${name}: ${name} modifier combo is no-op in editor`, () => {
			const c = openFreeform([singleQ]);
			c.handleInput("x");
			c.handleInput(seq); // modifier combo → should be no-op
			c.handleInput("y");
			const lines = c.render(60);
			const editorLine = lines.find((l) => l.includes("█"));
			expect(editorLine).toBeDefined();
			expect(editorLine).toContain("xy");
			// No leaked characters from the escape sequence
			expect(editorLine).not.toContain("[");
			expect(editorLine).not.toContain(";");
		});
	}
});
