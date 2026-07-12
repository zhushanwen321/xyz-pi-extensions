---
verdict: pass
must_fix: 0
---

# PR #84 — Type Safety Review

审查范围：`git diff origin/main...HEAD`，64 文件（14 commit），聚焦 4 个扩展的新增 / 变更 `.ts` 源码（不含 `__tests__` 中的测试技巧）。

## Summary

PR 的类型安全质量**很高**，没有发现需要修复的类型问题。主要发现：

- **零显式 `any`**：在所有新增源码中未发现 `: any` / `as any` / `<any>` / `Record<string, any>` / `Promise<any>` 等模式。新增代码完全满足项目 `no-explicit-any: error` 规则。
- **零隐式 `any`**：四个扩展在 `--noImplicitAny --strict` 下均无 TS7006（"parameter implicitly has an 'any' type"）报错。
- **类型完整**：新增纯函数（`parseSubagentRpcCommand` / `parseWorkflowRpcCommand` / `toProtoQuestions` / `protoAnswersToResult` / `buildGui` / `buildGoalGui` / `mapRunStatus` / `mapRunIcon` 等）全部带显式参数和返回值标注；回调参数（`(q: Question)`、`(o: Option)`、`(t: { name: string })` 等）均标注。
- **判别联合 + 类型守卫正确**：`SubagentRpcAction` / `WorkflowRpcAction` 是标准的 tagged union，`commands.ts` 用 `switch (parsed.action)` 收窄后访问 `parsed.runId` / `parsed.verb`，类型完全安全。
- **类型断言整体收敛**：`isLifecycleVerb` 中的 `verb as LifecycleVerb` 是合法的 `ReadonlySet.has` 收窄技巧（`Set<LifecycleVerb>.has` 签名要求参数为 `LifecycleVerb`，这是 TS 的已知限制，非不安全断言），且函数本身是 type guard（`verb is LifecycleVerb`），下游受益于类型收窄。
- **净减少不安全断言**：本 PR 移除了两处 `as unknown as X` 双步断言（`subagent-actions.ts` 的 `details as unknown as SubagentToolResult`、`tool-workflow.ts` 的 `withGui(...) as unknown as WorkflowToolDetails`），通过完善接口字段类型让编译器自然接受。
- **tsc 全绿**：四个扩展 `pnpm typecheck` 均以 exit 0 通过，无类型错误。
- **类型守卫有契约测试兜底**：`isLifecycleVerb` / `parseSubagentRpcCommand` / `parseWorkflowRpcCommand` 有独立 `command-actions.test.ts`（120 行，24 处引用），覆盖三态分支与边界。

测试文件（`__tests__/`）中出现的 `as unknown as ExtensionAPI`（mock 构造）和 `as never`（`RunMock` → `WorkflowRun` 收窄，配合 duck-typing 注释）属于标准测试技巧，且都在测试目录，不计入源码审查。

## Findings

| # | 类别 | 优先级 | 文件 | 说明 |
|---|------|--------|------|------|
| 1 | unsafe-cast | INFO | `extensions/subagent-workflow/src/interface/command-actions.ts:38` | `isLifecycleVerb` 内 `LIFECYCLE_VERBS.has(verb as LifecycleVerb)` —— 这是 `ReadonlySet<LifecycleVerb>.has` 签名与 `string` 入参的已知 TS 限制（`Set<T>.has` 要求 `T` 类型入参），非真正的运行时风险。函数是 type guard `verb is LifecycleVerb`，下游通过 `if (isLifecycleVerb(verb))` 收窄后赋给 `verb: "pause"\|"resume"\|"abort"` 字段类型安全。保留即可，注释已说明意图。 |
| 2 | unsafe-cast | INFO | `extensions/ask-user/src/__tests__/index.test.ts:1620` | `} as unknown as ExtensionAPI` 构造 mock pi 对象。位于 `__tests__`，是测试 fixture 常见做法（mock 只实现 `sendMessage`），不影响生产类型安全。 |
| 3 | unsafe-cast | INFO | `extensions/ask-user/src/__tests__/index.test.ts:1627` | `const runAsParam = (r: RunMock): Parameters<typeof notifyDone>[2] => r as never` —— 测试中用 `as never` 把 duck-typed `RunMock` 收窄到 `WorkflowRun` 入参类型，注释已说明意图（避免每用例重复断言）。位于 `__tests__`，可接受。 |
| 4 | missing-annotation | INFO | （全量扫描） | 无遗漏。所有新增导出函数 / 接口字段 / 回调参数均带类型标注。`StartHandlerResult` 的 `bg` 分支新增 `slug: string`、`SubagentListItem` 新增 `slug` 字段、`TodoDetails._render` 改为 `__gui__?: GuiRenderResult`（类型更精确），覆盖了所有使用点。 |

## 验证命令

| 扩展 | 命令 | 结果 |
|------|------|------|
| subagent-workflow | `pnpm typecheck` (`tsc --noEmit`) | exit 0，无错误 |
| ask-user | `pnpm typecheck` | exit 0，无错误 |
| todo | `pnpm typecheck` | exit 0，无错误 |
| goal | `pnpm typecheck` | exit 0，无错误 |
| 隐式 any | `tsc --noEmit --noImplicitAny --strict` ×4 | 无 TS7006 |
| 显式 any（diff 新增行） | `git diff ... \| grep ': any\|as any\|<any>'` | 0 命中 |

## 结论

`verdict: pass`，`must_fix: 0`。本 PR 在类型安全上是示范级实现：判别联合、类型守卫、显式标注齐全，且净减少了旧代码的不安全断言。所有 INFO 项均为可接受的模式（type guard 收窄技巧 / 测试 fixture），无需改动。
