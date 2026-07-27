import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
	},
	resolve: {
		// Vite 自身能解析 .js → .ts，不需要 alias（相对 import ../types.js 直接解析到 ../types.ts）
	},
});
