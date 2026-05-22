---
verdict: pass
---

# E2E Test Plan — batch-operations

## Test Scenarios

### TS-1: Todo 批量添加（AC-1）
- 添加 3 条 todo，验证 ID 连续分配、返回汇总文本
- 添加 1 条 todo（单条等价），验证正常工作
- 添加空数组，验证返回错误
- 添加含空白字符串的数组，验证返回错误

### TS-2: Todo 批量删除（AC-2）
- 删除 2 条 todo，验证删除正确、返回汇总文本
- 删除不存在的 ID，验证整体报错不部分删除
- 删除重复 ID，验证去重后执行
- 删除 1 条（单条等价），验证正常工作

### TS-3: Todo update 保持单条（AC-3 部分）
- update id + status 正常工作
- update id + text 正常工作

### TS-4: GoalTask 四态（AC-3）
- create_tasks 创建的任务初始为 pending
- update_tasks: pending → in_progress → completed（正常流程）
- update_tasks: pending → cancelled（取消流程）
- update_tasks: 已 completed 任务变更状态 → 报错
- update_tasks: 已 cancelled 任务变更状态 → 报错
- completed 状态必须有 evidence

### TS-5: Goal update_tasks 批量（AC-4）
- 批量 update 3 条（2 completed + 1 cancelled），全部生效
- 批量 update 中某条 completed 缺 evidence → 整体报错
- 批量 update 中某条 taskId 不存在 → 整体报错
- 批量 update 空数组 → 报错
- 批量 update 中重复 taskId → 整体报错
- update_tasks 中非 completed 状态附带 evidence → 静默忽略

### TS-6: Goal complete_goal 四态适配（AC-5）
- 6 completed + 2 cancelled → 允许完成
- 6 completed + 2 pending → 拒绝，提示未完成
- 全部 cancelled → 拒绝

### TS-7: 渲染验证（AC-6）
- formatTaskList 输出三组：completed / in_progress+pending / cancelled
- renderCall 对 add 显示 (N items)
- renderCall 对 update_tasks 显示 (N updates)
- widget 状态栏显示完成/取消计数

### TS-8: 构建验证（AC-7, AC-8）
- `npx tsc --noEmit` 零错误
- `npm run lint` 零 error

## Test Environment

- 本地开发环境，手动验证
- 通过 Pi 运行时加载扩展，调用 tool 验证行为
- TypeScript 类型检查和 ESLint 作为自动化验证
