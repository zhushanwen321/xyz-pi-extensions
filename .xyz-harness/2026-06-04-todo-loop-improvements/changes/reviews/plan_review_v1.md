---
review:
  type: plan_review
  round: 1
  timestamp: "2026-06-04T18:30:00"
  target: ".xyz-harness/2026-06-04-todo-loop-improvements/plan.md"
  verdict: fail
  summary: "计划评审完成，第1轮，2条MUST FIX，需修改后重审"

statistics:
  total_issues: 5
  must_fix: 2
  must_fix_resolved: 0
  low: 3
  info: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 6 Step 3 implementation code"
    title: "Task 6 TUI verifyText 显示违反 spec FR-1"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 5 Step 3 needsVerify 条件"
    title: "Task 5 验证触发条件 verifyAttempts===0 导致首次失败后无法重试"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "plan.md:Task 5 Step 3 allCompletedAtCount"
    title: "Task 5 allCompletedAtCount 状态变量未在 Interface Contracts 中声明"
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
    location: "spec.md:FR-4 验证失败处理"
    title: "Spec 未定义验证失败后的中间状态转换（completed → ? → completed）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-06-04 18:30
- 评审类型：计划评审
- 评审对象：spec.md + plan.md + e2e-test-plan.md + use-cases.md + non-functional-design.md

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | plan.md:Task 6 Step 3 | Task 6 的 before_agent_start 实现代码中，TUI verifyTag 格式为 `` ` [待验证: ${t.verifyText}]` ``，将 verifyText 原文暴露在 TUI 显示中。但 spec FR-1 明确规定「TUI 行末显示 [待验证]（不含具体内容）」，AI 通过 `<todo_context>` 注入读到 verifyText 原文，TUI 仅显示标签。Plan 代码违反了这一刻意的 UI 设计决策。 | TUI 行格式改为 `` `[待验证]` ``（不含 `${t.verifyText}`），与 spec FR-1 和 FR-4 的 TUI 设计一致。`<todo_context>` 注入中保留 verifyText 原文（AI 可见），TUI 只显示标签（用户可见）。 |
| 2 | MUST FIX | plan.md:Task 5 Step 3 | Task 5 agent_end 的验证触发条件 `todos.find(t => t.status === "completed" && t.verifyText && t.verifyAttempts === 0)` 使用 `verifyAttempts === 0`，只在首次标记 completed 时触发验证。一旦验证失败（verifyAttempts 变为 1），即使 AI 重新实现并再次标记 completed，由于 verifyAttempts=1≠0，验证不会再触发。这直接破坏了 AC-5「AI 验证发现有问题 → verifyAttempts +1，提醒修复」的重试流程。 | 将条件改为 `verifyAttempts < MAX_VERIFY_ATTEMPTS`，确保首次失败后（verifyAttempts=1）重新标记 completed 时仍能触发验证。同时 needsVerify 的状态检查需与验证失败后的状态转换对齐（见 #5）。 |
| 3 | LOW | plan.md:Task 5 Step 3 / Interface Contracts | Task 5 代码引用 `allCompletedAtCount === null` 和 `userMessageCount` 作为状态变量，但 Interface Contracts 部分未声明这些状态。auto-clear 的轮次计数机制（如何追踪"全部完成的起算点"）在 plan 中描述模糊。 | 在 Interface Contracts 的 Constants 或新增 State Variables 表中，声明 `allCompletedAtCount: number | null` 和 `userMessageCount: number` 的用途和生命周期。或在 Task 5 描述中补充状态管理说明。 |
| 4 | LOW | plan.md:Task 5 Step 1 | Task 5 的测试断言使用 `expect(true).toBe(true)` 占位符（如 "should reject non-existent ids" 和 "should detect pending tasks"），不验证任何实际逻辑。TDD 流程中这些测试不会在 Red 阶段失败。 | 虽然 TDD 流程中这些会被实际实现替换，但 plan 中的测试代码应至少包含能失败的断言（如检查具体状态值、调用计数等），以证明测试骨架有意义。 |
| 5 | LOW | spec.md:FR-4 / plan.md:Task 5 | Spec FR-4 定义了验证触发（completed + verifyText）和验证失败（verifyAttempts >= 2 → failed），但未定义验证失败后的中间状态：AI 标记 completed → agent_end 触发验证 → AI 验证失败 → 状态变为什么？Plan 假设为 `in_progress`，但这不在 spec 的状态定义中（spec 只定义了 pending/in_progress/completed/failed 四态）。如果状态保持 completed + verifyAttempts++，则 needsVerify 条件需要重新设计。 | 在 spec FR-4 中明确：验证失败时，AI 将状态从 completed 回退为 in_progress（或定义一个显式的状态转换规则）。Plan 的实现依赖此状态转换，必须与 spec 对齐。 |

### 检查维度总结

#### 1. Spec 完整性

**目标明确性**：通过。Spec 开头一段话清晰描述了三个核心问题（无法自动闭合、提醒机制无效、缺少验证机制）和一个 API 改进（批量更新）。

**范围合理性**：通过。所有改动集中在 `extensions/todo/src/index.ts` 单文件，不涉及跨扩展变更。约束条件明确（向后兼容、不引入新依赖、session 持久化不变）。

**验收标准可量化**：通过。AC-1 到 AC-7 均可通过测试验证（数据模型字段存在性、API 参数行为、事件 handler 注入内容）。

**待决议项**：无。

#### 2. Plan 可行性

**任务拆分**：通过。9 个 task 粒度适中，单个 subagent 可独立完成。Task 1-4 是数据层/API 层基础，Task 5-6 是核心业务逻辑，Task 7-8 是注册/提示词，Task 9 是清理。

**依赖关系**：基本通过。Task 5 依赖 1/2/3（正确），Task 6 依赖 1（正确），Task 8 依赖 6（正确），Task 9 依赖 5/6（正确）。Task 7 标注无依赖但实际在 Task 6 之后执行（serial group 中隐式依赖），不影响正确性。

**遗漏检查**：无明显遗漏。Spec 中所有 FR 和 AC 在 plan 的 Spec Coverage Matrix 中均有对应 Task。

#### 3. Spec-Plan 一致性

**覆盖完整性**：通过。Plan 的 Spec Coverage Matrix 覆盖了所有 7 个 AC、8 个 FR、4 个 UC。

**一致性问题**：发现 2 处 MUST FIX 不一致（#1 TUI 显示、#2 验证触发条件），详见问题列表。

**额外工作**：Plan 中 VALID_STATUSES 常量是合理的实现细节，spec 未单独列出但不冲突。

#### 4. Execution Groups 合理性

**分组合理性**：通过。所有改动在单文件 extension 中，单一 BGExt1 分组合理。文件数预估 2 个（1 create + 1 modify）与实际一致。

**类型划分**：通过。全部为 backend task，无混合类型。

**依赖关系**：通过。串行执行（T1→T2→...→T9），无并行冲突。

**Subagent 配置**：通过。Agent/Model/注入上下文/读取文件/修改文件均有列出。注入上下文包含 spec AC 和 plan Task 描述。

**Wave 编排**：单 Wave，无并行问题。

#### 5. 接口契约审查

**Todo 接口**：与 spec FR-1 一致（id/text/verifyText/status/verifyAttempts）。

**migrateTodo**：与 spec 向后兼容要求一致（缺失字段补默认值）。

**TodoParams**：新增 verifyTexts 和 updates 字段与 spec FR-2/FR-3 一致。

**AC 覆盖矩阵**：所有 adopted AC 均在矩阵中有对应行。无遗漏。

### 结论

需修改后重审。2 条 MUST FIX 问题涉及核心功能正确性（TUI 显示违反 spec 设计意图、验证重试逻辑断裂），修复后 plan 的可行性和一致性将完整。

### Summary

计划评审完成，第1轮，2条MUST FIX，需修改后重审。
