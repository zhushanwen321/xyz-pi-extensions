// src/__tests__/fixtures.ts
// Shared test fixtures — stub theme, mock TUI, sample questions, key sequences.
import type { Question, ThemeLike } from "../types";

// ── Stub theme (passthrough — no ANSI codes, plain text) ──
export const stubTheme: ThemeLike = {
	fg: (_t: string, s: string) => s,
	bg: (_t: string, s: string) => s,
	bold: (s: string) => s,
};

// ── Mock TUI (no-op requestRender) ──
export const mockTui = { requestRender: (): void => {} };

// ── Key sequences (real terminal escape codes that matchesKey recognizes) ──
export const ENTER = "\r";
export const SPACE = " ";
export const ESC = "\x1b";
export const UP = "\x1b[A";
export const DOWN = "\x1b[B";
export const RIGHT = "\x1b[C";
export const LEFT = "\x1b[D";
export const TAB = "\t";
export const BKSP = "\x7f";

// ── Sample questions ──
export const singleQ: Question = {
	question: "Which DB?",
	options: [
		{ label: "Postgres", description: "Battle-tested" },
		{ label: "SQLite", description: "Embedded" },
	],
};

export const singleQWithComment: Question = {
	question: "Which DB? (with comment)",
	allowComment: true,
	options: [
		{ label: "Postgres", description: "Battle-tested" },
		{ label: "SQLite", description: "Embedded" },
	],
};

export const singleQMulti: Question = {
	question: "Which features?",
	multiSelect: true,
	allowComment: true,
	options: [
		{ label: "Auth", description: "OAuth + session" },
		{ label: "Search", description: "Full-text" },
	],
};

export const multiQ: Question[] = [
	{ question: "Q1", header: "First", options: [{ label: "A" }, { label: "B" }] },
	{
		question: "Q2",
		header: "Second",
		options: [{ label: "X" }, { label: "Y" }],
		multiSelect: true,
	},
	{ question: "Q3", header: "Third", options: [{ label: "M" }, { label: "N" }] },
];

export const multiQWithComment: Question[] = [
	{ question: "Q1", header: "First", allowComment: true, options: [{ label: "A" }, { label: "B" }] },
	{ question: "Q2", header: "Second", options: [{ label: "X" }, { label: "Y" }] },
];

// ── Special keys (non-printable) ──
export const HOME = "\x1b[H";
export const END = "\x1b[F";
export const INSERT = "\x1b[2~";
export const PAGE_UP = "\x1b[5~";
export const PAGE_DOWN = "\x1b[6~";
export const F1 = "\x1bOP";
export const DELETE = "\x1b[3~";

// ── Modifier key sequences (ctrl/alt/shift/super + arrow/special) ──
// CSI u encoding (Kitty/modifyOtherKeys mode 2): ESC [ <code> ; <mod> ~
// mod = 1 + bitmask: shift=1, alt=2, ctrl=4, super=8
export const CTRL_UP = "\x1b[1;5A";
export const CTRL_DOWN = "\x1b[1;5B";
export const CTRL_LEFT = "\x1b[1;5D";
export const CTRL_RIGHT = "\x1b[1;5C";
export const ALT_UP = "\x1b[1;3A";
export const ALT_DOWN = "\x1b[1;3B";
export const ALT_LEFT = "\x1b[1;3D";
export const ALT_RIGHT = "\x1b[1;3C";
export const SHIFT_UP = "\x1b[1;2A";
export const SHIFT_DOWN = "\x1b[1;2B";
export const SHIFT_LEFT = "\x1b[1;2D";
export const SHIFT_RIGHT = "\x1b[1;2C";
export const SUPER_UP = "\x1b[1;9A";
export const SUPER_DOWN = "\x1b[1;9B";
export const SUPER_LEFT = "\x1b[1;9D";
export const SUPER_RIGHT = "\x1b[1;9C";
export const CTRL_SHIFT_UP = "\x1b[1;6A";
export const CTRL_SHIFT_DOWN = "\x1b[1;6B";
