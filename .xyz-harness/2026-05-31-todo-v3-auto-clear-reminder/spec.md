---
title: Todo Extension v3 升级规格
date: 2026-05-31
status: draft
author: pi-agent
verdict: pass
---

# Todo Extension v3 升级规格

## 概述

基于 Claude Code V1 TodoWrite 的设计理念，为 Pi Todo 扩展添加三个核心能力：自动清空、Todo Reminder、Verification Nudge。

## 功能清单

| 功能 | 描述 | 状态 |
|------|------|------|
| 自动清空 | 所有 todo 完成后，保留 2 轮用户消息，第 3 轮自动清空 | 新增 |
| Todo Reminder | 10 轮对话未调用 todo 工具时，提醒 agent 使用 | 新增 |
| Verification Nudge | 完成 3+ 任务且无验证步骤时，提醒 agent 添加验证 | 新增 |

## 数据结构

保持现有 `Todo` 接口不变：

```typescript
interface Todo {
  id: number;
  text: string;
  status: "pending" | "in_progress" | "completed";
}
```

## 新增状态

```typescript
// 用户消息轮数追踪
let userMessageCount: number = 0

// 自动清空追踪
let allCompletedAtCount: number | null = null  // 全部完成时的 userMessageCount

// 提醒追踪
let lastTodoCallCount: number = 0    // 上次调用 todo 时的 userMessageCount
let lastReminderCount: number = 0    // 上次提醒时的 userMessageCount
```

## 行为规范

### 1. 自动清空

**触发条件：**
- 所有 todo 状态为 `completed`（或列表为空）
- 距离全部完成已过 2 轮用户消息
- 仅在 `before_agent_start` 时检查

**实现逻辑：**
```
if (allCompletedAtCount !== null && userMessageCount - allCompletedAtCount >= 2) {
  todos = []
  nextId = 1
  allCompletedAtCount = null
  refreshDisplay(ctx)
  
  return {
    message: {
      customType: "todo-auto-clear",
      content: "所有 todo 已完成，列表已自动清空。",
      display: false
    }
  }
}
```

**边界情况：**
- 新增 todo 后 `allCompletedAtCount` 重置为 `null`
- `clear` action 后 `allCompletedAtCount` 重置为 `null`

### 2. Todo Reminder

**触发条件：**
- todo 列表非空
- 距离上次调用 todo 工具已过 10 轮用户消息
- 距离上次提醒已过 10 轮用户消息
- 自动清空未触发

**实现逻辑：**
```
if (todos.length > 0 && 
    allCompletedAtCount === null &&
    userMessageCount - lastTodoCallCount >= 10 && 
    userMessageCount - lastReminderCount >= 10) {
  lastReminderCount = userMessageCount
  
  return {
    message: {
      customType: "todo-reminder",
      content: "Todo 工具最近没有被使用。如果你在处理任务，建议使用它来跟踪进度。",
      display: false
    }
  }
}
```

### 3. Verification Nudge

**触发条件：**
- 所有 todo 完成
- todo 数量 >= 3
- 没有包含 "verif" 或 "验证" 关键词的任务
- 在自动清空前检查

**实现逻辑：**
```
if (allCompleted && todos.length >= 3 && !todos.some(t => /verif|验证/i.test(t.text))) {
  return {
    message: {
      customType: "todo-verification-nudge",
      content: "你刚完成了 3+ 个任务但没有验证步骤。建议在总结前添加验证任务。",
      display: false
    }
  }
}
```

## Prompt 更新

更新 `promptGuidelines`：

```typescript
promptGuidelines: [
  "[使用场景] 多步骤任务（3+步）、需要追踪进度、用户明确要求时使用 todo",
  "[不适用] 单步操作、任务简单可直接完成、已在用 goal_manager 时",
  "[时机] 开始工作前创建，完成时立即标记",
  "[状态] 同一时间最多一个 in_progress，完成后立即标记 completed",
  "[粒度] 一个 todo 对应一个可验证的工作单元，3-8 项为宜",
  "[完成] 所有 todo 完成后会自动清空（保留 2 轮后）",
  "[验证] 完成 3+ 任务时建议添加验证步骤",
  "[定位] 不要用 todo 替代 goal_manager，两者定位不同",
]
```

## 事件监听

```typescript
// 监听用户消息轮数
pi.on("agent_start", async (_event, ctx) => {
  userMessageCount++
})

// 监听 before_agent_start 检查提醒和自动清空
pi.on("before_agent_start", async (event, ctx) => {
  // 1. 检查自动清空
  // 2. 检查 Verification Nudge（在清空前）
  // 3. 检查 Todo Reminder（仅当未清空时）
  // 返回 message 或 undefined
})
```

## 向后兼容

- 现有 `Todo` 接口不变
- 新增状态使用 `null` 默认值，reconstructState 需要处理
- 旧 session 文件无需迁移

## 不做的事项

- ❌ `activeForm` 字段（用户认为没意义）
- ❌ 磁盘持久化（保持内存存储）
- ❌ 依赖关系系统（超出范围）
- ❌ 任务分配功能（超出范围）
