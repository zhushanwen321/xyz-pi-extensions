import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
	test: {
		include: ["src/__tests__/**/*.test.ts"],
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
