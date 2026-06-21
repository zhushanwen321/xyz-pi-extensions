---
verdict: APPROVE_WITH_MINOR_FIX
must_fix: true
review_date: 2026-06-20
branch: feat-subagent-workflow-enhance
base: main
scope: "extensions/subagents/src/**/*.ts, extensions/workflow/src/**/*.ts, shared/types/mariozechner/index.d.ts, shared/taste-lint/**, 其余 extensions 的 .ts 变更"
tsc_result: "0 errors (npx tsc --noEmit)"
eslint_explicit_any: "0 errors (规则已从 warn 升级为 error)"
eslint_no_unsafe_cast: "8 warnings across 4 prod files（规则为 warn，不阻断）"
---

# 类型安全审查报告 — feat-subagent-workflow-enhance (PR #66)

## Summary

整体类型质量**高**，显著优于历史水平。三个亮点：

1. **类型桩精确化**（`shared/types/mariozechner/index.d.ts` +143 行）：将 `ExtensionAPI`、
   `SessionStartEvent`、`ExtensionHandler<E,R>`、`ExtensionContext` 从 `any` 升级为精确结构，
   使 CI 能在编译期捕获「session_start handler 单参数」这类历史 bug。已逐字段核对真实 SDK
   (`node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`)，**完全一致**：
   - `ExtensionHandler<E, R> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void` ✅
   - `SessionStartEvent` 仅含 `type/reason/previousSessionFile`，无 `modelRegistry/cwd/ui` ✅
   - `ExtensionContext` 含 `modelRegistry/cwd/ui/sessionManager/model` ✅
   - `ExtensionAPI.on` 的 `session_start`/`resources_discover` 重载签名 ✅

2. **新增品味规则 `taste/no-unsafe-cast`**（`shared/taste-lint/rules/no-unsafe-cast.mjs`）：
   检测 4 种 type-erasing cast（`as never` / `as any` / `as unknown as T` / 全可选结构断言），
   含完整 RuleTester 覆盖（含 `optional` vs `questionToken` 的 Round 1 MF#3 边界修复）。`no-explicit-any`
   同步从 `warn` 升级为 `error`，与 CLAUDE.md / quality-gates.md 文档一致。

3. **`as unknown as GoalTask` 双重断言清除**（`extensions/goal/src/state.ts`）：deserializeState
   改为逐字段 cast（`t.id as number` 等），移除了 `as unknown as GoalTask`——正是新规则要抓的反模式。

**`npx tsc --noEmit` = 0 errors**，独立确认（非依赖 pre-commit）。

## Findings

| # | 类别 | 文件:行 | 严重度 | 说明 |
|---|------|---------|--------|------|
| MF#1 | unsafe-cast | `extensions/subagents/src/tools/subagent-tool.ts:207,239,245` | **must_fix（低风险）** | 3 处 `{ content, details } as unknown as void`。根因：本地类型别名 `SubagentExecuteCb` 返回类型声明为 `Promise<void>`（line 49），但实现实际返回 `AgentToolResult<SubagentToolDetails>`。SDK 真实签名是 `execute(...): Promise<AgentToolResult<TDetails>>`，别名撒谎，迫使 3 处双重断言。**本 PR 自己引入的 `taste/no-unsafe-cast` 规则正抓这 3 处**。修复已验证（见下）。 |
| S#1 | unsafe-cast | `extensions/subagents/src/tools/subagent-tool.ts:98` | suggestion | `args as { model?: unknown; thinkingLevel?: unknown }` 结构断言到全可选类型。后续有逐字段 `typeof === "string"` 运行时 guard，实际安全，但规则会 warn。可提取类型守卫 `isModelOverride(args)` 消除 warning。 |
| I#1 | unsafe-cast | `extensions/subagents/src/runtime/model-config-service.ts:246`、`subagent-service.ts:532` | info（可接受） | `globalThis as unknown as Record<symbol, unknown>`。`globalThis` 不允许 symbol 索引，此为标准 escape hatch；有运行时初始化 guard（`if (!record[KEY]) record[KEY] = { current: null }`）+ 详细注释。进程单例模式，idiomatic。 |
| I#2 | unsafe-cast | `extensions/subagents/src/core/session-factory.ts:171` | info（可接受） | `mod as unknown as SdkLike`。ESM 动态 import 返回完整模块类型，与手写鸭子类型 `SdkLike`（最小子集）结构不兼容。已加 `eslint-disable-next-line taste/no-unsafe-cast` + 注释说明 + `sdk-contract.test.ts` 契约测试兜底。符合规范。 |
| I#3 | unsafe-cast | `extensions/unified-hooks/src/hooks/tool-error-handler.ts:30` | info（可接受） | `event as ToolExecutionEndLikeEvent`（从 `unknown` 单次断言到含必填字段的接口）。非双重断言、非全可选结构，规则不报。SDK 事件为 `any`，此处显式声明最小子集接口是合理窄化。可后续用类型守卫强化。 |
| — | explicit-any | 全量生产代码 | **0 处** | `: any` / `as any` / `<any>` / `Record<string,any>` / `Promise<any>` 在生产 .ts 中 0 命中。仅存在于 `.d.ts` stub（eslint ignore）和 `__tests__/`/`mocks/`（测试 fixture，允许）。 |
| — | implicit-any | 全量 | **0 处** | `strict: true` + `noImplicitReturns: true` 已开，tsc 通过即证明回调参数（`.map((m) => ...)` 等）均由上下文正确推断，无 TS7006。 |
| — | tsc-error | 全量 | **0 errors** | `npx tsc --noEmit` exit 0。 |
| — | missing-annotation | 全量 | **0 处** | 抽查 subagents/workflow 新文件，函数参数/返回值均有标注；`AgentCallContext`、`ErrorHandlerContext`、`BudgetCallbacks`、`HookContext`、`SdkLike`、`SubagentToolDetails`、`QueryResult` 等接口完备。 |
| — | SDK 契约 | `extensions/subagents/src/index.ts:66`、`extensions/todo/src/handlers.ts:169-182`、`extensions/unified-hooks/.../tool-error-handler.ts:29` | **通过** | 所有 `pi.on("session_start", ...)` 及其他事件 handler 均为 `(event, ctx)` 两参数签名，从 `ctx`（非 `event`）读取 `modelRegistry/cwd/ui`。编译期由精确 stub 强制，`sdk-contract.test.ts` 补充运行时断言。 |

## MF#1 修复方案（已验证）

**问题**：`SubagentExecuteCb` 返回类型应为 `Promise<AgentToolResult<SubagentToolDetails>>`，错写为 `Promise<void>`。

**修复**（4 行，已临时应用并通过 `tsc --noEmit` = 0 errors，已还原）：

```diff
--- a/extensions/subagents/src/tools/subagent-tool.ts
+++ b/extensions/subagents/src/tools/subagent-tool.ts
@@ ctx?: ExtensionContext,
-) => Promise<void>;
+) => Promise<AgentToolResult<SubagentToolDetails>>;

@@ return { content, details: result } as unknown as void;
-return { content, details: result } as unknown as void;
+return { content, details: result };

@@       details: handle.details } as unknown as void;
+      details: handle.details };
@@   details: handle.details } as unknown as void;
+  details: handle.details };
```

**为什么 must_fix**：本 PR 引入 `taste/no-unsafe-cast` 规则，但 PR 自己的代码在单个文件内触发该规则 3 次，且根因是一个错误的类型别名（非不可避免）。修复是 4 行、零运行时行为变化、tsc 验证通过。合并前修掉，避免「上线第一天自己的规则就在自己的代码上报 warning」。

`QueryResult`（poll 路径的 `result`）是 `SubagentToolDetails` 的结构超集（多出 `id/startedAt/endedAt/mode`），结构兼容，无需额外 cast。

## 不在 must_fix 范围的观察

- `taste/no-silent-catch` 在 `session-factory.ts:243`、`subagent-tool.ts:138` 各 1 处 warning。属于错误处理品味，非类型安全，本审查不展开。
- `extensions/workflow/src/infra/execution-trace.ts` 删除了 `loadTrace`/`updateNodeStatus`/`getTraceSummary` 等死代码，顺带消除了一处 `(entry as CustomEntry)` cast——净正向。
- `extensions/workflow/src/engine/model-resolver.ts` 简化为纯函数，移除了动态 import + 模块级可变 `_resolveModelForScene`（本身就是类型/状态气味）——净正向。

## 结论

**APPROVE_WITH_MINOR_FIX**。修掉 MF#1（4 行）即可合并。类型基础设施（精确 stub + no-unsafe-cast 规则 + 契约测试）是本 PR 的类型安全净收益，质量扎实。

---

### 审查执行记录
- `git diff main...HEAD --stat`（174 文件，+28234/-788）
- `npx tsc --noEmit` → exit 0
- `npx eslint` on 4 生产文件 → 0 errors, 8 warnings（全为 no-unsafe-cast / no-silent-catch）
- 真实 SDK 对照：`/private/tmp/npm-pack-test/subagents/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`
- MF#1 修复验证：临时应用 + tsc 通过 + 还原
