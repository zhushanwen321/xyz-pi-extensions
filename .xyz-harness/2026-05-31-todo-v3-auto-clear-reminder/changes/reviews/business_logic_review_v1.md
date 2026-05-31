---
verdict: fail
must_fix: 1
review_metrics:
  files_reviewed: 1
  issues_found: 3
  must_fix_count: 1
  low_count: 1
  info_count: 1
  duration_estimate: "25"
---

# Dev Business Logic Review v1

## 审查记录
- 审查时间：2026-05-31 15:00
- 审查模式：Dev
- 审查对象：use-cases.md + todo/src/index.ts
- 模拟数据路径数：8

## UC 覆盖追踪

| UC 编号 | UC 名称 | 覆盖状态 | 执行路径 | 发现的问题 |
|---------|---------|---------|----------|-----------|
| UC-1 | 自动清空已完成任务列表 | ⚠️ 部分 | 主流程可走通但时序错误 | 差值比较用 `>` 应为 `>=`，触发延迟 1 轮 |
| UC-2 | 长时间未更新 Todo 提醒 | ✅ 完整 | 主流程 + 3 条异常路径均可走通 | — |
| UC-3 | 验证步骤提醒 | ✅ 完整 | 主流程 + 2 条异常路径均可走通 | — |

## 问题清单

| # | 严重度 | UC 编号 | 描述 | 文件 | 行号/位置 | 修改建议 |
|---|--------|---------|------|------|----------|---------|
| 1 | MUST_FIX | UC-1 | 自动清空比较运算符错误：`> AUTO_CLEAR_DELAY_ROUNDS` 应为 `>= AUTO_CLEAR_DELAY_ROUNDS`，导致自动清空延迟 3 轮而非 spec/UC 要求的 2 轮 | todo/src/index.ts | L621 | `>` 改为 `>=` |
| 2 | LOW | UC-3 | Verification Nudge 无去重守卫：在全部完成到自动清空之间，每次 `before_agent_start` 都会触发 nudge。当前 `> 2` 逻辑下会连续触发 2 次 | todo/src/index.ts | L637-645 | 修复 #1 后此问题自动消失（`>= 2` 使 auto-clear 在第 2 轮触发，nudge 仅在第 1 轮触发一次）；如需额外保护可加 `nudgeFired` 标志 |
| 3 | INFO | — | v3 计数器（userMessageCount/allCompletedAtCount/lastTodoCallCount/lastReminderCount）未持久化到 session entries，session 重建后全部重置为初始值 | todo/src/index.ts | L566-569 | 已知限制，spec 明确"旧 session 无需迁移"。记录即可 |

## 执行路径详情

### UC-1: 自动清空已完成任务列表

**模拟数据（主流程）：**
```json
{
  "uc_id": "UC-1",
  "scenario": "3 个 todo 全部完成后，2 轮用户消息触发自动清空",
  "initial_state": {
    "todos": [
      { "id": 1, "text": "修复登录 bug", "status": "pending" },
      { "id": 2, "text": "更新文档", "status": "pending" },
      { "id": 3, "text": "添加测试", "status": "pending" }
    ],
    "userMessageCount": 5,
    "allCompletedAtCount": null
  }
}
```

**执行路径：**
```
1. Agent 调用 todo update(id=1, status="completed")
   → index.ts:239 lastTodoCallCount = 5
   → index.ts:290 allCompletedAtCount = null (还有未完成的)
   → result: "已更新 todo #1，状态 → completed"

2. Agent 调用 todo update(id=2, status="completed")
   → index.ts:239 lastTodoCallCount = 5
   → index.ts:290 allCompletedAtCount = null (还有未完成的)
   → result: "已更新 todo #2，状态 → completed"

3. Agent 调用 todo update(id=3, status="completed")
   → index.ts:239 lastTodoCallCount = 5
   → index.ts:376 isLastCompletion = true (incompleteBefore=1)
   → index.ts:394-396 allCompleted = true → allCompletedAtCount = 5
   → result: "已更新 todo #3...所有 todo 已完成。请总结工作成果。"

4. 用户发送消息 → agent_start: userMessageCount = 6
   → before_agent_start: 6 - 5 = 1 > 2? No → 不触发 ✅

5. 用户发送消息 → agent_start: userMessageCount = 7
   → before_agent_start: 7 - 5 = 2 > 2? No → ❌ 应触发但未触发！
   → Spec UC-1: "差值 = 2 ≥ 2，触发自动清空"
   → 代码要求差值 > 2（即 ≥ 3），比 spec 多等 1 轮

6. 用户发送消息 → agent_start: userMessageCount = 8
   → before_agent_start: 8 - 5 = 3 > 2? Yes → 触发自动清空
   → todos = [], nextId = 1, allCompletedAtCount = null
   → 返回 todo-auto-clear 消息
```

**异常路径（2 轮内添加新 todo）：**
```
1. allCompletedAtCount = 5
2. 用户发送消息 → userMessageCount = 6
3. Agent 调用 todo add(texts=["新增需求"])
   → index.ts:292 allCompletedAtCount = null → 自动清空取消 ✅
```

**根因：** L621 使用 `>` 而非 `>=`，与 spec 伪代码（`>= 2`）和 UC-1 主流程（差值 = 2 ≥ 2）不一致。

---

### UC-2: 长时间未更新 Todo 提醒

**模拟数据（主流程）：**
```json
{
  "uc_id": "UC-2",
  "scenario": "有未完成 todo，10 轮未调用 todo 工具",
  "initial_state": {
    "todos": [
      { "id": 1, "text": "重构模块 A", "status": "in_progress" },
      { "id": 2, "text": "编写测试", "status": "pending" }
    ],
    "userMessageCount": 20,
    "lastTodoCallCount": 10,
    "lastReminderCount": 5,
    "allCompletedAtCount": null
  }
}
```

**执行路径：**
```
用户发送消息 → agent_start: userMessageCount = 21
→ before_agent_start:
  1. Auto-clear: allCompletedAtCount === null → skip
  2. Nudge: allCompletedAtCount === null → skip
  3. Reminder:
     - todos.length(2) > 0? Yes ✅
     - allCompletedAtCount === null? Yes ✅
     - 21 - 10 = 11 >= 10? Yes ✅
     - 21 - 5 = 16 >= 10? Yes ✅
     → 注入 todo-reminder 消息
     → lastReminderCount = 21
```

**异常路径 2a（距上次提醒不足 10 轮）：**
```json
{
  "userMessageCount": 25,
  "lastTodoCallCount": 10,
  "lastReminderCount": 21
}
```
```
→ before_agent_start:
  - 25 - 10 = 15 >= 10? Yes
  - 25 - 21 = 4 >= 10? No → 不触发 ✅
```

**异常路径 2b（todo 列表为空）：**
```json
{
  "todos": [],
  "userMessageCount": 25,
  "lastTodoCallCount": 10,
  "lastReminderCount": 5
}
```
```
→ before_agent_start:
  - todos.length(0) > 0? No → 不触发 ✅
```

**异常路径 2c（已全部完成）：**
```json
{
  "todos": [{ "id": 1, "text": "任务", "status": "completed" }],
  "userMessageCount": 25,
  "lastTodoCallCount": 10,
  "lastReminderCount": 5,
  "allCompletedAtCount": 20
}
```
```
→ before_agent_start:
  - allCompletedAtCount(20) !== null → 等待自动清空，不触发 reminder ✅
```

---

### UC-3: 验证步骤提醒

**模拟数据（主流程）：**
```json
{
  "uc_id": "UC-3",
  "scenario": "完成 3 个无验证关键词的 todo",
  "initial_state": {
    "todos": [
      { "id": 1, "text": "修复 bug A", "status": "completed" },
      { "id": 2, "text": "修复 bug B", "status": "completed" },
      { "id": 3, "text": "更新 README", "status": "completed" }
    ],
    "userMessageCount": 10,
    "allCompletedAtCount": 10
  }
}
```

**执行路径：**
```
用户发送消息 → agent_start: userMessageCount = 11
→ before_agent_start:
  1. Auto-clear: 11 - 10 = 1 > 2? No → skip
  2. Nudge:
     - allCompletedAtCount(10) !== null? Yes ✅
     - todos.length(3) >= 3? Yes ✅
     - /verif|验证/i.test? No match → Yes ✅
     → 注入 todo-verification-nudge 消息
     → lastReminderCount = 11
```

**异常路径 2a（包含验证关键词）：**
```json
{
  "todos": [
    { "id": 1, "text": "修复 bug", "status": "completed" },
    { "id": 2, "text": "更新文档", "status": "completed" },
    { "id": 3, "text": "验证修复结果", "status": "completed" }
  ]
}
```
```
→ /verif|验证/i.test("验证修复结果") → true → !true = false → 不触发 ✅
```

**异常路径 2b（todo 数量 < 3）：**
```json
{
  "todos": [
    { "id": 1, "text": "修复 bug", "status": "completed" },
    { "id": 2, "text": "更新文档", "status": "completed" }
  ]
}
```
```
→ todos.length(2) >= 3? No → 不触发 ✅
```

**当前代码下 Nudge 重复触发路径（LOW #2）：**
```
假设 allCompletedAtCount = 10, todos = 3 个已完成（无验证关键词）

消息 1: userMessageCount = 11
  Auto-clear: 11-10=1 > 2? No
  Nudge: 条件满足 → 触发 ✅ (第 1 次)

消息 2: userMessageCount = 12
  Auto-clear: 12-10=2 > 2? No
  Nudge: 条件仍满足 → 触发 ✅ (第 2 次，重复！)

消息 3: userMessageCount = 13
  Auto-clear: 13-10=3 > 2? Yes → 清空，不走到 nudge

若修复 #1 (> 改 >=)：
消息 1: Auto-clear: 1 >= 2? No → Nudge 触发 (第 1 次)
消息 2: Auto-clear: 2 >= 2? Yes → 清空 → 不走到 nudge
→ 重复触发问题消失
```

## 结论

**需修改：** 1 条 MUST FIX。

UC-2 和 UC-3 的主流程和异常路径全部可走通，实现正确。UC-1 的自动清空功能存在 off-by-one 错误：`>` 应改为 `>=`，否则自动清空比 spec/UC 规定的延迟 1 轮（3 轮而非 2 轮）。此修复同时消除 Verification Nudge 的重复触发问题。

修复建议：
```typescript
// index.ts L621
// 修改前:
if (allCompletedAtCount !== null && userMessageCount - allCompletedAtCount > AUTO_CLEAR_DELAY_ROUNDS) {
// 修改后:
if (allCompletedAtCount !== null && userMessageCount - allCompletedAtCount >= AUTO_CLEAR_DELAY_ROUNDS) {
```
