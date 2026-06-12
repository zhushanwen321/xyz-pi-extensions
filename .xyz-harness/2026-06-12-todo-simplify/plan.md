---
verdict: pass
---

# Plan: Todo 扩展简化

## 依赖关系

```
Task 1 (model.ts) ──┬──> Task 3 (tool.ts)
                    ├──> Task 4 (handlers.ts)
                    ├──> Task 5 (render.ts + component.ts)
                    └──> Task 2 (test.ts)
Task 6 (双列 widget) ── 独立，依赖 Task 5 完成
Task 7 (集成验证) ── 最后执行
```

## Task 1: model.ts 三态简化

**文件**: `extensions/todo/src/model.ts`

1. `Todo` 接口：删除 `verifyText`、`verifyAttempts`、`evidence`，只保留 `id`、`text`、`status`
2. `VALID_STATUSES` 改为 `["pending", "in_progress", "completed"]`
3. `addTodos()`: 删除 `verifyTexts` 参数
4. `updateTodos()`: 删除所有验证拦截逻辑（blockedItems 分支、verifying/completed 拦截），直接应用状态变更；删除 verifyAttempts++ 逻辑
5. `migrateTodo()`: `verifying` → `in_progress`，`failed` → `pending`；删除 verifyText/verifyAttempts/evidence 迁移
6. `formatTodoLine()`: 删除所有 verifyTag 分支，mark 只处理三种状态
7. `buildRender()`: 不变（已与验证无关）
8. 删除 `MIN_EVIDENCE_LENGTH`、`MAX_VERIFY_ATTEMPTS` 常量

## Task 2: test.ts 重写

**文件**: `extensions/todo/src/__tests__/todo.test.ts`

1. 删除所有验证相关 describe 块（verifyAttempts、verifying state transitions、batch verify 等）
2. 保留并简化：数据模型测试（三态）、add 测试（无 verifyTexts）、batch update 测试（无拦截）、formatTodoLine 测试（三态）、buildRender 测试
3. 新增：migrateTodo 将 verifying→in_progress、failed→pending 的测试
4. 新增：updateTodos 对 completed 无拦截的测试

## Task 3: tool.ts 参数简化

**文件**: `extensions/todo/src/tool.ts`

1. `TodoParams`: 删除 `verifyTexts`、`verified`、`evidence` 参数；`status` 枚举只含三态；`updates[]` 内部删除 `verified`、`evidence`
2. `promptGuidelines`: 删除验证流程/跳过验证/验证失败三条，保留 Usage/Goal 冲突/批量优先/自动闭合/Not for
3. `handleAdd()`: 删除 verifyTexts 传参
4. `handleSingleUpdate()`: 删除所有 verifying/completed 拦截逻辑；保留 isLastCompletion 检测（用于 FR-2 steer 注入）
5. `handleBatchUpdate()`: 删除 blockedItems 分支
6. `mapUpdateErrorText()`: 删除 verifyText/evidence 相关 case
7. `description` 字符串：删除 verifyTexts 说明

## Task 4: handlers.ts 注入简化 + FR-2 steer

**文件**: `extensions/todo/src/handlers.ts`

1. 删除 `MAX_VERIFY_ATTEMPTS` 常量
2. `REMINDER_INTERVAL` 从 3 改为 2
3. `buildPendingContext()`: 改为极简版——只返回 `[TODO] 你有 N 个未完成任务。下一个应处理：#X {text}`
4. `handleVerifyFailure()`: 整个函数删除
5. `agent_end` orchestrator: 删除 verify-failure 调用
6. `buildBeforeAgentStartMessage()`: 简化注入内容，删除验证规则
7. 新增 FR-2 逻辑：在 `handleSingleUpdate`/`handleBatchUpdate` 检测到全部 completed 时（或 agent_end 中检测），注入 steer `[TODO] 所有任务已完成。请快速检查每项任务的交付质量。`
   - 方案：在 agent_end 中检测"本轮新变为全部 completed"（对比之前的状态），注入 steer
   - 需要在 state 中加 `completionSteered: boolean` 标记，防止重复注入

## Task 5: render.ts + component.ts 去验证渲染

**文件**: `extensions/todo/src/render.ts`, `extensions/todo/src/component.ts`

1. `renderWidgetLines()`: 删除 verifying/failed/verifyTag 分支，mark 只处理三态
2. `buildTodoListText()`: 同上
3. `renderTodoResult()`: 同上
4. `TodoListComponent.render()`: 同上
5. 两个文件中的 verifyTag 逻辑全部删除

## Task 6: Widget 双列布局

**文件**: `extensions/todo/src/render.ts`（`renderWidgetLines` 函数）

1. 获取终端宽度：`process.stdout.columns || 80`
2. 计算每列最大宽度：`Math.floor((termWidth - 6) / 2)`（减去缩进 2 + 间距 4）
3. 分割 todo 列表为左半/右半：`half = Math.ceil(todos.length / 2)`
4. 按行拼接：每行 `leftCol + "   " + rightCol`，每列内容截断到 maxColWidth
5. 第一行保留 `☑ N/M` 进度摘要
6. 注意 ANSI 转义字符占位：用 `truncateToWidth`（pi-tui 已提供）处理带颜色的字符串

## Task 7: 集成验证

1. `pnpm --filter @zhushanwen/pi-todo typecheck` 无错误
2. `pnpm --filter @zhushanwen/pi-todo test` 全部通过
3. `pnpm --filter @zhushanwen/pi-todo lint` 无错误
4. 全量 `pnpm -r typecheck` 确认无下游影响
