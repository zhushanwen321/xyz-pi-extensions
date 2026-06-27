import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// typebox 未在 todo devDeps（Pi 运行时提供）；通过 pi-ai 的依赖图定位其虚拟 store 路径，
// 避免硬编码 pnpm store 版本号。tool.ts import "typebox" 用于 TodoParams schema 构造。
function resolveTypeboxFromPiAi(): string {
	const piAiReal = fs.realpathSync(
		path.resolve(__dirname, "./node_modules/@earendil-works/pi-ai"),
	);
	const virtualNodeModules = path.dirname(path.dirname(piAiReal));
	return path.join(virtualNodeModules, "typebox", "build", "index.mjs");
}

export default defineConfig({
	test: {
		include: ["src/__tests__/**/*.test.ts"],
		root: __dirname,
	},
	resolve: {
		alias: {
			"@mariozechner/pi-tui": path.resolve(
				__dirname,
				"./node_modules/@earendil-works/pi-tui/dist/index.js",
			),
			"@mariozechner/pi-ai": path.resolve(
				__dirname,
				"./node_modules/@earendil-works/pi-ai/dist/index.js",
			),
			typebox: resolveTypeboxFromPiAi(),
		},
	},
});
