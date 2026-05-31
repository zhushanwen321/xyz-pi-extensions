---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-31T16:30:00"
  target: ".xyz-harness/2026-05-31-goal-staleness-reminder-auto-clear/plan.md"
  verdict: fail
  summary: "计划评审第1轮，2条 MUST FIX（_render key 漏重命名 + /goal clear 路径漏覆盖），需修改后重审"

statistics:
  total_issues: 4
  must_fix: 2
  low: 2
  info: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 1 替换规则表"
    title: "Task 1 替换规则表遗漏 _render 数据中 subItems → subtasks 的 key 重命名"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 4 completedAtTurnIndex/goal-history 写入位置"
    title: "Task 4 遗漏 handleGoalCommand 中 /goal clear 和 /goal set（替换旧 goal）两个终态路径"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "plan.md:Task 3/Task 4"
    title: "handleBeforeAgentStart 重构方案和 updateWidget 修改方案未显式描述"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "plan.md:Task 3"
    title: "staleness reminder 返回后会替代 context injection，此交互未显式说明"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-31 16:30
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-05-31-goal-staleness-reminder-auto-clear/plan.md` + spec.md + e2e-test-plan.md + use-cases.md + non-functional-design.md

---

## 1. Spec 完整性

**结论：通过。**

- **目标明确**：4 个 FR（终态自动清理、停滞提醒、命名统一、history 命令），一段话说清要做的事。
- **范围合理**：所有改动局限在 `goal/` 扩展目录内，无跨扩展依赖，无外部 I/O。
- **验收标准可量化**：AC-1~AC-4 每条都有明确的行为描述和可测试条件（如 `currentTurnIndex - completedAtTurnIndex >= 2`、`>= 10 turn` 阈值）。
- **无 `[待决议]` 项**：停滞阈值默认 10 turn、不可配置的决策已明确记录在 Constraints 中。
- **业务用例覆盖完整**：UC-1~UC-4 覆盖全部 FR，UC-AC 映射表无遗漏。

---

## 2. Plan 可行性

**结论：基本可行，2 处遗漏需修复。**

### 任务拆分（5 个 Task）

| Task | 粒度 | 独立 subagent 可完成 | 判定 |
|------|------|---------------------|------|
| Task 1: subTodo→subtask 重命名 | 机械替换，61 处 | ✓ | 合理 |
| Task 2: 新增字段 + 常量 + 序列化 | 类型扩展 + 默认值 | ✓ | 合理 |
| Task 3: 停滞提醒 | 新增 turn_end + before_agent_start 逻辑 | ✓ | 合理 |
| Task 4: 自动清理 + widget + 快照 | 多个位置插入 | ✓ | 合理 |
| Task 5: /goal history | 命令 + entry 读取 | ✓ | 合理 |

依赖关系 `1→2→3→4→5` 正确（类型名重命名必须先完成，新字段必须在功能逻辑之前）。

### 工作量

6 个文件、0 新建 + 6 修改，全部在 `goal/src/` 内，预估合理。

### 遗漏检查（对照源码）

通过阅读现有 `index.ts` 发现以下 plan 未覆盖的终态路径：

1. **`handleGoalCommand` "clear" case**（`/goal clear` 命令）：设置 `status = "cancelled"` 后立即 `clearGoalSession`。这是终态转换，plan Task 4 没有将其列为 `completedAtTurnIndex` 和 `writeGoalHistoryEntry` 的写入位置。

2. **`handleGoalCommand` "set" case 中取消旧 goal**（`/goal <new-objective>` 替换现有 goal）：设置 `status = "cancelled"` 后 `persistGoalState`。同样是终态转换，plan 未覆盖。

---

## 3. Spec 与 Plan 一致性

**结论：基本一致，1 处 spec 约束未在 plan 中体现。**

### 逐条 AC 对照

| Spec AC | Plan 覆盖 | 判定 |
|---------|----------|------|
| AC-1: completedAtTurnIndex | Task 4 — 多个终态位置 | ⚠️ 遗漏 `/goal clear` 和 `/goal set` 路径（Issue #2） |
| AC-1: widget 折叠 | Task 4 — renderTerminalStatusLine | ✓ |
| AC-1: before_agent_start 自动清理 | Task 4 — checkAutoClear | ✓ |
| AC-1: goal-history 快照 | Task 4 — writeGoalHistoryEntry | ⚠️ 同上遗漏 |
| AC-2: currentTurnIndex | Task 3 — turn_end 递增 | ✓ |
| AC-2: lastUpdatedTurn (task) | Task 3 — update 时设置 | ✓ |
| AC-2: lastUpdatedTurn (subtask) | Task 3 — update 时设置 | ✓ |
| AC-2: 停滞 >= 10 turn 提醒 | Task 3 — checkStaleness | ✓ |
| AC-2: 提醒内容 | Task 3 — stalenessReminderPrompt | ✓ |
| AC-2: 重置 lastUpdatedTurn | Task 3 | ✓ |
| AC-2: 边界 allTerminal | Task 3 | ✓ |
| AC-3: 命名统一 | Task 1 替换规则表 | ⚠️ 遗漏 `_render` 中 `subItems` key（Issue #1） |
| AC-3: 工具参数名变更 | Task 1 替换规则表 | ✓ |
| AC-3: deserializeState 兼容 | Task 2 | ✓ |
| AC-4: /goal history | Task 5 | ✓ |
| AC-4: goal-history entry | Task 4 | ✓ |
| AC-4: 不被 clear 清理 | Task 4 | ✓ |

### Spec Constraints 对照

| Spec 约束 | Plan 覆盖 | 判定 |
|-----------|----------|------|
| 向后兼容 deserializeState | Task 2 明确列出默认值策略 | ✓ |
| 事件选择 turn_end / before_agent_start | Task 3 明确 | ✓ |
| 命名迁移破坏性 + promptGuidelines 更新 | Task 1 + Task 3 | ✓ |
| **`_render.data.items[].subItems` → `subtasks`** | **Task 1 替换规则表未包含此映射** | **✗（Issue #1）** |
| 持久化限 session 内 | Task 4 | ✓ |
| 停滞阈值默认 10 | Task 2 常量 | ✓ |

---

## 4. Execution Groups 合理性

**结论：合理。**

- **分组合理性**：BG1 包含 5 个 Task / 6 个文件，功能强关联（同一扩展同一组文件），串行执行。符合"功能关联度优先"原则。
- **类型划分**：全部 backend Task，无混合。
- **依赖关系**：`1→2→3→4→5` 正确。Task 3 和 Task 4 理论可并行但共享 `index.ts`，plan 正确选择串行。
- **Wave 编排**：5 waves × 1 task，无并行，无冲突。
- **Subagent 配置**：每组含 Agent、Model、注入上下文、读取/修改文件列表，完整。
- **上下文充分性**：spec FR-1~FR-4 + AC + state.ts 类型定义 + templates.ts 规范，足够 subagent 独立完成。

---

## 5. 接口契约审查

**结论：基本完整。**

- `state.ts` 接口（Subtask、GoalTask 扩展、GoalRuntimeState 扩展）定义清晰，字段类型和默认值明确。
- `constants.ts` 3 个新常量合理。
- `index.ts` 5 个新函数签名（handleTurnEnd、checkStaleness、writeGoalHistoryEntry、checkAutoClear、handleGoalHistory）签名明确。
- `widget.ts` renderTerminalStatusLine 签名明确。
- **未列出**：现有 `updateWidget`、`handleBeforeAgentStart`、`handleAgentEnd` 的修改规格（L1 可接受，但标记为 LOW 问题）。

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | plan.md:Task 1 替换规则表 | **`_render` 数据中 `subItems` key 未列入重命名映射。** Spec Constraints 明确要求 `_render.data.items[].subItems` → `subtasks`。当前 `makeGoalResult`（index.ts ~L156）中 `subItems: t.subTodos?.map(...)` 在 Task 1 执行后变为 `subItems: t.subtasks?.map(...)`——源数据引用正确但 key 名仍是 `subItems`。 | 在 Task 1 替换规则表中新增一行：`subItems`（_render 数据 key）→ `subtasks`，位置：index.ts makeGoalResult。同时在 Task 1 的"验证"步骤中追加：`grep -n "subItems" goal/src/index.ts` 应返回 0 行 |
| 2 | MUST FIX | plan.md:Task 4 completedAtTurnIndex/goal-history 写入位置 | **遗漏 `handleGoalCommand` 中两个设置终态的代码路径。** (a) `/goal clear` 命令：直接设 `status = "cancelled"` 后 `clearGoalSession`，未设置 `completedAtTurnIndex` 也未写 `goal-history` entry。(b) `/goal <objective>` 设置新 goal 时取消旧 goal：设 `status = "cancelled"` 后 `persistGoalState`，同样遗漏。两条路径都是"goal 进入终态"，按 FR-1/FR-4 应触发历史快照写入。 | Task 4 的"具体位置"列表中追加：(4) `handleGoalCommand` "clear" case 中 `state.status = "cancelled"` 之后、`clearGoalSession` 之前——设置 `completedAtTurnIndex` + 写 `writeGoalHistoryEntry`。(5) `handleGoalCommand` "set" case 中取消旧 goal 的 `state.status = "cancelled"` 之后、`persistGoalState` 之前——同理处理 |
| 3 | LOW | plan.md:Task 3/Task 4 | **`handleBeforeAgentStart` 重构方案和 `updateWidget` 修改方案未显式描述。** Task 4 说"终态 but 未 auto-clear 时，updateWidget 改为调用 renderTerminalStatusLine"，但没有描述现有 `updateWidget` 函数需要增加 `isTerminalStatus` 分支。Task 3 说在 `isActiveStatus` 检查之前插入，但没有描述函数结构变化（terminal check → staleness check → original active check）。意图清晰但实现者可能遗漏细节。 | 在 Task 3/Task 4 中各增加一个"代码结构变更"小节，用伪代码描述 `handleBeforeAgentStart` 和 `updateWidget` 修改后的控制流 |
| 4 | LOW | plan.md:Task 3 | **staleness reminder 返回后替代（而非补充）context injection，此交互未显式说明。** 当 staleness 检测到停滞任务时返回 `{ message: ... }` 提前退出，`handleBeforeAgentStart` 后续的 context injection 不会执行。该 turn agent 只收到 staleness 提醒，不收到常规 goal context 注入。staleness prompt 本身使用 `<goal_context>` XML 格式包含必要信息，实际效果合理，但此行为应在 plan 中明确记录。 | 在 Task 3 的停滞提醒逻辑描述中追加一句："注意：staleness reminder 返回后，本轮不再注入常规 context injection（staleness prompt 已包含足够 goal 上下文）" |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

## 补充观察（非问题）

1. **E2E Test Plan 覆盖度好**：TS-1~TS-8 覆盖了 AC-1~AC-4 的核心场景和边界情况。TS-2 要求 10+ turn 模拟，手动测试较慢但可接受。
2. **Non-Functional Design 完整**：5 个维度（稳定性、数据一致性、性能、业务安全、数据安全）分析合理，无遗漏风险。
3. **Spec Coverage Matrix 完整**：plan.md 中的矩阵逐条覆盖所有 AC 条目，便于执行者对照。
4. **命名替换表精确**：Task 1 的 10 行替换规则表提供了精确的旧名→新名→位置映射，执行者可直接按表操作。

---

## 结论

需修改后重审。2 条 MUST FIX 需在 plan.md 中修复：
1. Task 1 补充 `_render` 数据 key `subItems` → `subtasks` 的重命名映射
2. Task 4 补充 `handleGoalCommand` 中 `/goal clear` 和 `/goal set`（取消旧 goal）路径的 `completedAtTurnIndex` 设置和 `writeGoalHistoryEntry` 调用

### Summary

计划评审完成，第1轮，2条 MUST FIX（_render key 漏重命名 + /goal clear 路径漏覆盖），需修改后重审。
