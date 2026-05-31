---
verdict: pass
complexity: L1
---

# Todo Extension v3 升级实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Pi Todo 扩展添加自动清空、Todo Reminder、Verification Nudge 三个能力，提升 agent 自主跟踪任务的体验。

**Architecture:** 在现有 todo 扩展中新增模块级状态变量追踪用户消息轮数和 todo 调用历史，通过 `before_agent_start` 事件监听实现自动清空和提醒注入。保持现有数据结构不变，所有新状态使用 `null` 默认值确保向后兼容。

**Tech Stack:** TypeScript, Pi Extension API (`@mariozechner/pi-coding-agent`), typebox

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `todo/src/index.ts` | modify | BG1 | 主扩展文件，添加状态变量、事件监听、更新 prompt |

---

## Spec Metrics Traceability

| Spec AC | 采纳状态 | 对应 Task |
|---------|---------|----------|
| AC-1 自动清空：所有 todo 完成后保留 2 轮用户消息，第 3 轮自动清空 | adopted | Task 1, 2, 4 |
| AC-2 Todo Reminder：10 轮对话未调用 todo 工具时提醒 | adopted | Task 1, 2, 4 |
| AC-3 Verification Nudge：完成 3+ 任务且无验证步骤时提醒 | adopted | Task 1, 2 |
| AC-4 Prompt 更新：更新使用场景指导 | adopted | Task 3 |

---

## Interface Contracts

### Module: todo

#### State: TodoRuntimeState

| Field | Type | Description |
|-------|------|-------------|
| todos | Todo[] | 当前 todo 列表 |
| nextId | number | 下一个 todo ID |
| userMessageCount | number | 用户消息轮数计数器 |
| allCompletedAtCount | number \| null | 全部完成时的 userMessageCount |
| lastTodoCallCount | number | 上次调用 todo 工具时的 userMessageCount |
| lastReminderCount | number | 上次提醒时的 userMessageCount |

#### Event: before_agent_start

| Handler | Returns | Description |
|---------|---------|-------------|
| `(_event, ctx)` | `{ message: { customType, content, display } } \| undefined` | 递增 userMessageCount + 检查并注入提醒消息 |

---

## Task List

| # | Task | Type | Depends on | Group |
|---|------|------|-----------|-------|
| 1 | 添加状态变量和 reconstructState 更新 | backend | — | BG1 |
| 2 | 添加 before_agent_start 事件监听（含 userMessageCount 递增） | backend | 1, 4 | BG1 |
| 3 | 更新 promptGuidelines | backend | 2 | BG1 |
| 4 | 更新 executeTodoAction 追踪调用 | backend | 1 | BG1 |
| 5 | 更新 _render 描述符 | backend | 4 | BG1 |

---

## Execution Groups

#### BG1: 核心逻辑实现

**Description:** 所有任务都在同一个文件 `todo/src/index.ts` 中修改，按依赖顺序串行执行。

**Tasks:** Task 1, Task 2, Task 3, Task 4, Task 5

**Files (预估):** 1 个文件（0 create + 1 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high、tdd-coder: medium） |
| 注入上下文 | spec.md、plan.md、CLAUDE.md 编码规范 |
| 读取文件 | `todo/src/index.ts` |
| 修改/创建文件 | `todo/src/index.ts` |

**Execution Flow (BG1 内部):** 串行派遣，每个 Task 走完整 subagent 链后再开始下一个 Task。

  Task 1:
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 2-5 (depends on previous):
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** Task 2 依赖 Task 1 + Task 4（使用 lastTodoCallCount）

**设计细节:** L1，直接写在此处

---

## Task Details

### Task 1: 添加状态变量和 reconstructState 更新

**Type:** backend

**Files:**
- Modify: `todo/src/index.ts:243-245`（模块级状态区域）
- Modify: `todo/src/index.ts:483-507`（reconstructState 函数）

- [ ] **Step 1: 添加新状态变量**

在模块级状态区域（约 243 行）添加：

```typescript
// ── 模块级状态 ───────────────────────────────────────

let todos: Todo[] = [];
let nextId = 1;

// 新增：用户消息轮数追踪
let userMessageCount: number = 0;
let allCompletedAtCount: number | null = null;
let lastTodoCallCount: number = 0;
let lastReminderCount: number = 0;
```

- [ ] **Step 2: 更新 reconstructState**

在 `reconstructState` 函数开头添加新状态重置：

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

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `cd todo && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add todo/src/index.ts
git commit -m "feat(todo): add state variables for auto-clear and reminders"
```

---

### Task 2: 添加 before_agent_start 事件监听（含 userMessageCount 递增）

**Type:** backend

**Files:**
- Modify: `todo/src/index.ts`（扩展入口，session_start 之后）

**重要说明：** 根据 Pi 源码分析，`before_agent_start` 在 `agent_start` 之前触发。因此 `userMessageCount++` 必须放在 `before_agent_start` handler 最开头，而非 `agent_start` 事件中。

- [ ] **Step 1: 添加 before_agent_start 事件**

在 `session_tree` 事件监听之后、`registerTool` 之前添加：

```typescript
pi.on("before_agent_start", async (_event, _ctx) => {
  // 递增用户消息轮数（必须在检查之前）
  userMessageCount++;

  // 1. 检查自动清空
  if (allCompletedAtCount !== null && userMessageCount - allCompletedAtCount >= 2) {
    const count = todos.length;
    todos = [];
    nextId = 1;
    allCompletedAtCount = null;
    refreshDisplay(_ctx);

    return {
      message: {
        customType: "todo-auto-clear",
        content: `所有 ${count} 个 todo 已完成，列表已自动清空。`,
        display: false,
      },
    };
  }

  // 2. 检查 Verification Nudge（仅在全部完成时，且未触发自动清空）
  if (
    allCompletedAtCount !== null &&
    todos.length >= 3 &&
    !todos.some((t) => /verif|验证/i.test(t.text)) &&
    userMessageCount - lastReminderCount >= 1  // 防重触发守卫
  ) {
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
  if (
    todos.length > 0 &&
    allCompletedAtCount === null &&
    userMessageCount - lastTodoCallCount >= 10 &&
    userMessageCount - lastReminderCount >= 10
  ) {
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

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `cd todo && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add todo/src/index.ts
git commit -m "feat(todo): add before_agent_start for auto-clear and reminders"
```

---

### Task 3: 更新 promptGuidelines

**Type:** backend

**Files:**
- Modify: `todo/src/index.ts`（registerTool 中的 promptGuidelines）

- [ ] **Step 1: 更新 promptGuidelines**

替换现有的 `promptGuidelines` 数组：

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

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `cd todo && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add todo/src/index.ts
git commit -m "feat(todo): update promptGuidelines with auto-clear and verification guidance"
```

---

### Task 4: 更新 executeTodoAction 追踪调用

**Type:** backend

**Files:**
- Modify: `todo/src/index.ts`（executeTodoAction 函数）

- [ ] **Step 1: 在 executeTodoAction 开头追踪调用**

在 `executeTodoAction` 函数开头添加：

```typescript
function executeTodoAction(params: { action: string; text?: string; id?: number; texts?: string[]; ids?: number[]; status?: string }, ctx: ExtensionContext) {
  // 追踪 todo 工具调用
  lastTodoCallCount = userMessageCount;

  let resultText = "";
  // ... 现有 switch 逻辑
}
```

- [ ] **Step 2: 在 add action 中重置 allCompletedAtCount**

在 `case "add":` 的 `break;` 之前添加：

```typescript
case "add": {
  // ... 现有逻辑

  // 重置自动清空计数器（新增了未完成任务）
  allCompletedAtCount = null;

  break;
}
```

- [ ] **Step 3: 在 clear action 中重置 allCompletedAtCount**

在 `case "clear":` 中添加：

```typescript
case "clear": {
  const count = todos.length;
  todos = [];
  nextId = 1;
  allCompletedAtCount = null; // 重置自动清空计数器
  resultText = count > 0 ? `已清空 ${count} 项 todo` : "暂无 todo，无需清空";
  break;
}
```

- [ ] **Step 4: 在 update action 中检查全部完成**

**注意：** 在现有 `isLastCompletion` 逻辑和 `resultText` 拼接之后、`break` 之前插入，不修改现有逻辑。

```typescript
// 检查是否全部完成（在现有 isLastCompletion 逻辑之后）
const allCompleted = todos.every((t) => t.status === "completed");
if (allCompleted && todos.length > 0) {
  // 首次全部完成时记录轮数
  if (allCompletedAtCount === null) {
    allCompletedAtCount = userMessageCount;
  }
} else {
  // 有未完成任务时重置
  allCompletedAtCount = null;
}
```

- [ ] **Step 5: 在 delete action 中检查全部完成**

在 `case "delete":` 的删除逻辑之后添加类似的检查：

```typescript
// 检查是否全部完成
const allCompletedAfterDelete = todos.every((t) => t.status === "completed");
if (allCompletedAfterDelete && todos.length > 0) {
  if (allCompletedAtCount === null) {
    allCompletedAtCount = userMessageCount;
  }
} else {
  allCompletedAtCount = null;
}
```

- [ ] **Step 6: 验证 TypeScript 编译**

Run: `cd todo && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add todo/src/index.ts
git commit -m "feat(todo): track todo calls and all-completed state for auto-clear"
```

---

### Task 5: 更新 _render 描述符

**Type:** backend

**Files:**
- Modify: `todo/src/index.ts`（buildRender 函数）

- [ ] **Step 1: 更新 buildRender 添加 meta 信息**

更新 `buildRender` 函数：

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
        ...(allCompletedAtCount !== null
          ? { autoClear: `${2 - (userMessageCount - allCompletedAtCount)} 轮后清空` }
          : {}),
      },
    },
  };
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `cd todo && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add todo/src/index.ts
git commit -m "feat(todo): add auto-clear countdown to _render meta"
```

---

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 自动清空 | before_agent_start → check allCompletedAtCount | userMessageCount - allCompletedAtCount >= 2 → clear todos | Task 2, Task 4 |
| AC-2 Todo Reminder | before_agent_start → check lastTodoCallCount | userMessageCount - lastTodoCallCount >= 10 → inject message | Task 2, Task 4 |
| AC-3 Verification Nudge | before_agent_start → check todos | allCompleted + length >= 3 + no verif → inject message | Task 2, Task 4 |
| AC-4 Prompt 更新 | registerTool.promptGuidelines | static string | Task 3 |

---

## Dependency Graph & Wave Schedule

```
Task 1 (状态变量) ──┬──→ Task 4 (executeTodoAction 追踪) ──→ Task 2 (before_agent_start) ──→ Task 3 (prompt)
                    │                                              ↑
                    └──────────────────────────────────────────────┘
                                                                  │
                                              Task 5 (_render 更新) ← 依赖 Task 4
```

| Wave | Tasks | 说明 |
|------|-------|------|
| Wave 1 | Task 1 | 基础状态变量 |
| Wave 2 | Task 4 | executeTodoAction 追踪 |
| Wave 3 | Task 2, Task 5 | before_agent_start 核心逻辑 + _render 更新 |
| Wave 4 | Task 3 | prompt 更新 |
