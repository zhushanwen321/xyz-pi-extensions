// 提示词质量回归：structured-output tool 必须把 "schema/data envelope" 结构
// 作为一等公民教给模型，并用结构反例堵住弱模型最常见的三类结构性误用：
//   1. 把答案直接当参数（漏 envelope）
//   2. schema/data 互换（静默腐败根因）
//   3. schema/data 合并成一个对象
//
// 同时锁定 execute() 内的运行时互换检测 + keyword-less schema 拒绝 + 错误回显，
// 防止后续重构把这些防御 silently 删掉。这三板斧是治静默腐败（P0）的核心保障。
//
// 读源码文本断言（参考 subagent-workflow 的 subagent-tool-prompt.test.ts），
// 避免 mock 链（index.ts 依赖 ajv/typebox/PiAPI 值导入）。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "../src/index.ts"), "utf-8");

/**
 * 提取 description 赋值的源码片段。
 *
 * description 在源码里是字符串拼接表达式（"..." + "..." + ...），终止于
 * promptSnippet: 前的逗号。保留拼接字面量原文供子串断言——拼接表达式里的
 * 字面量文本会原样出现在捕获片段中，故子串搜索有效。
 */
function extractDescription(src: string): string {
	const m = src.match(/description:\s*([\s\S]*?),\s*promptSnippet:/);
	if (!m) throw new Error("description assignment not found in src/index.ts");
	return m[1]!;
}

const DESCRIPTION = extractDescription(SRC);

describe("structured-output description — envelope 结构为一等公民", () => {
	it("含完整 envelope 正例（schema + data 配对，含真实 data 值）", () => {
		// 弱模型首次调用常把答案塞进 schema 或漏掉外层 envelope。
		// 一个带真实 data 值的完整调用正例是最强信号。
		expect(DESCRIPTION).toMatch(/Correct \(full call\)/i);
		expect(DESCRIPTION).toMatch(/data:\{name:'Alice'/);
	});

	it("声明 schema/data 必须配对匹配", () => {
		expect(DESCRIPTION.toLowerCase()).toContain("must match");
	});

	it("覆盖 number 与 boolean 根类型正例", () => {
		// 现有覆盖 object/array/string-enum，补 number/boolean 防止模型
		// 误以为只能返回对象。
		expect(DESCRIPTION).toMatch(/type:'number'/);
		expect(DESCRIPTION).toMatch(/type:'boolean'/);
	});

	it("含结构层反例：漏 envelope（含 'envelope' 与 'Wrap'）", () => {
		expect(DESCRIPTION.toLowerCase()).toContain("envelope");
		expect(DESCRIPTION).toMatch(/wrap/i);
	});

	it("含结构层反例：schema/data 互换（含 'swap'）", () => {
		expect(DESCRIPTION).toMatch(/swap/i);
	});

	it("含结构层反例：合并 schema 与 data", () => {
		expect(DESCRIPTION.toLowerCase()).toContain("merging");
	});
});

describe("structured-output execute() — 运行时防御锁定（防静默腐败）", () => {
	it("含互换检测（'swapped' 或 'recognized keyword'）", () => {
		// 互换检测是治静默腐败的最高优先守卫，不能被重构删掉。
		expect(SRC).toMatch(/swap|recognized keyword/i);
	});

	it("含 keyword-less schema 拒绝（validateSchema 加固）", () => {
		// ajv strict:false 会把 {} 编译成"接受一切"，必须显式拒绝。
		expect(SRC).toContain("recognized keyword");
	});

	it("含 schema keyword 识别清单（draft-07 keyword 检测）", () => {
		// 识别 keyword 的字符串数组是 keyword-less 拒绝的基础。
		// 至少要覆盖需求列出的核心 keyword。
		expect(SRC).toMatch(/SCHEMA_KEYWORDS/);
		for (const kw of ["type", "properties", "items", "enum", "required", "$ref", "anyOf", "oneOf", "allOf"]) {
			expect(SRC).toContain(`"${kw}"`);
		}
	});

	it("错误回显 schema/data（让模型看到自己传了什么）", () => {
		// 校验失败 + 编译失败 + 互换 + keyword-less 四类错误都应回显收到的 schema/data
		expect(SRC).toContain("Received schema=");
		expect(SRC).toContain("echo(data)");
	});
});
