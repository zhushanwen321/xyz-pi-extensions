---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-31T16:00:00"
  target: ".xyz-harness/2026-05-31-goal-staleness-reminder-auto-clear/spec.md"
  verdict: fail
  summary: "Spec 评审第 1 轮，3 条 MUST FIX（提醒范围自相矛盾、auto-clear 与 history 数据冲突、终态 widget 行为未定义），需修改后重审"

statistics:
  total_issues: 8
  must_fix: 3
  must_fix_resolved: 0
  low: 3
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md > FR-2 功能描述 vs AC-2"
    title: "停滞提醒范围自相矛盾：FR-2 说只提醒 1 个 task，AC-2 说提醒全部"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "spec.md > FR-1 + FR-4"
    title: "Auto-clear 删除 session 状态后 history 无法获取数据，快照机制未定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "spec.md > FR-1 功能描述 + AC-1"
    title: "终态到清理间的 widget 渲染行为未定义：全量折叠到 status bar 还是保留 task 列表？"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "spec.md > FR-2"
    title: "停滞阈值 10 turn 是否可配置未定义，现有 budget 中 maxStallTurns=5 已有配置先例"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "spec.md > FR-2（缺少边界情况）"
    title: "所有 task 终态但 goal 未终结的边界情况未覆盖"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "spec.md > FR-3"
    title: "命名迁移未评估对 _render 协议 consumers（xyz-agent GUI）的影响"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: INFO
    location: "spec.md > FR-3"
    title: "subUpdates 列为保持不变，作为变更项列出易引起歧义"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: INFO
    location: "spec.md > AC-2"
    title: "currentTurnIndex 初始值未说明（应明确为 0，但 goal 创建时机需考虑）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 评审 v1

## 评审记录
- 评审时间：2026-05-31 16:00
- 评审类型：计划评审 — spec 完整性专项
- 评审对象：`.xyz-harness/2026-05-31-goal-staleness-reminder-auto-clear/spec.md`

## 检查维度 1：spec 完整性

### 目标明确性

目标明确：为 Goal 扩展增加 4 项功能（终态自动清理、停滞提醒、命名统一、history 命令）。一句话能说清楚。

### 范围合理性

范围合理。4 个 FR 都围绕 Goal 扩展自身，不涉及跨扩展改动。命名统一是必要的重构前置。

### 验收标准可量化性

AC-1 和 AC-3 可测试、可验证（具体到字段名、条件表达式）。**但 AC-2 和 AC-4 存在问题**，详见下方 MUST FIX #1 和 #2。

### 待决议项

spec 中无显式 `[待决议]` 标记，但存在隐含未决项（提醒范围、快照机制）。

---

## 发现的问题

### MUST FIX

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | spec.md > FR-2 功能描述 vs AC-2 | **停滞提醒范围自相矛盾**。FR-2 正文说"只提醒最小编号的停滞项所在的最小单位（task 级别），避免一次性提醒过多"（暗示仅提醒 1 个 task）。但 AC-2 第 5 条说"提醒内容包含所有非终态项的 ID 和停滞 turn 数"（暗示提醒全部）。两者矛盾，实现者无法确定提醒范围。 | 二选一统一：(A) 只提醒最小编号停滞项所在的 task 及其 subtask，AC-2 相应修改；或 (B) 提醒所有停滞项，删除 FR-2 中"只提醒最小编号"的描述。需在 FR-2 和 AC-2 保持一致后重写。 |
| 2 | MUST FIX | spec.md > FR-1 + FR-4 | **Auto-clear 与 history 数据生命周期冲突**。FR-1 规定终态 2 轮后调用 `clearGoalSession`（等同 `/goal clear`），清除 `session.state = null`。FR-4 需要从 goal-state entries 读取已终结 goal 的历史数据。查看当前代码，`clearGoalSession` 将 `session.state = null` 并清除 widget/status。虽然 session entries（`pi.appendEntry`）可能仍在 `ctx.sessionManager.getEntries()` 中，但当前 GC 逻辑可能清理旧 entries。spec 提到"保留终结时的快照"但**未定义**：(a) 快照包含哪些字段；(b) 快照以什么 entry type 存储；(c) 快照的 GC 策略；(d) 快照创建时机（进入终态时还是 clear 前）。AC-4 也不验证快照机制，导致一个"永远无历史"的 trivial 实现也能通过 AC。 | 明确定义快照机制：新增 `goal-history` entry type，在 goal 进入终态时（不是 clear 时）写入快照（objective、status、task count、elapsed time）。history 命令从该 entry type 读取。快照不随 `clearGoalSession` 删除，由 session 级 GC 管理。AC-4 增加："进入终态时自动写入 goal-history 快照 entry"。 |
| 3 | MUST FIX | spec.md > FR-1 功能描述 + AC-1 | **终态到清理间的 widget 渲染行为未定义**。FR-1 说"终态保留一个简短 status bar 提示（如 `◆ Goal ✓ 完成`），不立即清除 widget"。但"不立即清除 widget"和"保留 status bar"之间有歧义——widget 是保持完整的 task 列表只改 status bar？还是折叠为一行 status bar？UC-1 说"status bar 显示 `◆ Goal ✓ 完成`"，暗示 widget 消失、只留 status bar，但 spec 正文说"不立即清除 widget"。当前代码中 `updateWidget` 在终态时仍渲染完整 widget（budget 等信息），`clearGoalSession` 时才清除。 | 明确中间态渲染：在 FR-1 中定义"终态 widget 折叠为仅 status bar 一行（显示终态状态和预算摘要），task 列表不再渲染"。在 AC-1 增加："终态期间 widget 折叠为单行 status bar 提示，task 列表不显示"。 |

### LOW

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 4 | LOW | spec.md > FR-2 | 停滞阈值 10 turn 是否可配置未定义。现有 `BudgetConfig` 已有 `maxStallTurns: 5`（全局 stall 检测）的配置先例，新增的 task 级停滞阈值应该也纳入配置，避免两个"停滞"概念有不同的配置模式。 | 建议在 `BudgetConfig` 中新增 `taskStallTurns?: number` 字段，默认 10。或在 FR-2 中明确"暂不可配置，后续迭代"。 |
| 5 | LOW | spec.md > FR-2（缺少边界情况） | "所有 task 已终态但 goal 未终结"的边界情况未覆盖。场景：AI 完成所有 task 但忘记调 `complete_goal`。FR-2 只检测非终态 task 的停滞，此时所有 task 已终态，不会触发提醒。 | 可在 FR-2 增加一条：当所有 task 为终态但 goal 仍为 active 时，注入提醒"所有任务已完成，请调用 complete_goal"。或标注为已知限制。 |
| 6 | LOW | spec.md > FR-3 | 命名迁移未评估对 `_render` 协议 consumers 的影响。CLAUDE.md 中 `makeGoalResult` 示例使用 `t.subTodos?.map(...)`，xyz-agent GUI 可能依赖 `details._render.data.items[].children` 中的字段名。重命名后 GUI 侧需同步更新。 | 在 FR-3 或 Constraints 中补充说明：`_render` data 中的 `subTodos` 相关字段名同步更改为 `subtasks`，xyz-agent 需配套更新。 |

### INFO

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 7 | INFO | spec.md > FR-3 | `subUpdates` 列为"保持不变，已经足够清晰"，作为变更项列出容易让审查者/实现者误以为需要改动。 | 从 FR-3 变更列表中移除，或改为"不在本次变更范围内"的排除声明。 |
| 8 | INFO | spec.md > AC-2 | `currentTurnIndex` 初始值未说明。应为 0，但需明确是 goal 创建时开始计数还是 session 开始时。考虑到 goal 可跨 session 恢复，建议明确为"goal 创建/恢复时从当前 session 的 turn 计数器同步"。 | 在 AC-2 补充 `currentTurnIndex` 初始值说明。 |

---

## 检查维度 1 逐项结论

| 检查项 | 结论 |
|--------|------|
| 目标是否明确 | ✅ 一段话说清楚 4 项功能 |
| 范围是否合理 | ✅ 不大不小，有边界 |
| 验收标准是否可量化 | ⚠️ AC-2 矛盾，AC-4 缺快照验证 |
| 是否有 [待决议] 项 | ⚠️ 无显式标记，但有 3 个隐含未决项（提醒范围、快照机制、中间态渲染） |

## 架构合规性（对照 CLAUDE.md）

| 检查项 | 结论 |
|--------|------|
| Session 隔离 | ✅ 新增字段在 GoalRuntimeState 中，由 session_start 重建 |
| 状态持久化 | ⚠️ `currentTurnIndex`/`lastUpdatedTurn` 需在 serialize/deserialize 中处理（AC-3 已提及向后兼容，但 AC-2 未提及新字段的序列化） |
| Tool 设计 | ✅ 参数变更遵循 typebox + StringEnum 模式 |
| 事件选择 | ✅ turn_end + before_agent_start 与现有 skill-state 模式一致 |
| deserializeState 向后兼容 | ⚠️ 新增 3 个字段（currentTurnIndex、completedAtTurnIndex、lastUpdatedTurn）需要默认值，spec 约束中提及但未在 AC 中验证 |

## 与现有代码的兼容性分析

| 变更点 | 现有代码 | 影响评估 |
|--------|----------|---------|
| `currentTurnIndex` 字段 | state.ts 无此字段 | ✅ deserializeState 给默认值 0 即可 |
| `completedAtTurnIndex` 字段 | state.ts 无此字段 | ✅ 非终态 goal 该字段为 undefined，默认值处理即可 |
| `lastUpdatedTurn` on GoalTask | state.ts GoalTask 无此字段 | ✅ deserializeState 兼容 |
| `subTodos` → `subtasks` | state.ts 定义 `SubTodo` + `subTodos` 字段 | ⚠️ 类型名+字段名全改，影响面大（index.ts 中约 30+ 处引用），但机械替换风险可控 |
| `add_sub_todos` → `add_subtasks` | StringEnum action 名 | ⚠️ 破坏性变更，AI prompt 会由 promptGuidelines 自动更新，但执行中的 session 可能残留旧 action 名 |
| `clearGoalSession` 改造 | 当前直接 `session.state = null` | ⚠️ 需在 clear 前保存快照（FR-4 需要） |
| `before_agent_start` 扩展 | 当前仅做 context injection | ✅ 扩展为：context injection + auto-clear 检查 + 停滞提醒 |

## 结论

**需修改后重审。** 3 条 MUST FIX 必须解决：

1. **FR-2 提醒范围自相矛盾** — FR-2 正文与 AC-2 对"提醒哪些项"的描述冲突
2. **Auto-clear 与 history 数据冲突** — `clearGoalSession` 删除状态后 history 无数据源，快照机制未定义
3. **终态 widget 中间态未定义** — "不立即清除 widget"与"保留 status bar"之间有歧义

### Summary

Spec 评审完成，第 1 轮，3 条 MUST FIX（提醒范围矛盾、数据生命周期冲突、widget 行为未定义），需修改后重审。
