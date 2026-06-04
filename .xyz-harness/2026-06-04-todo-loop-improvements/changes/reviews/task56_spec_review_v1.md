---
verdict: fail
must_fix: 2
---

# Task 5 & 6 Spec 合规审查

**审查文件**: `extensions/todo/src/index.ts`, `extensions/todo/src/model.ts`
**Spec 来源**: `.xyz-harness/2026-06-04-todo-loop-improvements/spec.md`
**日期**: 2026-06-04

## Task 5: agent_end 循环 (AC-4, AC-5)

### 检查结果

| # | 检查项 | AC | 状态 | 说明 |
|---|--------|-----|------|------|
| 1 | `pi.on("agent_end")` 已注册 | AC-4 | ✅ PASS | index.ts:654 |
| 2 | agent_end 检查 needsVerify (completed + verifyText + attempts < MAX) | AC-4 | ✅ PASS | index.ts:661-667 |
| 3 | agent_end 检查验证失败 (attempts >= MAX) | AC-5 | ⚠️ PARTIAL | 条件存在但永远不会触发（见 Issue #1） |
| 4 | auto-clear (allCompletedAtCount + 2 round delay) | AC-4 | ✅ PASS | index.ts:695-710，`AUTO_CLEAR_DELAY_ROUNDS=2` |
| 5 | stall 检测和提醒 | AC-4 | ✅ PASS | index.ts:714-728，STALL_THRESHOLD=5，REMINDER_INTERVAL=3 |
| 6 | 常量 STALL_THRESHOLD=5, REMINDER_INTERVAL=3, MAX_VERIFY_ATTEMPTS=2 | AC-4 | ✅ PASS | index.ts:246-252 |
| 7 | userMessageCount/lastTodoCallCount 在 executeTodoAction 中递增 | AC-4 | ✅ PASS | index.ts:298-299 |

### 关键问题

#### Issue #1 (MUST FIX): 验证流程不可闭合 — `verifyAttempts` 永远不会被递增

**AC**: AC-5（验证流程）
**严重性**: 🔴 阻断

`verifyAttempts` 在 `Todo` 接口中定义（model.ts:13），在 `addTodos` 中初始化为 0（model.ts:140），在 `migrateTodo` 中默认补 0（model.ts:56）。但**全代码库中没有任何一行代码执行 `verifyAttempts++` 或 `verifyAttempts = n`**。

验证流程预期生命周期：

```
AI 标记 completed → agent_end 注入验证提醒 → AI 执行验证
  ├─ 通过 → 保持 completed（✅ 无需额外操作）
  └─ 失败 → verifyAttempts++ + 回退 in_progress（❌ 缺失）
       → 再次 completed → agent_end 再次提醒
       → 失败 → verifyAttempts++（❌ 缺失）
       → verifyAttempts >= 2 → 标记 failed（❌ 条件永远不满足）
```

**实际行为**：
1. 任务被标记 `completed` → agent_end step 1 找到 `needsVerify`（verifyAttempts=0 < 2）→ 注入验证提醒 ✅
2. 下一轮：任务仍为 `completed`，`verifyAttempts` 仍为 0 → agent_end step 1 再次找到同一任务 → 再次注入提醒
3. 无限循环：验证提醒每轮触发，但 `verifyAttempts` 永远为 0，任务永远不失败

**修复方向**（二选一）：
- **方案 A**：在 `todo update` 的 execute 中增加验证逻辑 — 如果任务有 `verifyText` 且状态从非 completed 变为 completed，检查 `verifyAttempts` 并递增
- **方案 B**：在 agent_end 的验证分支中，当 AI 未能成功验证时（通过某种信号），递增 `verifyAttempts` 并将状态回退为 `in_progress`

#### Issue #2 (MUST FIX): 验证失败检测条件与 spec 流程不匹配

**AC**: AC-5
**严重性**: 🔴 阻断

agent_end step 2（index.ts:678-691）检查：

```typescript
t.verifyText &&
t.verifyAttempts >= MAX_VERIFY_ATTEMPTS &&
t.status === "in_progress"
```

要求 `status === "in_progress"`。但验证流程中，任务是由 AI 标记 `completed` 后被 agent_end 拦截进入验证的。如果验证失败：
- spec 预期：`completed` → 验证失败 → 回退 `in_progress` + `verifyAttempts++`
- 代码实际：没有任何地方将 `completed` 回退为 `in_progress`

即使 Issue #1 修复了 `verifyAttempts++`，`status` 的回退逻辑仍然缺失。agent_end step 2 的检查条件（`status === "in_progress" && verifyAttempts >= 2`）永远不会被满足，因为：
1. 任务被标记 `completed` 后状态保持 `completed`
2. 没有代码将其改回 `in_progress`
3. step 2 只看 `in_progress` 状态的任务

---

## Task 6: before_agent_start refactor (AC-7)

### 检查结果

| # | 检查项 | AC | 状态 | 说明 |
|---|--------|-----|------|------|
| 1 | before_agent_start handler 已替换 | AC-7 | ✅ PASS | index.ts:606-641 |
| 2 | 没有 display:true 的消息注入 | AC-7 | ✅ PASS | grep 无匹配 "display.*true"、"todo-auto-clear"、"todo-verification-nudge"、"todo-reminder" |
| 3 | 有 display:false 的 todo_context 注入 | AC-7 | ✅ PASS | index.ts:626-630, `display: false, customType: "todo-context"` |
| 4 | ctx.ui.setStatus() 仍然保留 | AC-7 | ✅ PASS | index.ts:633 |
| 5 | VERIFICATION_NUDGE_THRESHOLD 已删除 | AC-7 | ✅ PASS | grep 无匹配 |
| 6 | TODO_REMINDER_INTERVAL 已删除 | AC-7 | ✅ PASS | grep 无匹配 |
| 7 | lastReminderCount 已删除 | AC-7 | ✅ PASS | grep 无匹配 |
| 8 | todo_context 包含 verifyText 原文 | AC-7 | ✅ PASS | index.ts:617 `待验证: ${t.verifyText}` |

### 非阻断观察

| # | 观察项 | 级别 | 说明 |
|---|--------|------|------|
| N1 | before_agent_start 中 setStatus 使用 emoji | INFO | index.ts:633 `📋 ${pendingTodos.length} pending`。项目规范禁止 emoji，但这是 display 层面的小问题，不影响功能 |
| N2 | remind 每轮触发而非按间隔触发 | INFO | agent_end step 5 在 count-lastTodoCall >= 3 的**每一轮**都触发提醒，不是每 3 轮触发一次。可能导致 AI 上下文中重复出现提醒。spec 未明确要求 "每 N 轮触发一次"，但 "REMINDER_INTERVAL" 这个命名暗示间隔语义 |
| N3 | FR-6 registerMessageRenderer 未实现 | INFO | spec 中提到 FR-6 要求注册 `todo-context` 消息 renderer，但不在 Task 5/6 范围内（可能是独立 Task） |

---

## 总结

| Task | AC | Verdict |
|------|-----|---------|
| Task 5: agent_end 循环 | AC-4 | ✅ PASS（auto-clear、stall、remind 均实现） |
| Task 5: agent_end 循环 | AC-5 | ❌ FAIL（验证流程不可闭合） |
| Task 6: before_agent_start refactor | AC-7 | ✅ PASS |

**MUST FIX: 2**

1. **Issue #1**: 增加 `verifyAttempts` 递增逻辑 — 验证失败时必须递增计数器
2. **Issue #2**: 补充 `completed → in_progress` 状态回退逻辑 — 验证失败时任务必须回到可重试状态

两个问题根因相同：验证流程只有 "检测到需要验证" 和 "检测到失败次数超限" 两端，中间的 "记录失败" 和 "状态回退" 两个转换步骤缺失。
