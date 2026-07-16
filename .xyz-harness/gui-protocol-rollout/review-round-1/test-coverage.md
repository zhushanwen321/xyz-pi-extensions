---
verdict: fail
must_fix: 1
---

## Summary

1 must-fix, 7 suggestions, 2 infos.

测试运行结果：4 个扩展全部通过（ask-user 296 / subagent-workflow 814 / todo 70 / goal 278，共 1258 测试）。无 failing-test。测试框架合规（4 个扩展都有 vitest.config.ts，统一用 vitest，无 node:test / tsx --test）。

主要缺口集中在 subagent-workflow 的 `tool-workflow-script.ts`（`buildScriptGui`/`withScriptGui` 两个新函数、5 个 action 分支共约 100 行逻辑完全无测试），以及若干边界条件与 helper 覆盖薄弱。

## Findings

| 优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向 |
|--------|------|------|------|------|----------|
| MUST_FIX | extensions/subagent-workflow/src/interface/tool-workflow-script.ts | 83-153 | missing-test | `withScriptGui` + `buildScriptGui` 为本次新增的 GUI 协议构造逻辑（约 100 行），覆盖 generate/lint/list/save/delete 5 个 action 分支，每个分支产出不同 stats-line（severity ok/warn、value 取值不同）。当前 `src/__tests__/` 下无任何测试引用这两个函数（已 grep 确认）。这是 PR 四扩展中唯一「新增可测函数完全零测试」的扩展，其余三个（ask-user/todo/goal）都补了对应 gui.test.ts。 | 新建 `extensions/subagent-workflow/src/__tests__/workflow-script-gui.test.ts`，import 并导出 `buildScriptGui`（当前为 module-private，需先 export 或通过 `withScriptGui` 间接测），对 5 个 action 各写一个用例：generate→`{label:"generated", severity:"ok"}`、lint valid→`"passed"/ok`、lint invalid→`"N findings"/warn`、list→`{label:"scripts", value:count}`、save/delete ok→`severity:"ok"`、save/delete fail→`severity:"warn"`。同时补 RPC 模式下 `withScriptGui` 透传 `__gui__` 的验证。 |
| SUGGESTION | extensions/subagent-workflow/src/interface/gui-mappers.ts | 11-17 | missing-test | `toGuiCtx(ctx)` 为新增 export 函数（被 subagent-tool.ts / tool-workflow.ts / tool-workflow-script.ts 三处调用），负责把 Pi ExtensionContext 收口为协议 GuiContext 子集（提取 mode/hasUI，undefined 输入返回 undefined）。gui.test.ts 未对其直接测试，仅通过 `buildGuiComponent`/`buildWorkflowGui` 间接经过（实际那两个函数不依赖 toGuiCtx）。 | 在 gui.test.ts 加一个 `describe("toGuiCtx")`：①`undefined` → `undefined`；②`{mode:"rpc",hasUI:false}` → `{mode:"rpc",hasUI:false}`；③`{mode:"tui",hasUI:true}` → 正确透传；④验证返回对象只有 mode/hasUI 两键（不泄漏 ui 引用）。 |
| SUGGESTION | extensions/subagent-workflow/src/interface/helpers.ts | 87-99 | missing-test | `notifyDone` 的 GUI 分支本次重写：从 `workflow-runs` 组件改为 `list-tree` 组件，并用新增的 `mapRunStatus`/`mapRunIcon` 拼接 `statusStr = status + reason`。reason 存在时拼接 `(reason)` 后缀，影响映射结果（如 `done (failed)` → failed/cross）。`src/__tests__/` 下无 notifyDone 测试。 | 在 helpers 相关测试文件补一个用例：构造一个 reason 非空的 run（如 `status:"done", reason:"failed"`），断言 `details.__gui__.component.type === "list-tree"` 且 item status=failed/icon=cross；再补一个 reason 为 undefined 的用例。 |
| SUGGESTION | extensions/goal/src/adapters/goal-control-adapter.ts | 241-244 | edge-case | `statusSeverity` 的三目链有 4 个分支：active→ok、blocked→danger、complete→ok、其他→warn。gui.test.ts 只覆盖了 active（隐式，line 39）、blocked（line 85）、complete（line 96）。`其他→warn` 分支（对应 budget_limited/time_limited/cancelled/paused 四个真实 GoalStatus）完全未测。 | 在 gui.test.ts 补一个用例：`status:"budget_limited"`（或 paused/cancelled/time_limited）→ 断言 stats-line 里 status item 的 `severity === "warn"`，card 的 `variant === "default"`。 |
| SUGGESTION | extensions/goal/src/adapters/goal-control-adapter.ts | 250-270 | edge-case | 预算阈值 `BUDGET_RATIO_HIGH=0.9` / `BUDGET_RATIO_LOW=0.7` 用 `>=` 比较。测试只取了 95%（danger）和 75%（warn）两个中间值，未测精确边界（正好 90% / 正好 70%）。由于实现是 `tokenPct >= 0.9`，90% 整应判 danger；70% 整应判 warn。边界 off-by-one（`>` vs `>=`）是典型回归点。 | 补两个用例：`tokensUsed:9000, tokenBudget:10000`（正好 0.9）→ danger；`tokensUsed:7000, tokenBudget:10000`（正好 0.7）→ warn。token 和 time 各补一组（time 当前只测了 90% danger，70% warn 完全缺）。 |
| SUGGESTION | extensions/goal/src/adapters/goal-control-adapter.ts | 273-289 | missing-test | 「无 budget → stats-line 摘要」分支（line 39-49 的测试）只验证了 label 包含 goal/status/turn/tokens，未验证 status item 的 severity 值。无 budget 路径同样要走 `statusSeverity` 三目链，但其 severity 未断言。 | 在「无 budget → stats-line 摘要」用例中补 `expect(items.find(i=>i.label==="status").severity).toBe("ok")`（默认 active）。 |
| SUGGESTION | extensions/subagent-workflow/src/interface/gui-mappers.ts | 39-57, 62-82 | edge-case | `mapRunStatus`/`mapRunIcon` 用 `includes` 子串匹配。测试覆盖了各类已知状态，但未测未知状态（如 `"foobar"`、`""`）的 default 落点（→ done / check）。子串匹配的边界：`"error"` 会命中任何含 error 的状态（如 `"no_error"`→failed），这是潜在误匹配点。 | 补两个用例：①`mapRunStatus("foobar")` / `mapRunIcon("foobar")` → done / check（default 分支）；②`mapRunStatus("")` / `mapRunIcon("")` → done / check（空串边界）。 |
| INFO | extensions/todo/src/tool.ts | 210-224 | missing-test | `executeTodoAction` 中 `ctx.mode === "rpc"` 分支（决定是否 attach `__gui__`）未通过 execute 路径测试。buildGui 函数本身已单测覆盖（gui.test.ts 3 个用例），但 dispatch 层的 RPC 条件分支（含 `ctx.mode` 取值）未集成测试。同样情况见 goal 的 `goal-control-adapter.ts:346-349`。 | 风险较低（条件分支简单），可在现有 tool.test/adapter.test 里补一个 RPC 模式的 execute 集成用例验证 `__gui__` 字段存在性；或接受当前单元级覆盖。 |
| INFO | extensions/subagent-workflow/src/__tests__/gui.test.ts | 1-449 | framework-compliance | 文件 import 语句格式异常：`import { mapRunIcon,mapRunStatus }`（逗号后无空格）、`import { describe, expect,it }`、import 路径用 `.ts` 后缀（`from "../interface/gui-mappers.ts"`）。`.ts` 后缀在该项目的 vitest 配置下能跑通，但与其他测试文件风格不一致。 | 纯风格问题，非测试覆盖问题。如需统一可去掉 `.ts` 后缀并补逗号后空格。 |
