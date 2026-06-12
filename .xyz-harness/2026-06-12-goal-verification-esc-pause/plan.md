# Plan: Goal Verification, Widget Collapse, ESC Pause

## Task 分解

### T1: 数据模型扩展 (state.ts)
- `GoalTask` 新增可选字段 `verification?: { method: string; expected: string }`
- `GoalTask` 新增可选字段 `verificationFor?: number`（verify_task 关联原 task）
- `GoalSession` 新增 `pendingPause: boolean`
- `deserializeState` 为新字段补默认值
- 新增 helper: `isVerifyTask(task)` — 检查 `verificationFor !== undefined`
- 新增 helper: `getIncompleteVerifyTasks(tasks)` — 返回未终态的 verify_task

### T2: Tool Schema + Description (tool-handler.ts, index.ts)
- `GoalManagerParams` 的 create_tasks/add_tasks 增加 `verifications` 可选参数
- `goal_manager` tool description 增加 Verification 相关 promptGuidelines（模板、反例）
- `GoalManagerParams` 新增 `verify_task` action（可选，或复用 update_tasks）

实际上 verify_task 不需要独立 action — AI 用 update_tasks(completed) 标记 verify_task 完成即可。只需要 steering 引导。

### T3: Action Handlers (action-handlers.ts)
- `handleCreateTasks`: 解析 verifications 参数，写入 task.verification
- `handleAddTasks`: 同上
- `handleUpdateTasks`: 当 task 有 verification 且 status→completed 时：
  - 自动创建 verify_task（平级 task）
  - 注入 steering 提示 AI 执行验证
  - 返回消息包含 verify_task 信息
- `handleUpdateTasks`: verify_task 约束 — 不能在原 task completed 之前完成
- `handleCompleteGoal`: 新增检查 — 所有 verify_task 必须终态

### T4: Steering Templates (templates.ts)
- `continuationPrompt`: 增加验证引导规则
- 新增 `verifyTaskPrompt(task, verification)` — 注入给 AI 的验证执行提示
- `contextInjectionPrompt`: 增加验证规则

### T5: Widget (widget.ts)
- FR-1: `renderWidgetLines` 中，task 下所有 subtask completed 时不渲染 subtask 行
- FR-2.6: 非验证 task 右侧显示验证方法（截断 40 字符）
- verify_task 行前缀 `[验证]` 视觉区分

### T6: ESC Pause (tool-handler.ts, agent-end-handler.ts)
- `executeGoalAction`: signal.aborted 时设置 `session.pendingPause = true`
- `handleStallAndContinuation`: 检查 pendingPause，有则 pause + notify + return

### T7: 向后兼容 + 测试
- deserializeState 测试：旧格式数据（无 verification/verificationFor）正确加载
- typecheck 通过
- lint 通过

## 执行顺序

T1 → T2 → T3 → T4 → T5 → T6 → T7（线性依赖）

T5(FR-1 subtask 收起) 和 T6(FR-3 ESC) 互相独立，可以和 T2-T4 交叉，但改动量小（各 ~15 行），串行也很快。

## 风险

- **verify_task 的 steering 注入时机**：update_tasks 中创建 verify_task 后需要 sendUserMessage 注入提示。但 update_tasks 是 tool execute，sendUserMessage 是否可用需确认。[VERIFIED] tool-handler.ts 中 `pi` 对象在 execute 闭包中可用。
- **widget 双列对齐**：TUI 中没有真正的列布局，需要用空格填充。task 描述长度不固定，需要计算截断。简单方案：固定 task 描述列宽 40 字符，不足补空格。
