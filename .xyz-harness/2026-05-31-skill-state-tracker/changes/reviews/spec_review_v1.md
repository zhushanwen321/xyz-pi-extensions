---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-31T16:00:00"
  target: ".xyz-harness/2026-05-31-skill-state-tracker/spec.md"
  verdict: fail
  summary: "spec 评审完成，第1轮，3条MUST FIX（状态转换规则不一致、FR-4/FR-5 因果矛盾、上下文摘要不可实现），需修改后重审"

statistics:
  total_issues: 6
  must_fix: 3
  must_fix_resolved: 0
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-2 + FR-5"
    title: "状态机转换规则不完整，图与参数定义不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "spec.md:FR-4 vs FR-5"
    title: "FR-4 与 FR-5 对 recorded 状态的触发顺序描述矛盾"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: MUST_FIX
    location: "spec.md:FR-4"
    title: "上下文摘要数据来源不明确，扩展无法访问 LLM 对话"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "spec.md:FR-5"
    title: "缺少 TUI 渲染说明（renderCall/renderResult）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "spec.md:AC-5"
    title: "AC-5 Then 条件不够精确，触发强制记录缺少可验证断言"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: INFO
    location: "spec.md:FR-5"
    title: "未提及 _render GUI 描述符，可考虑为 list 操作添加"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 评审 v1

## 评审记录
- 评审时间：2026-05-31 16:00
- 评审类型：计划评审（spec 部分）
- 评审对象：`.xyz-harness/2026-05-31-skill-state-tracker/spec.md`

## 评审维度覆盖

### 1. spec 完整性

**目标明确性 ✅**：一段话可概括——通过 hook 自动检测 skill 加载，状态机追踪执行状态，异常累积自动触发问题记录。目标清晰。

**范围合理性 ✅**：4 状态状态机 + 3 事件 hook + 1 工具，预估 ~580 行。不过大不过小，边界清晰（无跨扩展代码依赖、不使用 child_process）。

**验收标准可量化 ⚠️**：AC-1 至 AC-8 均用 Given/When/Then 格式，大部分可测试。但 AC-5 的 Then 条件（"触发强制记录"）不够精确（详见 issue #5）。

**[待决议] 项**：无显式标记。但存在 3 处隐含歧义（详见 MUST FIX issues）。

### 2. 与 CLAUDE.md 架构约束一致性

- ✅ Session 隔离：闭包变量 + appendEntry，session_start 重建
- ✅ 状态持久化：pi.appendEntry + GC 策略
- ✅ Tool 设计：typebox schema + content/details 返回结构
- ✅ 目录结构：skill-state/ 遵循标准扩展布局
- ✅ 禁止 any、单文件 1000 行限制
- ⚠️ TUI 渲染：未指定 renderCall/renderResult（详见 issue #4）

### 3. 业务用例覆盖

UC-1（正常追踪）和 UC-2（异常记录）覆盖了主要场景。缺少一个用例：skill 加载后 AI 从未调用 skill_state 工具（只有 10 turn 提醒，但提醒不会自动终态）。这是一个设计选择而非遗漏，可接受。

---

## 发现的问题

| # | 优先级 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|---------|
| 1 | MUST FIX | FR-2 状态机图 + FR-5 status 参数 | 状态机图只画出 `loaded→completed`、`loaded→error`、`error→completed`、`error→error`、`error→recorded` 五条转换。但 FR-5 的 `status` 参数允许 AI 从任何状态调用 `update` 传入 `completed`、`error`、`recorded` 任意值，转换验证规则未定义。 | 增加一个转换合法性表格，明确列出 (当前状态, 目标状态) 的所有合法组合。例如：`loaded` 能否直接转到 `recorded`？`completed` 终态被重新加载后，旧 item 保持终态、新 item 从 `loaded` 开始——这需要显式说明。 |
| 2 | MUST FIX | FR-4 vs FR-5 | FR-4 描述的因果链：`errorCount ≥ 2 → 注入 steering → AI 调用 subagent → 自动流转到 recorded`（subagent 在先，recorded 在后）。FR-5 描述的因果链：`AI 调用 skill_state(status=recorded) → 触发 FR-4 的 subagent 调用`（recorded 在先，subagent 在后）。两者顺序相反，实现者无法判断正确的执行流程。 | 选择一种模型并统一描述。方案 A（推荐）：FR-4 触发时只注入 steering，AI 调用 skill_state(status=recorded) 时扩展自动派发 subagent，然后确认 recorded。方案 B：FR-4 触发时扩展直接注入 steering 要求 AI 先调 subagent 再调 skill_state。需选一个并在 FR-4 和 FR-5 中保持一致。 |
| 3 | MUST_FIX | FR-4 "上下文摘要" | "当前 session 中该 skill 的上下文摘要" 作为 subagent prompt 的输入。但扩展只能访问 TrackedItem 的状态数据（status、errorCount、turn 信息），无法访问 LLM 对话历史来生成有意义的执行摘要。 | 明确 "上下文摘要" 的数据来源。如果只是 TrackedItem 自身的字段（名称、状态历史、errorCount、加载时长），直接说明。如果需要 AI 传入，则在 skill_state 工具中增加 `context` 参数让 AI 填写。 |
| 4 | LOW | FR-5 整体 | 未描述 skill_state 工具的 TUI 渲染行为。按 CLAUDE.md 架构要求，每个工具都应有 renderCall 和 renderResult 定义。 | 补充 renderCall（显示 action 和目标 skill）和 renderResult（list 时显示 TrackedItem 表格，update 时显示变更前后的 diff）的描述。 |
| 5 | LOW | AC-5 Then 条件 | "触发强制记录" 作为 Then 断言不够精确，测试无法直接验证。 | 改为可验证的具体行为，如："Then errorCount = 2，且通过 sendMessage 注入了包含 subagent 调用指令的 steering 消息，消息内容引用该 skill 的 TrackedItem"。 |
| 6 | INFO | FR-5 list 行为 | CLAUDE.md 定义了 _render GUI 描述符协议，list 操作天然适合 `task-list` 类型渲染。初始版本可以不加，但建议标注为后续优化项。 | — |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

### 问题 #1 详析：状态机转换规则不完整

FR-2 的状态机图画出了 5 条转换边，但缺少以下关键定义：

1. **`loaded → recorded` 是否合法？** 如果 AI 加载 skill 后直接想记录问题，是否允许跳过 error 阶段？参数定义允许传入 `recorded`，但图上没有这条边。
2. **`loaded → loaded` 是否合法？** 即 AI 对已 loaded 的 item 重复调用 `update(status: loaded)` 应该忽略还是报错？
3. **终态后的重新追踪**：AC-3 说明终态 item 允许创建新 TrackedItem，但没有说明旧 item 的处理（保留在列表中还是删除）。

建议：用表格显式列出所有 (from, to) 合法组合，消除歧义。

### 问题 #2 详析：FR-4 与 FR-5 因果矛盾

这是最关键的设计不一致。两条原文：

- **FR-4**：`errorCount ≥ 2` → 注入 steering → AI 调 subagent → **自动流转**到 recorded
- **FR-5**：`recorded` 时 → **触发** FR-4 的 subagent 调用

如果按 FR-4 的顺序，扩展需要某种机制检测 "AI 已经调了 subagent"（扩展无法直接监听 subagent 工具的执行完成）。如果按 FR-5 的顺序，recorded 是 AI 主动标记的，subagent 是扩展在 AI 标记后触发的——但这意味着扩展需要能在工具 execute 内部派发 subagent（通过 steering？），且 "AI 调用 subagent 后自动流转" 的描述就不成立了。

### 问题 #3 详析：上下文摘要不可实现

FR-4 要求 subagent prompt 包含 "当前 session 中该 skill 的上下文摘要"。但 Pi 扩展的 API 边界明确限制：扩展只能访问 `ctx.sessionManager.getEntries()` 中的结构化 entry，无法访问 LLM 对话原文。

TrackedItem 自身只有 { name, status, errorCount, loadedAtTurn, lastRemindAtTurn } 这些字段，无法构成有意义的 "执行上下文摘要"。

两种修复方向：
- **方向 A**：摘要只包含 TrackedItem 自身数据 + 该 skill 加载后发生的 entry 事件摘要（扩展能从 entries 提取）
- **方向 B**：在 skill_state 工具中增加可选的 `context` 参数，让 AI 在标记 error 时描述遇到的问题

---

## 结论

需修改后重审。3 条 MUST FIX 均涉及核心状态机设计，必须在 plan 阶段前解决。

### Summary

spec 评审完成，第1轮，3条MUST FIX（状态转换规则不完整、FR-4/FR-5 因果矛盾、上下文摘要不可实现），需修改后重审。
