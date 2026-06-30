# 测试策略

> **always-current**。记录**测试策略**（金字塔 / 边界 / 门禁 / 约定），非每次的 test-matrix 堆叠。
> 每次 ⑥的 test-matrix 留在 `.xyz-harness/{主题}/`；design-closeout 只把「不可回退基线」沉淀到此。
> 命名刻意区分 TEST-STRATEGY（策略）vs per-topic test-matrix（用例）。

## 测试金字塔与边界

- **单元测试**：纯格式化 / 计算逻辑从 `index.ts` 提取到独立模块（`format.ts` / `speed.ts`），不依赖 Pi 运行时
- **集成测试**：Pi 运行时类型通过 `PlainPallet` / `plainThemeFg` 等无 ANSI 替代品绕过
- **SDK 契约测试**：凡调用 `pi.on()` / `registerTool()` / 读 `ctx.*` 的代码须有契约测试（模板：`extensions/subagents/src/__tests__/sdk-contract.test.ts`）

## 覆盖率门禁

- 框架：vitest（`^4.1.8`），禁止 `node:test`
- 测试文件：`src/__tests__/*.test.ts`，每个有测试的包需 `vitest.config.ts`
- pre-commit 按需触发：仅 staged 文件涉及的包有 `src/__tests__/` 时运行

## Mock 与测试数据约定

- 测试只 import 被测模块的导出函数，不 import Pi SDK
- vitest.config.ts alias：`extensions/*` 映射 `@zhushanwen/pi-quota-providers`；`shared/*` 映射 `@mariozechner/*` types stub

## 不可回退基线（Regression Baseline）

> design-closeout 从 ⑥验收清单提炼：破坏即事故的用例。每条标溯源。
> 与 NFR.md「验证」字段双向引用。

### {待沉淀 RB-N}  [from: {topic}]

- **用例来源**：⑥验收清单 {ID}
- **断言**：{一句话}
- **破坏即**：{事故级别}
- **关联约束**：NFR {S-N / C-N / ...}
