import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    root: __dirname,
  },
  resolve: {
    extensions: [".ts", ".js", ".json"],
    alias: {
      // Pi 运行时模块在 vitest 环境不可用，用最小 stub 让被测模块加载不报错。
      // 状态机测试只测 canTransition 等纯函数，不依赖 Type/StringEnum 运行时校验。
      "@mariozechner/pi-ai": path.resolve(
        __dirname,
        "src/__tests__/stubs/pi-ai.ts",
      ),
      typebox: path.resolve(__dirname, "src/__tests__/stubs/typebox.ts"),
    },
  },
});
