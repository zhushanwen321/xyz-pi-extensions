import { defineConfig } from "vitest/config";
import path from "node:path";

const workspaceRoot = path.resolve(__dirname, "../../");

export default defineConfig({
	test: {
		include: ["src/__tests__/**/*.test.ts"],
	},
	resolve: {
		alias: {
			"@earendil-works/pi-coding-agent": path.resolve(
				workspaceRoot,
				"shared/types/earendil-works/index",
			),
		},
	},
	// cache.ts uses ESM syntax but package has no "type: module"
	// vitest transform handles this via esbuild
	build: {
		target: "es2022",
	},
	esbuild: {
		target: "es2022",
	},
});
