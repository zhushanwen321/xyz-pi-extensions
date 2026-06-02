---
verdict: pass
complexity: L1
---

# Todo Extension v3 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Pi Todo 扩展添加自动清空、Todo Reminder、Verification Nudge 三个能力，通过 `before_agent_start` 事件注入隐藏消息实现。

**Architecture:** 在现有模块级状态上新增 4 个追踪变量，通过 `agent_start` 计数用户消息轮数，通过 `before_agent_start` 检查并触发自动清空和提醒。所有改动集中在 `todo/src/index.ts`。

**Tech Stack:** TypeScript, Pi Extension API (`ExtensionAPI`, `ExtensionContext`), typebox, pi-tui

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `todo/src/index.ts` | modify | BG1 | 唯一修改文件：新增状态、事件监听、状态追踪、prompt 更新 |

---

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| FR-1 自动清空 | adopted | Task 2, Task 3 |
| FR-2 Todo Reminder | adopted | Task 3 |
| FR-3 Verification Nudge | adopted | Task 3 |
| FR-4 Prompt 更新 | adopted | Task 4 |
| 向后兼容 | adopted | Task 1 |

---

## Interface Contracts

### Module: todo-extension (executeTodoAction)

#### Function: executeTodoAction

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| executeTodoAction | (params: ActionParams, ctx: ExtensionContext) → ToolResult | `{ content, details }` | add 后重置 allCompletedAtCount; clear 后重置 allCompletedAtCount; update 后检查是否全部完成 | FR-1, FR-2 |

#### Data: ReminderState（新增模块级变量）

| Field | Type | Description |
|-------|------|-------------|
| userMessageCount | number | 用户消息轮数计数器 |
| allCompletedAtCount | number \| null | 全部完成时的 userMessageCount，null 表示未全部完成 |
| lastTodoCallCount | number | 上次调用 todo 工具时的 userMessageCount |
| lastReminderCount | number | 上次触发提醒时的 userMessageCount |

#### Event Handler: before_agent_start_handler

| Check | Condition | Action | Message customType | Spec Ref |
|-------|-----------|--------|--------------------|----------|
| Auto-clear | `allCompletedAtCount !== null && userMessageCount - allCompletedAtCount >= 2` | 清空 todos，重置 nextId | `todo-auto-clear` | FR-1 |
| Verification Nudge | `allCompletedAtCount !== null && todos.length >= 3 && !hasVerificationKeyword` | 注入提醒 | `todo-verification-nudge` | FR-3 |
| Todo Reminder | `todos.length > 0 && allCompletedAtCount === null && userMessageCount - lastTodoCallCount >= 10 && userMessageCount - lastReminderCount >= 10` | 注入提醒 | `todo-reminder` | FR-2 |

---

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| FR-1 自动清空 | before_agent_start_handler (auto-clear check) | executeTodoAction(update) → sets allCompletedAtCount → before_agent_start checks → clears | Task 2, Task 3 |
| FR-2 Todo Reminder | before_agent_start_handler (reminder check) | executeTodoAction(any) → updates lastTodoCallCount → before_agent_start checks → injects message | Task 2, Task 3 |
| FR-3 Verification Nudge | before_agent_start_handler (nudge check) | executeTodoAction(update) → sets allCompletedAtCount → before_agent_start checks → injects message | Task 2, Task 3 |
| FR-4 Prompt 更新 | registerTool promptGuidelines | N/A | Task 4 |
| 向后兼容 | reconstructState | N/A | Task 1 |

---

## Task List

| # | Task | Type | Depends on | Group |
|---|------|------|-----------|-------|
| 1 | 新增状态变量 + reconstructState 重置 | backend | — | BG1 |
| 2 | executeTodoAction 状态追踪 | backend | 1 | BG1 |
| 3 | 事件监听器（agent_start + before_agent_start） | backend | 2 | BG1 |
| 4 | promptGuidelines 更新 | backend | — | BG1 |

---

### Task 1: 新增状态变量 + reconstructState 重置

**Type:** backend

**Files:**
- Modify: `todo/src/index.ts` (模块级状态区域 ~L195, reconstructState ~L280)

- [ ] **Step 1: 在模块级状态区域添加 4 个新变量**

在现有 `let todos` 和 `let nextId` 之后添加：

```typescript
let todos: Todo[] = [];
let nextId = 1;

// v3: 用户消息轮数与提醒追踪
let userMessageCount: number = 0;
let allCompletedAtCount: number | null = null;
let lastTodoCallCount: number = 0;
let lastReminderCount: number = 0;
```

- [ ] **Step 2: 在 reconstructState 中重置新状态**

在 `reconstructState` 函数内，`todos = []; nextId = 1;` 之后添加：

```typescript
// v3: 重置提醒追踪状态
userMessageCount = 0;
allCompletedAtCount = null;
lastTodoCallCount = 0;
lastReminderCount = 0;
```

- [ ] **Step 3: 运行类型检查**

Run: `cd /Users/zhushanwen/Code/xyz-pi-extensions-workspace/main/todo && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add todo/src/index.ts
git commit -m "feat(todo): add v3 state variables and reconstructState reset"
```

---

### Task 2: executeTodoAction 状态追踪

**Type:** backend

**Files:**
- Modify: `todo/src/index.ts` (executeTodoAction 函数内)

- [ ] **Step 1: 在 executeTodoAction 入口处更新 lastTodoCallCount**

在 `switch` 语句之前、`let resultText = "";` 之后添加：

```typescript
// v3: 追踪 todo 工具调用轮数
lastTodoCallCount = userMessageCount;
```

- [ ] **Step 2: 在 add case 中重置 allCompletedAtCount**

在 `case "add"` 的成功分支末尾（`resultText = ...` 之后，`break` 之前）添加：

```typescript
// v3: 新增 todo 表示未全部完成
allCompletedAtCount = null;
```

- [ ] **Step 3: 在 clear case 中重置 allCompletedAtCount**

在 `case "clear"` 的成功分支末尾添加：

```typescript
// v3: 手动清空后重置
allCompletedAtCount = null;
```

- [ ] **Step 4: 在 update case 中追踪 allCompletedAtCount**

在 `update` case 的成功分支中，`todo.status = params.status` 赋值之后、`resultText` 拼接之前，添加全部完成检测逻辑：

```typescript
// v3: 检查是否所有 todo 已完成
const allCompleted = todos.every((t) => t.status === "completed");
if (allCompleted && todos.length > 0) {
    allCompletedAtCount = userMessageCount;
} else {
    allCompletedAtCount = null;
}
```

- [ ] **Step 5: 运行类型检查**

Run: `cd /Users/zhushanwen/Code/xyz-pi-extensions-workspace/main/todo && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add todo/src/index.ts
git commit -m "feat(todo): track allCompletedAtCount and lastTodoCallCount in executeTodoAction"
```

---

### Task 3: 事件监听器（agent_start + before_agent_start）

**Type:** backend

**Files:**
- Modify: `todo/src/index.ts` (扩展入口函数内，session_start 监听之后)

- [ ] **Step 1: 添加 agent_start 事件监听**

在 `pi.on("session_tree", ...)` 之后添加：

```typescript
// v3: 追踪用户消息轮数
pi.on("agent_start", async (_event, _ctx) => {
    userMessageCount++;
});
```

- [ ] **Step 2: 添加 before_agent_start 事件监听**

在 `agent_start` 监听之后添加：

```typescript
// v3: 自动清空与提醒检查
pi.on("before_agent_start", async (_event, ctx) => {
    // 1. 自动清空：全部完成后经过 2 轮用户消息
    if (allCompletedAtCount !== null && userMessageCount - allCompletedAtCount > 2) {
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

    // 2. Verification Nudge：完成 3+ 任务且无验证步骤
    if (
        allCompletedAtCount !== null &&
        todos.length >= 3 &&
        !todos.some((t) => /verif|验证/i.test(t.text))
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

    // 3. Todo Reminder：10 轮未调用 todo 工具
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

- [ ] **Step 3: 运行类型检查**

Run: `cd /Users/zhushanwen/Code/xyz-pi-extensions-workspace/main/todo && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add todo/src/index.ts
git commit -m "feat(todo): add agent_start counter and before_agent_start auto-clear/reminder logic"
```

---

### Task 4: promptGuidelines 更新

**Type:** backend

**Files:**
- Modify: `todo/src/index.ts` (registerTool 的 promptGuidelines 数组)

- [ ] **Step 1: 更新 promptGuidelines 内容**

将现有 promptGuidelines 数组替换为：

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

- [ ] **Step 2: 运行类型检查**

Run: `cd /Users/zhushanwen/Code/xyz-pi-extensions-workspace/main/todo && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add todo/src/index.ts
git commit -m "feat(todo): update promptGuidelines with auto-clear and verification nudge hints"
```

---

## Execution Groups

#### BG1: Todo v3 核心功能

**Description:** 所有改动集中在 `todo/src/index.ts`，按依赖顺序串行执行：状态变量 → 状态追踪 → 事件监听 → prompt 更新。

**Tasks:** Task 1, Task 2, Task 3, Task 4

**Files (预估):** 1 个文件（modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose（直接执行，无需 TDD） |
| Model | 按 taskComplexity 自动选择（medium） |
| 注入上下文 | spec.md 行为规范章节 + plan.md Task 描述 |
| 读取文件 | `todo/src/index.ts` |
| 修改文件 | `todo/src/index.ts` |

**Execution Flow (BG1 内部):** 串行派遣。

  Task 1 (无依赖):
    1. general-purpose → 添加状态变量 + reconstructState 重置
    2. general-purpose → 类型检查验证

  Task 2 (depends on Task 1):
    1. general-purpose → executeTodoAction 状态追踪
    2. general-purpose → 类型检查验证

  Task 3 (depends on Task 2):
    1. general-purpose → 事件监听器
    2. general-purpose → 类型检查验证

  Task 4 (无依赖，可与 Task 1-3 并行):
    1. general-purpose → promptGuidelines 更新

**Dependencies:** 无

**设计细节:** 直接写在 Task 描述中（L1 无子文档）

---

## Dependency Graph & Wave Schedule

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | 全部任务串行执行 |

Task 4 无依赖可并行，但由于单文件修改无法并行写同一文件，实际串行执行。

---

## Self-Review

### Spec coverage
- FR-1 自动清空 → Task 2 (追踪) + Task 3 (检查) ✅
- FR-2 Todo Reminder → Task 2 (追踪) + Task 3 (检查) ✅
- FR-3 Verification Nudge → Task 3 (检查) ✅
- FR-4 Prompt 更新 → Task 4 ✅
- 向后兼容 → Task 1 ✅

### Placeholder scan
- 无 TBD、TODO、fill in details 等占位符 ✅

### Type consistency
- `allCompletedAtCount` 在 Task 1 声明为 `number | null`，Task 2 和 Task 3 中一致使用 `null` 重置 ✅
- `userMessageCount` 在 Task 1 声明为 `number`，Task 2/3 中一致使用数字比较 ✅
- `customType` 字符串在 Task 3 中定义，与 spec 一致 ✅
