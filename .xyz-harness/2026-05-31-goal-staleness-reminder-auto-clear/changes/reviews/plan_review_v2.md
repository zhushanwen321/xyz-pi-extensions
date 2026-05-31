---
review:
  type: plan_review
  round: 2
  timestamp: "2026-05-31T17:00:00"
  target: ".xyz-harness/2026-05-31-goal-staleness-reminder-auto-clear/plan.md"
  verdict: pass
  summary: "计划评审第2轮，v1 的 2 条 MUST FIX 和 2 条 LOW 全部已解决，无新问题引入"

statistics:
  total_issues: 4
  must_fix: 0
  low: 0
  info: 4

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 1 替换规则表"
    title: "Task 1 替换规则表遗漏 _render 数据中 subItems → subtasks 的 key 重命名"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 4 completedAtTurnIndex/goal-history 写入位置"
    title: "Task 4 遗漏 handleGoalCommand 中 /goal clear 和 /goal set（替换旧 goal）两个终态路径"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 3
    severity: LOW
    location: "plan.md:Task 3/Task 4"
    title: "handleBeforeAgentStart 重构方案和 updateWidget 修改方案未显式描述"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 4
    severity: LOW
    location: "plan.md:Task 3"
    title: "staleness reminder 返回后会替代 context injection，此交互未显式说明"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

info:
  - text: "handleBeforeAgentStart 伪代码中 staleness 检查位于 context injection 之前，return 后不会执行 injection。这与 Task 4 注意事项一致，逻辑正确。"
  - text: "cancel_goal case 的备注（cancel 后紧跟 clearGoalSession，快照必须在 clear 前）是正确的时序约束，源码确认了 clearGoalSession 会清除 session.state。"
  - text: "Task 4 goal-history GC 放在 reconstructGoalState 中（session 启动时清理），时机合理，不影响运行时性能。"
  - text: "updateWidget 结构变更描述为新增 isTerminalStatus 分支调用 renderTerminalStatusLine，与 renderTerminalStatusLine cancelled 返回空串的设计一致。"
---

# 计划评审 v2

## 评审记录
- 评审时间：2026-05-31 17:00
- 评审类型：计划评审（第 2 轮）
- 评审对象：`.xyz-harness/2026-05-31-goal-staleness-reminder-auto-clear/plan.md`（v1 修复后版本）
- 对比基线：plan_review_v1.md 的 4 条 issue

---

## 1. MUST FIX 验证

### Issue #1: _render key subItems → subtasks

**状态：已解决。**

- Task 1 替换规则表末尾新增行：`subItems` (_render data key) → `subtasks`，位置：index.ts makeGoalResult。
- 验证步骤追加：`grep -n "subItems" goal/src/index.ts` 返回 0 行。
- 对照源码 index.ts:175，`subItems: t.subTodos?.map(...)` 确实存在于 makeGoalResult 中，替换规则覆盖正确。

### Issue #2: /goal clear 和 /goal set 终态路径遗漏

**状态：已解决。**

- Task 4 completedAtTurnIndex 记录位置列表新增两处：
  - (4) `handleGoalCommand` "clear" case 中 `state.status = "cancelled"` 之后、`clearGoalSession` 之前
  - (5) `handleGoalCommand` "set" case 中取消旧 goal 的 `state.status = "cancelled"` 之后、`persistGoalState` 之前
- 对照源码：
  - clear case (L631): `state.status = "cancelled"` → `persistGoalState` → `clearGoalSession` — 快照应在 persistGoalState 之前、status 赋值之后写入，plan 描述准确。
  - set case (L682): `state.status = "cancelled"` → `persistGoalState` — 同上，时序正确。

---

## 2. LOW 验证

### Issue #3: handleBeforeAgentStart / updateWidget 结构变更未描述

**状态：已解决。**

- Task 4 新增 `handleBeforeAgentStart 结构变更` 小节，用伪代码清晰描述了三层控制流：终态处理 → 停滞提醒 → context injection。
- Task 4 新增 `updateWidget 结构变更` 小节，明确描述了 isTerminalStatus 分支。
- 伪代码逻辑与源码现有 handleBeforeAgentStart 的位置（isActiveStatus 检查前插入）一致。

### Issue #4: staleness reminder 替代 context injection 未说明

**状态：已解决。**

- Task 4 末尾新增注意事项："staleness reminder 返回后，本轮不再注入常规 context injection（staleness prompt 已包含足够 goal 上下文）。"
- 与 handleBeforeAgentStart 伪代码中 staleness 检查在 context injection 之前 return 的行为一致。

---

## 3. 新增内容检查

审查 v1→v2 新增的所有内容，未发现引入新问题：

| 新增内容 | 检查结果 |
|---------|---------|
| Task 1 替换规则表末行 + 验证 grep | 精确映射，与源码 L175 对应 |
| Task 4 终态位置 (4)(5) | 时序正确（status 赋值后、clear/persist 前） |
| Task 4 handleBeforeAgentStart 伪代码 | 三层分支逻辑正确，return 点合理 |
| Task 4 updateWidget 结构变更 | 描述简洁准确，与 renderTerminalStatusLine 签名一致 |
| Task 4 staleness 注意事项 | 补充说明交互行为，不影响实现 |

---

## 4. 结论

v1 的 2 条 MUST FIX 和 2 条 LOW 全部已解决，修复内容准确且未引入新问题。计划可以进入执行阶段。
