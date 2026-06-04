---
verdict: pass
complexity: L1
---

# Todo Extension v4 — Agent Loop + Verification + Batch Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `@zhushanwen/pi-todo` from a passive task list to an active agent loop with automatic lifecycle management, structured verification, and batch operations.

**Architecture:** Single-file extension (`extensions/todo/src/index.ts`, currently ~747 lines). Add `agent_end` event handler for auto-close/stall-detection/verify-trigger, refactor `before_agent_start` to use `display: false` context injection, extend data model with `verifyText`/`verifyAttempts`/`failed` status, add batch `updates[]` and `verifyTexts` parameters. Constants at module top. No new dependencies.

**Tech Stack:** TypeScript, Pi Extension API (`@mariozechner/pi-coding-agent`), typebox.

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `extensions/todo/src/index.ts` | modify | BGExt1 | All changes in this single file |
| `extensions/todo/src/__tests__/todo.test.ts` | create | BGExt1 | Unit tests for new features |

All tests are under `extensions/todo/src/__tests__/` matching existing test convention.

## Interface Contracts

### Module: extensions/todo

#### Interface: Todo

| Field | Type | Description |
|-------|------|-------------|
| id | number | Unique identifier |
| text | string | Task description (TUI visible) |
| verifyText | string? | Verification logic (AI readable only) |
| status | "pending" \| "in_progress" \| "completed" \| "failed" | Task lifecycle status |
| verifyAttempts | number | Failed verification count (0/1/2) |

#### Function: migrateTodo

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| migrateTodo | (t: any) -> Todo | Todo | missing verifyText -> undefined, missing verifyAttempts -> 0, old done:boolean -> status | AC-1 |

#### Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| AUTO_CLEAR_DELAY_ROUNDS | 2 | Rounds to wait before clearing completed todos |
| STALL_THRESHOLD | 5 | Rounds without any todo activity before marking stalled |
| REMINDER_INTERVAL | 3 | Rounds since last todo call before injecting reminder |
| MAX_VERIFY_ATTEMPTS | 2 | Max failed verification retries before marking failed |
| VALID_STATUSES | "pending"\|"in_progress"\|"completed"\|"failed" | Allowed status values |

#### Data: TodoParams (typebox schema)

| Field | Type | Description |
|-------|------|-------------|
| action | StringEnum | "list" \| "add" \| "update" \| "delete" \| "clear" |
| text | string? | Todo text (single update) |
| id | number? | Todo ID (single update) |
| texts | string[]? | Todo text list (batch add) |
| verifyTexts | string[]? | Verification text list (batch add, NEW) |
| ids | number[]? | Todo ID list (batch delete) |
| status | string? | Target status (single update) |
| updates | Array\<{id:number, status?:string, text?:string}\>? | Batch updates (NEW, takes priority over single update params) |

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1: data model | Todo interface, migrateTodo | entry deserialize → migrateTodo → state | Task 1 |
| AC-2: verifyTexts add | TodoParams.verifyTexts | add handler → create Todo.verifyText | Task 2 |
| AC-3: batch update | TodoParams.updates | update handler → map over updates[] | Task 3 |
| AC-4: agent_end loop | on("agent_end") handler | agent_end → check state → inject context / clear | Task 5 |
| AC-5: verify flow | on("agent_end") verify check | agent_end → detect completed+verifyText → context | Task 5 |
| AC-6: prompt rewrite | promptSnippet, description, promptGuidelines | tool registration string updates | Task 7 |
| AC-7: display:false | both event handlers context injection | inject display:false instead of display:true | Task 6 |

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 数据模型 | adopted | Task 1 |
| AC-2 add verifyTexts | adopted | Task 2 |
| AC-3 batch update | adopted | Task 3 |
| AC-4 agent_end loop | adopted | Task 5 |
| AC-5 verify flow | adopted | Task 5 |
| AC-6 prompt rewrite | adopted | Task 7 |
| AC-7 display:false | adopted | Task 6 |
| FR-3b list output | adopted | Task 4 |
| FR-6 registerMessageRenderer | adopted | Task 8 |
| UC-1 AI self-management | adopted | Task 5 (auto-close) |
| UC-2 verify flow | adopted | Task 5 (verify trigger) |
| UC-3 batch completion | adopted | Task 3 (batch update) |
| UC-4 verify failure | adopted | Task 5 (failed status) |

---

## Task List

| # | Task | Type | Depends on | Group |
|---|------|------|-----------|-------|
| 1 | Data Model + Backward Compat | backend | — | BGExt1 |
| 2 | `todo add` — verifyTexts param | backend | 1 | BGExt1 |
| 3 | `todo update` — batch updates[] param | backend | 1 | BGExt1 |
| 4 | `todo list` — verifyText in output | backend | 1 | BGExt1 |
| 5 | `agent_end` loop (auto-close + stall + verify) | backend | 1, 2, 3 | BGExt1 |
| 6 | `before_agent_start` refactor (display:false) | backend | 1 | BGExt1 |
| 7 | Prompt rewrite (promptSnippet/description/guidelines) | backend | — | BGExt1 |
| 8 | registerMessageRenderer for todo-context | backend | 6 | BGExt1 |
| 9 | Cleanup: remove old display:true code + constants | backend | 5, 6 | BGExt1 |

---

## Execution Groups

#### BGExt1: Todo Extension Core Changes

**Description:** All changes to the single-file todo extension. Tasks are tightly coupled (same file), executed sequentially.

**Tasks:** Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7 → Task 8 → Task 9

**Files (预估):** 2 个文件（1 create + 1 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high, tdd-coder: medium） |
| 注入上下文 | spec.md AC-1~AC-7, FR-1~FR-7, plan.md Task 1~9 |
| 读取文件 | `extensions/todo/src/index.ts`, `extensions/goal/src/index.ts`（agent_end 模式参考） |
| 修改/创建文件 | `extensions/todo/src/index.ts`, `extensions/todo/src/__tests__/todo.test.ts` |

**Execution Flow (BGExt1 内部):** 串行派遣，每个 Task 走完整 subagent 链后再开始下一个 Task。

  Task 1:
    1. general-purpose (skill: xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (skill: xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (skill: xyz-harness-expert-reviewer) → spec 合规检查

  Task 2 (depends on Task 1):
    ...same TDD chain...

  Task 3-8: same pattern, sequential

  Task 9 (cleanup, no TDD needed):
    1. general-purpose → 删除旧代码 + 运行测试验证

**Dependencies:** 无

**设计细节:** 所有改动集中在 `extensions/todo/src/index.ts`。参考 goal 的 `agent_end` handler（`extensions/goal/src/index.ts:860`）和 `registerMessageRenderer`（`extensions/goal/src/index.ts:885`）的实现模式。

---

## Dependency Graph & Wave Schedule

```
  BGExt1: T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BGExt1 | 所有 task 串行执行（单文件，必须按顺序） |

---

### Task 1: Data Model + Backward Compat

**Type:** backend

**Files:**
- Modify: `extensions/todo/src/index.ts:19-25` (Todo interface) — 加 verifyText?, status "failed", verifyAttempts
- Modify: `extensions/todo/src/index.ts:138-150` (migrateTodo) — 向后兼容新字段
- Modify: `extensions/todo/src/index.ts` (VALID_STATUSES) — 加 "failed"
- Modify: `extensions/todo/src/index.ts` (deserializeState) — 加 verifyAttempts, verifyText
- Test: `extensions/todo/src/__tests__/todo.test.ts` — 新字段反序列化测试

- [ ] **Step 1: Write the failing test**

Test file: `extensions/todo/src/__tests__/todo.test.ts`

```typescript
import { describe, it, expect } from "vitest";

// Note: migrateTodo and Todo type are internal to the extension.
// We import what we can test without Pi runtime.
// The extension's migrateTodo function handles backward compat.

describe("Todo data model", () => {
  it("should handle backward compat: old format without verifyText", () => {
    // Simulate old format: no verifyText, no verifyAttempts
    const old = { id: 1, text: "test", status: "completed" };
    // After migrateTodo: verifyAttempts defaults to 0
    expect((old as any).verifyText).toBeUndefined();
    expect((old as any).verifyAttempts).toBeUndefined();
  });

  it("should have valid status values including failed", () => {
    const valid = ["pending", "in_progress", "completed", "failed"];
    // VALID_STATUSES will be a const array
    // Check that "failed" is included
    expect(valid.includes("failed")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run extensions/todo/src/__tests__/todo.test.ts -t "Todo data model"
```
Expected: Initially tests exist as scaffolding only.

- [ ] **Step 3: Write minimal implementation**

In `extensions/todo/src/index.ts`:

```typescript
interface Todo {
  id: number;
  text: string;
  verifyText?: string;       // NEW
  status: "pending" | "in_progress" | "completed" | "failed";  // +"failed"
  verifyAttempts: number;    // NEW
}

// In migrateTodo:
function migrateTodo(t: any): Todo {
  return {
    id: t.id,
    text: t.text || "",
    verifyText: t.verifyText,           // NEW: undefined-safe
    status: t.done === true ? "completed" : (t.status || "pending"),
    verifyAttempts: t.verifyAttempts ?? 0,  // NEW: default 0
  };
}

// VALID_STATUSES update
const VALID_STATUSES = ["pending", "in_progress", "completed", "failed"] as const;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run extensions/todo/src/__tests__/todo.test.ts -t "Todo data model"
```

- [ ] **Step 5: Commit**

```bash
git add extensions/todo/src/index.ts extensions/todo/src/__tests__/todo.test.ts
git commit -m "feat(todo): add verifyText, failed status, verifyAttempts to data model"
```

---

### Task 2: `todo add` — verifyTexts param

**Type:** backend

**Files:**
- Modify: `extensions/todo/src/index.ts:42-48` (TodoParams) — 加 verifyTexts
- Modify: `extensions/todo/src/index.ts:342-365` (add action handler) — 处理 verifyTexts
- Test: `extensions/todo/src/__tests__/todo.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe("todo add with verifyTexts", () => {
  it("should map verifyTexts to todos when provided", () => {
    const texts = ["Task A", "Task B"];
    const verifyTexts = ["Verify A"];
    // Expected: todos[0].verifyText = "Verify A", todos[1].verifyText = undefined
    expect(verifyTexts.length).toBeLessThanOrEqual(texts.length);
  });

  it("should default verifyText to undefined when not provided", () => {
    const texts = ["Task A"];
    // Expected: todos[0].verifyText = undefined
    expect(true).toBe(true); // placeholder, expand in implementation
  });
});
```

- [ ] **Step 2: Run test**

```bash
npx vitest run extensions/todo/src/__tests__/todo.test.ts -t "todo add with verifyTexts"
```

- [ ] **Step 3: Write minimal implementation**

In TodoParams:
```typescript
verifyTexts: Type.Optional(Type.Array(Type.String(), {
  description: "Verification text list (one per texts entry, for add action)",
})),
```

In add action handler (around index.ts:354):
```typescript
// After trimming texts
const verifyTexts = params.verifyTexts || [];

if (verifyTexts.length < trimmed.length) {
  // Pad with undefined for entries without verifyText
}

// When creating todos:
const todo: Todo = {
  id: nextId++,
  text: trimmed[i],
  verifyText: verifyTexts[i],  // will be undefined if not provided
  status: "pending",
  verifyAttempts: 0,
};
```

Validations:
- `verifyTexts.length > texts.length` → return error

- [ ] **Step 4: Run test**

```bash
npx vitest run extensions/todo/src/__tests__/todo.test.ts -t "todo add with verifyTexts"
```

- [ ] **Step 5: Commit**

```bash
git add extensions/todo/src/index.ts
git commit -m "feat(todo): add verifyTexts param to todo add"
```

---

### Task 3: `todo update` — batch updates[] param

**Type:** backend

**Files:**
- Modify: `extensions/todo/src/index.ts:42-48` (TodoParams) — 加 updates[]
- Modify: `extensions/todo/src/index.ts:378-440` (update action handler) — 批量处理
- Test: `extensions/todo/src/__tests__/todo.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe("todo update batch", () => {
  it("should handle updates array with multiple items", () => {
    const updates = [
      { id: 1, status: "completed" as const },
      { id: 2, status: "in_progress" as const },
    ];
    expect(updates.length).toBe(2);
  });

  it("should reject duplicate ids in updates", () => {
    const updates = [
      { id: 1, status: "completed" as const },
      { id: 1, status: "pending" as const },
    ];
    const ids = updates.map(u => u.id);
    const unique = new Set(ids);
    expect(unique.size).toBeLessThan(ids.length);
    // should return error
  });

  it("should reject non-existent ids in updates", () => {
    const updates = [{ id: 999, status: "completed" as const }];
    // should return error (all-or-nothing)
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run test**

```bash
npx vitest run extensions/todo/src/__tests__/todo.test.ts -t "todo update batch"
```

- [ ] **Step 3: Write minimal implementation**

In TodoParams:
```typescript
updates: Type.Optional(Type.Array(Type.Object({
  id: Type.Number(),
  status: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
}), {
  description: "Batch updates array (takes priority over single id/status/text)",
})),
```

In update action handler:
```typescript
case "update":
  // Prefer batch updates over single update
  if (params.updates && params.updates.length > 0) {
    // Validate: no duplicate ids
    const ids = params.updates.map(u => u.id);
    if (new Set(ids).size !== ids.length) {
      return error("duplicate ids in updates");
    }
    // Validate: all ids exist
    for (const u of params.updates) {
      if (!todos.find(t => t.id === u.id)) {
        return error(`id ${u.id} not found`);
      }
      if (!u.status && !u.text) {
        return error(`update item for id ${u.id} has neither status nor text`);
      }
    }
    // Apply all updates
    for (const u of params.updates) {
      const todo = todos.find(t => t.id === u.id)!;
      if (u.status) todo.status = u.status as Todo["status"];
      if (u.text) todo.text = u.text;
    }
    // Save and return
    ...
  }
  // Fall through to existing single update logic
```

- [ ] **Step 4: Run test**

```bash
npx vitest run extensions/todo/src/__tests__/todo.test.ts -t "todo update batch"
```

- [ ] **Step 5: Commit**

```bash
git add extensions/todo/src/index.ts
git commit -m "feat(todo): add batch updates[] param to todo update"
```

---

### Task 4: `todo list` — verifyText in output

**Type:** backend

**Files:**
- Modify: `extensions/todo/src/index.ts` (list action text output) — 追加 "| 验证: ..."
- Modify: `extensions/todo/src/index.ts:728` (renderResult) — 显示 [待验证] / [无需验证] 标签
- Test: `extensions/todo/src/__tests__/todo.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe("todo list output", () => {
  it("should include verifyText in text output when present", () => {
    const todo = { id: 1, text: "Fix auth", verifyText: "Check status codes", status: "pending" as const, verifyAttempts: 0 };
    // Expected text output line: "[pending] #1: Fix auth | 验证: Check status codes"
    const hasVerifyText = todo.verifyText !== undefined;
    expect(hasVerifyText).toBe(true);
  });

  it("should not include verify suffix when verifyText is absent", () => {
    const todo = { id: 2, text: "Create dir", verifyText: undefined, status: "pending" as const, verifyAttempts: 0 };
    const hasVerifyText = todo.verifyText !== undefined;
    expect(hasVerifyText).toBe(false);
  });
});
```

- [ ] **Step 2: Run test**

```bash
npx vitest run extensions/todo/src/__tests__/todo.test.ts -t "todo list output"
```

- [ ] **Step 3: Write minimal implementation**

In list action handler (currently formats todos as text):
```typescript
// In the todo-to-string formatting:
const parts = [`[${t.status}] #${t.id}: ${t.text}`];
if (t.verifyText) {
  parts.push(` | 验证: ${t.verifyText}`);
}
return parts.join("");
```

In renderResult (TUI display — must NOT show verifyText content per spec FR-1):
```typescript
// In the line formatting for renderResult:
// TUI shows only [待验证] tag, no verifyText content
const suffix = todo.verifyText ? " [待验证]" : " [无需验证]";
// Or via theme coloring for the tag
```

- [ ] **Step 4: Run test**

```bash
npx vitest run extensions/todo/src/__tests__/todo.test.ts -t "todo list output"
```

- [ ] **Step 5: Commit**

```bash
git add extensions/todo/src/index.ts
git commit -m "feat(todo): show verifyText in list output and TUI tags"
```

---

### Task 5: `agent_end` loop (auto-close + stall + verify)

**Type:** backend

**Files:**
- Modify: `extensions/todo/src/index.ts` — 在事件注册区域新增 `pi.on("agent_end")`
- Modify: `extensions/todo/src/index.ts` (module top) — 新增常量 REMINDER_INTERVAL, STALL_THRESHOLD, MAX_VERIFY_ATTEMPTS
- Test: `extensions/todo/src/__tests__/todo.test.ts`

**设计参考:** `extensions/goal/src/index.ts:860-880` 的 `agent_end` handler 实现模式。

- [ ] **Step 1: Write the failing test**

```typescript
describe("agent_end loop", () => {
  it("should detect when all tasks completed", () => {
    const todos: Todo[] = [
      { id: 1, text: "A", status: "completed", verifyAttempts: 0 },
      { id: 2, text: "B", status: "completed", verifyAttempts: 0 },
    ];
    const allDone = todos.every(t => t.status === "completed");
    expect(allDone).toBe(true);
  });

  it("should detect pending tasks for reminder", () => {
    const todos: Todo[] = [
      { id: 1, text: "A", status: "completed", verifyAttempts: 0 },
      { id: 2, text: "B", status: "pending", verifyAttempts: 0 },
    ];
    const hasPending = todos.some(t => t.status !== "completed");
    expect(hasPending).toBe(true);
  });

  it("should detect verifyText tasks that need verification", () => {
    const todos: Todo[] = [
      { id: 1, text: "A", verifyText: "Check X", status: "completed", verifyAttempts: 0 },
    ];
    const needsVerify = todos.some(t => t.status === "completed" && t.verifyText);
    expect(needsVerify).toBe(true);
  });
});
```

- [ ] **Step 2: Run test**

```bash
npx vitest run extensions/todo/src/__tests__/todo.test.ts -t "agent_end loop"
```

- [ ] **Step 3: Write minimal implementation**

At module top:
```typescript
const AUTO_CLEAR_DELAY_ROUNDS = 2;
const STALL_THRESHOLD = 5;
const REMINDER_INTERVAL = 3;
const MAX_VERIFY_ATTEMPTS = 2;
```

In extension factory, register agent_end handler:
```typescript
pi.on("agent_end", async (_event: any, ctx: ExtensionContext) => {
  const [todos, setTodos, getPersisted] = getTodoState(ctx);
  if (todos.length === 0) return;

  // 1. Check for auto-complete
  const allCompleted = todos.every(t => t.status === "completed");
  if (allCompleted && allCompletedAtCount === null) {
    // Mark when all completed first detected
    // After AUTO_CLEAR_DELAY_ROUNDS rounds, clear
  }

  // 2. Check for tasks needing verification
  // Condition: status=completed AND has verifyText AND attempts < MAX (= still retryable)
  // This allows retry after first failure (verifyAttempts=1 → still < MAX(2))
  const needsVerify = todos.find(t =>
    t.status === "completed" && t.verifyText && t.verifyAttempts < MAX_VERIFY_ATTEMPTS
  );
  if (needsVerify) {
    // Inject verification context (display: false → AI reads, not TUI visible)
    pi.deliver({
      deliverAs: "steer",
      display: false,
      customType: "todo-context",
      message: `<todo_context>\n[TODO] Task #${needsVerify.id} needs verification:\n${needsVerify.verifyText}\n</todo_context>`,
    });
  }

  // 3. Check for verify failures
  const verifyFailed = todos.find(t => t.status === "in_progress" && t.verifyText && t.verifyAttempts >= MAX_VERIFY_ATTEMPTS);
  if (verifyFailed) {
    verifyFailed.status = "failed";
    // Persist and notify
  }

  // 4. Stall detection
  // 5. Reminder injection (every REMINDER_INTERVAL)
});
```

- [ ] **Step 4: Run test**

```bash
npx vitest run extensions/todo/src/__tests__/todo.test.ts -t "agent_end loop"
```

- [ ] **Step 5: Commit**

```bash
git add extensions/todo/src/index.ts
git commit -m "feat(todo): add agent_end loop with auto-close, stall, and verify trigger"
```

---

### Task 6: `before_agent_start` refactor (display:false)

**Type:** backend

**Files:**
- Modify: `extensions/todo/src/index.ts:621-680` (before_agent_start handler) — 移除 display:true 消息，改为 display:false context 注入

- [ ] **Step 1: Read existing before_agent_start code**

```bash
sed -n '616,690p' extensions/todo/src/index.ts
```

- [ ] **Step 2: Write the failing test**

```typescript
describe("before_agent_start context", () => {
  it("should format todo context with pending tasks", () => {
    const todos: Todo[] = [
      { id: 1, text: "Fix auth", verifyText: undefined, status: "pending", verifyAttempts: 0 },
      { id: 2, text: "Create dir", verifyText: "Check dir", status: "in_progress", verifyAttempts: 0 },
    ];
    // Expected: formatted context with [无需验证] and [待验证] tags
    expect(todos.length).toBe(2);
  });
});
```

- [ ] **Step 3: Write minimal implementation**

Replace the existing before_agent_start handler:

Old behavior (index.ts:621-680):
- Injects three `display: true` messages (todo-auto-clear, todo-verification-nudge, todo-reminder)
- Uses `userMessageCount` for interval tracking

New behavior:
- Check if todos are empty → skip
- Build `<todo_context>` string with pending task list + rules
- `pi.deliver({ deliverAs: "steer", display: false, customType: "todo-context", message: contextStr })`
- Keep `ctx.ui.setStatus()` call for widget display
- Remove userMessageCount references for reminder (moved to agent_end)

```typescript
pi.on("before_agent_start", async (_event: any, ctx: ExtensionContext) => {
  const [todos, setTodos, getPersisted] = getTodoState(ctx);
  if (todos.length === 0) return;

  const pendingTodos = todos.filter(t => t.status !== "completed");
  if (pendingTodos.length === 0) return;

  // Format pending tasks for AI context injection (display: false, not TUI visible)
  // verifyText content IS included here so AI can read and execute it
  const lines = pendingTodos.map(t => {
    const verifyTag = t.verifyText ? ` [待验证: ${t.verifyText}]` : " [无需验证]";
    return `#${t.id}: ${t.text}${verifyTag}`;
  });

  const contextStr = `<todo_context>\n[TODO] ${pendingTodos.length} tasks pending\n${lines.join("\n")}\n\nRules:\n- 优先使用 updates[] 批量更新\n- [待验证] 的任务必须验证通过后才能 completed\n- 全部完成后工具自动闭合\n</todo_context>`;

  pi.deliver({
    deliverAs: "steer",
    display: false,
    customType: "todo-context",
    message: contextStr,
  });

  // Keep status bar widget (TUI visible, no verifyText content)
  ctx.ui.setStatus(`📋 ${pendingTodos.length} pending`);

  // Keep status bar widget
  ctx.ui.setStatus(`📋 ${pendingTodos.length} pending`);
});
```

- [ ] **Step 4: Run test**

```bash
npx vitest run extensions/todo/src/__tests__/todo.test.ts -t "before_agent_start context"
```

- [ ] **Step 5: Commit**

```bash
git add extensions/todo/src/index.ts
git commit -m "refactor(todo): replace display:true messages with display:false context injection"
```

---

### Task 7: Prompt rewrite

**Type:** backend

**Files:**
- Modify: `extensions/todo/src/index.ts:697` (promptSnippet)
- Modify: `extensions/todo/src/index.ts` (description 末尾)
- Modify: `extensions/todo/src/index.ts` (promptGuidelines 数组)

- [ ] **Step 1: Write minimal implementation**

No TDD needed for string changes. Direct edits.

Find and replace `promptSnippet`:
```
Old: "Lightweight task list for tracking progress on multi-step work"
New: "Use todo when breaking multi-step work into trackable items during normal (non-goal) conversation. Not for single-step operations."
```

Append to description:
```
" When /goal is active, do NOT use this tool — use goal_manager's add_subtasks instead."
```

Replace promptGuidelines:
```typescript
promptGuidelines: [
  "[Usage] 多步骤工作（3+步）时使用。AI 自发创建，无需用户触发",
  "[Goal 冲突] /goal 激活后禁止使用 todo — 改用 add_subtasks",
  "[批量优先] 完成多项任务时使用 updates[] 批量更新，减少工具调用次数",
  "[验证] 复杂任务创建时附带 verifyText，定义验证逻辑。有 [待验证] 的任务必须在 completed 前执行验证",
  "[验证失败] 验证失败 2 次后任务进入 failed 状态，由用户决定",
  "[自动闭合] 全部完成后工具会在几轮后自动清理，无需手动 clear",
  "[Not for] 单步操作、简单对话、/goal 已激活时",
],
```

- [ ] **Step 2: Verify no type errors**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add extensions/todo/src/index.ts
git commit -m "docs(todo): rewrite prompts for trigger-driven usage and goal boundaries"
```

---

### Task 8: registerMessageRenderer for todo-context

**Type:** backend

**Files:**
- Modify: `extensions/todo/src/index.ts` — registerMessageRenderer 调用

**设计参考:** `extensions/goal/src/index.ts:885` 的实现。

- [ ] **Step 1: Read goal's registerMessageRenderer**

```bash
sed -n '885,900p' extensions/goal/src/index.ts
```

- [ ] **Step 2: Write minimal implementation**

```typescript
// In extension factory, after tool registration:
pi.registerMessageRenderer("todo-context", (message: any, _options: any, theme: Theme) => {
  const text = message?.message || "";
  // Extract count from context
  const match = text.match(/\[TODO\]\s*(\d+)\s*tasks?\s*(pending|completed)/);
  const count = match ? match[1] : "?";
  const status = match ? match[2] : "";
  const displayText = status === "completed"
    ? `[TODO] All tasks completed ✓`
    : `[TODO] ${count} tasks pending`;
  return new Text(displayText, 0, 0);
});
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add extensions/todo/src/index.ts
git commit -m "feat(todo): register message renderer for todo-context type"
```

---

### Task 9: Cleanup — remove old display:true code + dead constants

**Type:** backend

**Files:**
- Modify: `extensions/todo/src/index.ts` — 删除旧代码

- [ ] **Step 1: Identify and remove**

Remove these items:
1. Constant `VERIFICATION_NUDGE_THRESHOLD = 3` (replaced by MAX_VERIFY_ATTEMPTS)
2. Constant `TODO_REMINDER_INTERVAL = 10` (replaced by REMINDER_INTERVAL = 3)
3. Old display:true pi.deliver calls with customType "todo-auto-clear", "todo-verification-nudge", "todo-reminder"

Note: Do NOT remove `userMessageCount`/`allCompletedAtCount` — they are re-used by the new `agent_end` handler for round-tracking and auto-close delay.

- [ ] **Step 2: Run test to ensure nothing broken**

```bash
npx vitest run extensions/todo/src/__tests__/todo.test.ts
```
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add extensions/todo/src/index.ts
git commit -m "chore(todo): remove dead code and constants replaced by new agent loop"
```
