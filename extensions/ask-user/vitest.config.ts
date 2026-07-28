import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	test: {
		include: ["src/__tests__/**/*.test.ts"],
		root: __dirname,
	},
	resolve: {
		alias: {
			"@earendil-works/pi-tui": path.resolve(
				__dirname,
				"./node_modules/@earendil-works/pi-tui/dist/index.js",
			),
			"@earendil-works/pi-coding-agent": path.resolve(
				__dirname,
				"../../shared/types/earendil-works/index.ts",
			),
		},
	},
});
