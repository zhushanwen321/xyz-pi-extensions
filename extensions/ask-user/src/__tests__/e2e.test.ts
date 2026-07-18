// src/__tests__/e2e.test.ts
// E2E test cases for ask_user. Drives tool.execute() → real AskUserComponent
// → simulated keypresses → asserts on final execute() result contract.
// Spec: .xyz-harness/2026-06-15-ask-user/e2e-test-cases.md

import { describe, expect, it } from "vitest";

import { makeE2E } from "./e2e-harness";

// ── E2E-1: 单问题无评论 — 选第二项提交 ─────────────────
describe("E2E-1: single question, no comment — pick 2nd option", () => {
	const questions = [
		{
			question: "Which DB?",
			options: [{ label: "Postgres" }, { label: "SQLite" }],
		},
	];

	it("selects SQLite on ↓ + Enter and returns answers", async () => {
		const e = makeE2E(questions);
		e.keys(["\x1b[B", "\r"]); // ↓ + Enter
		const result = await e.getExecuted();
		const details = result.details;

		// User-facing summary
		expect(result.content[0].text).toContain("Which DB?");
		expect(result.content[0].text).toContain("SQLite");
		// Data contract
		expect(details.cancelled).toBe(false);
		expect(details.answers["Which DB?"]).toBe("SQLite");
		expect(details.questions.length).toBe(1);
	});
});

// ── E2E-2: 单问题 + allowComment — 选项 + 评论拼接 ─────
describe("E2E-2: single question + allowComment — option + comment joined", () => {
	const questions = [
		{
			question: "Which DB?",
			allowComment: true,
			options: [{ label: "Postgres" }, { label: "SQLite" }],
		},
	];

	it("joins selected option with comment via ' — '", async () => {
		const e = makeE2E(questions);
		// Enter 选 Postgres → 进评论模式 → 输 "fast" → Enter 保存（allowComment 分支）
		e.keys(["\r", "f", "a", "s", "t", "\r"]);
		const result = await e.getExecuted();
		const details = result.details;

		expect(details.cancelled).toBe(false);
		expect(details.answers["Which DB?"]).toBe("Postgres — fast");
		expect(result.content[0].text).toContain("Postgres — fast");
	});
});

// ── E2E-3: 单问题 + allowComment — Enter 空评论跳过 ─────
describe("E2E-3: single question + allowComment — Enter in comment skips", () => {
	const questions = [
		{
			question: "Which DB?",
			allowComment: true,
			options: [{ label: "Postgres" }, { label: "SQLite" }],
		},
	];

	it("empty Enter in comment mode keeps option without ' — ' suffix", async () => {
		const e = makeE2E(questions);
		// Enter 选 Postgres → 直接 Enter 评论模式跳过（AC-12）
		e.keys(["\r", "\r"]);
		const result = await e.getExecuted();
		const details = result.details;

		expect(details.cancelled).toBe(false);
		// 不含 " — " 分隔符
		expect(details.answers["Which DB?"]).toBe("Postgres");
		expect(details.answers["Which DB?"]).not.toContain("—");
	});
});

// ── E2E-4: 多问题提交 — 逐题选择后 Submit tab 提交（S-11）──────
describe("E2E-4: multi-question submit — answer each then Submit tab", () => {
	const questions = [
		{ question: "Q1", header: "First", options: [{ label: "A" }, { label: "B" }] },
		{ question: "Q2", header: "Second", options: [{ label: "X" }, { label: "Y" }] },
	];

	it("answers both via Enter + Enter on Submit tab", async () => {
		const e = makeE2E(questions);
		// Q1: Enter 选 A（auto-confirm → advance 到 Q2）
		// Q2: Enter 选 X（auto-confirm → advance 到 Submit tab）
		// Submit: Enter（allConfirmed）→ 提交
		e.keys(["\r", "\r", "\r"]);
		const result = await e.getExecuted();
		const details = result.details;

		expect(details.cancelled).toBe(false);
		expect(details.answers["Q1"]).toBe("A");
		expect(details.answers["Q2"]).toBe("X");
		expect(result.content[0].text).toContain("Q1");
		expect(result.content[0].text).toContain("Q2");
	});
});

// ── E2E-5: 多选 — Space 勾选多项后 Enter 提交（S-11）──────────
describe("E2E-5: multi-select — Space toggle two options then Enter", () => {
	const questions = [
		{
			question: "Which features?",
			multiSelect: true,
			options: [{ label: "Auth" }, { label: "Search" }],
		},
	];

	it("toggles Auth + Search via Space and submits on Enter", async () => {
		const e = makeE2E(questions);
		// Space 选 Auth（cursor@0）→ ↓ → Space 选 Search（cursor@1）→ Enter 确认（单问题→submit）
		e.keys([" ", "\x1b[B", " ", "\r"]);
		const result = await e.getExecuted();
		const details = result.details;

		expect(details.cancelled).toBe(false);
		expect(details.answers["Which features?"]).toBe("Auth, Search");
	});
});

// ── E2E-6: Other 自由文本 — 输入自定义答案（S-11）─────────────
describe("E2E-6: Other free-text — type custom answer", () => {
	const questions = [
		{ question: "Which DB?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
	];

	it("navigates to Other, types a custom answer, submits", async () => {
		const e = makeE2E(questions);
		// ↓↓ 到 Other（cursor@2，2 个普通选项 + Other）→ Enter 开 freeform 编辑器
		// → 输 "redis" → Enter 保存（afterConfirm → advance → submit）
		e.keys(["\x1b[B", "\x1b[B", "\r", "r", "e", "d", "i", "s", "\r"]);
		const result = await e.getExecuted();
		const details = result.details;

		expect(details.cancelled).toBe(false);
		expect(details.answers["Which DB?"]).toBe("redis");
	});
});

// ── E2E-7: 取消 — Esc 进入确认层 → Esc 确认取消（S-11）────────
describe("E2E-7: cancel — Esc confirm overlay → Esc cancels", () => {
	const questions = [
		{ question: "Which DB?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
	];

	it("single Esc raises confirm overlay, second Esc confirms cancel", async () => {
		const e = makeE2E(questions);
		// 单问题首个 tab：Esc → pendingCancel 覆盖层；再 Esc → cancel() → done(null)
		e.keys(["\x1b", "\x1b"]);
		const result = await e.getExecuted();
		const details = result.details;

		expect(details.cancelled).toBe(true);
		expect(result.content[0].text).toContain("cancelled");
		// 取消时 answers 为空对象
		expect(Object.keys(details.answers)).toHaveLength(0);
	});
});

// ── E2E-8: cancel 在多问题场景 — 首个问题 Esc→Esc 取消（S-11 cancel 多问题路径）─
describe("E2E-8: cancel during multi-question — Esc overlay then confirm", () => {
	const questions = [
		{ question: "Q1", header: "First", options: [{ label: "A" }, { label: "B" }] },
		{ question: "Q2", header: "Second", options: [{ label: "X" }, { label: "Y" }] },
	];

	it("Esc on first question raises overlay, second Esc cancels all", async () => {
		const e = makeE2E(questions);
		e.keys(["\x1b", "\x1b"]);
		const result = await e.getExecuted();
		const details = result.details;

		expect(details.cancelled).toBe(true);
		// 取消返回 details.answers = {}，details.questions 仍回传（renderResult 数据源）
		expect(Object.keys(details.answers)).toHaveLength(0);
	});
});
