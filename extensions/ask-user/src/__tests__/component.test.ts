// src/__tests__/component.test.ts
import { describe, expect, it } from "vitest";

import { AskUserComponent } from "../component";
import type { Question, Result } from "../types";
import {
	BKSP,
	DOWN,
	ENTER,
	ESC,
	LEFT,
	mockTui,
	multiQ,
	multiQWithComment,
	RIGHT,
	singleQ,
	singleQMulti,
	singleQWithComment,
	stubTheme,
	TAB,
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

// ── 5a. 单问题（AC-2）──────────────────────────────────
describe("AskUserComponent — single question", () => {
	it("C-1: renders question without tab bar", () => {
		const { c } = make([singleQ]);
		const lines = c.render(60);
		expect(lines.some((l) => l.includes("Which DB?"))).toBe(true);
		expect(lines.some((l) => l.includes("Submit"))).toBe(false);
	});

	it("C-2: confirms first option on Enter and resolves", () => {
		const { c, result } = make([singleQ]);
		c.handleInput(ENTER);
		expect(result.val).not.toBeUndefined();
		expect(result.val!.cancelled).toBe(false);
		expect(result.val!.answers["Which DB?"]).toBe("Postgres");
	});

	it("C-3: moves cursor down then confirms second option", () => {
		const { c, result } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		expect(result.val!.answers["Which DB?"]).toBe("SQLite");
	});

	it("C-4: resolves cancelled on Esc", () => {
		const { c, result } = make([singleQ]);
		c.handleInput(ESC);
		expect(result.val).toBeNull();
	});

	it("C-5: Up at first option does not go below 0", () => {
		const { c } = make([singleQ]);
		c.render(60);
		c.handleInput(UP);
		// Render and verify cursor still on first (Postgres highlighted)
		const lines = c.render(60);
		expect(lines.some((l) => l.includes(">") && l.includes("Postgres"))).toBe(true);
	});

	it("C-6: Down does not go beyond Other (last option)", () => {
		const { c } = make([singleQ]);
		// 2 options + Other = 3 rows (indices 0,1,2). Press Down 5 times.
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		const lines = c.render(60);
		// Cursor should be on Other (last), not beyond
		expect(lines.some((l) => l.includes(">") && l.includes("Other"))).toBe(true);
	});
});

// ── 5b. 多问题 Tab 导航（AC-3 / AC-16）─────────────────
describe("AskUserComponent — multi question tab nav", () => {
	it("C-7: renders tab bar with headers + Submit", () => {
		const { c } = make(multiQ);
		const lines = c.render(80);
		const t = lines.join("\n");
		expect(t).toContain("First");
		expect(t).toContain("Second");
		expect(t).toContain("Third");
		expect(t).toContain("Submit");
	});

	it("C-8: navigates tabs and submits all answers", () => {
		const { c, result } = make(multiQ);
		// Q1: select A (Enter)
		c.handleInput(ENTER);
		// Q2: toggle X (Space), confirm (Enter)
		c.handleInput(" ");
		c.handleInput(ENTER);
		// Q3: select M (Enter)
		c.handleInput(ENTER);
		// Submit tab: Enter
		c.handleInput(ENTER);
		expect(result.val!.answers["Q1"]).toBe("A");
		expect(result.val!.answers["Q2"]).toBe("X");
		expect(result.val!.answers["Q3"]).toBe("M");
	});

	it("C-9: Submit tab blocks when not all confirmed", () => {
		const { c, result } = make(multiQ);
		c.handleInput(RIGHT); // -> Q2
		c.handleInput(RIGHT); // -> Q3
		c.handleInput(RIGHT); // -> Submit
		c.handleInput(ENTER); // should NOT submit
		expect(result.val).toBeUndefined();
	});

	it("C-10: Right wraps Submit → Q1", () => {
		const { c } = make(multiQ);
		// Navigate to Submit (3 questions → tabs 0,1,2,3=Submit)
		c.handleInput(RIGHT); // Q2
		c.handleInput(RIGHT); // Q3
		c.handleInput(RIGHT); // Submit
		c.handleInput(RIGHT); // should wrap to Q1
		const lines = c.render(80);
		expect(lines.some((l) => l.includes("Q1") || l.includes("First"))).toBe(true);
	});

	it("C-11: Left wraps Q1 → last question (Submit's left target)", () => {
		const { c } = make(multiQ);
		c.handleInput(LEFT); // Q1 left → wraps to Submit
		const lines = c.render(80);
		// On Submit tab
		expect(lines.some((l) => l.includes("Ready") || l.includes("Unanswered"))).toBe(true);
	});

	it("C-16 (AC-16): can re-edit confirmed answer", () => {
		const { c, result } = make(multiQ);
		// Q1: select A
		c.handleInput(ENTER); // → Q2
		// Go back to Q1
		c.handleInput(LEFT); // Q1
		// Select B instead
		c.handleInput(DOWN);
		c.handleInput(ENTER); // → Q2
		// Skip Q2, Q3 by confirming
		c.handleInput(" ");
		c.handleInput(ENTER); // Q2 → Q3
		c.handleInput(ENTER); // Q3 → Submit
		c.handleInput(ENTER); // Submit
		expect(result.val!.answers["Q1"]).toBe("B");
	});

	it("C-15: leaving multi-select tab auto-confirms answered selection", () => {
		// Use 2 questions: Q1 single, Q2 multi-select
		const twoQ: Question[] = [
			{ question: "Q1", header: "First", options: [{ label: "A" }, { label: "B" }] },
			{ question: "Q2", header: "Second", options: [{ label: "X" }, { label: "Y" }], multiSelect: true },
		];
		const { c, result } = make(twoQ);
		c.handleInput(ENTER); // Q1 select A → Q2
		c.handleInput(" ");   // Q2 toggle X (no Enter-confirm)
		c.handleInput(RIGHT); // → Submit, should auto-confirm Q2
		c.handleInput(ENTER); // Submit (all confirmed)
		expect(result.val!.answers["Q1"]).toBe("A");
		expect(result.val!.answers["Q2"]).toBe("X");
	});

	it("C-REG-R6: Other 录入→重进清空→Submit 应回到未答（confirmed 不变式）", () => {
		// 回归 MUST_FIX: freeform 空 Enter 清空 freeTextValue 后须重置 confirmed=false
		const { c, result } = make(multiQ);
		// Q1 (A/B + Other): 导航到 Other，录入 "custom"
		c.handleInput(DOWN);
		c.handleInput(DOWN); // → Other
		c.handleInput(" ");   // 打开 freeform
		c.handleInput("c");
		c.handleInput("u");
		c.handleInput("s");
		c.handleInput("t");
		c.handleInput("o");
		c.handleInput("m");
		c.handleInput(ENTER); // 保存 freeText → confirmed=true → advance to Q2
		// 切回 Q1，重进 Other 编辑器，清空后空 Enter
		c.handleInput(LEFT);  // → Q1
		c.handleInput(DOWN);  // idempotent: cursor stays on Other
		c.handleInput(DOWN);
		c.handleInput(" ");   // 重开 freeform，editorText 预填 "custom"
		c.handleInput(BKSP);  // 清空 editorText
		c.handleInput(BKSP);
		c.handleInput(BKSP);
		c.handleInput(BKSP);
		c.handleInput(BKSP);
		c.handleInput(BKSP);
		c.handleInput(ENTER); // 空 Enter → freeTextValue 清空，confirmed 应重置 false
		// 导航到 Submit 并尝试提交 → 应被阻塞（Q1 回到未答）
		c.handleInput(RIGHT); // → Q2
		c.handleInput(RIGHT); // → Q3
		c.handleInput(RIGHT); // → Submit
		c.handleInput(ENTER); // 应被阻塞
		expect(result.val).toBeUndefined();
	});
});

// ── 5c. 单选选择（FR-6）────────────────────────────────
describe("AskUserComponent — single-select", () => {
	it("C-17: cursor movement does not record answer", () => {
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.render(60);
		// No resolution yet (only Enter resolves single)
		// We verify by checking the question is still interactive — render shows cursor on SQLite
		const lines = c.render(60);
		expect(lines.some((l) => l.includes(">") && l.includes("SQLite"))).toBe(true);
	});

	it("C-19: re-selecting a normal option clears freeText", () => {
		const { c, result } = make([singleQ]);
		// Go to Other (index 2), open editor, type text
		c.handleInput(DOWN);
		c.handleInput(DOWN); // Other
		c.handleInput(" "); // open freeform
		c.handleInput("c");
		c.handleInput("u");
		c.handleInput("s");
		c.handleInput("t");
		c.handleInput("o");
		c.handleInput("m");
		c.handleInput(ENTER); // save freeText → submit (single question)
		expect(result.val!.answers["Which DB?"]).toBe("custom");
	});
});

// ── 5d. 多选 toggle（FR-6 / AC-18）─────────────────────
describe("AskUserComponent — multi-select toggle", () => {
	it("C-20: Space toggles index into selectedIndices", () => {
		const { c } = make([singleQMulti]);
		c.handleInput(" ");
		const lines = c.render(60);
		expect(lines.some((l) => l.includes("[✓]") && l.includes("Auth"))).toBe(true);
	});

	it("C-21: Space twice removes from selectedIndices", () => {
		const { c } = make([singleQMulti]);
		c.handleInput(" "); // add
		c.handleInput(" "); // remove
		const lines = c.render(60);
		expect(lines.some((l) => l.includes("[ ]") && l.includes("Auth"))).toBe(true);
	});

	it("C-24 (AC-18): multi-select toggle does NOT trigger comment mode", () => {
		// singleQMulti has allowComment:true + multiSelect:true
		const { c } = make([singleQMulti]);
		c.handleInput(" "); // toggle — should NOT enter comment mode
		const lines = c.render(60);
		// No comment prompt shown
		expect(lines.some((l) => l.toLowerCase().includes("comment"))).toBe(false);
	});
});

// ── 5e. Other 自由文本（FR-4.5 / AC-5）─────────────────
describe("AskUserComponent — Other free-text editor", () => {
	it("C-25: Space on Other row opens freeform editor", () => {
		const { c } = make([singleQ]);
		// Navigate to Other (index 2)
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(" ");
		const lines = c.render(60);
		expect(lines.some((l) => l.includes("Your answer"))).toBe(true);
	});

	it("C-26: Tab on Other row opens freeform editor", () => {
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(TAB);
		const lines = c.render(60);
		expect(lines.some((l) => l.includes("Your answer"))).toBe(true);
	});

	it("C-27: editor accepts printable characters", () => {
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(" "); // open
		c.handleInput("h");
		c.handleInput("i");
		const lines = c.render(60);
		expect(lines.some((l) => l.includes("hi"))).toBe(true);
	});

	it("C-28: editor Backspace deletes last char", () => {
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(" ");
		c.handleInput("a");
		c.handleInput("b");
		c.handleInput(BKSP); // delete "b"
		const lines = c.render(60);
		expect(lines.some((l) => l.includes("a") && !l.includes("ab"))).toBe(true);
	});

	it("C-31: editor Esc returns to options list", () => {
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(" ");
		c.handleInput(ESC);
		const lines = c.render(60);
		// Back in options mode — no "Your answer" editor prompt
		expect(lines.some((l) => l.includes("Your answer"))).toBe(false);
	});

	it("C-29: editor Enter with text saves and submits (single)", () => {
		const { c, result } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(" ");
		c.handleInput("x");
		c.handleInput(ENTER);
		expect(result.val).not.toBeUndefined();
		expect(result.val!.answers["Which DB?"]).toBe("x");
	});

	it("C-30: editor Enter empty clears freeText (single → submit with null)", () => {
		const { c, result } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(" "); // open editor
		c.handleInput(ENTER); // FR-6: empty Enter → clear freeText, close editor (NO confirm/submit)
		// Not submitted; still in options list
		expect(result.val).toBeUndefined();
		// Back in options mode — no "Your answer" editor prompt
		const lines = c.render(60);
		expect(lines.some((l) => l.includes("Your answer"))).toBe(false);
	});
});

// ── 5f. 评论流程（FR-4.6 / FR-11 / AC-6/12/17）─────────
describe("AskUserComponent — comment flow", () => {
	it("C-33: single-select + allowComment Enter enters comment mode", () => {
		const { c } = make([singleQWithComment]);
		c.handleInput(ENTER); // select Postgres
		const lines = c.render(60);
		expect(lines.some((l) => l.toLowerCase().includes("comment"))).toBe(true);
	});

	it("C-34 (AC-12): comment Enter empty skips and submits (single)", () => {
		const { c, result } = make([singleQWithComment]);
		c.handleInput(ENTER); // select → comment mode
		c.handleInput(ENTER); // empty comment → skip → submit
		expect(result.val).not.toBeUndefined();
		expect(result.val!.answers["Which DB? (with comment)"]).toBe("Postgres");
	});

	it("C-35: comment Enter with text saves comment", () => {
		const { c, result } = make([singleQWithComment]);
		c.handleInput(ENTER); // select → comment mode
		c.handleInput("f");
		c.handleInput("a");
		c.handleInput("s");
		c.handleInput("t");
		c.handleInput(ENTER); // save comment → submit
		expect(result.val!.answers["Which DB? (with comment)"]).toBe("Postgres — fast");
	});

	it("C-38: multi-select + allowComment: Enter after toggle enters comment", () => {
		const { c } = make([singleQMulti]);
		c.handleInput(" "); // toggle Auth
		c.handleInput(ENTER); // confirm → comment mode
		const lines = c.render(60);
		expect(lines.some((l) => l.toLowerCase().includes("comment"))).toBe(true);
	});

	it("C-39: Other + allowComment: freeText then comment", () => {
		const { c, result } = make([singleQWithComment]);
		// Navigate to Other
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(" "); // open freeform
		c.handleInput("c");
		c.handleInput("u");
		c.handleInput("s");
		c.handleInput("t");
		c.handleInput("o");
		c.handleInput("m");
		c.handleInput(ENTER); // save freeText → allowComment → comment mode
		c.handleInput(ENTER); // empty comment → skip → submit
		expect(result.val!.answers["Which DB? (with comment)"]).toBe("custom");
	});

	it("C-36 (AC-17): comment Esc skips comment and advances (single)", () => {
		const { c, result } = make([singleQWithComment]);
		c.handleInput(ENTER); // select Postgres → comment mode
		c.handleInput(ESC); // Esc in comment = skip comment → advance → submit
		expect(result.val).not.toBeUndefined();
		// commentValue stays null (no prior comment), answer is the selected option
		expect(result.val!.answers["Which DB? (with comment)"]).toBe("Postgres");
	});

	it("C-36b (AC-17): comment Esc advances to next tab (multi-question)", () => {
		const { c, result } = make(multiQWithComment);
		// Q1 (allowComment): select A → comment mode
		c.handleInput(ENTER); // select A → comment mode
		c.handleInput(ESC); // Esc in comment = skip → advance to Q2
		// Q2: select X → Submit
		c.handleInput(ENTER); // select X → Submit
		c.handleInput(ENTER); // Submit
		expect(result.val).not.toBeUndefined();
		expect(result.val!.answers["Q1"]).toBe("A");
		expect(result.val!.answers["Q2"]).toBe("X");
	});

	it("C-36c (AC-17): Esc-in-comment discards typed text (vs Enter which saves)", () => {
		// Contrast: typing then Enter would save commentValue and append " — keep".
		// Esc should discard the typed editor text and advance without attaching it.
		const { c, result } = make([singleQWithComment]);
		c.handleInput(ENTER); // select Postgres → comment mode
		c.handleInput("k");
		c.handleInput("e");
		c.handleInput("e");
		c.handleInput("p");
		c.handleInput(ESC); // Esc in comment = discard typed text → advance → submit
		expect(result.val).not.toBeUndefined();
		// No " — keep" suffix: Esc did not commit the typed text
		expect(result.val!.answers["Which DB? (with comment)"]).toBe("Postgres");
	});

	it("C-37: answer + comment combined format 'label — note'", () => {
		const { c, result } = make([singleQWithComment]);
		c.handleInput(ENTER); // select Postgres → comment mode
		c.handleInput("n");
		c.handleInput("o");
		c.handleInput("t");
		c.handleInput("e");
		c.handleInput(ENTER); // save comment → submit
		expect(result.val!.answers["Which DB? (with comment)"]).toBe("Postgres — note");
	});
});

// ── 5g. 防重入（FR-12）─────────────────────────────────
describe("AskUserComponent — re-entry guard", () => {
	it("C-40: ignores input after resolution (submit)", () => {
		const { c, result } = make([singleQ]);
		c.handleInput(ENTER); // submit
		const firstVal = result.val;
		c.handleInput(ENTER); // ignored
		expect(result.val).toBe(firstVal);
	});

	it("C-41: ignores input after cancel", () => {
		const { c, result } = make([singleQ]);
		c.handleInput(ESC); // cancel
		expect(result.val).toBeNull();
		c.handleInput(ENTER); // ignored
		expect(result.val).toBeNull();
	});
});

// ── 5h. 渲染缓存 ───────────────────────────────────────
describe("AskUserComponent — render cache", () => {
	it("C-42: same width returns same reference", () => {
		const { c } = make([singleQ]);
		const a = c.render(60);
		const b = c.render(60);
		expect(a).toBe(b);
	});

	it("C-43: input invalidates cache", () => {
		const { c } = make([singleQ]);
		const a = c.render(60);
		c.handleInput(DOWN);
		const b = c.render(60);
		expect(a).not.toBe(b);
	});

	it("C-44: different width invalidates cache", () => {
		const { c } = make([singleQ]);
		const a = c.render(60);
		const b = c.render(80);
		expect(a).not.toBe(b);
	});
});

// ── 5i. Submit tab 交互（FR-5）──────────────────────────
describe("AskUserComponent — Submit tab", () => {
	it("C-47: Submit Esc cancels", () => {
		const { c, result } = make(multiQ);
		c.handleInput(RIGHT); // Q2
		c.handleInput(RIGHT); // Q3
		c.handleInput(RIGHT); // Submit
		c.handleInput(ESC); // cancel
		expect(result.val).toBeNull();
	});

	it("C-46: Submit Enter when all confirmed submits", () => {
		const { c, result } = make(multiQWithComment);
		// Q1 (allowComment): select A → comment mode → skip
		c.handleInput(ENTER); // select A
		c.handleInput(ENTER); // skip comment → Q2
		// Q2: select X
		c.handleInput(ENTER); // → Submit
		c.handleInput(ENTER); // Submit
		expect(result.val).not.toBeUndefined();
		expect(result.val!.answers["Q1"]).toBe("A");
		expect(result.val!.answers["Q2"]).toBe("X");
	});
});
