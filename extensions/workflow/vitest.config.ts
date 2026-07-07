import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Vitest config for src/**\/__tests__/**\/*.test.ts.
 *
 * External Pi SDK packages are aliased to shared/types stubs or inline mocks
 * so that vitest's module resolution succeeds without the real packages installed.
 */
export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    // config-loader 模块级缓存在并发文件间不安全（E3 real 测试扫真实全局目录，
    // 与 registry-impl 测试的临时目录并发时缓存互相污染）。串行执行避免竞态。
    fileParallelism: false,
  },
  resolve: {
    alias: {
      // Pi SDK packages → mock modules (vitest will use vi.mock for actual logic)
      "@mariozechner/pi-coding-agent": path.resolve(__dirname, "../../shared/types/mariozechner/index.ts"),
      "@mariozechner/pi-ai": path.resolve(__dirname, "mocks/pi-ai.ts"),
      "@mariozechner/pi-tui": path.resolve(__dirname, "mocks/pi-tui.ts"),
      "@earendil-works/pi-tui": path.resolve(__dirname, "mocks/pi-tui.ts"),
      "@earendil-works/pi-ai": path.resolve(__dirname, "mocks/pi-ai.ts"),
      "@earendil-works/pi-coding-agent": path.resolve(__dirname, "../../shared/types/mariozechner/index.ts"),
      "typebox": path.resolve(__dirname, "mocks/typebox.ts"),
    },
  },
});
