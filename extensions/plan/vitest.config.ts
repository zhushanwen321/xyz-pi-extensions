import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@mariozechner/pi-coding-agent": path.resolve(dir, "../../shared/types/mariozechner/index.ts"),
      "@mariozechner/pi-tui": path.resolve(dir, "../workflow/mocks/pi-tui.ts"),
      "@mariozechner/pi-ai": path.resolve(dir, "../workflow/mocks/pi-ai.ts"),
      "typebox": path.resolve(dir, "../workflow/mocks/typebox.ts"),
    },
  },
});
