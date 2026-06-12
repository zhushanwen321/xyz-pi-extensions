---
template: feature-plan
created: "2026-06-12"
status: draft
---

# Feature Plan: /goal abort — 无 task 时直接退出 goal

## Overview

Goal 启动后、AI 尚未创建 task 前，如果 AI 发现目标已经满足（如 typo 已被修、文件已存在），当前机制会反复催促 `create_tasks`，迫使 AI 走完整的 create→update→complete 流程。需要提供一条"目标已满足，直接退出"的路径。

**核心约束**：代码级校验 `tasks` 为空或 undefined 时才允许 abort。

## Requirements

1. 用户可通过 `/goal abort` 手动退出（仅无 task 时允许）
2. AI 可通过 `cancel_goal` action 退出（已有能力），但 steering prompt 需引导：无 task 且目标已满足时，应 cancel 而非继续 create_tasks
3. abort 时状态为 `cancelled`，写入 goal-history，清理 session

## Design Decisions

**决策：不新增 tool action，复用 `cancel_goal`**

`cancel_goal` 对 task 数量无限制，AI 侧无需新 action。用户侧新增 `/goal abort` 子命令作为快捷入口，本质是带前置校验的 cancel。

理由：多一个 action 增加 AI 选择复杂度，且 abort 语义和 cancel 高度重叠。通过校验 + prompt 引导即可覆盖两端需求。

## Implementation Steps

### Step 1: commands.ts — 新增 abort 子命令解析

- `GoalCommandArgs.action` 联合类型增加 `"abort"`
- `parseGoalArgs` 中增加 `if (trimmed === "abort") return { action: "abort" }`

### Step 2: command-handler.ts — handleAbort 子函数

- `handleGoalCommand` switch 增加 `case "abort"`
- 新增 `handleAbort` 函数，逻辑：
  1. 无 active goal → notify "Goal mode not active"
  2. `state.tasks && state.tasks.length > 0` → notify "Cannot abort: tasks already created (N). Use /goal clear to force cancel."
  3. 终态 → notify "Goal already in terminal state (status)"
  4. 否则：status → cancelled，writeGoalHistoryEntry，persistGoalState，clearGoalSession，notify "Goal aborted: no work needed."

### Step 3: templates.ts — 调整 steering prompt

`continuationPrompt` 中 `Tasks: Not created.` 的分支，改为：
```
Tasks: Not created. First check if the objective is already met. If yes, call cancel_goal with reason. Otherwise call create_tasks immediately.
```

### Step 4: agent-end-handler.ts — 调整 handleNoTasksOrMaxTurns

`handleNoTasksOrMaxTurns` 中 followUp 消息调整：
```
No task list created yet. First check if the objective is already satisfied. If yes, call goal_manager's cancel_goal with cancelReason. Otherwise call create_tasks immediately.
```

### Step 5: index.ts — 更新描述

- `registerCommand` 的 description 增加 `abort`
- `goal_manager` tool 的 `promptGuidelines` 补充一条：
  ```
  "[Quick exit] When no tasks have been created and you determine the objective is already met, call cancel_goal with cancelReason instead of creating tasks"
  ```

## File Change Summary

| 文件 | 改动类型 | 改动量 |
|------|---------|-------|
| `extensions/goal/src/commands.ts` | 修改 | ~3 行 |
| `extensions/goal/src/command-handler.ts` | 修改 | ~15 行 |
| `extensions/goal/src/templates.ts` | 修改 | ~2 行 |
| `extensions/goal/src/agent-end-handler.ts` | 修改 | ~2 行 |
| `extensions/goal/src/index.ts` | 修改 | ~3 行 |

## Testing Strategy

手动验证：
1. `/goal fix the typo` → `/goal abort` → 期望：cancelled，session 清理
2. `/goal fix the typo` → AI create_tasks 后 → `/goal abort` → 期望：拒绝，提示用 clear
3. `/goal fix the typo` → AI 判断已满足 → 调 cancel_goal → 期望：cancelled
4. 无 goal 时 `/goal abort` → 期望：提示未激活

## Risks & Mitigations

| 风险 | 缓解 |
|------|------|
| AI 过度使用 cancel_goal 跳过任务分解 | steering prompt 明确要求"先检查目标是否已满足"，evidence 逻辑已在 cancel_goal 中通过 promptGuidelines 引导 |
