import { defineConfig } from "vitest/config";

// Round 1 MF#3: taste-lint 规则是 .mjs（ESM），测试用 RuleTester（eslint 内置）。
// include 限定 __tests__ 下的 .test.mjs，与 extensions/* 的 .test.ts 约定区分。
export default defineConfig({
	test: {
		include: ["__tests__/**/*.test.mjs"],
	},
	esbuild: {
		target: "es2022",
	},
});
