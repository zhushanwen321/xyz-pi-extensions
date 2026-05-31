# Todo Extension v3 实现计划

## 概述

将 spec 中的设计转化为具体实现，修改文件：`todo/src/index.ts`

## 任务清单

### Task 1: 新增状态变量

**文件：** `todo/src/index.ts`

**改动：** 在模块级状态区域添加新变量

```typescript
// 现有状态
let todos: Todo[] = [];
let nextId = 1;

// 新增状态
let userMessageCount: number = 0;
let allCompletedAtCount: number | null = null;
let lastTodoCallCount: number = 0;
let lastReminderCount: number = 0;
```

**验证：** TypeScript 编译通过

---

### Task 2: 更新 executeTodoAction 追踪调用

**文件：** `todo/src/index.ts`

**改动：** 在 `executeTodoAction` 函数中：

1. 更新 `lastTodoCallCount = userMessageCount`（任何 action 调用时）
2. 在 `add` action 中，重置 `allCompletedAtCount = null`
3. 在 `clear` action 中，重置 `allCompletedAtCount = null`
4. 在 `update` action 中，检查是否全部完成：
   - 如果是，设置 `allCompletedAtCount = userMessageCount`
   - 如果之前是全部完成但现在新增了未完成任务，重置 `allCompletedAtCount = null`

**验证：** 添加 todo 后 allCompletedAtCount 为 null，全部完成后设置

---

### Task 3: 添加 agent_start 事件监听

**文件：** `todo/src/index.ts`

**改动：** 在扩展入口添加事件监听

```typescript
pi.on("agent_start", async (_event, ctx) => {
  userMessageCount++;
});
```

**验证：** 每次用户消息后 userMessageCount 递增

---

### Task 4: 添加 before_agent_start 事件监听

**文件：** `todo/src/index.ts`

**改动：** 在扩展入口添加事件监听

```typescript
pi.on("before_agent_start", async (_event, ctx) => {
  // 1. 检查自动清空
  if (allCompletedAtCount !== null && userMessageCount - allCompletedAtCount >= 2) {
    const count = todos.length;
    todos = [];
    nextId = 1;
    allCompletedAtCount = null;
    refreshDisplay(ctx);
    
    return {
      message: {
        customType: "todo-auto-clear",
        content: `所有 ${count} 个 todo 已完成，列表已自动清空。`,
        display: false,
      },
    };
  }

  // 2. 检查 Verification Nudge（仅在全部完成时）
  if (allCompletedAtCount !== null && todos.length >= 3 && !todos.some(t => /verif|验证/i.test(t.text))) {
    lastReminderCount = userMessageCount;
    return {
      message: {
        customType: "todo-verification-nudge",
        content: "你刚完成了 3+ 个任务但没有验证步骤。建议在总结前添加验证任务。",
        display: false,
      },
    };
  }

  // 3. 检查 Todo Reminder
  if (todos.length > 0 && 
      allCompletedAtCount === null &&
      userMessageCount - lastTodoCallCount >= 10 && 
      userMessageCount - lastReminderCount >= 10) {
    lastReminderCount = userMessageCount;
    return {
      message: {
        customType: "todo-reminder",
        content: "Todo 工具最近没有被使用。如果你在处理任务，建议使用它来跟踪进度。",
        display: false,
      },
    };
  }

  return undefined;
});
```

**验证：**
- 自动清空在 2 轮后触发
- Todo Reminder 在 10 轮未调用后触发
- Verification Nudge 在完成 3+ 无验证任务后触发

---

### Task 5: 更新 reconstructState

**文件：** `todo/src/index.ts`

**改动：** 在 `reconstructState` 中初始化新状态

```typescript
const reconstructState = (ctx: ExtensionContext) => {
  todos = [];
  nextId = 1;
  
  // 重置新状态（无法从 entries 恢复，使用默认值）
  userMessageCount = 0;
  allCompletedAtCount = null;
  lastTodoCallCount = 0;
  lastReminderCount = 0;

  // ... 现有逻辑不变
};
```

**验证：** session 恢复后状态正确初始化

---

### Task 6: 更新 promptGuidelines

**文件：** `todo/src/index.ts`

**改动：** 更新工具描述中的 `promptGuidelines`

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
],
```

**验证：** Prompt 更新正确

---

### Task 7: 更新 _render 描述符

**文件：** `todo/src/index.ts`

**改动：** 在 `buildRender` 中添加自动清空状态

```typescript
function buildRender(todoList: Todo[]): TodoDetails["_render"] {
  const completed = todoList.filter((t) => t.status === "completed").length;
  const total = todoList.length;
  return {
    type: "task-list" as const,
    summary: `${completed}/${total} 已完成`,
    data: {
      items: todoList.map((t) => ({ id: t.id, text: t.text, status: t.status })),
      meta: {
        ...(allCompletedAtCount !== null ? { autoClear: `${2 - (userMessageCount - allCompletedAtCount)} 轮后清空` } : {}),
      },
    },
  };
}
```

**验证：** GUI 能显示自动清空倒计时

---

## 执行顺序

1. Task 1: 新增状态变量
2. Task 5: 更新 reconstructState
3. Task 2: 更新 executeTodoAction
4. Task 3: 添加 agent_start 监听
5. Task 4: 添加 before_agent_start 监听
6. Task 6: 更新 promptGuidelines
7. Task 7: 更新 _render 描述符

## 验证方式

```bash
# 类型检查
cd todo && npx tsc --noEmit

# 手动验证（启动 Pi 后）
1. 添加 3 个 todo
2. 完成所有 todo
3. 发送 2 条消息后检查是否自动清空
4. 添加新 todo，等待 10 轮检查提醒
```
