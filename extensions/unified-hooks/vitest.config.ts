import path from "node:path";

import { defineConfig } from "vitest/config";

const workspaceRoot = path.resolve(__dirname, "../../");

/**
 * Vitest config for src/__tests__/ directory.
 *
 * External Pi SDK packages are aliased to shared/types stubs so that vitest's
 * module resolution succeeds without the real packages installed.
 */
export default defineConfig({
	test: {
		include: ["src/__tests__/**/*.test.ts"],
	},
	resolve: {
		alias: {
			"@mariozechner/pi-coding-agent": path.resolve(
				workspaceRoot,
				"shared/types/mariozechner/index",
			),
		},
	},
});
