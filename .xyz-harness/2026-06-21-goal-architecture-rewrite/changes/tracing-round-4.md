# Tracing Round 4

## 收敛判定
NOT CONVERGED

spec 经过 3 轮已极其完善（FR-8 含 20+ 行为契约、FR-8.6/8.7/8.8 补强），但从零审视仍发现 5 处"代码有 spec 没写"的真实 F gap，集中在 spec 较少聚焦的 **tool action handler 内部副作用** 和 **创建后的消息触发**。这些 gap 在新架构中可能丢失，需补入 FR-8。

## 追踪范围
- spec 版本：含 FR-1~FR-8（FR-8.6/8.7/8.8 补强）、AC-1~AC-7、D-01~D-19、UC-1~UC-5
- 追踪视角：5 视角全适用，重点验证 P1（action 副作用）、P3（创建后触发）、P5（守卫边界）

## Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G-R4-001 | F | P1 User Journey | before-agent-start-handler.ts:136-143 | staleness reminder 注入时**重置被提醒 task/subtask 的 `lastUpdatedTurn`**（避免下一轮再次触发提醒）。spec FR-8.6 说"注入提醒（不改状态）"——描述不准确，实际有 mutate。新架构若按字面"不改状态"实现会导致 staleness reminder 每轮重复触发同一批 task |
| G-R4-002 | F | P1 User Journey | action-handlers.ts:137-139, 143-154 | `update_tasks` 把 task 标 `completed` 且该 task 有 verification 配置时，立即调 `injectVerificationSteering`（deliverAs="steer"）注入提示 AI 跑验证命令。spec FR-1.2/FR-8.6 提到双维度但未描述这个**即时 steering 副作用**。新架构若只在 prompt 文本里写规则，AI 可能不知道该立刻跑验证 |
| G-R4-003 | F | P4 State Machine | action-handlers.ts:233-237 | `complete_goal` 有"至少一个 task 必须 completed/verified，全 cancelled 不算完成"守卫。spec FR-8 提到 complete_goal 的 notDone 检查和 prompt 的"cancelled 不阻塞 goal 完成"，但未显式描述"不能全 cancelled"这条独立守卫 |
| G-R4-004 | F | P4 State Machine | action-handlers.ts:308 | `add_subtasks` 拒绝给 `completed` 状态的 task 加 subtask（`isTerminalTaskStatus(status) \|\| status === "completed"`）。由于 completed 在 isTerminalTaskStatus 中不算终态（verified 才是），这条额外守卫是刻意业务决策。spec 未描述 |
| G-R4-005 | F | P1 User Journey | command-handler.ts:298 | `/goal set` 创建 goal 后调 `pi.sendUserMessage(objective, { deliverAs: "followUp" })` 触发 AI 开始工作。这是创建流程的**关键尾部副作用**（用户输 `/goal <obj>` 后 AI 自动开始执行）。spec FR-3.1/FR-8.4 完全未提及。新架构若漏掉，用户 set goal 后 AI 不会自动启动 |

## 5 视角追踪摘要

### P1: User Journey
追踪 8 个 /goal 子命令 + 10 个 tool action + __goalInit。
- handleSet/handleClear/handleAbort/handleUpdate/handlePause/handleResume/handleStatus/handleHistory 全部验证，行为与 FR-8.4/8.7 一致
- 10 个 action handler 行为基本与 FR-8 一致
- 发现 G-R4-002（update_tasks verification steering）、G-R4-005（set 后 sendUserMessage）两处遗漏

### P2: Data Lifecycle
GoalRuntimeState / GoalHistoryEntry / GoalSession 三模型追踪。
- Entry GC（G-006）、AUTO_CLEAR_TURNS（G-007）、部分损坏全丢（G-024）、persist 失败保持现状（G-023）spec 均已覆盖
- cancel_goal / clear / abort 都 writeHistoryEntry + clearGoalSession，与 FR-8.7 cancelled 立即 clear 一致
- 无 gap

### P3: API Contract
goal_manager tool schema（10 action）/ /goal 8 子命令 / __goalInit 签名追踪。
- schema 与 FR-3/AC-4 一致
- **唯一遗漏**：`/goal set` 创建后的 `sendUserMessage(deliverAs="followUp")` 尾部副作用（G-R4-005）
- 其余契约 spec 覆盖完整

### P4: State Machine
Goal 7 态 / Task 5 态 / Subtask 3 态追踪。
- transitionStatus 宽松守卫（G-016）、completed 无 verification 全锁（G-017）、subtask 宽松（G-018）spec 均覆盖
- 发现 G-R4-003（complete_goal 全 cancelled 守卫）、G-R4-004（add_subtasks 对 completed task 的限制）两处遗漏

### P5: Failure Path
deserialize throw / persist 失败 / stale context / 并发 / 预算 / maxTurns / stall 追踪。
- goalId snapshot stale-checker（G-020）、isProcessing 防重入（G-021）、stale context patterns（G-010）、continuation 去抖（G-R2-005）spec 均覆盖
- agent_end 分支优先级（FR-8.7）与代码一致：allTasksDone(maxTurns→complete / budgetTight→steer / else→followUp) → noTasks(maxTurns→cancelled / else→followUp) → maxTurns→cancelled → stall+continuation
- **ESC 行为差异已确认是 spec 故意变更**（D-18/FR-6.7）：当前代码 pendingPause→paused 将被改为纯打断。这是 spec 明确的行为演进，非 gap
- 无新 gap

## 详细追踪依据

### G-R4-001 依据
`before-agent-start-handler.ts:134-143`:
```
if (staleTasks.length > 0) {
    // 重置被提醒项的 lastUpdatedTurn
    for (const item of staleTasks) {
        item.task.lastUpdatedTurn = state.currentTurnIndex;
        if (item.task.subtasks) {
            for (const s of item.task.subtasks) {
                if (s.status !== "completed") s.lastUpdatedTurn = state.currentTurnIndex;
            }
        }
    }
    return { message: { ... stalenessReminderPrompt(...) } };
}
```
spec FR-8.6 原文："staleness reminder（TASK_STALL_TURN_THRESHOLD=10）：检查单个 task/subtask 是否 10 turn 未更新 → 注入提醒（不改状态）"——"不改状态"与代码 mutate 矛盾。

### G-R4-002 依据
`action-handlers.ts:119-139`：update_tasks 中 `if (u.status === "completed") { ... if (task.verification) tasksNeedingVerification.push(task); }`，循环后 `if (tasksNeedingVerification.length > 0) injectVerificationSteering(pi, tasksNeedingVerification)`。injectVerificationSteering 发 deliverAs="steer" 消息。

### G-R4-003 依据
`action-handlers.ts:233-237`：
```
const completedOrVerified = state.tasks.filter((t) => t.status === "completed" || t.status === "verified");
if (completedOrVerified.length === 0) {
    return errorResult("At least one task must be completed or verified. All-cancelled does not count.");
}
```

### G-R4-004 依据
`action-handlers.ts:307-310`：
```
// isTerminalTaskStatus 不含 completed（completed 有 verification 时需转为 verified）
// 这里的 || completed 是有意的业务决策：completed 任务不允许加 subtask
if (isTerminalTaskStatus(parentTask.status) || parentTask.status === "completed") {
    return errorResult(`Task #${parentTask.id} in terminal state (${parentTask.status}), cannot add subtask`);
}
```

### G-R4-005 依据
`command-handler.ts:298`：`pi.sendUserMessage(objective, { deliverAs: "followUp" });`——handleSet 的最后一步，在 persistAndUpdate + notify 之后。这是 goal 创建后驱动 AI 开始 autonomous loop 的触发点。
