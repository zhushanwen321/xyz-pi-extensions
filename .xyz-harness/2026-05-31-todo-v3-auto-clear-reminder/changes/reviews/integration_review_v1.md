---
verdict: fail
must_fix: 1
review_metrics:
  files_reviewed: 1
  boundaries_checked: 8
  issues_found: 3
  must_fix_count: 1
  low_count: 2
  info_count: 0
  duration_estimate: "20"
---

# Integration Review v1

## 审查记录
- 审查时间：2026-05-31 16:30
- 上游 BLR: business_logic_review_v1.md
- 模块边界点数：8
- 模拟数据验证路径数：5

## 边界拓扑

本扩展为单文件架构（`todo/src/index.ts`），模块边界主要体现在**共享状态的生产者-消费者关系**和 **Pi Runtime API 契约**上：

| 边界编号 | 生产者 | 消费者 | 共享变量/接口 |
|----------|--------|--------|--------------|
| B1 | `executeTodoAction` | module-level state | `todos`, `nextId`, `allCompletedAtCount`, `lastTodoCallCount` |
| B2 | `agent_start` handler | module-level state | `userMessageCount` (++) |
| B3 | `before_agent_start` handler | module-level state | 读取全部 v3 计数器，写入 `todos`, `nextId`, `allCompletedAtCount`, `lastReminderCount` |
| B4 | `before_agent_start` | Pi hook return contract | `{ message: { customType, content, display } }` |
| B5 | `executeTodoAction` | Pi tool result contract | `{ content, details }` |
| B6 | `refreshDisplay` | Pi UI API | `ctx.ui.setStatus`, `ctx.ui.setWidget` |
| B7 | `reconstructState` | session entries → state | 从 entries 恢复 `todos`, `nextId` |
| B8 | auto-clear (before_agent_start) | reconstructState | 自动清空后未持久化，reconstructState 恢复旧数据 |

## 边界检查矩阵

| UC 编号 | 边界点 | D1 格式转换 | D2 错误传播 | D3 契约一致 | D4 前后端 | 问题 |
|---------|--------|------------|------------|------------|----------|------|
| UC-1 | B1→B3: executeTodoAction 设置 allCompletedAtCount | ✅ | ✅ | ❌ | — | `>` vs `>=`，阈值与 UC 规定的差值语义不一致 |
| UC-1 | B2→B3: agent_start 递增 userMessageCount | ✅ | ✅ | ✅ | — | — |
| UC-1 | B3→B4: before_agent_start 返回 hook message | ✅ | ✅ | ✅ | — | — |
| UC-1 | B3→B6: auto-clear 调用 refreshDisplay | ✅ | ✅ | ✅ | — | — |
| UC-1 | B3→B8: auto-clear 未持久化 | ✅ | — | ⚠️ | — | reconstructState 会恢复已清空的 todos |
| UC-2 | B1→B3: executeTodoAction 设置 lastTodoCallCount | ✅ | ✅ | ✅ | — | — |
| UC-2 | B3→B4: reminder 返回 hook message | ✅ | ✅ | ✅ | — | — |
| UC-2 | B3 内部: nudge/reminder 共用 lastReminderCount | ✅ | ✅ | ✅ | — | 互斥条件保证不冲突 |
| UC-3 | B1→B3: allCompletedAtCount + todos 关键词检查 | ✅ | ✅ | ⚠️ | — | 无去重守卫，修复 #1 后消失 |
| UC-3 | B3→B4: nudge 返回 hook message | ✅ | ✅ | ✅ | — | — |
| — | B5: tool result 结构 | ✅ | ✅ | ✅ | — | content + details 格式正确 |
| — | B7: reconstructState 恢复状态 | ✅ | ✅ | ✅ | — | v3 计数器重置为初始值（已知限制） |

## 问题清单

| # | 严重度 | UC | 边界点 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|-----|--------|------|------|------|------|---------|
| 1 | MUST_FIX | UC-1 | B1→B3 | D3 | 自动清空比较运算符错误：`> AUTO_CLEAR_DELAY_ROUNDS` 应为 `>= AUTO_CLEAR_DELAY_ROUNDS`。`executeTodoAction` 设置 `allCompletedAtCount = userMessageCount`，`before_agent_start` 读取时要求差值 > 2（即 ≥ 3），与 UC-1 规定的"差值 = 2 ≥ 2 触发"不一致。这是跨状态边界的契约违约 | todo/src/index.ts | L621 | `>` 改为 `>=` |
| 2 | LOW | UC-1 | B3→B8 | D3 | auto-clear 修改状态后未通过 `pi.appendEntry` 持久化。若 `session_tree` 在 auto-clear 窗口内触发（如 compaction），`reconstructState` 从 entries 恢复出最近一次 tool 调用的 completed todos，同时 `allCompletedAtCount` 被重置为 null，导致 auto-clear 永远不会重新触发，completed todos 卡在列表中 | todo/src/index.ts | L623-631 | auto-clear 后追加一条 entry 记录清空操作，或在 reconstructState 中检查是否存在 auto-clear entry；低优先级因为 session_tree 触发频率低且用户可手动 clear |
| 3 | LOW | UC-3 | B1→B3 | D3 | Verification Nudge 在全部完成到自动清空之间的每一轮 `before_agent_start` 都会重复触发（无去重守卫）。当前 `>` bug 下连续触发 2 次。修复 #1 后 auto-clear 提前到第 2 轮，nudge 仅触发 1 次，此问题消失 | todo/src/index.ts | L637-645 | 修复 #1 后自动消除；如需额外保护可加 `nudgeFired` 标志 |

## 模拟数据验证详情

### UC-1: 自动清空 — 边界 B1→B3（MUST_FIX）

**模拟数据：** `allCompletedAtCount = 5, AUTO_CLEAR_DELAY_ROUNDS = 2`

**生产者（executeTodoAction）：**
```
update(id=3, status="completed")
→ allCompleted = true → allCompletedAtCount = userMessageCount  // 设为 5
```

**消费者（before_agent_start）：**
```
// Round N+1: agent_start → userMessageCount = 6
diff = 6 - 5 = 1
1 > 2? No → skip                        // ✅ 正确

// Round N+2: agent_start → userMessageCount = 7
diff = 7 - 5 = 2
2 > 2? No → skip                        // ❌ 应触发，UC 规定 diff=2 ≥ 2 触发

// Round N+3: agent_start → userMessageCount = 8
diff = 8 - 5 = 3
3 > 2? Yes → 触发 auto-clear            // 比预期多等 1 轮
```

**修复后（`>=`）：**
```
diff = 7 - 5 = 2
2 >= 2? Yes → 触发 auto-clear           // ✅ 符合 UC-1
```

**结论：** 边界处的阈值契约不一致，生产者设置的时间戳被消费者用错误的比较运算符消费。

### UC-1: 自动清空 — 边界 B2→B3（事件时序验证）

**关键时序：** `agent_start`（userMessageCount++）→ `before_agent_start`（读取 userMessageCount）

**模拟数据：**
```
Round N: userMessageCount = 5 时完成所有 todo
  agent_start: userMessageCount = 6
  before_agent_start: diff = 6 - 5 = 1

Round N+1:
  agent_start: userMessageCount = 7
  before_agent_start: diff = 7 - 5 = 2  // 关键轮次
```

**结论：** 时序正确。`agent_start` 先于 `before_agent_start` 执行，保证 `userMessageCount` 已递增后才做差值比较。

### UC-2: Reminder — 边界 B1→B3

**模拟数据：** `userMessageCount = 21, lastTodoCallCount = 10, lastReminderCount = 5, TODO_REMINDER_INTERVAL = 10`

**生产者（executeTodoAction，10 轮前）：**
```
lastTodoCallCount = 10  // 记录最后一次调用
```

**消费者（before_agent_start）：**
```
todos.length(2) > 0? Yes
allCompletedAtCount === null? Yes
21 - 10 = 11 >= 10? Yes
21 - 5 = 16 >= 10? Yes
→ 触发 reminder, lastReminderCount = 21 ✅
```

**异常路径 2a（距上次提醒不足 10 轮）：**
```
lastReminderCount = 21, userMessageCount = 25
25 - 21 = 4 >= 10? No → 不触发 ✅
```

**结论：** 边界正确。`lastTodoCallCount` 和 `lastReminderCount` 两个独立计数器在 `before_agent_start` 中同时满足才触发，防止频繁提醒。

### UC-3: Nudge — 边界 B1→B3（含重复触发路径）

**模拟数据：** `allCompletedAtCount = 10, todos = 3 completed（无验证关键词）, userMessageCount = 11`

**当前代码（`>` bug 存在时）：**
```
// Round 1: userMessageCount = 11
auto-clear: 11 - 10 = 1 > 2? No
nudge: allCompletedAtCount !== null ✅, todos.length(3) >= 3 ✅, 无验证关键词 ✅
→ 触发 nudge（第 1 次）, lastReminderCount = 11

// Round 2: userMessageCount = 12
auto-clear: 12 - 10 = 2 > 2? No
nudge: 条件仍满足 → 触发 nudge（第 2 次，重复！）

// Round 3: userMessageCount = 13
auto-clear: 13 - 10 = 3 > 2? Yes → 清空
```

**修复后（`>=`）：**
```
// Round 1: userMessageCount = 11
auto-clear: 1 >= 2? No → nudge 触发（第 1 次）

// Round 2: userMessageCount = 12
auto-clear: 2 >= 2? Yes → 清空 → 不走到 nudge ✅
```

**结论：** Nudge 重复触发是 `>` bug 的连锁反应，修复 #1 后自动消除。

### UC-1: auto-clear — 边界 B3→B8（状态持久化间隙）

**模拟数据：** auto-clear 触发后，`session_tree` 紧接着触发

**auto-clear 执行：**
```
todos = [], nextId = 1, allCompletedAtCount = null
// 未调用 pi.appendEntry —— 无持久化记录
```

**session_tree 触发 reconstructState：**
```
扫描 entries → 找到最近一条 toolResult(toolName="todo")
→ details.todos = [3 个 completed todo]  // auto-clear 前的状态
→ todos 恢复为 3 个 completed todo
→ allCompletedAtCount = null  // 重置为初始值
→ auto-clear 永远不会重新触发（allCompletedAtCount === null）
```

**结论：** 存在状态持久化间隙。实际影响低——`session_tree`（compaction 触发）在 auto-clear 窗口（2 轮）内同时触发的概率极低，且用户可手动 clear 兜底。

## 结论

**需修改：** 1 条 MUST FIX，2 条 LOW。

核心问题与 BLR 一致：UC-1 的 `>` 运算符应改为 `>=`，这是 `executeTodoAction`（设置 `allCompletedAtCount`）与 `before_agent_start`（消费该值）之间的契约不一致。此修复同时消除 UC-3 Nudge 的重复触发问题。

新增发现：auto-clear 状态未持久化，存在与 `reconstructState` 的集成间隙（LOW），但实际触发概率极低。

其余 6 个边界点（事件时序、Pi API 契约、UI 刷新、reminder 条件互斥）全部正确。
