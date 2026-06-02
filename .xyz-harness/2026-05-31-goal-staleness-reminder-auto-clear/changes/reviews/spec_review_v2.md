---
review:
  type: spec_review
  round: 2
  timestamp: "2026-05-31T16:30:00"
  target: ".xyz-harness/2026-05-31-goal-staleness-reminder-auto-clear/spec.md"
  verdict: pass
  summary: "3 条 MUST FIX 全部解决。v1 的 LOW/INFO 问题也已逐一回应。新增内容发现 2 条 LOW，不阻塞通过"

statistics:
  total_issues: 10
  must_fix: 0
  must_fix_resolved: 3
  low: 2
  info: 0

carried_issues:
  - original_id: 1
    v1_severity: MUST_FIX
    v2_status: resolved
    resolution: "FR-2 统一为'一次性列出所有非终态 task 及其 subtask 的停滞 turn 数'，AC-2 第 5 条对应修改。矛盾消除"

  - original_id: 2
    v1_severity: MUST_FIX
    v2_status: resolved
    resolution: "FR-4 新增完整快照机制定义（entry type、字段、写入时机、GC 策略）。AC-1 第 5 条 + AC-4 第 4/5 条联动验证。与 clearGoalSession 隔离"

  - original_id: 3
    v1_severity: MUST_FIX
    v2_status: resolved
    resolution: "FR-1 明确'widget 折叠为单行 status bar（终态状态 + 预算摘要），task 列表不再渲染'。AC-1 第 2 条对应验证"

  - original_id: 4
    v1_severity: LOW
    v2_status: resolved
    resolution: "Constraints 明确'默认 10 turn，暂不可配置，后续按需加入配置'"

  - original_id: 5
    v1_severity: LOW
    v2_status: resolved
    resolution: "FR-2 新增边界情况条目 + AC-2 第 7 条验证"

  - original_id: 6
    v1_severity: LOW
    v2_status: resolved
    resolution: "Constraints 新增'_render 协议：字段名同步变更，xyz-agent GUI 侧需配套更新'"

  - original_id: 7
    v1_severity: INFO
    v2_status: kept
    resolution: "FR-3 保留 subUpdates 条目，标注'保持不变'。不影响实现，可接受"

  - original_id: 8
    v1_severity: INFO
    v2_status: resolved
    resolution: "AC-2 第 1 条明确'初始值 0，goal 创建时设置'"

new_issues:
  - id: 9
    severity: LOW
    location: "spec.md > AC-2 第 3 条"
    title: "Subtask lastUpdatedTurn 默认值表述有歧义：'默认为父 task 创建时的 currentTurnIndex' 可能误导实现者使用 task 创建时的值而非 subtask 创建时的值"
    status: open
    raised_in_round: 2
    suggestion: "改为'默认为 subtask 创建时的 currentTurnIndex'，消除'父 task'的歧义引用"

  - id: 10
    severity: LOW
    location: "spec.md > FR-1 第 4 点"
    title: "'complete 终态保留 budget report 通知'单独提 complete 可能让人误以为其他终态行为不同"
    status: open
    raised_in_round: 2
    suggestion: "改为'所有终态均保留 budget report 通知，用户有 2 轮窗口查看'，或删除此条（因为上一条已定义所有终态统一折叠为 status bar）"
---

# Spec 评审 v2

## 评审记录
- 评审时间：2026-05-31 16:30
- 评审类型：计划评审 — spec v1 修改后复审
- 评审对象：`.xyz-harness/2026-05-31-goal-staleness-reminder-auto-clear/spec.md`（v1 修改版）

## MUST FIX 逐项验证

### #1 提醒范围矛盾 — ✅ 已解决

v1 问题：FR-2 正文说"只提醒最小编号停滞项"，AC-2 说"提醒所有非终态项"。

v2 修改：
- FR-2 明确"提醒范围：一次性列出所有非终态 task 及其 subtask 的停滞 turn 数"
- AC-2 第 5 条"提醒内容列出所有非终态 task 及其停滞 turn 数（含 subtask 状态摘要）"

两边语义一致，矛盾消除。

### #2 Auto-clear 与 history 数据冲突 — ✅ 已解决

v1 问题：clearGoalSession 删除 session.state 后 history 无数据源，快照机制未定义。

v2 修改：
- FR-4 新增完整快照定义：`goal-history` entry type，字段 { goalId, objective, status, completedTasks, totalTasks, elapsedSeconds, timestamp }
- 写入时机明确：终态时（clearGoalSession 之前）
- GC 策略明确：session 级最多 20 条
- AC-1 第 5 条 + AC-4 第 4/5 条联动验证写入和清理隔离

数据链路闭环。

### #3 终态 widget 中间态 — ✅ 已解决

v1 问题："不立即清除 widget"与"保留 status bar"之间有歧义。

v2 修改：
- FR-1 明确"widget 折叠为单行 status bar（显示终态状态 + 预算摘要，如 `◆ Goal ✓ 完成 | 3/5 任务 | Token: 45%`），task 列表不再渲染"
- AC-1 第 2 条验证"widget 折叠为单行 status bar，task 列表不显示"

渲染行为不再有歧义。

## LOW/INFO 遗留项检查

| # | v1 严重性 | v2 状态 | 说明 |
|---|----------|--------|------|
| 4 | LOW | ✅ 已解决 | Constraints 明确不可配置决策 |
| 5 | LOW | ✅ 已解决 | FR-2 + AC-2 覆盖边界情况 |
| 6 | LOW | ✅ 已解决 | Constraints 补充 _render 协议说明 |
| 7 | INFO | 保留 | subUpdates 不影响实现 |
| 8 | INFO | ✅ 已解决 | AC-2 明确初始值 |

## 新增内容审查

v2 在 FR-1/FR-2/FR-4/AC-1/AC-2/AC-4/Constraints 中新增内容约 40 行。逐段审查发现 2 条 LOW：

1. **AC-2 第 3 条**：Subtask `lastUpdatedTurn` "默认为父 task 创建时的 currentTurnIndex"——subtask 是通过 `add_subtasks` 后续添加的，"父 task 创建时"的 turn index 与 subtask 创建时不同。表述应改为"默认为 subtask 创建时的 currentTurnIndex"。

2. **FR-1 第 4 点**："complete 终态保留 budget report 通知"单独提 complete 可能让人误以为其他终态行为不同。实际上所有终态都走同样的折叠+2 轮后清理流程，应统一表述。

两条都不影响实现正确性（实现者按自然语义理解不会出错），不阻塞通过。

## 结论

**PASS。** 3 条 MUST FIX 全部解决，spec 可以进入 plan 阶段。2 条 LOW 建议在 plan 阶段开始前修正，但不作为阻塞条件。
