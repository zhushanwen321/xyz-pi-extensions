---
verdict: pass
must_fix: 0
---

## Summary

0 must-fix, 3 suggestions, 5 infos.

`pnpm -r typecheck` 全量通过（ask-user / subagent-workflow / todo / goal 四个 extension 均 Done，GLOBAL_EXIT=0），无任何 TS 错误。`pnpm -r lint` 也通过（EXIT=0）。

逐项检查结果：
- **explicit-any**：本次新增代码 0 处。grep `: any` / `as any` / `<any>` / `Record<string, any>` 在所有新增行中无命中。
- **implicit-any**：`tsconfig.json` 开启 `strict: true`（含 `noImplicitAny`），tsc 通过即证明无隐式 any。所有新增函数（`toProtoQuestions` / `protoAnswersToResult` / `runRpcInteraction` / `buildGui` / `buildGoalGui` / `toGuiCtx` / `mapRunStatus` / `mapRunIcon` / `buildScriptGui` / `withScriptGui`）参数与返回值均有显式标注。
- **missing-annotation**：0 处。回调参数（如 `questions.map((q: Question) => ...)`、`todos.map((t) => ...)` 由上下文推断）均有类型来源。
- **unsafe-cast**：本次新增 2 处 `no-unsafe-cast` warn（见下），均有结构性原因且无更优替代，定级 SUGGESTION。其余 6 处 warn 均为 pre-existing（main 分支已存在，本次仅行号位移）。
- **tsc-error**：0 处。

结论：类型安全层面**通过**。新增断言均有合理的结构性约束（discriminated union 加 `__gui__` 字段需双重断言；`unknown` 入参收窄到全可选形状）。建议项不阻断合并。

## Findings

| 优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向 |
|--------|------|------|------|------|----------|
| SUGGESTION | extensions/subagent-workflow/src/interface/tool-workflow-script.ts | 100-106 | unsafe-cast | `withScriptGui` 用 `{ ...details, __gui__: ... } as unknown as WorkflowScriptToolDetails` 双重断言把 `__gui__` 加回 discriminated union。`taste/no-unsafe-cast` 已 warn（line 102）。原因正当：`WorkflowScriptToolDetails` 是 5 成员的 discriminated union，TS 不允许在 union 字面量上直接加额外字段，双重断言是惯用法（与 tool-workflow.ts:280 的 `withGui` 同构）。 | 可选改进：把 `TextContent.details` 类型从 `WorkflowScriptToolDetails \| undefined` 改成 `(WorkflowScriptToolDetails & { __gui__?: GuiRenderResult }) \| undefined`，让 `__gui__` 成为合法可选字段，消除双重断言。但需同步改 tool-workflow.ts 的 `withGui`，跨文件一致性改动较大，当前实现可接受。 |
| SUGGESTION | extensions/subagent-workflow/src/interface/tool-render.ts | 103 | unsafe-cast | `(startParam as { slug?: unknown }).slug` 结构断言到全可选形状。`taste/no-unsafe-cast` 已 warn（structuralCast）。本行是 renderCall 渲染路径从 `unknown` args 提取 slug 用于显示。紧邻的 line 98（startParam 提取）和 line 126（task 提取）是 pre-existing 同模式。 | 已有运行时 guard 兜底：line 105 `typeof slug === "string" ? slug.trim() : ""` 做类型收窄，非字符串回落空串。结构断言 + typeof guard 是处理 `unknown` args 的合规模式，无需改动。仅记录与 pre-existing 模式的一致性。 |
| SUGGESTION | extensions/ask-user/src/index.ts | 137-141 | unsafe-cast | `runRpcInteraction` 构造 `guiCtx = { mode: ctx.mode, hasUI: ctx.hasUI, ui: { select: ctx.ui.select.bind(ctx.ui) } }`，未显式标注类型即传入 `askUserInteract(guiCtx, ...)`。对象字面量经结构推断被 `askUserInteract(ctx: GuiContext, ...)` 收窄，tsc 通过。注释说明了 `ExtensionContext.ui.custom` 泛型签名与协议 `GuiContext.ui.custom` 不兼容（TS2345），故构造最小子集。 | 实现正确，与 `toGuiCtx` 同构思路（最小子集规避签名冲突）。可选：把 `guiCtx` 显式标注 `: GuiContext` 提升可读性，但不影响类型安全。注意 `ui.select` 只 bind 了 select，input/confirm/custom 未传——`askUserInteract` 仅用 select 通道，类型安全。 |
| INFO | extensions/subagent-workflow/src/interface/gui-mappers.ts | 25-29 | unsafe-cast | `toGuiCtx(ctx)` 用 `{ mode: ctx.mode, hasUI: ctx.hasUI }` 构造 `GuiContext`，**省略 ui 字段**。协议 `GuiContext.ui` 全可选，故兼容。subagent-workflow 的所有 GUI 路径（`adapter` / `notifyDone` / `withScriptGui` / `withGui`）只做渲染（`guiResult` / `guiComponent`），从不调 `ctx.ui.*`，故省略 ui 类型安全。 | 无需修改。注释准确。注意：若未来 subagent-workflow GUI 路径需要 `ctx.ui.setWidget` 等，需同步在 `toGuiCtx` 补传 ui（参考 ask-user 的 runRpcInteraction 模式）。 |
| INFO | extensions/todo/src/model.ts | 31-56 | missing-annotation | `buildGui(todos: Todo[]): GuiRenderResult` 参数/返回值标注完整。内部 `items: TreeItem[]` 显式标注，`map((t) => ...)` 的 `t` 由 `Todo[]` 推断为 `Todo`，无隐式 any。 | 无问题。示范实现。 |
| INFO | extensions/goal/src/adapters/goal-control-adapter.ts | 234-307 | missing-annotation | `buildGoalGui(state: GoalRuntimeState): GuiRenderResult` 参数/返回值标注完整。访问 `state.budget.tokenBudget` / `state.tokensUsed` / `state.timeUsedSeconds` / `state.currentTurnIndex` 均对应 `GoalRuntimeState` 接口（engine/types.ts:53-78）的真实字段。`GoalControlDetails`（line 90-97）是 plain interface（非 union），直接加 `__gui__?: GuiRenderResult` 字段，line 350 `details: { ...details, __gui__: ... }` 无需断言——类型安全。 | 无问题。与 subagent-workflow 的双重断言形成对比：plain interface 可直接 spread 加字段，discriminated union 必须双重断言。这是 union 类型的固有限制，非实现缺陷。 |
| INFO | extensions/ask-user/src/index.ts | 78-100 | missing-annotation | `toProtoQuestions(questions: Question[]): AskUserQuestion[]` / `protoAnswersToResult(...): Result["answers"]` 参数/返回值标注完整。`q.options.map((o: Option) => ...)` 回调参数显式标注。 | 无问题。 |
| INFO | shared/types/mariozechner/index.d.ts | 15-29 | unsafe-cast | 新增 `ExtensionMode = "tui" \| "rpc" \| "json" \| "print"` 类型与 `ExtensionContext.mode: ExtensionMode` 字段，与协议 `GuiContext.mode` 的 union 完全对齐。这是消除 `_ctx as GuiContext` 强断言的根因改进——有了精确的 `mode` 字段后，`isGuiCapable(ctx)` 可精确匹配 `ctx.mode === 'rpc'`。 | 无问题。类型设计正确。注意 line 42 `model: any` / line 134 `ExtensionContextActions = any` 是 pre-existing ambient 类型补丁，不在本次变更范围。 |

## 验证记录

- `git diff main...HEAD --stat`：49 文件，+1621 / -322
- `npx tsc --noEmit`（根目录）：EXIT_CODE=0，无输出
- `pnpm -r typecheck`：GLOBAL_EXIT=0，ask-user/goal/subagent-workflow/todo 均 Done
- `pnpm -r lint`：EXIT=0（包级 lint script 未透出 warn）
- `npx eslint <file>`（逐文件验证 no-unsafe-cast）：确认本次新增 2 处 warn（tool-workflow-script.ts:102, tool-render.ts:103），其余 6 处 warn 全部 pre-existing

## pre-existing 断言清单（不在本次范围，仅记录）

以下 `no-unsafe-cast` warn 在 main 分支已存在，本次仅行号位移，**不计入本次审查的 must-fix/suggestion**：

| 文件 | 行号（当前） | 类别 | 状态 |
|------|------|------|------|
| extensions/todo/src/model.ts | 35 | doubleCast (`as unknown as Record<string, unknown>`) | pre-existing（migrateTodo 未改） |
| extensions/todo/src/model.ts | 45 | structuralCast (`as { done?: boolean }`) | pre-existing（migrateTodo 未改） |
| extensions/goal/src/adapters/goal-control-adapter.ts | 370 | structuralCast (`as { details?: GoalControlDetails }`) | pre-existing（main line 281） |
| extensions/subagent-workflow/src/interface/subagent-actions.ts | 273 | doubleCast (`as unknown as SubagentToolResult`) | pre-existing（main line 260） |
| extensions/subagent-workflow/src/interface/tool-workflow.ts | 280 | doubleCast (`as unknown as WorkflowToolDetails`) | pre-existing（main line 263，本次仅把内层 `_ctx as GuiContext` 改为 `toGuiCtx(_ctx)`——实际**减少**了一处断言） |
| extensions/subagent-workflow/src/interface/tool-render.ts | 98, 126 | structuralCast (`as { startParam?: unknown }`, `as { task?: unknown }`) | pre-existing |
