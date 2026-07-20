// src/__tests__/answer-format.test.ts
//
// answer-format.ts 独立单元测试。
// 覆盖审查 S5 发现的覆盖盲区：
//   - parseAnswerParts 子串误匹配（"A" 不应命中 "AB"）
//   - formatAnswer 空 parts → null

import { describe, expect, it } from "vitest";

import { formatAnswer, parseAnswerParts } from "../answer-format.js";

describe("formatAnswer", () => {
	it("returns null for empty parts (unanswered)", () => {
		expect(formatAnswer([])).toBeNull();
	});

	it("joins single part without separator", () => {
		expect(formatAnswer(["yes"])).toBe("yes");
	});

	it("joins multiple parts with ', '", () => {
		expect(formatAnswer(["A", "B", "C"])).toBe("A, B, C");
	});
});

describe("parseAnswerParts", () => {
	it("extracts selected labels by exact match", () => {
		const labels = ["yes", "no", "maybe"];
		const result = parseAnswerParts("yes, no", labels);
		expect(result.selected).toEqual(["yes", "no"]);
	});

	// S5 核心：防子串误匹配——"A" 不应命中 label "AB"
	it("does NOT match substring labels (A vs AB)", () => {
		const labels = ["A", "AB", "ABC"];
		// 答案 "A, AB" 应精确匹配两个 label，而非 "A" 匹配三次
		const result = parseAnswerParts("A, AB", labels);
		expect(result.selected).toEqual(["A", "AB"]);
	});

	it("does NOT match 'A' when only 'AB' is in answer", () => {
		const labels = ["A", "AB"];
		// 答案 "AB" 只应命中 "AB"，不应命中 "A"
		const result = parseAnswerParts("AB", labels);
		expect(result.selected).toEqual(["AB"]);
	});

	it("preserves order of appearance in answer (not label order)", () => {
		const labels = ["A", "B", "C"];
		// 用户选择顺序可能与 options 定义顺序不同
		const result = parseAnswerParts("C, A", labels);
		expect(result.selected).toEqual(["C", "A"]);
	});

	it("handles full-width comma (，) as separator", () => {
		const labels = ["A", "B"];
		const result = parseAnswerParts("A，B", labels);
		expect(result.selected).toEqual(["A", "B"]);
	});

	it("returns non-matching tokens as neither selected (Other free text)", () => {
		const labels = ["yes", "no"];
		// "custom text" 不匹配任何 label → 是 Other 自由文本
		const result = parseAnswerParts("custom text", labels);
		expect(result.selected).toEqual([]);
	});

	it("handles empty answer string", () => {
		const result = parseAnswerParts("", ["A", "B"]);
		expect(result.selected).toEqual([]);
	});
});
