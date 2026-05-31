---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-31T22:30:00"
  target: ".xyz-harness/2026-05-31-todo-v3-auto-clear-reminder/plan.md"
  verdict: fail
  summary: "计划评审完成，第1轮，1条MUST FIX（事件顺序假设错误导致全功能时序偏移），需修改后重审"

statistics:
  total_issues: 4
  must_fix: 1
  low: 3
  info: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 2 + Task 3 (agent_start / before_agent_start 事件)"
    title: "事件顺序假设错误：agent_start 在 before_agent_start 之后触发"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "plan.md:Task 3 before_agent_start handler"
    title: "Verification Nudge 可能重复触发（取决于事件顺序修复方案）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "plan.md:Task List 依赖表"
    title: "Task 3 逻辑依赖 Task 5（使用 lastTodoCallCount）但依赖表未体现"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "plan.md:Task 5 Step 4"
    title: "未提及保留 update handler 中已有的 isLastCompletion 逻辑"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-31 22:30
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-05-31-todo-v3-auto-clear-reminder/plan.md` + `spec.md`

## 1. Spec 完整性

| 检查项 | 结论 |
|--------|------|
| 目标是否明确 | ✅ 一句话可概括：为 todo 扩展添加自动清空、Reminder、Verification Nudge |
| 范围是否合理 | ✅ 三个功能聚焦于 todo 扩展内部，不跨模块，边界清晰 |
| 验收标准可量化 | ✅ AC1-AC3 都有明确数值（2轮/10轮/3+任务），AC4 是静态配置 |
| 待决议项 | ✅ 无 `[待决议]` 标记 |

**Spec 无问题。**

## 2. Plan 可行性

### 任务拆分

6 个 task 拆分合理，每个 task 粒度适中（单一职责），可由一个 subagent 独立完成。唯一文件 `todo/src/index.ts` 约 500 行，每个 task 变更量在 10-40 行之间，工作量估算现实。

### 依赖关系

**依赖图和 Wave Schedule 执行顺序正确**（Task 5 在 Task 3 之前执行），但**依赖表不完整**——见 Issue #3。

### 严重问题：事件顺序假设错误（Issue #1）

Plan 将 `userMessageCount++` 放在 `agent_start` 事件中，将所有检查逻辑放在 `before_agent_start` 事件中。Plan 隐含假设 `agent_start` 先于 `before_agent_start` 触发。

**实际行为（通过阅读 Pi 源码 `agent-session.ts` + `agent-loop.ts` 确认）：**

```
prompt() 调用
  → emitBeforeAgentStart()       ← before_agent_start 触发（检查逻辑）
  → agent.prompt(messages)       ← agent loop 启动
    → runAgentLoop()
      → emit({ type: "agent_start" })  ← agent_start 触发（计数递增）
```

`before_agent_start` 在 `agent_start` **之前**触发。这意味着 `userMessageCount` 在检查时尚未递增。

**后果：**

| 功能 | 预期行为 | 实际行为（修复前） |
|------|---------|-------------------|
| 自动清空 | 2 轮后清空 | 3 轮后清空（off-by-one） |
| Todo Reminder | 10 轮后触发 | 11 轮后触发（off-by-one） |
| Verification Nudge | 触发 1 次 | 触发 2 次（round 0 和 round 1 都满足条件） |

**修复方向：**

取消 Task 2（`agent_start` 事件监听），改为在 Task 3 的 `before_agent_start` handler 最开头递增 `userMessageCount`：

```typescript
pi.on("before_agent_start", async (_event, _ctx) => {
  userMessageCount++;  // ← 移到这里，消除事件顺序依赖

  // 1. 检查自动清空
  // 2. 检查 Verification Nudge
  // 3. 检查 Todo Reminder
});
```

这样无论 `agent_start` 何时触发，检查逻辑使用的 `userMessageCount` 始终是当前轮的值。

## 3. Spec 与 Plan 一致性

逐条对照：

| Spec AC | Plan Task | 覆盖 | 备注 |
|---------|-----------|------|------|
| AC-1 自动清空 | Task 1, 3, 5 | ✅ | 状态变量 + 事件监听 + add/clear/update/delete 中追踪 |
| AC-2 Todo Reminder | Task 1, 3, 5 | ✅ | 同上 |
| AC-3 Verification Nudge | Task 1, 3 | ✅ | 在 before_agent_start 中检查 |
| AC-4 Prompt 更新 | Task 4 | ✅ | 替换 promptGuidelines 数组 |
| 边界：add 重置 allCompletedAtCount | Task 5 Step 2 | ✅ | |
| 边界：clear 重置 allCompletedAtCount | Task 5 Step 3 | ✅ | |
| 向后兼容 | Task 1 | ✅ | reconstructState 重置新状态为默认值 |
| 不做事项 | — | ✅ | Plan 未包含任何 spec 明确排除的工作 |

**无遗漏，无 spec 外的额外工作。**

## 4. Execution Groups 合理性

| 检查项 | 结论 |
|--------|------|
| 分组合理性 | ✅ 仅 BG1 一个 Group，1 个文件，合理 |
| 文件数 ≤ 10 | ✅ 1 个文件 |
| 依赖关系 | ✅ 串行执行，按 Wave 排列 |
| Subagent 配置 | ✅ 每个 Task 走 TDD 链路（测试→实现→审查） |
| 上下文充分性 | ✅ 注入 spec.md + plan.md + CLAUDE.md |

**Execution Groups 无问题。**

## 5. 接口契约审查

Plan 包含 Interface Contracts（State、Event）。逐项检查：

| 检查项 | 结论 |
|--------|------|
| State 字段完整性 | ✅ 6 个字段与 spec 数据结构一致 |
| agent_start handler | ⚠️ 设计有误（Issue #1），应合并到 before_agent_start |
| before_agent_start 返回类型 | ✅ `{ message: { customType, content, display } } \| undefined` 与 Pi API 一致 |
| AC 覆盖矩阵 | ✅ 4 个 AC 均在矩阵中有对应行 |

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | plan.md:Task 2 + Task 3 | **事件顺序假设错误**：`agent_start` 在 `before_agent_start` 之后触发（已通过 Pi 源码 `agent-session.ts:1074` 和 `agent-loop.ts:109` 确认）。导致自动清空 off-by-one（3轮而非2轮）、Reminder off-by-one（11轮而非10轮）、Verification Nudge 重复触发 | 取消 Task 2，将 `userMessageCount++` 移到 Task 3 的 `before_agent_start` handler 最开头。同时删除 Task 2 的 commit 和验证步骤 |
| 2 | LOW | plan.md:Task 3 before_agent_start handler | **Verification Nudge 缺少防重触发守卫**：当事件顺序修复后（Issue #1），nudge 在 count 递增后检查，round 1（count=completion+1）触发。但 round 2（count=completion+2）auto-clear 触发前，nudge 条件仍然为 true（`allCompletedAtCount !== null` 且 todos 未清空）。虽然 auto-clear 优先级更高会拦截，但逻辑上 nudge 条件本身没有幂等保护 | 建议添加 `verificationNudged` 标记，或利用 `lastReminderCount` 守卫（nudge 后 `lastReminderCount = userMessageCount`，但当前 nudge 条件未检查此字段）。如认为 auto-clear 优先拦截已足够，可 dismiss 此条 |
| 3 | LOW | plan.md:Task List 依赖表 | **Task 3 逻辑依赖 Task 5 未在依赖表体现**：Task 3 的 `before_agent_start` 使用 `lastTodoCallCount`（在 Task 5 的 `executeTodoAction` 中更新），但依赖表只写了 `Task 3 depends on Task 2`。Wave Schedule 执行顺序正确（Task 5 在 Wave 2，Task 3 在 Wave 3），但依赖表应显式标注 `Task 3 depends on Task 2, Task 5` |
| 4 | LOW | plan.md:Task 5 Step 4 | **未提及保留 `update` handler 中已有的 `isLastCompletion` 逻辑**（当前代码约 L325-340）：现有代码有"最后一个 pending 即将完成"的引导逻辑。Plan Step 4 在 `case "update"` 的状态更新之后添加 allCompleted 检查，但未明确说明与现有 `isLastCompletion` 代码的关系。Subagent 可能误删现有逻辑 | 在 Step 4 添加说明："在现有 `isLastCompletion` 逻辑和 `resultText` 拼接之后、`break` 之前插入，不修改现有逻辑" |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

### 结论

需修改后重审。

### Summary

计划评审完成，第1轮，1条MUST FIX（事件顺序假设错误导致全功能时序偏移），需修改后重审。
