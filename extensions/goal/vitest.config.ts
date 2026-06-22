import path from "node:path";

import { defineConfig } from "vitest/config";

const piStub = path.resolve(__dirname, "src/__tests__/stubs/pi-sdk.ts");
const typeboxStub = path.resolve(__dirname, "src/__tests__/stubs/typebox.ts");

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
	},
	resolve: {
		alias: {
			"@mariozechner/pi-coding-agent": piStub,
			"@earendil-works/pi-ai": piStub,
			"@earendil-works/pi-tui": piStub,
			"@mariozechner/pi-ai": piStub,
			"@sinclair/typebox": typeboxStub,
			"typebox": typeboxStub,
		},
	},
});
