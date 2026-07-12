---
verdict: fail
must_fix: 1
---

## Summary
1 must-fix, 3 suggestions, 4 infos.

审查范围：ask-user（RPC 交互）、todo（buildGui list-tree）、goal（buildGoalGui 预算可视化）、subagent-workflow（task-list/workflow-runs/subagent-trace → list-tree/card/stats-line 映射 + slug 透传）。重点核对了四条转换路径与 TUI 旧实现的语义一致性、边界条件与回归风险。

整体业务逻辑迁移质量较高：ask-user 的 `protoAnswersToResult` 与 TUI `getAnswerText`/`buildResult` 在 `parts.join(", ")` + `ANSWER_COMMENT_SEPARATOR=" — "` 上完全对齐（R-1~R-7 测试覆盖单选/多选/Other/comment/header-key 五种组合）；todo 的 status→icon/status 三态映射正确；goal 的预算比例阈值（0.9/0.7）与 `engine/budget.ts` 的 `RATIO_HIGH/RATIO_LOW` 一致；subagent-workflow 的 `mapRunStatus`/`mapRunIcon` 对 DoneReason（completed/failed/aborted/budget_limited/time_limited）覆盖完整。主要问题集中在 subagent-workflow 的 workflow "not_found" 错误路径被错误渲染为成功状态。

## Findings

| 优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向 |
|--------|------|------|------|------|----------|
| MUST_FIX | `extensions/subagent-workflow/src/interface/tool-workflow.ts` | 157-167 | correctness | `buildWorkflowGui` 的 `action:"run"` 分支用 `mapRunStatus(details.status)` / `mapRunIcon(details.status)` 渲染状态。当 `actionRun` 的 not_found 错误路径返回 `details: { action:"run", runId:"", status:"not_found", name }`（见 335-344 行，`isError:true`）时，`mapRunStatus("not_found")` 不命中任何 running/failed 关键字 → 返回 `"done"`，`mapRunIcon("not_found")` → `"check"`。结果：workflow 找不到脚本的**错误**路径在 GUI 中被渲染为绿色对勾的**成功**状态（label 还原成 `"myworkflow "` 经 trim 后的裸名），与 `isError:true` + "Workflow '...' not found" 文案直接矛盾，误导用户。该路径在 RPC 模式下可达（`withGui` 无差别附加 `__gui__`）。 | 在 `buildWorkflowGui` 的 run 分支前对 `status === "not_found"` 短路：返回 `guiComponent("stats-line", { items: [{ label:"run", value:"not found", severity:"danger" }] })`；或在 `mapRunStatus`/`mapRunIcon` 里把 `"not_found"`/`"not found"` 归入 failed。建议前者，避免污染通用 mapper。 |
| SUGGESTION | `extensions/subagent-workflow/src/interface/subagent-actions.ts` | 283-289 | logic-error | `buildGuiComponent` 的 `action:"start"` 分支硬编码 `header:"subagent"` + `body:[stats-line({value:"running"})]`，丢弃了 `input.domain`（`StartHandlerResult`）里的 `subagentId` / `agent` / `slug` 关键信息。对比被替换的 `subagent-trace`（含 agent 名 + 状态 + stats + result），GUI 信息密度明显下降——后台启动一个 subagent 后，用户在 GUI 只看到无身份的 "subagent / running"（实际数据仍在 content JSON 里，仅 LLM 可读，GUI 用户无法区分多个并发 subagent）。 | 利用 `input.domain` 构造：`header: domain.slug ? \`${domain.slug}\` : domain.subagentId.slice(0,8)`，`body` 里 stats-line 加 `{label:"agent", value:...}` / `{label:"id", value:domain.subagentId.slice(0,8)}` / `{value:"running", severity:"ok"}`。 |
| SUGGESTION | `extensions/goal/src/adapters/goal-control-adapter.ts` | 241-244 | logic-error | `buildGoalGui` 的 `statusSeverity` 三元链把 `paused`/`budget_limited`/`time_limited`/`cancelled` 统一兜底为 `"warn"`。但 `budget_limited`/`time_limited` 是预算耗尽的错误终态（`projection/widget.ts` 用 `getBudgetColor` 渲成 error 红），语义应为 `"danger"`。当前 `goal_control` execute 后 session.state 只可能是 active/complete/blocked（budget 终态由 `service.ts` 的 `checkBudgetOnTurnEnd` 在 agent_end hook 设置，不在此工具内转换），故实际不可达——属防御性隐患，若后续 `buildGoalGui` 被复用到 widget/notify 场景就会暴露。 | 把三元链补全：`budget_limited`/`time_limited`/`cancelled` → `"danger"`；`paused` → `"warn"`；或直接 switch 覆盖全部 `GoalStatus`。 |
| SUGGESTION | `extensions/ask-user/src/index.ts` | 109-115 | correctness | `protoAnswersToResult` 把多选 answers 用 `parts.push(...selected)` 按前端回传顺序拼接，未按 option 在 question.options 中的索引排序。TUI 版 `submit-view.ts:getAnswerText`（37-41 行）对 `selectedIndices` 做了 `[...s.selectedIndices].sort((a,b)=>a-b)` 再映射 label，故 TUI 永远按选项定义顺序输出（"A, C"）。RPC 路径输出依赖前端选中顺序，若前端回传 `["C","A"]` 则输出 `"C, A"`，与 TUI 同一选择产出不同字符串。答案集合等价（集合法义一致），但 `Result.answers` 文本不一致，可能影响 LLM 对"首选在前"的感知与快照对比。 | 多选分支对 `selected`（string[]）按 `q.options` 中 value/label 的索引重排后再 join：`selected.sort((a,b) => idxOf(a) - idxOf(b))`，其中 idxOf 查 `q.options.findIndex(o => o.label === x)`。 |
| INFO | `extensions/goal/src/adapters/goal-control-adapter.ts` | 246, 251, 264 | boundary | `hasBudget = tokenBudget !== undefined \|\| timeBudgetMinutes !== undefined`，但进度条渲染用真值判断 `if (state.budget.tokenBudget)` / `if (state.budget.timeBudgetMinutes)`。当 `budget = { tokenBudget: 0 }` 且无 timeBudget 时：`hasBudget=true` → 进 card 分支，但两个进度条 if 都不进（0 falsy），最终 card body 只剩一个 stats-line。视觉上等价于"无预算"但包了一层 card 容器，与无 budget 的扁平 stats-line 分支不一致。tokenBudget=0 在业务上语义本就模糊（不该出现），影响轻微。 | hasBudget 与进度条判定统一口径，建议都用 `!== undefined && > 0`；或对 `tokenBudget===0` 直接走无预算分支。 |
| INFO | `extensions/ask-user/src/index.ts` | 137-142 | boundary | `runRpcInteraction` 直接 `ctx.ui.select.bind(ctx.ui)`。若 RPC 模式下 `ctx.ui.select` 为 undefined（极端环境），`.bind` 会抛 `Cannot read properties of undefined`。该异常被外层 try/catch 捕获 → useRpc 分支禁用工具（274 行），属于优雅降级，不崩溃。但现有测试（R-1~R-7）rpc 模式 ctx 必挂 select，未覆盖此边界。 | 在 bind 前加守卫：`if (!ctx.ui.select) throw new Error("ui.select unavailable in RPC mode")`，让错误信息更明确；或保持现状但补一个测试。 |
| INFO | `extensions/subagent-workflow/src/interface/helpers.ts` | 92-100 | regression | `notifyDone` 的 list-tree item label 为 `${name} ${runId.slice(0,8)}`，未包含 `run.spec.slug`；而 `tool-workflow.ts:buildWorkflowGui` 的 run/status item label 是 `${name} ${slug ?? ""} ${runId.slice(0,8)}`。同一 run 在 "执行返回" 和 "完成通知" 两条消息里 label 格式不一致，用户在 GUI 里看到的两行无法直接对应同一 run（尤其并发多个同名脚本 run）。run.spec.slug 可能 undefined（旧 run），此处省略也合理，但与 buildWorkflowGui 的展示规则不统一。 | notifyDone 的 label 也拼 slug：`${name} ${run.spec.slug ?? ""} ${runId.slice(0,8)}`.trim()，与 buildWorkflowGui 对齐。 |
| INFO | `extensions/subagent-workflow/src/interface/tool-workflow-script.ts` | 110-142 | logic-error | `buildScriptGui` 的 switch 无 default 分支。当 `details.action` 为未预期值时函数返回 undefined，`guiResult(undefined)` 会在协议包内 `stripUndefined(undefined)` 后产出 `{v:1, component:undefined}` 的非法 GuiRenderResult。当前被 `withScriptGui` 的 `!result.details` 守卫兜住（Unknown action 路径 `textResult` 的 details 为 undefined，不进入 buildScriptGui），且 action 是有限联合类型，实际不可达。属防御性空缺。 | switch 加 `default: return guiComponent("stats-line", { items:[...] })` 兜底，或在 withScriptGui 里对 action 白名单过滤。 |

## 备注：已核验无问题的关键点

- ask-user `toProtoQuestions`：`value: o.label` 与 TUI buildResult 用 label 拼 answers 语义一致；`allowOther:true` 固定（schema 不暴露 Other）符合 ask-user 无条件追加 Other 的设计。
- ask-user headless 判定从 `!ctx.hasUI` 改为 `mode !== "tui" && mode !== "rpc"`：四种 mode（tui/rpc/json/print）下行为与旧逻辑等价（tui/rpc 放行，json/print 拦截），无回归。
- ask-user RPC catch 分支仅 useRpc 时禁用工具（TUI 抛错不禁用，允许重试）——与注释声明的 FR-13 语义一致。
- todo `buildGui` 四态映射（pending→dot/无 status，in_progress→circle/running，completed→check/done，cancelled→cross/failed）正确，空数组与 isVerification 有测试覆盖。
- todo `TodoDetails._render` 字段移除无回归：render.ts/handlers.ts 仅消费 `details.todos`/`details.action`，不读 `_render`；`buildRender` 已无引用。
- goal `BUDGET_RATIO_HIGH=0.9`/`BUDGET_RATIO_LOW=0.7` 与 `engine/budget.ts` 的 `RATIO_HIGH/RATIO_LOW` 完全一致；`SECONDS_PER_MINUTE=60` 正确。
- subagent-workflow `mapRunStatus`/`mapRunIcon` 对 DoneReason 全集（completed/failed/aborted/budget_limited/time_limited）覆盖正确；"paused 优先于 running" 的 icon 映射顺序正确。
- slug 透传链路（startParam → ExecuteOptions → ExecutionRecord → SubagentToolDetails/SubagentListItem → tool-render）完整，旧持久化 record 经 `reconstructFromFile` 兜底空串，向后兼容。
- workflow 扩展（已废弃，README 标注 superseded）仍用旧 `_render`/`task-list`，未在本次改动范围，不构成回归。
