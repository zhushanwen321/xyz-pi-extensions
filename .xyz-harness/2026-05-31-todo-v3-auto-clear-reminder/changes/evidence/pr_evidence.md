---
pr_created: true
pr_title: "feat(todo): v3 auto-clear, reminder, and verification nudge"
branch: main
---

# PR Evidence

直接在 main 分支开发并推送（项目无分支保护，无 PR 流程）。

## 变更摘要

- `todo/src/index.ts`：新增 3 个功能（自动清空、Todo Reminder、Verification Nudge）
  - 4 个状态变量（userMessageCount, allCompletedAtCount, lastTodoCallCount, lastReminderCount）
  - agent_start 事件追踪用户消息轮数
  - before_agent_start 事件实现自动清空（>= 2 轮）、Verification Nudge（>= 3 任务）、Todo Reminder（>= 10 轮）
  - promptGuidelines 从 6 条更新到 8 条
  - 3 个命名常量：AUTO_CLEAR_DELAY_ROUNDS, VERIFICATION_NUDGE_THRESHOLD, TODO_REMINDER_INTERVAL

## 提交历史

```
b7b116c docs: add test phase retrospect for todo-v3
322485c chore: add taste_review alias for gate compatibility
24aa199 test: add test execution results for todo-v3 (8/8 pass)
ce854bf docs: add dev phase retrospect for todo-v3
ab7481b docs: add v2 reviews for todo-v3 dev phase (all pass)
14eeffb docs: add dev phase reviews for todo-v3 (BLR, integration, robustness)
ae88c16 fix(todo): add try/catch to before_agent_start and clarify state variable comments
a61541c fix(todo): change auto-clear threshold to >= per review feedback
ab7481b docs: add v2 reviews for todo-v3 dev phase (all pass)
ae5ac13 fix(todo): extract magic numbers to named constants
fab55ff feat(todo): add v3 auto-clear, reminder, and verification nudge
```
