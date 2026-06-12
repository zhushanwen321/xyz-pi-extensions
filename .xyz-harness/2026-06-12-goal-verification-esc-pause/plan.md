# Plan: Goal Verification, Widget Collapse, ESC Pause

## Task 分解

### T1: 数据模型扩展 (state.ts)
- `GoalTask` 新增可选字段 `verification?: { method: string; expected: string; actual?: string }`
- `TaskStatus` 新增 `"verified"` 值
- `GoalSession` 新增 `pendingPause: boolean`
- `deserializeState` 为新字段补默认值
- 新增 helper: `isTaskDone(task)` — verified/cancelled/completed+无verification 均为 done
- 新增 helper: `isTerminalTaskStatus()` 语义变更：`verified || cancelled`（completed 不再是终态）
- 新增 helper: `getNextTaskId(tasks)`

### T2: Tool Schema + Description (tool-handler.ts, index.ts)
- `GoalManagerParams` 的 create_tasks/add_tasks 增加 `verifications` 可选参数
- `GoalManagerParams` 的 updates 增加 `actual` 可选参数（verified 时必填）
- `goal_manager` tool description 增加 Verification 相关 promptGuidelines（模板、反例、状态流）

### T3: Action Handlers (action-handlers.ts)
- `handleCreateTasks`: 解析 verifications 参数，写入 task.verification
- `handleAddTasks`: 同上
- `handleUpdateTasks`: 新增 `validateUpdateTasks` 状态转换验证（合法转换白名单）
  - 当 task 有 verification 且 status→completed 时：注入 verification steering（不创建独立 task）
  - 当 status→verified 时：要求 actual 参数 + task 必须有 verification 配置
- `handleCompleteGoal`: 使用 `isTaskDone()` 替代原有终态检查
- `handleAddSubtasks`: 适配 isTerminalTaskStatus 语义变更（显式检查 completed）

### T4: Steering Templates (templates.ts)
- `continuationPrompt`: 增加验证引导规则 + quick-exit 规则
- `contextInjectionPrompt`: 增加验证规则
- `formatTaskList`: 新增 Verified 分组 + [awaiting verification] 标签 + [验证: method] 标签

### T5: Widget (widget.ts) + renderResult (index.ts)
- FR-1: `renderWidgetLines` 中，task 下所有 subtask completed 时不渲染 subtask 行
- FR-2.6: verified 用 ◉ 图标 / completed+verification 用 [待验证] 标签 / in_progress+verification 用 [验证: method] 标签
- `renderStatusLine`: 分离 verified/completed/pending-verify 计数
- `renderResult` (index.ts): 增加 verified 图标 + 用 getCompletedCount 计数 + verified dim 色

### T6: ESC Pause (tool-handler.ts, agent-end-handler.ts)
- `executeGoalAction`: signal.aborted 时设置 `session.pendingPause = true`
- `handleAgentEnd`: 文本生成中断也设置 pendingPause
- `handleStallAndContinuation`: 检查 pendingPause，有则 pause + notify + return
- `clearGoalSession`: 重置 `pendingPause = false`

### T7: Command (command-handler.ts, commands.ts)
- 新增 `/goal abort` 命令：无 task 或全 cancelled 时允许 abort
- `handleUpdate` 的 steer 改用 `sendGoalContextMessage`（hidden message）

### T8: 共享工具提取
- `sendGoalContextMessage` 从 agent-end-handler.ts / command-handler.ts / action-handlers.ts 提取到 tool-handler.ts

### T9: 向后兼容 + 测试
- deserializeState 测试：旧格式数据（无 verification/verified）正确加载
- validateUpdateTasks 测试：完整的状态转换验证（15+ 用例）
- isTaskDone 测试：各种状态组合（5+ 用例）
- typecheck 通过
- lint 通过

## 执行顺序

T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9（线性依赖）

T5(FR-1 subtask 收起) 和 T6(FR-3 ESC) 互相独立，可以和 T2-T4 交叉。

## 与 Spec 的偏离

| Spec 方案 | 实际实现 | 原因 |
|-----------|---------|------|
| 创建独立 verify_task（平级 task + verificationFor） | 同 task 的 completed→verified 两阶段状态 | 更简洁，无额外 task 污染列表，状态机更清晰 |
| Widget 双列布局 | 行内标签（[待验证]、[验证: method]） | TUI 无真正列布局，行内标签更实用 |
| verify_task 需要 evidence | verified 需要 actual 参数 | 语义更准确（actual 是实际验证结果） |
| AI 文本生成中断不覆盖 | agent_end 中增加 ctx.signal?.aborted 检查 | 超出 spec 范围但用户需求明确 |
