import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Vitest config for src/__tests__/ directory.
 *
 * External Pi SDK packages are aliased to shared/types stubs or inline mocks
 * so that vitest's module resolution succeeds without the real packages installed.
 */
export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    // 瞬时失败重试 2 次。针对 git worktree / 文件系统操作在全量并行时的锁竞态
    // flakiness（run-agent.test.ts V3 worktree 测试）。确定性测试不受影响（一次通过）。
    retry: 2,
  },
  resolve: {
    alias: {
      "@mariozechner/pi-coding-agent": path.resolve(__dirname, "../../shared/types/mariozechner/index.ts"),
      "@mariozechner/pi-ai": path.resolve(__dirname, "mocks/pi-ai.ts"),
      "@mariozechner/pi-tui": path.resolve(__dirname, "mocks/pi-tui.ts"),
      "@earendil-works/pi-tui": path.resolve(__dirname, "mocks/pi-tui.ts"),
      "@earendil-works/pi-ai": path.resolve(__dirname, "mocks/pi-ai.ts"),
      "@earendil-works/pi-coding-agent": path.resolve(__dirname, "../../shared/types/mariozechner/index.ts"),
      "typebox": path.resolve(__dirname, "mocks/typebox.ts"),
      "@sinclair/typebox": path.resolve(__dirname, "mocks/typebox.ts"),
    },
  },
});
