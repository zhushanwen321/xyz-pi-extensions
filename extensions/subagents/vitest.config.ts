import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Vitest config for src/__tests__/ directory.
 *
 * External Pi SDK packages are aliased to shared/types stubs or inline mocks
 * so that vitest's module resolution succeeds without the real packages installed.
 */
export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@mariozechner/pi-coding-agent": path.resolve(__dirname, "mocks/pi-coding-agent.ts"),
      "@mariozechner/pi-ai": path.resolve(__dirname, "mocks/pi-ai.ts"),
      "@mariozechner/pi-tui": path.resolve(__dirname, "mocks/pi-tui.ts"),
      "@earendil-works/pi-tui": path.resolve(__dirname, "mocks/pi-tui.ts"),
      "@earendil-works/pi-ai": path.resolve(__dirname, "mocks/pi-ai.ts"),
      "@earendil-works/pi-coding-agent": path.resolve(__dirname, "../../shared/types/mariozechner/index.ts"),
      "typebox": path.resolve(__dirname, "mocks/typebox.ts"),
      "@sinclair/typebox": path.resolve(__dirname, "mocks/typebox.ts"),
    },
  },
});
