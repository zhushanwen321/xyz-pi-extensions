// src/__tests__/validate.test.ts
import { describe, expect, it } from "vitest";

import { HEADER_MAX_CHARS, type Question } from "../types";
import { validateInput } from "../validate";

const q = (overrides: Partial<Question> = {}): Question => ({
	question: "Q1",
	options: [{ label: "A" }, { label: "B" }],
	...overrides,
});

describe("validateInput", () => {
	it("returns null for valid single question", () => {
		expect(validateInput([q()])).toBeNull();
	});

	it("returns null for valid multiple questions with headers", () => {
		expect(
			validateInput([
				q({ question: "Q1", header: "First" }),
				q({ question: "Q2", header: "Second" }),
			]),
		).toBeNull();
	});

	it("returns null for single question without header", () => {
		expect(validateInput([q()])).toBeNull();
	});

	it("detects duplicate question text", () => {
		const result = validateInput([
			q({ question: "Same", header: "A" }),
			q({ question: "Same", header: "B" }),
		]);
		expect(result).toContain("Duplicate question");
		expect(result).toContain("Same");
	});

	it("detects duplicate option labels within a question", () => {
		const result = validateInput([
			q({ options: [{ label: "A" }, { label: "A" }] }),
		]);
		expect(result).toContain("Duplicate option label");
		expect(result).toContain("A");
	});

	it("detects missing header in multi-question", () => {
		const result = validateInput([
			q({ question: "Q1", header: "First" }),
			q({ question: "Q2" }), // no header
		]);
		expect(result).toContain("header");
		expect(result).toContain("Q2");
	});

	it("allows whitespace-only header on single question (header unused)", () => {
		const result = validateInput([
			q({ question: "Q1", header: "  " }),
		]);
		expect(result).toBeNull();
	});

	it("detects empty-string header in multi-question", () => {
		const result = validateInput([
			q({ question: "Q1", header: "First" }),
			q({ question: "Q2", header: "  " }),
		]);
		expect(result).toContain("header");
	});

	// V-9: 4 个问题上限
	it("accepts 4 questions (maxItems boundary)", () => {
		const result = validateInput([
			q({ question: "Q1", header: "H1" }),
			q({ question: "Q2", header: "H2" }),
			q({ question: "Q3", header: "H3" }),
			q({ question: "Q4", header: "H4" }),
		]);
		expect(result).toBeNull();
	});

	// V-10/S3: 多 question 时 header 必须唯一——重复 header 会导致 askUserKey 碰撞
	// （协议 helper 用 header 作 answers 读取 key，后一个覆盖前一个的 Other/comment）
	it("rejects duplicate headers across different questions", () => {
		const result = validateInput([
			q({ question: "Q1", header: "Same" }),
			q({ question: "Q2", header: "Same" }),
		]);
		expect(result).not.toBeNull();
		expect(result).toContain("Duplicate header");
	});

	// V-11: option description 不参与唯一性校验
	it("allows duplicate descriptions across options", () => {
		const result = validateInput([
			q({
				options: [
					{ label: "A", description: "same desc" },
					{ label: "B", description: "same desc" },
				],
			}),
		]);
		expect(result).toBeNull();
	});

	// V-12: question 文本超过 QUESTION_MAX_CHARS(1000) 上限
	it("rejects question text exceeding QUESTION_MAX_CHARS (1000)", () => {
		const result = validateInput([q({ question: "x".repeat(1001) })]);
		expect(result).not.toBeNull();
		expect(result).toContain("1000");
	});

	// V-13: question 文本恰好 1000 字符（边界值，合法）
	it("accepts question text at exactly QUESTION_MAX_CHARS (1000)", () => {
		expect(validateInput([q({ question: "x".repeat(1000) })])).toBeNull();
	});

	// V-14: question 文本含控制字符（\n \t \r \x00）被拒绝
	it("rejects question text containing control characters", () => {
		for (const text of ["line1\nline2", "a\tb", "a\rb", "a\x00b"]) {
			const result = validateInput([q({ question: text })]);
			expect(result).toContain("control characters");
		}
	});

	// V-15: header 超过 HEADER_MAX_CHARS(12) 上限被拒绝（A3：补 validate 层校验）
	it("rejects header exceeding HEADER_MAX_CHARS (12)", () => {
		const result = validateInput([q({ header: "This header is too long" })]);
		expect(result).not.toBeNull();
		expect(result).toContain("Header exceeds");
		expect(result).toContain(`${HEADER_MAX_CHARS}`);
	});

	// V-16: header 恰好 12 字符（边界值，合法）
	it("accepts header at exactly HEADER_MAX_CHARS (12)", () => {
		expect(validateInput([q({ header: "123456789012" })])).toBeNull();
	});
});
