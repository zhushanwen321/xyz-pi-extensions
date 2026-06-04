# Business Logic Review v2 — BLR Re-verification

```yaml
verdict: fail
must_fix: 2
reviewer: BLR v2
date: 2026-06-04
commit: ae4c30e fix(todo): address BLR MUST_FIX issues
files_reviewed:
  - extensions/todo/src/index.ts
  - extensions/todo/src/model.ts
```

## MUST_FIX #1: userMessageCount 双重递增 — ❌ NOT FIXED

**原问题**: `executeTodoAction` 和 `agent_start` 都递增 `userMessageCount`，导致计数偏差。

**修复要求**:
- `executeTodoAction` 中移除 `userMessageCount++`
- 保留 `lastTodoCallCount = userMessageCount`
- `agent_start` 中 `userMessageCount++` 保留

**实际代码** (`index.ts` `executeTodoAction` 函数顶部, 约 L213-215):

```typescript
// v3: 追踪 todo 工具调用轮数
userMessageCount++;              // ← 仍然存在，未移除
lastTodoCallCount = userMessageCount;
```

`agent_start` handler (约 L313):

```typescript
pi.on("agent_start", async (_event: any, _ctx: ExtensionContext) => {
    userMessageCount++;          // ← 保留，正确
});
```

**结论**: `userMessageCount++` 仍在 `executeTodoAction` 中。每次 AI 调用 todo 工具时 `userMessageCount` 递增两次（agent_start + executeTodoAction），计数偏差未修复。`lastTodoCallCount` 会基于虚高的计数赋值，stall/reminder/auto-clear 的阈值判断全部偏移。

---

## MUST_FIX #2: Verify 流程无验证通过出口 — ❌ NOT FIXED

**原问题**: `agent_end` 自动递增 `verifyAttempts`，verifyAttempts 只增不减，任务必然走向 failed。AI 无法确认"验证通过"。

**修复要求**:
- `agent_end` needsVerify 分支中移除 `verifyAttempts++`
- verifyAttempts 只在 AI 将 completed 任务改为 in_progress 时递增（表示 AI 声明验证失败）

**实际代码** (`agent_end` handler needsVerify 分支, 约 L338-349):

```typescript
if (needsVerify) {
    needsVerify.verifyAttempts++;    // ← 仍然存在，agent_end 自动递增
    refreshDisplay(ctx);
    pi.deliver({
        deliverAs: "steer",
        display: false,
        customType: "todo-context",
        message: `... needs verification (attempt ${needsVerify.verifyAttempts}/${MAX_VERIFY_ATTEMPTS})...`,
    });
    return;
}
```

单条 update 路径 (约 L278-282) — **此部分已正确添加**:

```typescript
if (oldStatus === "completed" && params.status === "in_progress"
    && todo.verifyText && todo.verifyAttempts < MAX_VERIFY_ATTEMPTS) {
    todo.verifyAttempts++;          // ← AI 主动声明验证失败时递增，正确
}
```

**结论**: `agent_end` 仍然自动递增 `verifyAttempts`。问题未修复：

1. AI 标记 completed → agent_end 立即 `verifyAttempts++` → 注入验证上下文
2. AI 验证通过（什么都不做）→ 下一次 agent_end 再次 `verifyAttempts++`（因为仍是 completed + verifyText + attempts < MAX）
3. 经过 MAX_VERIFY_ATTEMPTS 次 agent_end 后，任务被自动标记为 failed
4. AI 无法通过任何操作阻止这个自动递增——即使验证成功，verifyAttempts 仍在每个 agent_end 递增

验证通过的出口不存在。任务生命周期是：completed → (agent_end 递增) → completed → (agent_end 递增) → failed。AI 没有机制声明"我已验证通过"。

---

## MUST_FIX #3: batch update 不校验 status — ✅ FIXED

**原问题**: `updateTodos()` 使用 `u.status as Todo["status"]` 强制类型断言，接受任意 string。

**修复要求**: 在 `updateTodos` 验证循环中增加 `VALID_STATUSES.includes()` 检查。

**实际代码** (`model.ts` `updateTodos` 函数验证循环, 约 L176-181):

```typescript
if (u.status && !VALID_STATUSES.includes(u.status as (typeof VALID_STATUSES)[number])) {
    return {
        updatedTodos: currentTodos,
        error: `invalid status: ${u.status}`,
        resultText: `Error: invalid status '${u.status}' for update item id ${u.id}`,
    };
}
```

**结论**: status 合法性校验已添加，返回错误阻止非法 status。修复正确。类型断言 `as Todo["status"]` 在验证通过后使用，安全。

---

## Summary

| # | Issue | Verdict |
|---|-------|---------|
| MUST_FIX #1 | userMessageCount 双重递增 | ❌ NOT FIXED |
| MUST_FIX #2 | Verify 流程无验证通过出口 | ❌ NOT FIXED |
| MUST_FIX #3 | batch update 不校验 status | ✅ FIXED |

**Overall: FAIL** — 2/3 MUST_FIX 未解决。
