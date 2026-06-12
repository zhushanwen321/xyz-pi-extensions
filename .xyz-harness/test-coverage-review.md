---
verdict: fail
must_fix: 3
---

## Summary

3 must-fix, 2 suggestions. The `ctx` parameter change touches a cross-extension API contract (`__goalInit`) but neither the goal extension (zero tests) nor the plan extension tests verify the new argument is correctly threaded.

## Findings

| 优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向 |
|--------|------|------|------|------|----------|
| MUST_FIX | `extensions/goal/` | — | missing-test | Goal 扩展完全没有测试：无 `src/__tests__/` 目录、无 `vitest.config.ts`、package.json 无 `test` script。`initializeGoalFromExternal` 是跨扩展 API 入口（`pi.__goalInit`），本次变更修改了其签名和持久化逻辑，但无任何测试覆盖 | 1) 添加 `vitest.config.ts`（参考 plan/`vitest.config.ts` 的 alias 配置）；2) package.json 添加 `"test": "vitest run"` + vitest devDep；3) 创建 `src/__tests__/state.test.ts` 和 `src/__tests__/external-init.test.ts` |
| MUST_FIX | `extensions/goal/src/index.ts` | 394–417 | missing-test | `initializeGoalFromExternal` 新增 `ctx` 参数和 `ctx ?? lastCtx` 回退逻辑，无测试验证：(a) `ctx` 显式传入时使用 `ctx`；(b) `ctx` 为 undefined 时回退到 `lastCtx`；(c) 两者都为 undefined 时跳过持久化 | 在新测试文件中 mock `persistGoalState`，分别传入 `ctx`、`undefined`（有 `lastCtx`）、`undefined`（无 `lastCtx`），验证调用行为 |
| MUST_FIX | `extensions/plan/src/__tests__/compact-handler.test.ts` | 61–73 | edge-case | 测试 `compact isolation` 只断言 `__goalInit` 被调用（`toHaveBeenCalled()`），未验证 `ctx` 作为第 4 个参数传入。即使 `ctx` 传递逻辑被删除，测试仍然通过 | 将断言改为 `toHaveBeenCalledWith(expect.any(String), expect.any(Array), undefined, ctx)` 以验证参数正确传递 |
| SUGGESTION | `extensions/plan/src/compact.ts` | 78–95 | missing-test | `tryGoalInit` 是 private 函数，仅通过 `handlePlanComplete` 间接测试。无测试覆盖：(a) plan 文件无步骤时返回 `false`；(b) `readFileSync` 抛异常时 catch 返回 `false`；(c) `__goalInit` 不存在时 catch 返回 `false` | 添加独立的 `tryGoalInit` 单元测试（考虑 export 为测试用，或通过 `handlePlanComplete` + mock fs 增强覆盖） |
| SUGGESTION | `extensions/plan/src/__tests__/compact-handler.test.ts` | 61–73 | edge-case | `compact onError` 路径也调用了 `tryGoalInit(pi, planFilePath, ctx)`，但测试未验证 `__goalInit` 在 onError 中被调用 | 补充 onError 路径中 `__goalInit` 调用断言 |
