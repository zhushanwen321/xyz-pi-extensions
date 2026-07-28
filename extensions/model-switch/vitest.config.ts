import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@zhushanwen/pi-quota-providers": path.resolve(
        __dirname,
        "../../shared/quota-providers/src/index.ts",
      ),
      "@earendil-works/pi-coding-agent": path.resolve(
        __dirname,
        "../../shared/types/earendil-works/index.ts",
      ),
    },
  },
});
