---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 1
  issues_found: 0
  must_fix_count: 0
  low_count: 0
  info_count: 1
  duration_estimate: "15"
---

# Dev Business Logic Review v2

## 审查记录
- 审查时间：2026-05-31 16:30
- 审查模式：Dev（修复后重审）
- 审查对象：use-cases.md + todo/src/index.ts
- 模拟数据路径数：8
- 上轮审查：business_logic_review_v1.md（1 MUST_FIX, 1 LOW）

## v1 问题修复确认

| # | 严重度 | 描述 | 状态 | 验证 |
|---|--------|------|------|------|
| M1 | ~~MUST_FIX~~ | 自动清空比较运算符 `>` → `>=` | ✅ 已修复 | L621 确认 `>= AUTO_CLEAR_DELAY_ROUNDS` |
| L2 | ~~LOW~~ | Verification Nudge 重复触发 | ✅ 自动消除 | 修复 M1 后推演：nudge 仅在差值=1 轮触发一次，差值=2 轮时 auto-clear 先触发，nudge 不再可达 |

## UC 覆盖追踪

| UC 编号 | UC 名称 | 覆盖状态 | 执行路径 | 发现的问题 |
|---------|---------|---------|----------|-----------|
| UC-1 | 自动清空已完成任务列表 | ✅ 完整 | 主流程 + 异常路径均可正确走通 | — |
| UC-2 | 长时间未更新 Todo 提醒 | ✅ 完整 | 主流程 + 3 条异常路径均可正确走通 | — |
| UC-3 | 验证步骤提醒 | ✅ 完整 | 主流程 + 2 条异常路径均可正确走通 | — |

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
1. Agent 调用 todo update(id=3, status="completed") — 最后一个
   → isLastCompletion = true
   → allCompleted = true → allCompletedAtCount = 5

2. 用户发送消息 → agent_start: userMessageCount = 6
   → before_agent_start:
     Auto-clear: 6 - 5 = 1 >= 2? No → skip ✅（符合 UC-1 步骤 4：差值=1 < 2，不触发）

3. 用户发送消息 → agent_start: userMessageCount = 7
   → before_agent_start:
     Auto-clear: 7 - 5 = 2 >= 2? Yes → 触发自动清空 ✅（符合 UC-1 步骤 6：差值=2 ≥ 2）
     → todos = [], nextId = 1, allCompletedAtCount = null
     → 返回 todo-auto-clear 消息
```

**异常路径（2 轮内添加新 todo）：**
```
1. allCompletedAtCount = 5
2. Agent 调用 todo add(texts=["新增需求"])
   → add handler: allCompletedAtCount = null → 自动清空取消 ✅
   → 返回前 refreshDisplay 更新状态栏
```

**时序精确匹配验证：** spec 伪代码 `userMessageCount - allCompletedAtCount >= 2`，UC-1 步骤 6 "差值 = 2 ≥ 2"，代码 `>= AUTO_CLEAR_DELAY_ROUNDS`（AUTO_CLEAR_DELAY_ROUNDS=2）。三者一致。✅

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
     → 注入 todo-reminder 消息，lastReminderCount = 21 ✅
```

**异常路径 2a（距上次提醒不足 10 轮）：**
```json
{ "userMessageCount": 25, "lastTodoCallCount": 10, "lastReminderCount": 21 }
```
```
→ 25 - 21 = 4 >= 10? No → 不触发 ✅
```

**异常路径 2b（todo 列表为空）：**
```json
{ "todos": [], "userMessageCount": 25, "lastTodoCallCount": 10, "lastReminderCount": 5 }
```
```
→ todos.length(0) > 0? No → 不触发 ✅
```

**异常路径 2c（已全部完成）：**
```json
{ "todos": [{"id":1,"text":"任务","status":"completed"}], "allCompletedAtCount": 20 }
```
```
→ allCompletedAtCount(20) !== null → Reminder 第 3 条件 allCompletedAtCount === null 为 false → 不触发 ✅
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
  1. Auto-clear: 11 - 10 = 1 >= 2? No → skip
  2. Nudge:
     - allCompletedAtCount(10) !== null? Yes ✅
     - todos.length(3) >= 3? Yes ✅
     - !todos.some(/verif|验证/i) → No match → Yes ✅
     → 注入 todo-verification-nudge 消息 ✅
     → lastReminderCount = 11
```

**下一轮（差值=2）不再重复触发 nudge：**
```
用户发送消息 → agent_start: userMessageCount = 12
→ before_agent_start:
  1. Auto-clear: 12 - 10 = 2 >= 2? Yes → 触发清空，return
     → Nudge 分支不可达 ✅（v1 LOW#2 问题已消除）
```

**异常路径 2a（包含验证关键词）：**
```json
{ "todos": [{"id":1,"text":"验证修复结果","status":"completed"}, ...] }
```
```
→ /verif|验证/i.test("验证修复结果") → true → !true = false → 不触发 ✅
```

**异常路径 2b（todo 数量 < 3）：**
```json
{ "todos": [{"id":1,"text":"修复 bug","status":"completed"},{"id":2,"text":"更新文档","status":"completed"}] }
```
```
→ todos.length(2) >= 3? No → 不触发 ✅
```

## 问题清单

| # | 严重度 | UC 编号 | 描述 | 文件 | 行号/位置 | 修改建议 |
|---|--------|---------|------|------|----------|---------|
| 1 | INFO | — | v3 计数器未持久化到 session entries，session 重建后全部重置 | todo/src/index.ts | L566-569 | 已知限制，spec 明确"旧 session 无需迁移" |

## 结论

**通过。** v1 的唯一 MUST_FIX（自动清空 off-by-one）已正确修复，`>` 改为 `>=` 后 UC-1 时序与 spec/UC 完全一致。v1 的 LOW（nudge 重复触发）随 M1 修复自动消除。三个 UC 的全部主流程和异常路径推演通过，无新发现问题。
