---
verdict: fail
must_fix: 3
review_metrics:
  files_reviewed: 3
  issues_found: 7
  must_fix_count: 3
  low_count: 2
  info_count: 2
  duration_estimate: "25"
---

# Dev Business Logic Review v1

## 审查记录
- 审查时间：2026-06-04 12:55
- 审查模式：Dev
- 审查对象：use-cases.md + git diff (2cf17bc..90e1b5d)
- 模拟数据路径数：8

## UC 覆盖追踪

| UC 编号 | UC 名称 | 覆盖状态 | 执行路径 | 发现的问题 |
|---------|---------|---------|----------|-----------|
| UC-1 | AI 自发管理多步骤任务 | ⚠️ 部分 | add→update→agent_end auto-clear | userMessageCount 双重递增问题 |
| UC-2 | 复杂任务的验证 | ⚠️ 部分 | add(verifyTexts)→update(completed)→agent_end verify loop | verify 只在 agent_end 触发一次 |
| UC-3 | 批量完成 | ✅ 完整 | update(updates[]) | — |
| UC-4 | 验证失败 | ⚠️ 部分 | completed→agent_end verify→failed | failed 状态在 batch update 中无验证守卫 |

## 问题清单

| # | 严重度 | UC 编号 | 描述 | 文件 | 行号/位置 | 修改建议 |
|---|--------|---------|------|------|----------|---------|
| 1 | MUST_FIX | UC-1 | `userMessageCount` 在 `executeTodoAction` 和 `agent_start` 中双重递增 | `index.ts` | executeTodoAction 入口 + agent_start handler | 每次 todo 工具调用 `userMessageCount++`，而 `agent_start` 也会 `++`。同一轮对话中，如果 AI 调用了 todo，count 被 +2 而非 +1。auto-clear 判定 `userMessageCount - allCompletedAtCount >= 2` 会被提前触发。应在 executeTodoAction 中去掉 `userMessageCount++`，因为 `agent_start` 已经计数了每个 agent turn。 |
| 2 | MUST_FIX | UC-2 | `agent_end` verify 循环只执行一次 `.find()`，如果有多个带 verifyText 的 completed 任务，只处理第一个 | `index.ts` | agent_end handler 中 `todos.find(...)` | 场景：3 个 todo 全部 completed 且都有 verifyText。`agent_end` 只 `find` 第一个，注入验证提示。AI 验证后下一次 `agent_end` 才处理第二个。这意味着验证是串行的——每轮只验证 1 个。这在功能上可行但效率低，且 AI 可能在验证 #2 时忘记 #1 已验证。建议改为一次注入所有待验证任务。 |
| 3 | MUST_FIX | UC-4 | batch `updateTodos()` 不验证 `status` 值是否在 `VALID_STATUSES` 内，可以直接设为任意 string | `model.ts` | `updateTodos` 函数 `u.status as Todo["status"]` | 单条 update 路径有 `VALID_STATUSES.includes()` 校验，但 `updateTodos()` 直接 `as Todo["status"]` 强制类型断言，运行时无校验。调用 `update(updates=[{id:1, status:"banana"}])` 会静默接受。应在 `updateTodos` 中增加 status 校验。 |
| 4 | LOW | UC-1 | `agent_end` 的 stall 检测和 reminder 逻辑顺序导致 reminder 永远不会在 stall 之前触发 | `index.ts` | agent_end handler 步骤 4 和 5 | 步骤 4 检查 `>= STALL_THRESHOLD(5)`，步骤 5 检查 `>= REMINDER_INTERVAL(3)`。由于步骤 4 先执行，3 轮时 reminder 触发，5 轮时 stall 触发。但 stall 和 reminder 都用 `pi.deliver` 发 steer 消息，stall 的消息比 reminder 更具体（包含任务详情），reminder 被跳过是合理的。只是这两个阈值是 5 和 3，gap 只有 2 轮，reminder 只能在第 3-4 轮触发一次。这是设计意图但阈值设计不够清晰。 |
| 5 | LOW | UC-2 | `verifyAttempts` 在 `agent_end` 中递增，但 AI 可能在同一轮中用 `update(status=completed)` 反复标记同一个 todo | `index.ts` | agent_end verify 检查 | AI 调用 `todo update(id=1, status=completed)` → `agent_end` 触发，`verifyAttempts` 从 0→1 → AI 又调用 `todo update(id=1, status=completed)`（status 不变，幂等）→ `agent_end` 再次触发 `verifyAttempts` 1→2。下一次 `agent_end` 发现 `verifyAttempts >= 2` 标记为 failed。这实际上意味着 verify 最多尝试 2 次就会被标记失败，符合 `MAX_VERIFY_ATTEMPTS = 2` 的设计。但 "attempt" 的语义是 "agent_end 触发次数" 而非 "AI 实际执行了验证操作"，可能导致 AI 未真正验证就被标记为 failed。 |
| 6 | INFO | — | `before_agent_start` 中 `ctx.ui.setStatus("todo", ...)` 使用了 emoji 前缀，但 `renderStatusText()` 中状态栏文本不含 emoji，两处状态栏写入风格不一致 | `index.ts` | before_agent_start handler vs renderStatusText | `before_agent_start` 设置 `📋 ${pendingTodos.length} pending`，但 `refreshDisplay→renderStatusText` 设置的是无 emoji 的 `☑ N/M`。`before_agent_start` 的 setStatus 会在下一轮被 `refreshDisplay` 覆盖，所以实际上 emoji 只存在一个 agent turn。 |
| 7 | INFO | — | `getDisplayStatus` 内部调用 `migrateTodo(t).status`，但 `migrateTodo` 返回新对象，对于已经是合法 status 的 todo 做了不必要的拷贝 | `model.ts` | `getDisplayStatus` | 这是一个性能问题，对每个 todo 的每次渲染都创建新对象。在 todo 数量少时可忽略，但属于不必要的开销。 |

## 执行路径详情（Dev 模式）

### UC-1: AI 自发管理多步骤任务

**模拟数据：**
```json
{
  "input_data": {
    "action": "add",
    "texts": ["修复登录 bug", "添加单元测试", "更新文档"]
  }
}
```

**执行路径：**
```
agent_start → userMessageCount: 0→1
  AI 调用 todo add(texts=[...3 items])
    executeTodoAction → userMessageCount: 1→2, lastTodoCallCount=2
    addTodos([], 1, ["修复登录 bug", "添加单元测试", "更新文档"], undefined)
    → todos: [{id:1, status:pending}, {id:2, status:pending}, {id:3, status:pending}]
    → nextId: 4
    allCompletedAtCount: null
  before_agent_start → inject todo_context (3 pending)
  AI 执行步骤1，调用 todo update(id=1, status=completed)
    executeTodoAction → userMessageCount: 2→3, lastTodoCallCount=3
    incompleteBefore = [todo#1, todo#2, todo#3], isLastCompletion = false
    allCompleted = false → allCompletedAtCount: null
  agent_end → 无全部完成，无 stall，无提醒 (3-3=0 < REMINDER_INTERVAL=3)
  
  ...类似继续，完成 #2...
  
  AI 调用 todo update(id=3, status=completed)
    executeTodoAction → userMessageCount: 5→6 (已递增多次)
    incompleteBefore = [todo#3], isLastCompletion = true
    resultText += "All todos completed. Please summarize your work."
    allCompleted = true → allCompletedAtCount = 6

  agent_end → 无 verifyText，无 all-completed-yet (6-6=0 < 2)
  
  下一个 agent_start → userMessageCount: 6→7
  agent_end → 7-6=1 < 2, 不触发 auto-clear
  
  下一个 agent_start → userMessageCount: 7→8
  agent_end → 8-6=2 >= 2, 触发 auto-clear ✓
    todos=[], nextId=1, allCompletedAtCount=null
```

**⚠️ 双重递增问题分析：**

上述推演假设 `agent_start` 每次 +1。但每次 `executeTodoAction` 也 +1。一轮 AI 对话中：
- `agent_start`: +1
- AI 调用 todo 工具: executeTodoAction 内 +1

所以每轮实际 +2。修正后的计数：

```
Turn 0: agent_start → count=1
Turn 0: todo add → count=2, lastTodoCall=2
Turn 1: agent_start → count=3
Turn 1: todo update #1 → count=4, lastTodoCall=4
Turn 1: agent_end → 不触发 (4-4=0 < 2 for stall, 4-4=0 for reminder)
Turn 2: agent_start → count=5
Turn 2: todo update #2 → count=6, lastTodoCall=6
Turn 2: agent_end → 6-6=0
Turn 3: agent_start → count=7
Turn 3: todo update #3 → count=8, allCompletedAtCount=8
Turn 3: agent_end → 8-8=0 < 2, 不触发
Turn 4: agent_start → count=9
Turn 4: agent_end → 9-8=1 < 2, 不触发
Turn 5: agent_start → count=10
Turn 5: agent_end → 10-8=2 >= 2, 触发 auto-clear
```

**结论**：由于双重递增，实际需要 5 个 AI turn 才触发 auto-clear（而非设计意图的 2 轮）。这是 MUST_FIX #1。

### UC-2: 复杂任务的验证

**模拟数据：**
```json
{
  "input_data": {
    "action": "add",
    "texts": ["修复登录模块"],
    "verifyTexts": ["密码错误时返回正确错误码"]
  }
}
```

**执行路径：**
```
todo add(texts=["修复登录模块"], verifyTexts=["密码错误时返回正确错误码"])
  → todos: [{id:1, text:"修复登录模块", status:"pending", verifyText:"密码错误时返回正确错误码", verifyAttempts:0}]

AI 执行修复，调用 todo update(id=1, status=completed)
  → todo.status = "completed", allCompletedAtCount=N

agent_end:
  步骤 1: verifyFailed? → completed + verifyText + verifyAttempts(0) >= 2? → No
  步骤 2: needsVerify? → completed + verifyText + 0 < 2? → Yes (todo #1)
    → verifyAttempts: 0→1
    → deliver steer: "Task #1 needs verification (attempt 1/2): 密码错误时返回正确错误码"
    → return

AI 验证通过，不做额外 todo 调用（verifyAttempts 保持 1）
下一次 agent_end:
  步骤 1: verifyFailed? → completed + verifyText + verifyAttempts(1) >= 2? → No
  步骤 2: needsVerify? → completed + verifyText + 1 < 2? → Yes
    → verifyAttempts: 1→2
    → deliver steer: "Task #1 needs verification (attempt 2/2): ..."
    → return

再一次 agent_end:
  步骤 1: verifyFailed? → completed + verifyText + verifyAttempts(2) >= 2? → Yes!
    → todo.status = "failed"
    → deliver steer: "failed verification after 2 attempts"
```

**⚠️ 问题**：即使 AI 在第 1 次 verify 提醒后实际通过了验证，但 AI 没有显式告知 todo 系统"验证通过"。`verifyAttempts` 只会在 `agent_end` 中被递增，没有任何路径让 `verifyAttempts` 停止递增（除非 AI 把 verifyText 改掉或删掉 todo）。

这意味着 **verify 流程必然导致 failed 状态**，除非 AI 通过某种方式主动 "确认验证通过"。但当前设计中，AI 唯一能做的是：
1. 删除 todo（`delete`）
2. 改 status 为非 completed 再改回来（重置 verifyAttempts？不，verifyAttempts 不会重置）
3. 清空所有 todo（`clear`）

这不符合 UC-2 描述的"验证通过 → 任务保留 completed"的预期。**缺少验证通过的确认机制。**

### UC-3: 批量完成

**模拟数据：**
```json
{
  "input_data": {
    "action": "update",
    "updates": [
      {"id": 1, "status": "completed"},
      {"id": 2, "status": "completed"},
      {"id": 3, "status": "completed"}
    ]
  }
}
```

**执行路径：**
```
executeTodoAction → userMessageCount++, lastTodoCallCount=userMessageCount
  case "update" → params.updates.length > 0 → batch path
    updateTodos(todos, [{id:1,status:"completed"},{id:2,status:"completed"},{id:3,status:"completed"}])
      → 验证: no duplicate ids ✓
      → 验证: all ids exist ✓
      → 验证: each has status ✓
      → apply: all 3 updated to "completed"
    todos = result.updatedTodos
    allCompleted = todos.every(t => t.status === "completed") → true
    allCompletedAtCount = userMessageCount
    resultText = "Updated 3 todo(s)"
  refreshDisplay ✓
  return {content, details} ✓
```

**异常路径：**
```
update(updates=[{id:1},{id:1,status:"completed"}])
  → duplicate ids detected → error: "duplicate ids in updates" ✓

update(updates=[{id:99,status:"completed"}])
  → id 99 not found → error: "id 99 not found" ✓

update(updates=[{id:1}])  // no status, no text
  → "update item for id 1 has neither status nor text" ✓
```

**⚠️ BUT**: `update(updates=[{id:1, status:"banana"}])` → 走到 `u.status as Todo["status"]` → 无运行时校验 → todo.status 变成 "banana"。这是 MUST_FIX #3。

### UC-4: 验证失败

**模拟数据：**
```json
{
  "input_data": {
    "action": "add",
    "texts": ["修复登录模块"],
    "verifyTexts": ["密码错误时返回正确错误码"]
  },
  "steps": ["AI 标记 completed → agent_end verify #1 → AI 尝试修复失败 → agent_end verify #2 → failed"]
}
```

**执行路径：**
```
todo add → todos: [{id:1, verifyText:"密码错误时返回正确错误码", verifyAttempts:0}]
AI 执行修复 → todo update(id=1, status=completed)

agent_end #1:
  needsVerify: verifyAttempts(0) < 2 → Yes
  verifyAttempts: 0→1
  deliver steer: verification prompt

AI 验证失败，重新修复 → (不调用 todo) → agent_end:
  needsVerify: verifyAttempts(1) < 2 → Yes
  verifyAttempts: 1→2
  deliver steer: verification prompt (attempt 2/2)

AI 再次标记 completed → todo update(id=1, status=completed) (幂等，status 已经是 completed)
agent_end:
  verifyFailed: verifyAttempts(2) >= 2 → Yes
  todo.status = "failed" ✓
  deliver steer: "failed verification after 2 attempts" ✓
```

**问题**：上面路径中 AI 需要再次标记 completed 才触发 agent_end 的 failed 检查。但 status 已经是 completed，`todo update(id=1, status=completed)` 虽然是幂等操作，但代码仍然接受它。如果 AI 不重新标记 completed，`agent_end` 仍会在后续 turn 被触发。

实际上，每轮 `agent_end` 都会执行 verify 检查，不需要 AI 重新调用 todo。所以路径修正为：

```
Turn 0: add → completed → agent_end: verifyAttempts 0→1
Turn 1: AI 尝试验证 → agent_end: verifyAttempts 1→2
Turn 2: agent_end: verifyAttempts(2) >= 2 → failed ✓
```

这个路径是正确的，但与 UC-2 的问题一致：**verifyAttempts 只增不减，验证必然走向 failed**。

### 额外路径：reconstructState

**模拟数据：** 旧 session entry: `{type:"toolResult", toolName:"todo", details:{todos:[{id:1, text:"test", done:true}], nextId:2}}`

**执行路径：**
```
reconstructState → iterate entries → find latest toolResult with toolName="todo"
  details.todos = [{id:1, text:"test", done:true}]
  migrateTodo({id:1, text:"test", done:true})
    → hasValidStatus: done:true → "done" not in VALID_STATUSES → false
    → done === true → status: "completed"
    → verifyText: undefined, verifyAttempts: 0
  → todos: [{id:1, text:"test", status:"completed", verifyText:undefined, verifyAttempts:0}]
  → nextId: 2

GC: splice stale entries (entries before latestIdx with toolName="todo") ✓
```

向后兼容 ✓。`allCompletedAtCount` 在 reconstructState 中重置为 null，意味着 session 恢复后 auto-clear 计时器归零，这是合理的。

### 额外路径：delete action

**模拟数据：** `{action:"delete", ids:[2,3]}`

**执行路径：**
```
executeTodoAction → case "delete"
  uniqueIds = [2,3]
  missing check ✓ (假设存在)
  splice todos one by one
  ⚠️ splice 时 index 会偏移：先删 #2，todo 列表缩短，#3 的 index 可能变
  → 但代码用 findIndex 按 id 查找，每次重新定位，所以是安全的 ✓
```

## 结论

**verdict: fail** — 3 个 MUST_FIX 问题：

1. **userMessageCount 双重递增** (`index.ts` executeTodoAction + agent_start)：导致 auto-clear、stall、reminder 的计数全部偏差，实际行为与设计意图不符。executeTodoAction 中的 `userMessageCount++` 应移除。

2. **verify 流程无"验证通过"出口** (`index.ts` agent_end)：`verifyAttempts` 单调递增，没有任何路径可以停止递增并让任务保持在 completed 状态。UC-2 描述的"验证通过 → 任务保留 completed"不可能实现。需要增加验证确认机制（例如：AI 在验证通过后 update status 为 in_progress 再 completed 来重置 attempts，或增加一个 verify_pass 动作，或在 before_agent_start 的 context 中告知 AI 如何确认验证通过）。

3. **batch updateTodos 不校验 status 值** (`model.ts` updateTodos)：单条 update 有 VALID_STATUSES 校验，batch 路径直接 as 强制转换，运行时接受任意字符串。需要在 updateTodos 中增加 VALID_STATUSES 校验。
