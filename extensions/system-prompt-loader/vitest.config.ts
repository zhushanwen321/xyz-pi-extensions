import { defineConfig } from "vitest/config";

/**
 * vitest 配置（与兄弟扩展 model-switch 对齐）。
 * 测试从 tests/ 导入 ../src/*.ts；Pi SDK 经骨架 node_modules 软链解析为真实类型。
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
