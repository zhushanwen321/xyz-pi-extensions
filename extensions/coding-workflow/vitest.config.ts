import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Vitest config for coding-workflow gate unit tests.
 *
 * External Pi SDK packages aliased to shared stubs/mocks so vitest resolves them
 * without the real packages installed. Mirrors extensions/workflow/vitest.config.ts.
 */
export default defineConfig({
  test: {
    include: ["lib/**/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@mariozechner/pi-coding-agent": path.resolve(__dirname, "mocks/pi-coding-agent.ts"),
    },
  },
});
