---
verdict: pass
must_fix: 0
---

## Summary
0 must-fix, 3 suggestions.

This commit adds an optional `ctx?: ExtensionContext` parameter to `GoalExternalInit` and its implementation `initializeGoalFromExternal`, allowing callers to explicitly pass their execution context for state persistence instead of relying on the `lastCtx` captured from goal extension's own event handlers. The change is backward compatible — new param is optional and at the end of the signature. The plumbing in `plan/src/compact.ts` correctly threads `ctx` through to `tryGoalInit`.

## Findings

| 优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向 |
|--------|------|------|------|------|----------|
| SUGGESTION | extensions/coding-workflow/lib/tool-handlers.ts | 503, 524 | backward-compat | `coding-workflow` 定义了独立的 `GoalInitFn` 内联类型 `(objective: string, tasks: string[], budget?) => boolean`，不含 `ctx` 参数。虽然 `ctx` 是 optional 不影响运行时，但类型定义与 canonical `GoalExternalInit`（state.ts:33）分叉，未来维护时容易遗漏同步 | 引用 `@zhushanwen/pi-goal` 的 `GoalExternalInit` 类型（如果是 package 依赖），或至少更新注释指向 canonical type |
| SUGGESTION | extensions/plan/src/__tests__/compact-handler.test.ts | 70-77 | tool-schema | 测试只验证 `__goalInit` 被调用（`toHaveBeenCalled()`），没有验证新参数 `ctx` 被正确传递。`onComplete` 回调中现在调用 `goalInit(objective, tasks, undefined, ctx)`，但 test 的 mock 不检查 args | 补充 `toHaveBeenCalledWith(expect.any(String), expect.any(Array), undefined, ctx)` 断言 |
| INFO | extensions/goal/src/index.ts | 413 | backward-compat | `const persistCtx = ctx ?? lastCtx` 的 fallback 策略正确：显式传入的 `ctx` 优先，未传时回退到 event handler 捕获的 `lastCtx`。这保证了 coding-workflow 等旧调用方（不传 `ctx`）行为不变 | 无需修复 |

## 详细分析

### 向后兼容性 — 通过

`GoalExternalInit` 类型变更是纯增量的：
- 新参数 `ctx?: ExtensionContext` 是 optional
- 放在参数列表末尾
- 既有调用方（coding-workflow line 506, 530；plan compact.ts line 95）不传 `ctx` 时，JS 运行时无影响
- `initializeGoalFromExternal` 实现中 `ctx ?? lastCtx` 保证未传 `ctx` 时行为不变

### 跨扩展 API 契约 — 通过

`pi.__goalInit` 通过 `as unknown as Record<string, unknown>` duck-type 访问，不产生 TypeScript 编译期依赖。plan 和 coding-workflow 各自定义局部 `GoalInitFn` 类型做 cast，契约松耦合。这符合项目架构设计（扩展间通过运行时属性通信，不建 package 依赖）。

### compact 回调中的 ctx 生命周期 — 通过

`onComplete`/`onError` 是 `ctx.compact()` 的回调，在 compact 完成后同步调用。此时 `ctx` 仍引用同一个 `ExtensionContext` 对象（sessionManager 未失效）。这与 goal extension 自身用 `lastCtx`（从 `session_start`/`tool execute` 捕获）是同一模式，已被验证可用。
