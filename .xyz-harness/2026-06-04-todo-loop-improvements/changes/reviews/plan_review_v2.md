---
review:
  type: plan_review
  round: 2
  timestamp: "2026-06-04T22:15:00"
  target: ".xyz-harness/2026-06-04-todo-loop-improvements/plan.md"
  verdict: pass
  summary: "计划评审完成，第2轮通过，0条MUST FIX。第1轮2条MUST FIX均已修复，无回归。"

statistics:
  total_issues: 7
  must_fix: 0
  must_fix_resolved: 2
  low: 5
  info: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 6 Step 3 implementation code"
    title: "Task 6 TUI verifyText 显示违反 spec FR-1"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 5 Step 3 needsVerify 条件"
    title: "Task 5 验证触发条件 verifyAttempts===0 导致首次失败后无法重试"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 3
    severity: LOW
    location: "plan.md:Task 5 Step 3 / Interface Contracts"
    title: "allCompletedAtCount / userMessageCount 状态变量未在 Interface Contracts 中声明"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "plan.md:Task 5 Step 1 test assertions"
    title: "Task 5 测试断言使用 expect(true).toBe(true) 占位符"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "spec.md:FR-4 / plan.md:Task 5"
    title: "Spec 未定义验证失败后的中间状态转换和 verifyAttempts 递增机制"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: LOW
    location: "plan.md:Task 5 Step 3 needsVerify"
    title: "needsVerify 使用 find 只处理第一个待验证任务，多任务并行验证时遗漏"
    status: open
    raised_in_round: 2
    resolved_in_round: null
  - id: 7
    severity: LOW
    location: "plan.md:Task 5 Step 3 verifyFailed"
    title: "verifyFailed 检测条件 status==='in_progress' 与验证流程衔接不明确"
    status: open
    raised_in_round: 2
    resolved_in_round: null
---

# 计划评审 v2

## 评审记录
- 评审时间：2026-06-04 22:15
- 评审类型：计划评审（增量审查）
- 评审对象：spec.md + plan.md + e2e-test-plan.md + use-cases.md + non-functional-design.md
- 前次评审：plan_review_v1.md（第1轮，2条 MUST_FIX）

### 第1轮 MUST_FIX 修复验证

#### #1: Task 6 TUI verifyText 显示违反 spec FR-1 → [FIXED]

**原始问题**：Task 6 的 `before_agent_start` 实现代码将 `verifyText` 原文暴露在 TUI 显示中（`[待验证: ${t.verifyText}]`），违反 spec FR-1 的「TUI 行末显示 [待验证]（不含具体内容）」设计。

**修复验证**：

Task 6 Step 3 当前代码构建 `<todo_context>` 字符串时包含 verifyText 原文，但通过 `display: false` 注入：
```typescript
pi.deliver({
  deliverAs: "steer",
  display: false,        // ← 进 AI 上下文，不显示在 TUI
  customType: "todo-context",
  message: contextStr,   // contextStr 包含 verifyText 原文
});
```

TUI 显示由 Task 4 的 `renderResult` 处理，仅显示标签：
```typescript
const suffix = todo.verifyText ? " [待验证]" : " [无需验证]";
```

**结论**：修复正确。`display: false` 使 verifyText 原文仅在 AI 上下文中可见，TUI 只显示 `[待验证]` 标签，与 spec FR-1 和 FR-4 完全一致。注释也正确标注了设计意图。

---

#### #2: Task 5 验证触发条件 verifyAttempts===0 → [FIXED]

**原始问题**：条件 `verifyAttempts === 0` 导致首次验证失败后（verifyAttempts 变为 1），即使 AI 重新标记 completed，验证不再触发。

**修复验证**：

Task 5 Step 3 当前代码：
```typescript
const needsVerify = todos.find(t =>
  t.status === "completed" && t.verifyText && t.verifyAttempts < MAX_VERIFY_ATTEMPTS
);
```

改为 `verifyAttempts < MAX_VERIFY_ATTEMPTS` 后：
- verifyAttempts=0 → `< 2` → 触发验证 ✅
- 首次失败后 verifyAttempts=1 → `< 2` → 仍可触发验证 ✅
- 二次失败后 verifyAttempts=2 → `>= 2` → 不再触发，进入 failed 路径 ✅

**结论**：修复正确。与 AC-5 的重试流程（"AI 验证发现有问题 → verifyAttempts +1，提醒修复"）完全对齐。

---

### 新发现问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 6 | LOW | plan.md:Task 5 Step 3 needsVerify | `todos.find()` 只返回第一个匹配项。若多个任务同时为 completed + verifyText + attempts < MAX，只有第一个会被注入验证上下文。虽然 AI 通常逐个处理验证，但并行场景下可能遗漏。 | 将 `find` 改为 `filter`，遍历所有待验证任务逐一注入。或在 plan 中明确说明"每次 agent_end 只处理一个待验证任务"的设计决策。 |
| 7 | LOW | plan.md:Task 5 Step 3 verifyFailed | `verifyFailed` 检测条件为 `status === "in_progress" && verifyAttempts >= MAX_VERIFY_ATTEMPTS`。这意味着验证失败后需要 AI 先将状态从 completed 改为 in_progress，agent_end 才能检测到失败并设为 failed。但 spec AC-5 未明确此中间状态转换，plan 也未说明 AI 如何知道要将 completed 改回 in_progress。 | 与 #5 关联——在 spec 或 plan 中明确验证失败的状态转换路径（completed → in_progress via AI → failed via agent_end），或在 `<todo_context>` 注入的 Rules 中指导 AI 验证失败时将状态改为 in_progress。 |

### 第1轮 LOW 问题状态（未变更）

| # | 状态 | 说明 |
|---|------|------|
| 3 | open | allCompletedAtCount/userMessageCount 未在 Interface Contracts 声明。不影响实现正确性，建议后续补充。 |
| 4 | open | 占位符测试断言。TDD 流程中会被替换，不阻塞执行。 |
| 5 | open | Spec 未定义 verifyAttempts 递增机制和验证失败中间状态。#6/#7 是此问题的具体表现。建议 spec 补充完整验证状态机。 |

### 检查维度总结

#### 1. Spec 完整性

与 v1 评审一致，通过。目标明确、范围合理、验收标准可量化、无待决议项。

#### 2. Plan 可行性

与 v1 评审一致，通过。9 个 task 粒度适中，依赖关系正确，无遗漏。

#### 3. Spec-Plan 一致性

v1 发现的 2 处 MUST FIX 不一致已修复，当前一致。新增 2 个 LOW 观察（#6 #7），涉及验证流程的边界场景，不影响核心功能交付。

#### 4. Execution Groups 合理性

与 v1 评审一致，通过。单文件单组串行执行，无并行问题。

#### 5. 接口契约审查

与 v1 评审一致，通过。Todo 接口、migrateTodo、TodoParams 与 spec 对齐。AC 覆盖矩阵完整。

### 结论

通过。第1轮 2 条 MUST_FIX 均已正确修复，无回归。现有 LOW 问题不影响执行。

### Summary

计划评审完成，第2轮通过，0条MUST FIX。第1轮2条MUST FIX均已修复，无回归。
