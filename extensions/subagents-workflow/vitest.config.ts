import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Vitest config for @zhushanwen/pi-subagents-workflow.
 *
 * External Pi SDK packages are aliased to inline mocks or shared type stubs
 * so that vitest's module resolution succeeds without the real packages installed.
 */
export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@mariozechner/pi-coding-agent": path.resolve(__dirname, "mocks/pi-coding-agent.ts"),
      "@mariozechner/pi-ai": path.resolve(__dirname, "mocks/pi-ai.ts"),
      "@mariozechner/pi-tui": path.resolve(__dirname, "mocks/pi-tui.ts"),
      "@earendil-works/pi-tui": path.resolve(__dirname, "mocks/pi-tui.ts"),
      "@earendil-works/pi-ai": path.resolve(__dirname, "mocks/pi-ai.ts"),
      "@earendil-works/pi-coding-agent": path.resolve(__dirname, "../../shared/types/mariozechner/index.d.ts"),
      "typebox": path.resolve(__dirname, "mocks/typebox.ts"),
      "@sinclair/typebox": path.resolve(__dirname, "mocks/typebox.ts"),
      "@zhushanwen/pi-structured-output": path.resolve(__dirname, "../structured-output/src/index.ts"),
    },
  },
});
