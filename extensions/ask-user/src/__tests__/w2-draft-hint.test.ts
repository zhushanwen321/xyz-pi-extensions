// src/__tests__/w2-draft-hint.test.ts
// W2: draftText migration (#2) + handleInput split (#3) + hint line (#4)
import { describe, expect, it } from "vitest";

import { AskUserComponent } from "../component";
import type { Question, Result } from "../types";
import {
	DOWN,
	ENTER,
	ESC,
	LEFT,
	mockTui,
	multiQ,
	RIGHT,
	singleQ,
	singleQWithComment,
	stubTheme,
	UP,
} from "./fixtures";

const make = (
	questions: Question[],
): { c: AskUserComponent; result: { val: Result | null | undefined } } => {
	const result = { val: undefined as Result | null | undefined };
	const c = new AskUserComponent(questions, mockTui, stubTheme, (r) => (result.val = r));
	return { c, result };
};

// ── parseKey guard: arrow keys no-op in editor ──
describe("W2 — parseKey guard (arrow/keys no-op in editor)", () => {
	it("C-ARROW-1: three right arrows do not leak escape fragments", () => {
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER); // open freeform
		c.handleInput(RIGHT);
		c.handleInput(RIGHT);
		c.handleInput(RIGHT);
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		expect(editorLine).not.toContain("\x1b[A"); expect(editorLine).not.toContain("\x1b[B"); expect(editorLine).not.toContain("\x1b[C"); expect(editorLine).not.toContain("\x1b[D");
	});

	it("C-ARROW-2: arrow keys between typed chars with cursor movement", () => {
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER); // open freeform
		c.handleInput(DOWN);  // no-op
		c.handleInput(RIGHT); // no-op (empty text)
		c.handleInput("a");   // insert at 0 → "a", cursor=1
		c.handleInput(UP);    // no-op
		c.handleInput(LEFT);  // cursor 1→0
		c.handleInput("b");   // insert at 0 → "ba", cursor=1
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		// cursor at 1: "b█a" — 去 ANSI 后精确文本 "ba"（证明 insert 位置：b 在 a 前）
		const stripped = editorLine!.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("ba");
		expect(editorLine).not.toContain("\x1b[A"); expect(editorLine).not.toContain("\x1b[B"); expect(editorLine).not.toContain("\x1b[C"); expect(editorLine).not.toContain("\x1b[D");
	});

	it("C-KEYMAP-SPACE: space input appends a space character", () => {
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		c.handleInput("a");
		c.handleInput(" ");
		c.handleInput("b");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toContain("a b");
	});

	it("C-KEYMAP-UP: up arrow is no-op in freeform editor", () => {
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		c.handleInput("a");
		c.handleInput(UP);
		c.handleInput("b");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toContain("ab");
		expect(editorLine).not.toContain("\x1b[A"); expect(editorLine).not.toContain("\x1b[B"); expect(editorLine).not.toContain("\x1b[C"); expect(editorLine).not.toContain("\x1b[D");
	});

	it.each([
		["ctrl+up", "\x1b[1;5A"],
		["ctrl+down", "\x1b[1;5B"],
		["ctrl+left", "\x1b[1;5D"],
		["ctrl+right", "\x1b[1;5C"],
		["alt+up", "\x1b[1;3A"],
		["alt+down", "\x1b[1;3B"],
		["shift+up", "\x1b[1;2A"],
		["shift+down", "\x1b[1;2B"],
		["shift+left", "\x1b[1;2D"],
		["shift+right", "\x1b[1;2C"],
	])("C-KEYMAP-MOD: %s is no-op in editor", (_name, seq) => {
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		c.handleInput("a");
		c.handleInput(seq);
		c.handleInput("b");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toContain("ab");
		expect(editorLine).not.toContain("\x1b[A"); expect(editorLine).not.toContain("\x1b[B"); expect(editorLine).not.toContain("\x1b[C"); expect(editorLine).not.toContain("\x1b[D");
	});
});

// ── draftText migration: per-question draft persistence ──
describe("W2 — draftText migration", () => {
	it("C-DRAFT-1: freeform draft persists when switching tabs away and back", () => {
		const { c } = make(multiQ);
		// Q1: navigate to Other (index 2), open freeform, type "abc"
		c.handleInput(DOWN); // 0→1
		c.handleInput(DOWN); // 1→2 (Other)
		c.handleInput(ENTER);
		c.handleInput("abc");
		c.handleInput(ESC); // back to options
		// Switch to Q2 and back to Q1
		c.handleInput(RIGHT);
		c.handleInput(LEFT);
		// Re-enter freeform
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		const lines = c.render(80);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		expect(editorLine).toContain("abc");
	});

	it("C-DRAFT-2: drafts on different questions are independent", () => {
		const { c } = make(multiQ);
		// Q1: type "aaa"
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		c.handleInput("aaa");
		c.handleInput(ESC);
		// Navigate to Q3
		c.handleInput(RIGHT);
		c.handleInput(RIGHT);
		// Q3: type "ccc"
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		c.handleInput("ccc");
		c.handleInput(ESC);
		// Go back to Q1
		c.handleInput(LEFT);
		c.handleInput(LEFT);
		// Re-enter freeform on Q1
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		const lines1 = c.render(80);
		const editorLine1 = lines1.find((l) => l.includes("\x1b[7m"));
		expect(editorLine1).toContain("aaa");
		expect(editorLine1).not.toContain("ccc");
	});

	it("C-BC4C: comment flow submits comment with answer", () => {
		const { c, result } = make([singleQWithComment]);
		c.handleInput(ENTER); // select A → comment mode
		c.handleInput("my note");
		c.handleInput(ENTER); // submit
		expect(result.val).toBeDefined();
		expect(result.val!.answers["Which DB? (with comment)"]).toBe("Postgres — my note");
	});
});

// ── hint line: append-only UX hint ──
describe("W2 — hint line", () => {
	it("C-HINT-1: freeform editor hint contains all expected hints", () => {
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		const lines = c.render(80);
		const hintLine = lines.find((l: string) => l.includes("move") && l.includes("Backspace deletes"));
		expect(hintLine).toBeDefined();
		expect(hintLine).toContain("Enter submit");
		expect(hintLine).toContain("Esc back");
	});

	it("C-HINT-2: comment editor hint contains all expected hints", () => {
		const { c } = make([singleQWithComment]);
		c.handleInput(ENTER);
		const lines = c.render(80);
		const hintLine = lines.find((l: string) => l.includes("move") && l.includes("Backspace deletes"));
		expect(hintLine).toBeDefined();
		expect(hintLine).toContain("Enter submit");
		expect(hintLine).toContain("Esc back");
	});
});

// ── freeDraft 隔离：丢弃的 freeform 草稿不污染答案、不触发 auto-confirm ──
describe("C-FREEDRAFT: discarded draft isolation", () => {
	it("C-FREEDRAFT-1: discarded freeform draft blocks submit (Q1 stays unconfirmed)", () => {
		const { c, result } = make(multiQ);
		// Q1: 打开 freeform，输入草稿 "abc"，ESC 丢弃（存入 freeDraft，但不 confirmed）
		c.handleInput(DOWN);  // 0→1
		c.handleInput(DOWN);  // 1→2 (Other)
		c.handleInput(ENTER); // 打开 freeform
		c.handleInput("abc");
		c.handleInput(ESC);   // freeDraft="abc"，回到 options，Q1 仍未答
		// 跳到 Submit tab 尝试提交
		c.handleInput(RIGHT); // → Q2
		c.handleInput(RIGHT); // → Q3
		c.handleInput(RIGHT); // → Submit tab
		c.handleInput(ENTER); // allConfirmed=false → 提交被阻塞
		expect(result.val).toBeUndefined();
	});

	it("C-FREEDRAFT-2: discarded draft does not appear in submitted answers", () => {
		const { c, result } = make(multiQ);
		// Q1: freeform 草稿 "abc" → ESC 丢弃 → 改选选项 A
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER); // freeform
		c.handleInput("abc");
		c.handleInput(ESC);   // 丢弃草稿，光标回到 Other
		c.handleInput(UP);    // 2→1
		c.handleInput(UP);    // 1→0 (A)
		c.handleInput(ENTER); // 选 A → confirmed → advance Q2
		// Q2 (multiSelect): 选 X → confirmed → advance Q3
		c.handleInput(ENTER);
		// Q3: 选 M → confirmed → advance Submit tab
		c.handleInput(ENTER);
		// Submit
		c.handleInput(ENTER);
		expect(result.val).toBeDefined();
		expect(result.val!.answers["Q1"]).toBe("A");
		// 丢弃的草稿 "abc" 不应出现在任何答案中
		expect(JSON.stringify(result.val!.answers)).not.toContain("abc");
	});
});
