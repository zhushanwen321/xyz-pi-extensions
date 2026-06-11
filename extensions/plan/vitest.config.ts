import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@mariozechner/pi-coding-agent": path.resolve(
        __dirname,
        "../../shared/types/mariozechner/index",
      ),
    },
  },
});
