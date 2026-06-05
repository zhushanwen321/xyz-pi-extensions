import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/__tests__/**/*.test.ts"],
		root: __dirname,
	},
	resolve: {
		alias: {
			"@zhushanwen/pi-quota-providers": path.resolve(
				__dirname,
				"../../shared/quota-providers/src/index.ts",
			),
		},
	},
});
