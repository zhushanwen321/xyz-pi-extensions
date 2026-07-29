/**
 * IT 系列：rules/index.ts barrel 导出验证。
 *
 * 确保公开 API surface 完整，调用方可从 "./rules/index.js" 一处 import。
 */
import { describe, expect, it } from "vitest";

import * as rulesApi from "../index.js";

describe("IT: rules barrel 导出", () => {
	it("导出所有公开函数", () => {
		expect(typeof rulesApi.matchRules).toBe("function");
		expect(typeof rulesApi.matchRulesForArgv).toBe("function");
		expect(typeof rulesApi.resolvePattern).toBe("function");
		expect(typeof rulesApi.getDefaultRules).toBe("function");
		expect(typeof rulesApi.isKnownSafeCommand).toBe("function");
		expect(typeof rulesApi.findGitSubcommand).toBe("function");
		expect(typeof rulesApi.wildcardToRegExp).toBe("function");
	});

	it("导出常量数据（BUILTIN_DANGER_RULES / BUILTIN_UNCONDITIONAL_SAFE）", () => {
		expect(Array.isArray(rulesApi.BUILTIN_DANGER_RULES)).toBe(true);
		expect(rulesApi.BUILTIN_DANGER_RULES.length).toBe(12);
		expect(rulesApi.BUILTIN_UNCONDITIONAL_SAFE.size).toBe(50);
	});
});
