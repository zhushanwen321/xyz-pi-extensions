import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Vitest config for coding-workflow.
 *
 * 同时覆盖三处测试：
 * - lib/gates/__tests__: gate 契约测试（ReviewGate / TestFixLoopGate 对 D-8 reason 的消费）
 * - src/__tests__:       test-orchestrator 单测（状态机 + 机器重算 status）
 * - src/cw/__tests__:    CW 重构（Wave 0+）—— types/store/... 的 real+mock 测试
 *
 * External Pi SDK packages aliased to shared stubs/mocks so vitest resolves them
 * without the real packages installed. Mirrors extensions/todo/vitest.config.ts。
 */
export default defineConfig({
  test: {
    include: [
      "src/__tests__/**/*.test.ts",
      "src/cw/__tests__/**/*.test.ts",
      "src/cw/actions/__tests__/**/*.test.ts",
      "lib/gates/__tests__/**/*.test.ts",
    ],
    root: __dirname,
  },
  resolve: {
    alias: {
      // 测试用最小 mock（runtime 不用真实 SDK，GateContext.pi 由测试注入 fake）
      "@mariozechner/pi-coding-agent": path.resolve(__dirname, "mocks/pi-coding-agent.ts"),
      "@earendil-works/pi-ai": path.resolve(
        __dirname,
        "./node_modules/@earendil-works/pi-ai/dist/index.js",
      ),
      // typebox 未在 devDeps（Pi 运行时提供）；通过 pi-ai 依赖图定位虚拟 store 路径。
      // /value 子路径必须排在 @sinclair/typebox 之前（前缀匹配优先），指向同一 1.1.38 typebox
      // 的 value 子模块——否则 Type（main）与 Value（/value）会跨版本不一致。
      "@sinclair/typebox/value": path.join(
        path.dirname(resolveTypeboxFromPiAi()),
        "value",
        "index.mjs",
      ),
      "@sinclair/typebox": resolveTypeboxFromPiAi(),
      typebox: resolveTypeboxFromPiAi(),
    },
  },
});

// typebox 未在 devDeps（Pi 运行时提供）；通过 pi-ai 的依赖图定位其虚拟 store 路径，
// 避免硬编码 pnpm store 版本号。
function resolveTypeboxFromPiAi(): string {
  const piAiReal = fs.realpathSync(
    path.resolve(__dirname, "./node_modules/@earendil-works/pi-ai"),
  );
  const virtualNodeModules = path.dirname(path.dirname(piAiReal));
  return path.join(virtualNodeModules, "typebox", "build", "index.mjs");
}
