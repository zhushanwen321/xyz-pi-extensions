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
