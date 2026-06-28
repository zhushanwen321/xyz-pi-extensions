---
verdict: fail
must_fix: 1
---

# 测试覆盖审查报告

## Summary
1 must-fix, 6 suggestions, 1 info. 测试整体质量较高（372 tests pass，vitest 合规），但 `projection/result.ts` 作为任务明确点名的「新增逻辑文件」完全无独立测试，判定为 fail。

## Findings

| 优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向 |
|--------|------|------|------|------|----------|
| MUST_FIX | extensions/goal/src/projection/result.ts | 42, 66, 81 | missing-test | 3 个 exported 函数 `makeGoalResult` / `errorResult` / `buildBudgetReport` 完全无测试。`projection/__tests__/result.test.ts` 不存在，且无任何测试 import `projection/result`。进一步核查发现：这三个函数在生产代码中也未被调用（仅 `index.ts` import 了 `GoalManagerDetails` 类型），属于 exported 死代码。 | 添加 `projection/__tests__/result.test.ts`：覆盖 `makeGoalResult`（有/无 token+time budget、state=null 早返回）、`buildBudgetReport`（有/无 tokenBudget、duration 计算）、`errorResult`（isError=true）。若确认死代码则改为删除该文件。 |
| SUGGESTION | extensions/goal/src/engine/task.ts | 133, 138, 143 | missing-test | `getNextTaskId` / `getCompletedCount` / `getIncompleteTasks` 三个 exported 纯函数仅在 `task.test.ts` 中未直接测试，只通过 service/budget/command-adapter 间接覆盖。 | 在 `engine/__tests__/task.test.ts` 补充：`getNextTaskId([])`→1、间隙 id `[1,3]`→4；`getCompletedCount` 统计 completed+verified；`getIncompleteTasks` 过滤 cancelled/verified/completed-no-verification。 |
| SUGGESTION | extensions/goal/src/engine/budget.ts | 72-83 | edge-case | `tick` 的 `isRunning=true && timeStartedAt<=0` 分支未覆盖（line 78 `isRunning && timeStartedAt > 0` 为 false 时直接返回 `{timeUsedSeconds, timeStartedAt: now}` 不累加）。`createGoalState` 初始 `timeStartedAt=now` 不会触发，但 resume/重构路径可能传入 0。 | 补 `tick(0, 100, 2000, true)` → `{timeUsedSeconds:100, timeStartedAt:2000}`。 |
| SUGGESTION | extensions/goal/src/engine/budget.ts | 116-119, 133-134 | edge-case | `checkBudgetOnTurnEnd` 的 warning90 维度分支未覆盖：(a) token≥90% 且 `budgetLimitSteeringSent=true` → `warning90 token`；(b) time≥90% 未发 → `warning90 time`。现有测试只覆盖了 shouldSendSteering、terminal exceeded、warning70。FR-6.2 的 4 个独立 flag 中 tokenWarning90Sent / timeWarning90Sent 的「触发」路径无测试。 | 补两个 warning90 触发场景测试。 |
| SUGGESTION | extensions/goal/src/adapters/command-adapter.ts | 174-210 | edge-case | `handleHistory` 仅测了「无 history」分支（`command-adapter.test.ts:386`）；实际渲染分支（icon ✓/✗/⊗/⏱ 切换、objective 截断、min/sec 时长计算、多 entry 倒序）完全未覆盖。这是 8 个子命令中唯一有渲染逻辑未测的。 | 补 fake `ctx.sessionManager.getEntries` 返回 goal-history entries（complete/cancelled/budget_limited/time_limited 各一条），断言 icon 与字段渲染。 |
| SUGGESTION | extensions/goal/src/adapters/command-adapter.ts | 134-144 | edge-case | `handleResume` 的 time-budget-exhausted 分支（`dim==="time"` → `time_limited`）未覆盖；现有测试只验证了 token 维度。 | 补 timeBudgetMinutes + timeUsedSeconds 超额、tokensUsed 未超额场景。 |
| SUGGESTION | extensions/goal/src/adapters/event-adapter.ts | 98-186 | missing-test | 4 个简单事件 handler（`handleAgentStart` / `handleTurnEnd` / `handleMessageEnd` / `handleSessionStart`）无 handler 级直接测试。仅通过 `service.test.ts` 的 `applyEvent` 间接覆盖 state 变更，但 handler 特有逻辑（ESC 早返回、updateWidget effect 执行、reconstructGoalState + 基线设置）未直接验证。 | 在 `event-adapter.test.ts` 补：handleTurnEnd/HandleMessageEnd 在 `aborted=true` 时不递增/不累加 token；handleSessionStart 重建后设基线并调 updateWidget。 |
| INFO | extensions/goal/vitest.config.ts | - | framework-compliance | 框架合规：`include: ["src/**/*.test.ts"]`、pi-sdk/typebox alias stubs 齐全、`defineConfig` 正确。全仓 0 处 `node:test` / `tsx --test`，13 测试文件 372 tests 全绿（338ms）。 | 无需修复。 |

## 审查说明

**覆盖良好的部分**：engine/task.ts 状态机（合法 5 转换 + 非法 11 转换全覆盖）、engine/goal.ts（7 态 × 终态守卫全矩阵）、engine/budget.ts accumulateTokens/tick/checkProgress、service.ts 双入口（applyToolAction 10 个 action + applyEvent 简单事件，含 FR-8.3 全锁、FR-8.9 verification steering、FR-8.10 全 cancelled 守卫）、event-adapter 的 handleAgentEnd 4 层分支优先级 + ESC 守卫 + 并发保护、tool-adapter executeGoalAction（stale context catch / signal.aborted / 未知 action / 通用错误兜底）、widget 5 状态 + hasUI 守卫、prompts formatBudget 4 样式 + XML 转义、session reconstructGoalState + isStaleContextError 边界已覆盖。

**边缘情况覆盖良好**：空输入（tasks=[]）、null state、全 cancelled、重复 taskId、texts 全空白、删空 subtasks 置 undefined、serialize 深拷贝隔离、deserialize 缺字段 throw、cacheRead>input 的 max 钳位、remaining clamp 不出负数、resume 终态守卫。

**MF-3 tick 回归测试扎实**：pause/clear/abort/set-overwrite 四条「转 paused/cancelled 前 tick 累加」路径均有断言（command-adapter.test.ts）。
