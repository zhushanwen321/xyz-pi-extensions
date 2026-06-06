import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    root: __dirname,
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
