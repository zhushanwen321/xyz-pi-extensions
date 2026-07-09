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
export const HOME = "\x1b[H";
export const END = "\x1b[F";
export const INSERT = "\x1b[2~";
export const PGUP = "\x1b[5~";
export const PGDN = "\x1b[6~";
export const F1 = "\x1bOP";
export const DELETE = "\x1b[3~";

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
