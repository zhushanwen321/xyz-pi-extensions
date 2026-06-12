---
verdict: pass
---

# Todo 扩展简化：去验证 + 提频 + 双列 Widget

## Background

当前 todo 扩展有完整的验证体系（verifyText/evidence/verifying 状态/verifyAttempts），实际使用中验证拦截导致完成率低、AI 困在验证流程中。需要简化为三态模型，提高任务完成率。

## Functional Requirements

### FR-1: 删除验证体系，简化为三态

- 状态从 5 态缩减为 3 态：`pending → in_progress → completed`
- 删除 `verifying`、`failed` 两个状态
- 删除 `verifyText`、`verifyAttempts`、`evidence` 字段
- 删除 `add` 的 `verifyTexts` 参数
- 删除 `update` 的 `verified`、`evidence` 参数
- `update` 标记 `completed` 无任何拦截，直接通过
- `promptGuidelines` 删除所有验证规则条目
- 渲染层删除 `verifying`/`failed`/`verifyTag` 相关分支

### FR-2: 全部完成时注入总检查 steer

- 当最后一个 pending/in_progress 任务被标记 completed 时（单个 update 或 batch update），通过 `pi.sendUserMessage` 注入一条 steer
- 内容极简：`[TODO] 所有任务已完成。请快速检查每项任务的交付质量。`
- 不强制、不阻塞，AI 自行决定是否检查

### FR-3: 每 2 turn 注入极简提醒

- `REMINDER_INTERVAL` 从 3 改为 2
- 注入内容改为极简版：`[TODO] 你有 N 个未完成任务。下一个应处理：#X {text}`
- 只提醒下一个推荐任务（按 id 顺序，第一个非 completed 的任务）
- `STALL_THRESHOLD` 保持 5 不变（stall 是独立的兜底机制）
- `before_agent_start` 注入也同步简化（去掉验证规则，保留 pending 列表但精简格式）

### FR-4: Widget 双列布局

- 当前 widget 单列展示，超过 ~11 行被隐藏
- 改为左右双列顺序排列：左列放前半，右列放后半
- 例：20 个 todo → 左列 1-10，右列 11-20，拼成 10 行
- 奇数个 todo 时最后一行只有左列
- 列间距 3 个空格，每列内容截断到 `(终端宽度 / 2 - 4)` 字符
- 终端宽度取 `process.stdout.columns`，fallback 80
- 第一行保留进度摘要（`☑ 3/20`），最后一行保留操作提示

## Acceptance Criteria

- AC-1: `VALID_STATUSES` 只包含 `pending`、`in_progress`、`completed`
- AC-2: `Todo` 接口只有 `id`、`text`、`status` 三个字段
- AC-3: `addTodos()` 不接受 `verifyTexts` 参数
- AC-4: `updateTodos()` 对 `completed` 无拦截，直接通过
- AC-5: `formatTodoLine()` 不输出验证相关文本
- AC-6: 全部 completed 时触发一条 steer（内容包含"所有任务已完成"）
- AC-7: `REMINDER_INTERVAL = 2`，注入内容只含下一个推荐任务
- AC-8: Widget 15 个 todo 时渲染为 8 行（1 行标题 + 7 行双列 + 1 行底部）
- AC-9: 旧 entry 中 `verifying`/`failed` 状态 migrate 为 `in_progress`/`pending`
- AC-10: 所有测试通过，`pnpm --filter @zhushanwen/pi-todo typecheck` 无错误

## Constraints

- 向后兼容：旧 session entry 中可能有 verifying/failed 状态，`migrateTodo` 需映射到新三态
- widget 是 `string[]`，无 width 参数，需自行估算终端宽度
- `state.ts` 接口不变（无验证相关字段）

## 业务用例

### UC-1: AI 创建多步骤任务并逐步完成
- **Actor**: AI agent
- **场景**: 用户要求修复 3 个 bug，AI 创建 3 个 todo
- **预期结果**: AI 每 2 turn 被提醒下一个任务，完成后无验证拦截，全部完成时收到总检查提示

### UC-2: 旧 session 恢复
- **Actor**: AI agent
- **场景**: session 重建时，旧 entry 中有 verifying/failed 状态的 todo
- **预期结果**: verifying → in_progress，failed → pending，数据不丢失

## Complexity Assessment

低复杂度。主要是删代码和简化逻辑。双列 widget 是唯一新增逻辑，约 30 行。
