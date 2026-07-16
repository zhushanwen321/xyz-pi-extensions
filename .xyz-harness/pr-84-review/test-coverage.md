---
verdict: pass
must_fix: 0
---

# PR #84 Test Coverage Review

审查范围：`git diff origin/main...HEAD`，4 个扩展（subagent-workflow / ask-user / goal / todo）新增 GUI 协议 + RPC 生命周期支持。所有测试均已运行通过（subagent-workflow 855 / ask-user 297 / goal 287 / todo 70）。

## Summary

测试整体质量高。**纯函数**层（parse 函数、mapRunStatus/Icon、buildGuiComponent、buildWorkflowGui、buildGoalGui、buildGui、protoAnswersToResult 等）覆盖充分，边界、错误路径、大小写、空输入均有用例。

**ask-user 是覆盖标杆**：index.test.ts 的 R-1~R-7 直接在 tool handler 级别测试 RPC 分支（select 成功/取消/throw/多选排序/Other/comment），是本 PR 中唯一把 mode 分支的 dispatch + 依赖注入（select mock）一起测的扩展。

主要缺口集中在 **command handler 的 RPC 分支 dispatch 没有直接测试**（subagent-workflow 的 commands.ts / subagents.ts，todo 的 tool.ts，goal 的 registerGoalControlTool）。这些 handler 把 parse 结果分发到 service/lifecycle 调用 + try/catch + notify，但测试只覆盖了被它调用的纯函数（parse / buildGui），handler 本身的接线逻辑（switch dispatch、catch 通知文案、service=null 短路）未被直接验证。属于 SUGGESTION 级别（纯函数已覆盖核心逻辑，handler 是薄分发），不阻塞合并。

另有 1 个重复测试用例（helpers-gui.test.ts 两段相同 it）和 1 个 vitest config 缺 alias 的小问题，均为 SUGGESTION/INFO。

## Findings

| # | 类别 | 优先级 | 位置 | 说明 |
|---|------|--------|------|------|
| 1 | edge-case | SUGGESTION | `subagent-workflow/src/interface/commands.ts`（registerWorkflowsCommand）+ `subagents.ts`（registerSubagentsCommand） | **RPC 命令 handler 分支无直接测试。** commands.ts 新增的 RPC 分支（`ctx.mode === "rpc"` → parse → switch pause/resume/abort → 调 pauseRun/resumeRun/abortRun + try/catch + ui.notify）和 subagents.ts 的 cancel 分支（service.cancel + 通知文案随 ok 值变化）没有任何测试直接调用 handler。纯函数 parseWorkflowRpcCommand/parseSubagentRpcCommand 已被 command-actions.test.ts 充分覆盖，但 handler 的 dispatch 接线（尤其 try/catch 里 `Failed to ${action}` 的 warning 文案、lifecycle 函数 throw 时的兜底）未被验证。建议加 1-2 个 handler 级集成测试（mock deps/pauseRun + 验证 notify 调用）。 |
| 2 | edge-case | SUGGESTION | `subagent-workflow/src/interface/subagents.ts` | **service=null 在 RPC 模式下的顺序未被测试。** handler 先取 `service = getSubagentService()`，service=null 时直接 notify "runtime not ready" 并 return——此短路发生在 RPC 分支判断之前，意味着 RPC 模式下 service 未就绪时会返回 "runtime not ready" 而非 RPC 专用文案。该顺序是否为有意设计未被测试覆盖（TUI 路径同样依赖此顺序，但 TUI 已有既有测试）。 |
| 3 | missing-test | SUGGESTION | `todo/src/tool.ts`（executeTodoAction 的 `if (ctx.mode === "rpc")` 分支）+ `goal/src/adapters/goal-control-adapter.ts`（registerGoalControlTool 的 `if (ctx.mode === "rpc" && session.state)` 分支） | **mode 判定 + __gui__ 注入分支无 handler 级测试。** 两个扩展都只在纯函数层（buildGui / buildGoalGui）有测试，handler 里 `ctx.mode === "rpc"` 的条件分支、`session.state` 为 null 时的跳过路径（goal）均无直接测试。todo 的 gui.test.ts 只测 buildGui([]) 空数组，未测 handler 在非 RPC 模式下不附加 __gui__。参考 ask-user 的 R-* 用例范式补 handler 级断言。 |
| 4 | edge-case | SUGGESTION | `ask-user/src/index.ts` protoAnswersToResult | **多问题混合场景未测。** R-1~R-7 都是单问题用例。protoAnswersToResult 的循环 + 多问题 key 映射（header→question 全文）、多问题中部分问题无回答（`parts.length === 0 → continue` 跳过）的边界未覆盖。建议补 1 个 2-3 问题混合（单选+多选+Other+comment）的用例。 |
| 5 | edge-case | INFO | `subagent-workflow/src/__tests__/helpers-gui.test.ts:85-107` | **重复测试用例。** "RPC 模式 + 无 reason → __gui__ status=done icon=check" 出现两次（line 85-95 与 97-107），描述和断言完全相同。第二个应为复制粘贴遗留，删除或改为测其他 reason（如 "completed"）以扩大覆盖。 |
| 6 | framework-compliance | INFO | 4 个扩展的测试 | **框架合规通过。** 全部从 `vitest` 导入 describe/expect/it/vi；vitest.config.ts 均存在且 include glob 正确；4 个扩展测试全绿（855/297/287/70）。subagent-workflow 的 vitest.config.ts 未显式 alias `@xyz-agent/extension-protocol`，但该包已 installed 且 node_modules 解析正常，非问题。 |
| 7 | test-config | INFO | `subagent-workflow/src/execution/__tests__/tool-action.test.ts` | **startHandler 的 slug 校验测试充分。** slug 缺失/空白/>20 字符 三个 throw 路径均有用例，且 background 启动用例验证 slug 透传到 result.details.slug + content JSON。adapter 用例也验证 slug 透传。session-reconstructor.test.ts 补了 slug 读取 + 旧文件无 slug 兜底空串的向后兼容用例。此部分覆盖质量高，记录为正向。 |

## 统计

- must_fix: 0
- suggestion: 4（#1, #2, #3, #4）
- info: 3（#5, #6, #7）
