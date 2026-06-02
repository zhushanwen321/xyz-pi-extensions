---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-31T22:00:00"
  target: ".xyz-harness/2026-05-31-todo-v3-auto-clear-reminder/plan.md"
  verdict: pass
  summary: "计划评审完成，第1轮，0条MUST FIX，2条LOW，通过"

statistics:
  total_issues: 4
  must_fix: 0
  must_fix_resolved: 0
  low: 2
  info: 2

issues:
  - id: 1
    severity: LOW
    location: "plan.md: Task 3 (before_agent_start auto-clear check)"
    title: "自动清空阈值与 spec 描述不一致（spec 内部矛盾，plan 忠实实现了伪代码）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "plan.md: Task 3 (Verification Nudge handler)"
    title: "Nudge 与 Reminder 共享 lastReminderCount，Nudge 触发会重置 Reminder 计时器"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: INFO
    location: "plan.md: Task 1 (模块级状态变量)"
    title: "新增 4 个模块级变量扩展了 CLAUDE.md 中已知的 session 隔离违反"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: INFO
    location: "plan.md: Execution Groups (BG1)"
    title: "单文件修改导致 Task 4 无法真正并行，plan 已正确说明"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-31 22:00
- 评审类型：计划评审（模式一）
- 评审对象：`spec.md` + `plan.md` + `e2e-test-plan.md` + `use-cases.md` + `non-functional-design.md` + `test_cases_template.json`
- 复杂度：L1（单文件修改）

---

## 1. spec 完整性

| 维度 | 评估 | 说明 |
|------|------|------|
| 目标明确性 | ✅ | 为 todo 扩展添加自动清空、Reminder、Verification Nudge 三个能力，一段话说得清 |
| 范围合理性 | ✅ | 单文件改动，4 个状态变量，3 个行为，边界清晰。"不做的事项"列出了排除项 |
| 验收标准 | ⚠️ | 功能有伪代码级的行为描述，但缺少可量化的 AC（如"2 轮后清空"vs 伪代码 `>= 2` 存在不一致，见 issue #1）|
| 待决议项 | ✅ | 无 `[待决议]` 标记 |

**spec 内部一致性问题（issue #1）**：spec 描述说"保留 2 轮用户消息，第 3 轮自动清空"，但 spec 伪代码使用 `userMessageCount - allCompletedAtCount >= 2`。追踪时序：

- 完成时：`allCompletedAtCount = N`（当前 userMessageCount）
- 第 1 条消息后：`agent_start` → count = N+1，`before_agent_start` 检查 diff = 1 < 2，不清空
- 第 2 条消息后：`agent_start` → count = N+2，`before_agent_start` 检查 diff = 2 ≥ 2，**清空**

实际只保留了 1 轮可见（第 1 条消息），第 2 条消息触发时就清空了。若要"保留 2 轮、第 3 轮清空"，阈值应为 `>= 3`。plan 忠实实现了 spec 伪代码（`>= 2`），但与 spec 文字描述不符。

---

## 2. plan 可行性

| 维度 | 评估 | 说明 |
|------|------|------|
| 任务拆分 | ✅ | 4 个 task，粒度适中：状态声明 → 状态追踪 → 事件监听 → prompt 更新。每个 task 可由一个 subagent 独立完成 |
| 依赖关系 | ✅ | Task 2 → Task 1（状态变量先声明），Task 3 → Task 2（事件监听依赖追踪逻辑），Task 4 无依赖。顺序正确 |
| 工作量估算 | ✅ | 单文件修改，4 个 task 各约 10-30 行代码，估算合理 |
| 遗漏检查 | ✅ | 对照 spec 逐条：FR-1→Task2+3, FR-2→Task2+3, FR-3→Task3, FR-4→Task4, 向后兼容→Task1。全覆盖 |
| 代码位置准确性 | ✅ | plan 中引用的行号（~L195 模块级状态, ~L280 reconstructState）与源码 `todo/src/index.ts` 结构吻合 |

---

## 3. spec 与 plan 一致性

| Spec 需求 | Plan 覆盖 | 说明 |
|-----------|----------|------|
| FR-1 自动清空 | ✅ Task 2（设置 allCompletedAtCount）+ Task 3（before_agent_start 检查并清空） | 阈值不一致见 issue #1 |
| FR-2 Todo Reminder | ✅ Task 2（更新 lastTodoCallCount）+ Task 3（before_agent_start 检查并注入） | |
| FR-3 Verification Nudge | ✅ Task 3（before_agent_start 检查 allCompletedAtCount + todos.length >= 3 + 关键词） | |
| FR-4 Prompt 更新 | ✅ Task 4（替换 promptGuidelines 数组） | |
| 向后兼容 | ✅ Task 1（reconstructState 中重置新变量为默认值） | |
| add 后重置 allCompletedAtCount | ✅ Task 2 Step 2 | |
| clear 后重置 allCompletedAtCount | ✅ Task 2 Step 3 | |
| update 后检查全部完成 | ✅ Task 2 Step 4 | |
| agent_start 递增计数 | ✅ Task 3 Step 1 | |
| delete 后的行为 | ✅ 无需特殊处理（删除 completed todo 不改变"全部完成"状态） | |

**plan 中无 spec 未提及的额外工作。** ✅

---

## 4. Execution Groups 合理性

| 维度 | 评估 | 说明 |
|------|------|------|
| 分组合理性 | ✅ | 单组 BG1，1 个文件，4 个 task。组内串行合理 |
| 类型划分 | ✅ | 全部为 backend task，无混合类型 |
| 功能关联度 | ✅ | 所有 task 修改同一文件且逻辑紧密关联 |
| 依赖关系 | ✅ | Task 1→2→3 串行，Task 4 可并行（但因单文件限制实际串行） |
| Wave 编排 | ✅ | 单 Wave，无并行需求 |
| Subagent 配置 | ✅ | general-purpose + medium 复杂度，注入上下文包含 spec 行为规范 + plan task 描述 |
| 上下文充分性 | ✅ | 每个 task 描述包含精确的代码位置、插入点、完整代码片段，subagent 可独立完成 |
| 文件数预估 | ✅ | 1 个文件（modify），准确 |

---

## 5. 接口契约审查

plan.md 包含 Interface Contracts 章节，进行检查：

| 维度 | 评估 | 说明 |
|------|------|------|
| AC 覆盖矩阵 | ✅ | FR-1 到 FR-4 + 向后兼容均有对应行 |
| Event Handler 契约 | ✅ | before_agent_start_handler 3 个 check 的条件、动作、customType 与 spec 一致 |
| ReminderState 数据 | ✅ | 4 个字段与 spec "新增状态"章节一致 |

L1 复杂度，不要求 interface_chain.json，跳过 data_flows cross-reference。

---

## 6. 配套交付物审查

| 文件 | 评估 | 说明 |
|------|------|------|
| e2e-test-plan.md | ✅ | 4 个 Test Scenario，10 个子场景，覆盖 FR-1/2/3 + session 恢复。场景设计合理，包含正常路径和边界条件 |
| use-cases.md | ✅ | 3 个 UC 对应 FR-1/2/3，含 Alternative Paths 和 Module Boundaries |
| non-functional-design.md | ✅ | 稳定性、数据一致性、性能、安全分析到位。正确指出模块级变量在 reconstructState 中重置 |
| test_cases_template.json | ✅ | 8 个 test case，全部 manual 类型，覆盖 e2e-test-plan 中的关键场景 |

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | LOW | plan.md: Task 3 auto-clear check | **自动清空阈值与 spec 描述不一致。** spec 文字说"保留 2 轮用户消息，第 3 轮自动清空"，但 spec 伪代码用 `>= 2`（plan 忠实实现）。实际时序分析：`>= 2` 只保留 1 轮可见，第 2 条消息时就清空。若要真正"保留 2 轮"，阈值应为 `>= 3`。 | spec 作者确认意图后，统一 spec 描述和伪代码。若确认应保留 2 轮，plan 的 `>= 2` 改为 `>= 3`。若确认 1 轮即可，更新 spec 描述。 |
| 2 | LOW | plan.md: Task 3 Verification Nudge handler | **Nudge 与 Reminder 共享 `lastReminderCount`。** Task 3 中 Nudge handler 设置 `lastReminderCount = userMessageCount`，但 Reminder handler 也用 `lastReminderCount` 做 10 轮去重。虽然两者触发条件互斥（Nudge 要求全部完成，Reminder 要求未全部完成），但 Nudge 触发后的间接影响是：如果 agent 响应 Nudge 添加了新 todo，Reminder 的计时器被 Nudge 重置过，需要额外 10 轮才触发。spec 未明确这个交互。 | 两种选择：(1) 为 Nudge 使用独立的 `lastNudgeCount` 变量，避免交叉影响；(2) 在 spec 中明确"共享计时器是预期行为"并记录原因。 |
| 3 | INFO | plan.md: Task 1 | **Session 隔离扩展。** 新增 4 个模块级变量（userMessageCount, allCompletedAtCount, lastTodoCallCount, lastReminderCount），扩展了 CLAUDE.md 中已记录的 session 隔离违反。plan 在 reconstructState 中正确重置，与现有 `let todos` 模式一致，但多 session 并发时仍有风险。 | 不阻塞。当前单 session 使用场景下无问题。未来多 session 重构时一并处理。 |
| 4 | INFO | plan.md: BG1 Execution Flow | **单文件串行限制。** Task 4（promptGuidelines 更新）声明无依赖可并行，但因与 Task 1-3 修改同一文件，实际必须串行。plan 在 Dependency Graph 中正确说明了这一点。 | 无需操作。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

## 整体评价

plan 质量较高，体现在：

1. **代码位置精确**：每个 task 标注了具体的插入位置（行号范围、函数名），subagent 可独立执行
2. **依赖关系清晰**：Task 1→2→3 串行链合理，Task 4 独立
3. **Interface Contracts 完整**：Event Handler 契约表清晰列出了 3 个 check 的条件、动作、customType
4. **Spec Coverage Matrix 全覆盖**：FR-1 到 FR-4 及向后兼容均有映射
5. **配套交付物齐全**：e2e-test-plan、use-cases、non-functional-design、test_cases_template 都已就绪
6. **Self-Review 到位**：spec coverage、placeholder scan、type consistency 检查完整

两个 LOW 问题都是 spec 层面的模糊性（阈值语义、变量共享），plan 本身的执行方案是可行的。

### 结论

**通过**

### Summary

计划评审完成，第1轮通过，0条MUST FIX，2条LOW（spec 阈值语义 + Nudge/Reminder 变量共享）。
