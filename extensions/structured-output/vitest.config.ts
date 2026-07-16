import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // structured-output 不直接 import pi-coding-agent（SDK 以 any 注入），指向 .d.ts 桩即可
      "@mariozechner/pi-coding-agent": path.resolve(__dirname, "../../shared/types/mariozechner/index.d.ts"),
      // 测试环境用本地 mock，真实类型由 Pi 运行时提供
      "@sinclair/typebox": path.resolve(__dirname, "mocks/typebox.ts"),
    },
  },
});
