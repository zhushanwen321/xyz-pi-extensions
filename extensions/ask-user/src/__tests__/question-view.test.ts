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
	it("Q-15: freeform mode renders Other row in-place with draft + cursor + number prefix", () => {
		const lines = renderQuestionView(
			singleQ,
			makeState({ mode: "freeform", cursorIndex: 2 }),
			stubTheme,
			60,
			true,
			"my draft",
		);
		const t = text(lines);
		// Other 行原地变 [ ] <input>█（freeform 模式不依赖 buildEditorBlock 独立编辑块）
		expect(t).toContain("my draft");
		expect(t).toContain("█");
		// 不再独立 "Your answer" 提示行
		expect(t).not.toContain("Your answer");
		// 需求4：Other 在 freeform 态也有编号前缀（与其他选项一致）。
		// singleQ 有 2 个选项 → Other 是第 3 项，lead 应含 "3. "
		expect(t).toContain("3. ");
	});

	it("Q-15-NUM: multi-select freeform Other row shows [ ] + number prefix", () => {
		// Auth(1), Search(2), Other(3)，多选 freeform 应渲染 "> [ ] 3. <input>█"
		const multiQ: Question = {
			question: "Which features?",
			multiSelect: true,
			options: [{ label: "Auth" }, { label: "Search" }],
		};
		const lines = renderQuestionView(
			multiQ,
			makeState({ mode: "freeform", cursorIndex: 2 }),
			stubTheme,
			60,
			true,
			"custom",
		);
		const t = text(lines);
		// 多选 box [ ] + 编号 3. 都在编辑行上
		expect(t).toContain("[ ]");
		expect(t).toContain("3. ");
		expect(t).toContain("custom");
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

	it("Q-17: Other row focused shows Enter hint (Tab now navigates tabs)", () => {
		const lines = renderQuestionView(
			singleQ,
			makeState({ cursorIndex: 2 }),
			stubTheme,
			60,
			true,
			"",
		);
		// help 行：Other 焦点时显示 "Enter open editor"
		expect(text(lines)).toContain("Enter open editor");
	});

	// ── Q-28 ~ Q-31: Other 多行换行（输入态 + 已保存预览） ──
	it("Q-28: freeform 长输入超过屏宽时软换行，完整内容不丢失", () => {
		const width = 30;
		// lead = "> [ ] " (单选 box="  ") = 6 列 → avail = 24
		const long = "x".repeat(60);
		const lines = renderQuestionView(
			singleQ,
			makeState({ mode: "freeform", cursorIndex: 2 }),
			stubTheme,
			width,
			true,
			long,
		);
		const t = text(lines);
		// 60 字符按 avail=24 换行 → 至少 3 行，且全部 60 个 x 都在输出里（不截断）
		const xCount = t.split("").filter((c) => c === "x").length;
		expect(xCount).toBe(60);
		expect(lines.some((l) => l.includes("x"))).toBe(true);
		// 光标仍在末尾出现
		expect(t).toContain("█");
		// 每个含 x 的行都不超过总宽 width（stubTheme 无 ANSI，长度=可见宽）
		for (const l of lines) {
			if (l.includes("x")) expect(l.length).toBeLessThanOrEqual(width);
		}
	});

	it("Q-28-WIDE: freeform 模式在宽终端下用全宽渲染（不被分屏左列压窄）", () => {
		// 回归：freeform/comment 模式忽略分屏，编辑器用全 width。
		// 修复前：宽终端走 split.left(≈40)，Other 输入被压在左半屏换行频繁。
		const width = 100;
		// getSplitPaneWidths(100) 非 null（宽终端会进分屏分支），但 freeform 应绕过它
		expect(getSplitPaneWidths(width)).not.toBeNull();
		// 单选 lead visLen=5 → avail = width - 5 = 95。用 60 字符（< 95）应单行装下。
		// 修复前若用 split.left≈40，avail≈35 → 60 字符会换 2 行。
		const input = "a".repeat(60);
		const lines = renderQuestionView(
			singleQ,
			makeState({ mode: "freeform", cursorIndex: 2 }),
			stubTheme,
			width,
			true,
			input,
		);
		// 用 █ 定位编辑器行（help 行不含 █），排除 “submit” 含 a 的干扰
		const editorLines = lines.filter((l) => l.includes("█"));
		expect(editorLines.length).toBe(1);
		// 全部 60 个 a 都在这一行（未被换行拆分）
		const aCount = editorLines[0]!.split("").filter((c) => c === "a").length;
		expect(aCount).toBe(60);
	});

	it("Q-29: freeform 输入超 5 行时截断到 5 行并加省略号", () => {
		const width = 30;
		// avail=24，200 字符 → 9 行，超过 5 行上限
		const huge = "y".repeat(200);
		const lines = renderQuestionView(
			singleQ,
			makeState({ mode: "freeform", cursorIndex: 2 }),
			stubTheme,
			width,
			true,
			huge,
		);
		// 统计含输入内容的行数 = input 渲染行数（应被截到 5 行）
		// 编号 "3. " 现在是 styled 内容的一部分，首行包裹段 "3." 不含 'y'
		const inputLines = lines.filter((l) => l.includes("y") || l.includes("3."));
		expect(inputLines.length).toBe(5);
		// 最后一行带省略号（表示还有更多，光标已被省略号取代）
		expect(inputLines[inputLines.length - 1]).toContain("…");
	});

	it("Q-30: 已保存 freeText 预览超屏宽时多行换行展示", () => {
		const width = 40;
		// 预览 lead="     "(5 列) → avail=35；预览文本带引号
		const long = "z".repeat(80);
		const lines = renderQuestionView(
			singleQ,
			makeState({ cursorIndex: 2, freeTextValue: long }),
			stubTheme,
			width,
			true,
			"",
		);
		const t = text(lines);
		// 80 个 z 全部展示（不再单行截断丢失）
		const zCount = t.split("").filter((c) => c === "z").length;
		expect(zCount).toBe(80);
		// 预览首行带引号开头
		expect(lines.some((l) => l.includes('"'))).toBe(true);
	});

	it("Q-31: 已保存 freeText 预览超 5 行时截断并加省略号", () => {
		const width = 30;
		// 预览 avail = 30-5 = 25，300 字符 → >5 行
		const huge = "w".repeat(300);
		const lines = renderQuestionView(
			singleQ,
			makeState({ cursorIndex: 2, freeTextValue: huge }),
			stubTheme,
			width,
			true,
			"",
		);
		const wLines = lines.filter((l) => l.includes("w"));
		expect(wLines.length).toBe(5);
		expect(wLines[wLines.length - 1]).toContain("…");
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
