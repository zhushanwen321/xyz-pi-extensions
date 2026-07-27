import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/__tests__/**/*.test.ts"],
	},
	resolve: {
		alias: {
			// 本地 src 直接解析
			find: /^\.\/(.+)\.js$/,
			replace: "./$1.ts",
		},
	},
});
