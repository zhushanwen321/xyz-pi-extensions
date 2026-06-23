---
verdict: pass
must_fix: 0
---

# 业务逻辑审查报告

## Summary
0 must-fix, 3 suggestions, 4 infos. 逐模块审查了 engine/task.ts（状态机 + 双维度投影）、engine/budget.ts（预算决策 + tick）、engine/goal.ts（Goal 状态机）、service.ts（双入口 + 10 action handler）、session.ts（状态重建 + entry GC + stale 检测）、adapters/event-adapter.ts（before_agent_start + agent_end + ESC guard + stall detection）、persistence.ts（严格 deserialize）。核心业务逻辑正确，状态机转换完备，tick 回归保护扎实（所有 9 处终态转换都在 transitionStatus 前调 tickState），全锁/verification steering/全 cancelled 守卫均正确实现。

## Findings

| 优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向 |
|--------|------|------|------|------|----------|
| SUGGESTION | extensions/goal/src/service.ts | 230-258 | boundary | `actionCreateTasks`（`create_tasks` tool action）替换任务列表时不重置 `session.tasksCompletedAtAgentStart` 基线。`createGoal`(L128) 会设 `tasksCompletedAtAgentStart = 0`，但 `actionCreateTasks` 直接构造 tasks 绕过 createGoal。当 all-complete 的 goal 被 create_tasks 替换为全新 pending tasks 后，`agent_end` 的 stall 检测用旧基线（oldCompletedCount）与新 completedCount(0) 比较 → `0 - oldCount !== 0` → 永远不报 stalled，直到 completedCount 超过 oldCount。**自愈**：下一次 `agent_start`(L617) 会重设基线为当前 getCompletedCount=0，所以只有 create_tasks 所在 turn 的 agent_end 受影响（1-turn 窗口）。 | 在 `actionCreateTasks` 成功替换 tasks 后加 `session.tasksCompletedAtAgentStart = 0;`（与 createGoal L128 对齐）。 |
| SUGGESTION | extensions/goal/src/service.ts | 166-178 | boundary | `finalizeGoal` 不内部调 `tickState`，依赖调用方在调它之前先 tick。当前 5 个调用方（actionCompleteGoal L380、actionCancelGoal L398、及 event-adapter 3 处终态转换）全部正确遵循此约定。但 API 是「隐式契约」——未来新增 finalizeGoal 调用方若忘记先 tick，history entry 的 `elapsedSeconds` 会少计最后一段运行时间。 | 要么把 `tickState(state)` 移入 `finalizeGoal` 开头（内部自洽），要么在 finalizeGoal 签名加 `@precondition state.timeUsedSeconds 必须已 tick` 的 JSDoc（当前 tickState 注释提到了，但 finalizeGoal 的注释未强调前置条件）。 |
| SUGGESTION | extensions/goal/src/engine/budget.ts | 112-115 | boundary | Token 预算耗尽终止（terminal）要求 `budgetLimitSteeringSent === true`：`if (tokenPct >= 1 && state.budgetLimitSteeringSent)`。如果单轮 token 从 <90% 暴涨到 ≥100%（大 message_end），该 turn 只发 steering（shouldSendSteering），不终止；下一 turn 才终止。这是**有意的 1-turn 宽限**（给 agent 一轮收尾），但 `>= 1` 不触发立即终止可能让 token 超出预算较多。对比：time 维度（L128）无此门槛，到 100% 立即终止。 | 若需更严格控制：`if (tokenPct >= 1 && state.budgetLimitSteeringSent) { terminal } else if (tokenPct >= 1) { shouldSendSteering }`——当前逻辑已隐含此行为（>=HIGH && !steeringSent → steering），仅确认设计意图。 |
| INFO | extensions/goal/src/engine/budget.ts | 126-138 | boundary | Time 预算终止（L128 `timeUsedSeconds >= budgetSeconds`）直接 terminal，不经过 steering 宽限。Token 维度有 steering → 下一 turn terminal 的两阶段；Time 维度是 warning90 → 直接 terminal 的单阶段。这种**不对称**合理（时间到点即止，无法「收尾」），但意味着接近 time limit 的 agent 没有 grace turn。设计意图明确，记录供参考。 | 无需修改，确认 FR-6.2 设计意图。 |
| INFO | extensions/goal/src/engine/task.ts | 90-95 vs 133 | boundary | `isTaskDone`（stall/progress 口径）= cancelled + verified + (completed && !verification)。`getCompletedCount`（widget/history 显示口径）= completed + verified。两者对 `completed && verification` 的归类不同：在 progress 检查中算「未完成」（pending_verification），但在显示计数中算「已完成」。这是有意的双口径设计（completion vs verification 维度分离），但在 `checkProgress` 的返回值中 `completedCount` 可能 > 实际「done」数，导致 `allTasksDone` 为 false 时 `completedCount` 仍显示满额。 | 无需修改，双口径设计正确；建议在 widget 渲染时区分显示「completed」与「verified」让语义更清晰。 |
| INFO | extensions/goal/src/service.ts | 584-625 | boundary | `applyEvent` 的 `message_end` 分支对 `eventData` 做结构断言（L598-603）但无运行时校验——若 SDK event 形状变化（如 usage 嵌套层变化），静默 break 不报错，token 不累加。`turn_end` 分支无参数消费。`agent_start` 分支正确设基线。三个简单事件逻辑正确。 | 可选：对 message_end 加 `if (!data.message?.usage) return [];` 的 early return（当前已隐式通过 `if (!usage) break` 实现）。 |
| INFO | extensions/goal/src/session.ts | 86-117 | boundary | Entry GC 逻辑正确：先收集 goal-state 降序索引并 splice（L99-101），再在已变更的 entries 数组上收集 history 索引（L106-110），最后降序 splice 最老的 history（L111-116）。两阶段 splice 各自索引自洽，无错位风险。`reconstructGoalState` 的 G-015 非对称激活（非终态非 paused → active + 重设 timeStartedAt）正确处理了 crashed-blocked 重启场景。 | 无需修改。 |

## 逐模块审查结论

### engine/task.ts — ✅ 正确
- 状态转换表（LEGAL_TRANSITIONS）完备：pending→{in_progress,cancelled}、in_progress→{completed,cancelled}、completed→{verified}、verified/cancelled 终态。
- `isTaskDone` 双口径正确：cancelled/verified 直接 done，completed 无 verification 才 done。
- 双维度投影（getCompletionState / getVerificationState）覆盖全部 status 组合。
- 边界：空 tasks（getNextTaskId 返回 1）、subtask 数组 undefined 处理。

### engine/budget.ts — ✅ 正确（1 SUGGESTION）
- `accumulateTokens`：正确实现 `max(input-cacheRead, 0) + output`，cacheRead>input 时钳为 0。
- `tick`：纯函数，isRunning && timeStartedAt>0 才累加。
- `checkBudgetOnTurnEnd`：4 个独立 flag（tokenWarning70/90, timeWarning70/90）维度独立触发。if-else 链确保同维度不重复发（70 已发则不进 70 分支，90 未发则进 90 分支）。
- `checkProgress`：allTasksDone 正确要求 totalCount>0 && incomplete==0 && completedCount>0。
- remaining clamp：getTokenUsagePercent/getTimeUsagePercent 在 budget<=0 时返回 0（除零保护）。

### engine/goal.ts — ✅ 正确
- `transitionStatus`：终态不可被覆盖（TERMINAL_GOAL_STATUSES.has(current) → return current）。
- `createGoalState`：初始值完备，4 个 warning flag 初始化为 false。

### service.ts — ✅ 正确（2 SUGGESTION）
- 10 个 action handler 正常/异常路径完备。
- FR-8.3 全锁（isProcessing 在 event-adapter 层，G-017/G-018 completed 不可变在 service 层）。
- FR-8.9 verification steering（tasksNeedingVerification → sendContextMessage）。
- FR-8.10 全 cancelled 守卫（completedOrVerified.length === 0 → reject）。
- 重复 taskId 校验（L277-281）。
- tick 回归：所有 5 处终态转换（complete/cancelled/blocked×2/context-paused）+ event-adapter 4 处全部在 transitionStatus 前 tickState。

### session.ts — ✅ 正确
- `reconstructGoalState`：从后往前找最新 goal-state entry，deserialize 失败 → state=null（G-024 全丢）。
- G-015 非对称激活正确。
- `isStaleContextError`：5 个 pattern 大小写不敏感匹配。
- `clearGoalSession`：hasUI 守卫正确。

### adapters/event-adapter.ts — ✅ 正确
- `handleAgentEnd` 分支优先级严格按 FR-8.7：终态 → active 检查 → ESC 守卫 → budget → progress(allTasksDone/noTasksCreated/maxTurns) → stall+continuation。
- ESC 守卫位置正确（在 active 检查后、副作用前）。
- `makeStaleChecker` goalId snapshot 正确。
- `checkStaleness`：TASK_STALL_TURN_THRESHOLD(10) + allTerminal 特殊分支 + lastUpdatedTurn 重置。
- `checkContextUsage`：CONTEXT_USAGE_RATIO_LIMIT(0.85) → paused + wrap-up injection。
- continuation 去抖：tokenDelta <= 0 只 persist 不发 continuation。
