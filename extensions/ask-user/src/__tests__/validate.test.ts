// src/__tests__/validate.test.ts
import { describe, expect, it } from "vitest";

import type { Question } from "../types";
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
});
