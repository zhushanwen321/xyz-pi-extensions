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
      // plan 仅用 import type 引用 pi-coding-agent（运行时擦除），指向 .d.ts 桩即可
      "@mariozechner/pi-coding-agent": path.resolve(dir, "../../shared/types/mariozechner/index.d.ts"),
      // 测试环境用本地 mock，真实类型由 Pi 运行时提供（与 pending-notifacts 等包约定一致）
      "@mariozechner/pi-tui": path.resolve(dir, "mocks/pi-tui.ts"),
      "@mariozechner/pi-ai": path.resolve(dir, "mocks/pi-ai.ts"),
      "typebox": path.resolve(dir, "mocks/typebox.ts"),
    },
  },
});
