# Tracing Round 5

## 收敛判定

**CONVERGED**

spec 已充分覆盖 5 视角的核心行为契约。本轮独立从零审视，未发现会导致"重构行为丢失或实现错误"的重大新 gap。发现的若干项均为边缘一致性/umbrella-coverage 问题（F 类小事实），已归入下方"边缘项备注"，不构成 NOT CONVERGED 理由。

## 追踪范围

- spec 版本：FR-1~FR-8（FR-8 含 12 个子章节 FR-8.1~FR-8.12），AC-1~AC-8，D-01~D-20，5 个业务用例
- 追踪视角：5 视角全适用（P1 User Journey / P2 Data Lifecycle / P3 API Contract / P4 State Machine / P5 Failure Path）
- 源码验证范围：index.ts（事件注册）、before-agent-start-handler.ts、agent-end-handler.ts、action-handlers.ts、command-handler.ts、tool-handler.ts、state.ts（选择性 grep + 重点段 read）

## Gap 列表

无重大新 gap（即无 NOT CONVERGED 级别的 gap）。

边缘项（F 类小事实，spec 未显式提及但不会导致重构错误，建议实现时留意，归类为备注而非 gap）：

| ID | Type | Perspective | Source | Question / 备注 |
|----|------|------------|--------|----------|
| E-R5-001 | F | P1 User Journey | command-handler.ts:128-133 (`handleResume`) | `/goal resume` 在有未完成任务时调 `pi.sendUserMessage(..., {deliverAs:"followUp"})` 重启 autonomous loop。这是 FR-8.12（set 后触发 AI）的**并行模式**——resume 也需触发 AI 才能继续 loop。spec 未显式列出，但 FR-8.12 已建立此模式，competenta 实现者按并行推理应保留。建议实现时显式保留。 |
| E-R5-002 | F | P1 User Journey | command-handler.ts:130, 243 | resume 注入 `lastBlockerReason` 到 sendUserMessage；`/goal update` 在 active 时发 `objectiveUpdatedPrompt` 作为 "steer"。属 prompt/trigger 细节，归入 projection/templates 层自然保留。 |
| E-R5-003 | F | P2 Data Lifecycle | command-handler.ts:234 | `/goal update` 重置 `lastProgressTurn=0`。spec FR-8.4 G-002 列了"重置 stallCount/currentTurnIndex/budget flags"但未显式提 lastProgressTurn。属 stall 基线重置范畴，FR-8.4 G-004 精神延伸，自然保留。 |
| E-R5-004 | F | P2 Data Lifecycle | command-handler.ts:112-113 | `/goal resume` 重置 `stallCount=0` + `timeStartedAt=Date.now()`（重启时间累计段）。FR-8.3 G-014 只提"resume 时 budget 重检"，未显式提 stallCount/timeStartedAt 重置。属 resume 语义自然组成。 |
| E-R5-005 | F | P3 API Contract | index.ts:384-401 | 注册 3 个 message renderer（goal-context / goal-context-exceeded / goal-staleness-reminder）及前缀染色逻辑。属 projection/widget 层基础设施，spec FR-2.1 已列 projection 目录，自然归位。 |

## 5 视角追踪摘要

### P1: User Journey
追踪 8 个 /goal 子命令 + 10 个 tool action + __goalInit。所有路径在 spec 中有明确归属：
- set/pause/resume/clear/abort/update/history/status → FR-3/FR-6.3/FR-8.4/FR-8.7 覆盖
- create_tasks/add_tasks/update_tasks/list_tasks/complete_goal/report_blocked/cancel_goal/add_subtasks/update_subtasks/delete_subtasks → FR-8.8~FR-8.11 覆盖关键守卫
- __goalInit → FR-4 (D-12/D-16) 覆盖

边缘项 E-R5-001（resume 触发 AI）是唯一值得显式留意的，但属 FR-8.12 并行模式。

### P2: Data Lifecycle
追踪 GoalRuntimeState（19 字段，A-05 已验证）/ GoalHistoryEntry / GoalSession 的 Create/Read/Update/Delete/GC：
- Entry GC（state 留 1 / history 留 20）→ FR-8.1 G-006 覆盖
- AUTO_CLEAR_TURNS=2 → FR-8.1 G-007 覆盖
- 部分损坏全丢 → FR-5 + FR-8.1 G-024 覆盖
- persist 失败保持现状 → FR-8.1 G-023 覆盖
- Budget tick 剥离 → FR-6.5 覆盖
- hasPendingInjection 删除 → FR-6.4 覆盖
- token/time 预警 flag 拆分（当前代码 state.ts:139-140 仍是共用单 flag，spec FR-1.3/FR-6.2 明确要求拆 4 个）→ 覆盖（这是要修的 bug，非 gap）

边缘项 E-R5-003/E-R5-004 是 update/resume 的字段重置细节，属 stall 基线/resume 语义自然组成。

### P3: API Contract
追踪 goal_manager tool schema / /goal 命令 / __goalInit 签名：
- tool action 枚举 + 参数 → AC-4 覆盖（schema 不变）
- __goalInit 签名（tasks 不变 D-12，ctx 必填 D-16）→ FR-4.2 覆盖
- /goal flag 解析（--tokens/--timeout/--max-turns/--max-stall，cap）→ AC-4 覆盖
- cancel_goal details.tasks 返回空数组 → FR-8.5 G-013 覆盖（验证 action-handlers.ts:285-290）
- makeGoalResult budget 后缀拼接 → projection 层自然归位

边缘项 E-R5-005（message renderer 注册）属 projection 基础设施。

### P4: State Machine
追踪 Goal 7 态 / Task 5 态 / Subtask 3 态：
- transitionStatus 宽松（仅守卫终态）→ FR-8.3 G-016 覆盖
- completed 无 verification 全锁（含不能 cancel）→ FR-8.3 G-017 + FR-8.10 覆盖
- subtask 宽松 → FR-8.3 G-018 覆盖
- resume 可转 terminal → FR-8.3 G-014 覆盖
- session_start 非对称强制激活 → FR-8.3 G-015 覆盖
- complete_goal 全 cancelled 守卫 → FR-8.10 覆盖（验证 action-handlers.ts:234-237）
- add_subtasks completed 限制 → FR-8.11 覆盖（验证 action-handlers.ts:308）
- Task 5 态转换表（validateUpdateTasks）→ FR-1.2 覆盖

无 gap。

### P5: Failure Path
追踪 deserialize throw / persist 失败 / stale context / 并发 / 预算耗尽 / maxTurns / stall / ESC：
- deserialize 缺字段 throw → FR-5 + FR-8.1 G-024 覆盖
- persist 失败保持现状（不额外 try/catch）→ FR-8.1 G-023 覆盖
- stale context 检测（4 模式匹配）→ FR-8.2 G-010 覆盖
- goalId snapshot stale-checker → FR-8.2 G-020 覆盖（验证 agent-end-handler.ts:80-83）
- isProcessing 防重入 → FR-8.2 G-021 覆盖（验证 agent-end-handler.ts:50）
- ESC 纯打断（D-18，移除 pendingPause）→ FR-6.7 覆盖（注：当前代码 agent-end-handler.ts:61-65 + tool-handler.ts:226-229 仍是 pendingPause→paused 旧行为，重写改为纯打断，这是 spec 明确的演进方向，非 gap）
- agent_end 分支优先级（allTasksDone 优先 complete）→ FR-8.7 G-R2-003 覆盖（验证 agent-end-handler.ts:151-168 顺序匹配）
- continuation 去抖 → FR-8.7 G-R2-005 覆盖（验证 agent-end-handler.ts:302-306）
- 预算 70/90/100% 三阈值 + 维度独立 → FR-1.3 + FR-6.2 覆盖

无 gap。

## 详细追踪依据

### 验证 1：FR-8.10 complete_goal 全 cancelled 守卫
源码 `action-handlers.ts:233-237`：
```
const completedOrVerified = state.tasks.filter((t) => t.status === "completed" || t.status === "verified");
if (completedOrVerified.length === 0) {
    return errorResult("At least one task must be completed or verified. All-cancelled does not count.");
}
```
与 spec FR-8.10 完全一致。守卫顺序（notDone → completedOrVerified → transitionStatus）亦匹配。

### 验证 2：FR-8.11 add_subtasks completed 限制
源码 `action-handlers.ts:308`：
```
if (isTerminalTaskStatus(parentTask.status) || parentTask.status === "completed") {
    return errorResult(`Task #${parentTask.id} in terminal state (${parentTask.status}), cannot add subtask`);
}
```
与 spec FR-8.11 守卫表达式完全一致。

### 验证 3：FR-8.12 /goal set 触发 AI
源码 `command-handler.ts:298`：`pi.sendUserMessage(objective, { deliverAs: "followUp" });`
顺序：createInitialState → persistAndUpdate → notify → sendUserMessage，与 spec FR-8.12 完全一致。

### 验证 4：FR-8.6 staleness reminder 重置 lastUpdatedTurn
源码 `before-agent-start-handler.ts:135-143`：注入提醒前重置 `task.lastUpdatedTurn = currentTurnIndex` 及非 completed 子任务的 lastUpdatedTurn。与 spec FR-8.6/FR-8.9 一致。allTerminal 分支（line 122-131）不重置，与 spec"此分支不重置"一致。

### 验证 5：FR-8.7 agent_end 分支优先级
源码 `agent-end-handler.ts:151-168` `handleProgressAndTasks` 分支顺序：allTasksDone → noTasksCreated → maxTurnsReached → continuation。与 spec FR-8.7 G-R2-003 矩阵一致。allTasksDone + maxTurns → complete（line 175-185），非 cancelled，与 FR-8.7 注"分支 1a 是 complete"一致。

### 验证 6：FR-8.5 cancel_goal details.tasks 空数组
源码 `action-handlers.ts:285-290`：cancelDetails 单独构造，`tasks: [] as GoalTask[]`，不调 makeGoalResult（因 session 已清空）。与 spec FR-8.5 G-013 一致。

## 结论

spec 经 4 轮迭代已高度完善，FR-8 的 12 个子章节精确覆盖了源码中所有关键行为契约（状态机守卫、事件链路副作用、agent_end 分支优先级、history 写入矩阵、触发机制、防御机制）。本轮独立审视未发现重大遗漏。

边缘项 E-R5-001~E-R5-005 均为 F 类小事实（prompt 细节、字段重置、基础设施注册），属已建立模式的自然延伸或 projection 层归位，competenta 实现者按 spec 既有原则可正确保留。建议实现阶段对 E-R5-001（resume 触发 AI）格外留意，因其与 FR-8.12 并行但未显式列出。
