import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		root: __dirname,
	},
	resolve: {
		// 与 ask-user 一致：把 @mariozechner/* 别名到本地 @earendil-works/* 真实包，
		// 让 vitest（node 解析，不走 tsconfig paths）能 import pi-tui 的真实实现。
		alias: {
			"@mariozechner/pi-tui": path.resolve(
				__dirname,
				"./node_modules/@earendil-works/pi-tui/dist/index.js",
			),
			"@mariozechner/pi-ai": path.resolve(
				__dirname,
				"./node_modules/@earendil-works/pi-ai/dist/index.js",
			),
			"@mariozechner/pi-coding-agent": path.resolve(
				__dirname,
				"../../shared/types/mariozechner/index.ts",
			),
			"@earendil-works/pi-ai": path.resolve(
				__dirname,
				"./node_modules/@earendil-works/pi-ai/dist/index.js",
			),
		},
	},
});
