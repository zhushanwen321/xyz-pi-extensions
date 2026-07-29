/**
 * widget.test.ts — renderPermissionHint（permission 常驻 widget）测试。
 *
 * 覆盖（TC9-TC12）：
 *  - TC9：auto 模式 + 有 model → 含 classifier model 行
 *  - TC10：非 auto 模式（yolo/approve/strict）→ 不含 classifier model
 *  - TC11：rule(s) 单复数（1→rule，0/2/5→rules）
 *  - TC12：返回单行数组（setWidget 契约）+ [pi-permission] 前缀
 */
import { describe, expect, it } from "vitest";

import { renderPermissionHint } from "../widget.js";
import type { PermissionMode } from "../types.js";

describe("TC9：auto 模式 + 有 classifier model → 含 model 行", () => {
	it("auto + model='gpt-4' → 行含 'classifier: gpt-4'", () => {
		const lines = renderPermissionHint({
			mode: "auto",
			userRuleCount: 3,
			classifierModel: "gpt-4",
		});
		expect(lines[0]).toContain("classifier: gpt-4");
	});

	it("auto + model='zhipu/glm-4-flash' → 行含完整 provider/model", () => {
		const lines = renderPermissionHint({
			mode: "auto",
			userRuleCount: 0,
			classifierModel: "zhipu/glm-4-flash",
		});
		expect(lines[0]).toContain("classifier: zhipu/glm-4-flash");
	});
});

describe("TC10：非 auto 模式 → 不含 classifier model", () => {
	const NON_AUTO: PermissionMode[] = ["yolo", "approve", "strict"];
	for (const mode of NON_AUTO) {
		it(`${mode} 模式即使有 model 也不显示 classifier`, () => {
			const lines = renderPermissionHint({
				mode,
				userRuleCount: 2,
				classifierModel: "gpt-4",
			});
			expect(lines[0]).not.toContain("classifier");
		});
	}

	it("auto 模式但 model 为空 → 不显示 classifier", () => {
		const lines = renderPermissionHint({
			mode: "auto",
			userRuleCount: 1,
			classifierModel: "",
		});
		expect(lines[0]).not.toContain("classifier");
	});
});

describe("TC11：rule(s) 单复数", () => {
	it("userRuleCount=1 → 'rule'（单数）", () => {
		const lines = renderPermissionHint({
			mode: "strict",
			userRuleCount: 1,
			classifierModel: "gpt-4",
		});
		expect(lines[0]).toContain("1 user rule");
		expect(lines[0]).not.toContain("1 user rules");
	});

	it("userRuleCount=0 → 'rules'（复数）", () => {
		const lines = renderPermissionHint({
			mode: "yolo",
			userRuleCount: 0,
			classifierModel: "",
		});
		expect(lines[0]).toContain("0 user rules");
	});

	it("userRuleCount=2 → 'rules'（复数）", () => {
		const lines = renderPermissionHint({
			mode: "approve",
			userRuleCount: 2,
			classifierModel: "",
		});
		expect(lines[0]).toContain("2 user rules");
	});

	it("userRuleCount=5 → 'rules'（复数）", () => {
		const lines = renderPermissionHint({
			mode: "auto",
			userRuleCount: 5,
			classifierModel: "gpt-4",
		});
		expect(lines[0]).toContain("5 user rules");
	});
});

describe("TC12：返回单行数组 + [pi-permission] 前缀（setWidget 契约）", () => {
	it("返回长度为 1 的数组", () => {
		const lines = renderPermissionHint({
			mode: "auto",
			userRuleCount: 1,
			classifierModel: "gpt-4",
		});
		expect(Array.isArray(lines)).toBe(true);
		expect(lines).toHaveLength(1);
	});

	it("行含 [pi-permission] 前缀（grep 友好）", () => {
		const lines = renderPermissionHint({
			mode: "strict",
			userRuleCount: 0,
			classifierModel: "",
		});
		expect(lines[0]).toContain("[pi-permission]");
	});

	it("纯函数：相同输入 → 相同输出（确定性）", () => {
		const input = { mode: "auto" as const, userRuleCount: 3, classifierModel: "gpt-4" };
		const a = renderPermissionHint(input);
		const b = renderPermissionHint(input);
		expect(a).toEqual(b);
	});
});
