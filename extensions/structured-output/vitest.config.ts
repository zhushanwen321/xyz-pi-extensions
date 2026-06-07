import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@mariozechner/pi-coding-agent": path.resolve(__dirname, "../../shared/types/mariozechner/index.ts"),
      "@sinclair/typebox": path.resolve(__dirname, "../workflow/mocks/typebox.ts"),
    },
  },
});
