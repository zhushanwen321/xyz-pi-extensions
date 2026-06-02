---
verdict: pass
---

# Skill State Tracker

## Background

用户有 70+ 个 skill，但 57 个从未触发。更关键的是：即使 skill 被加载执行，也无法知道执行是否成功、AI 是否遇到困难。前一次尝试（`skill-memory-keeper`）依赖 AI 主动记录问题，但 AI 缺乏这种元认知能力，导致从未被触发。

本扩展采用**状态机驱动**方案：Hook 自动检测 skill 加载（零 LLM 成本），状态机引导 AI 在适当时机流转状态，异常累积到阈值自动触发问题记录。

设计调研文档：`docs/research/skill-state-tracker-design.md`

## Functional Requirements

### FR-1: Skill 加载自动检测

通过 `tool_call` 事件拦截 AI 对 `read` 工具的调用。当 `input.path` 匹配 `SKILL.md` 结尾时，提取 skill 名称（路径倒数第二级目录名），创建 `TrackedItem(status: "loaded")`。

**去重规则：** 同一 skill 名称如果已有非终态 TrackedItem，不重复创建。

**注入方式：** 通过 `sendMessage({ deliverAs: "steer" })` 注入提示词，告知 AI 当前有活跃的 skill 追踪，可调用 `skill_state` 工具流转状态。

### FR-2: 状态机

**合法转换矩阵（行 = 当前状态，列 = 目标状态）：**

| 从 \ 到 | completed | error | recorded |
|---------|-----------|-------|----------|
| loaded  | ✅        | ✅     | ❌       |
| error   | ✅        | ✅     | ✅        |

**终态：** `completed`、`recorded`。终态不可变更。

**转换行为：**
- `→ completed`：AI 报告 skill 执行成功，直接终态
- `→ error`：`errorCount += 1`。如果 `errorCount ≥ 2`，扩展自动注入 steering 要求 AI 调用 subagent 记录问题
- `→ recorded`：仅 `error` 状态可转换。AI 确认 subagent 已完成记录后调用

### FR-3: 10 Turn 提醒

在 `turn_end` 事件中检查所有非终态 TrackedItem。如果 `currentTurnIndex - item.loadedAtTurn ≥ 10` 且 `currentTurnIndex - item.lastRemindAtTurn ≥ 10`，通过 `sendMessage({ deliverAs: "steer" })` 注入提醒。

提醒内容：`[SKILL-STATE] skill "{name}" 已加载 {N} turn 未终态，请调用 skill_state 工具流转状态。`

**提醒间隔：** 每 10 turn 一次，无限次，直到终态。

### FR-4: 异常强制记录

当 `errorCount ≥ 2` 时，通过 `sendMessage({ deliverAs: "steer" })` 注入强制记录指令。指令内容要求 AI 调用 `subagent` 工具（background 模式），任务 prompt 包含：
- skill 名称和异常次数
- 要求 subagent 读取该 skill 的 SKILL.md
- 要求 subagent 根据当前 session context（subagent 独立拥有 session 访问能力）分析 skill 执行中遇到的问题
- 生成结构化问题记录（skill 名称、异常次数、问题描述、改进建议）

注意：subagent 是独立进程，有自己的 session 上下文，可以直接读取当前 session 的 entries 获取执行上下文。本扩展不需要传递 "上下文摘要"，由 subagent 自行获取。

AI 完成上述流程后，调用 `skill_state` action=update, status=recorded 将 TrackedItem 流转到 `recorded` 终态。

**因果顺序：** 先注入 steering → AI 调用 subagent → AI 调用 skill_state(status=recorded)。扩展不自动流转到 recorded，需要 AI 确认 subagent 完成后主动流转。

### FR-5: skill_state 工具

注册 `skill_state` 工具，参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `action` | enum: `update`, `list` | 是 | 操作类型 |
| `id` | number | update 必填 | TrackedItem ID |
| `status` | enum: `completed`, `error`, `recorded` | update 必填 | 目标状态 |
| `detail` | string | 否 | 附加说明（如 error 原因） |

**update 行为：**
- 验证 id 存在且当前状态允许转换到目标状态（按 FR-2 转换矩阵）
- 不合法的转换（如 loaded → recorded）返回错误
- `→ error` 时 `errorCount += 1`；如果 `errorCount ≥ 2`，扩展注入 FR-4 的 steering
- `→ recorded` 时仅标记终态，不触发额外操作（subagent 应已由 AI 调用完成）
- 返回更新后的 TrackedItem 列表

**list 行为：**
- 返回所有 TrackedItem 列表（含状态、errorCount、turn 信息）

### FR-6: 状态持久化

通过 `pi.appendEntry("skill-state-tracker", data)` 持久化当前追踪列表。触发时机：每次状态变更时（tool execute 内、强制记录时）。

**GC 策略：** 保留最新的 entry，删除所有旧的同类型 entry。TrackedItem 达到终态后，在下次 `session_start` 重建时清理（仅保留非终态 item）。

### FR-7: Session 恢复

`session_start` 和 `session_tree` 事件中，从 `ctx.sessionManager.getEntries()` 重建状态：
1. 找到最新的 `customType === "skill-state-tracker"` entry
2. 反序列化 TrackedItem 列表
3. 过滤掉终态 item（已完成的不需要恢复追踪）
4. 恢复当前 turn 计数器（从 entries 中的 turn_end 事件推算）

### FR-8: before_agent_start 上下文注入

在 `before_agent_start` 事件中，如果有非终态 TrackedItem，注入上下文消息：
- 列出所有活跃追踪的 skill 名称和状态
- 提示 AI 可调用 `skill_state` 工具流转状态

这确保新 agent loop 开始时 AI 知道有待处理的追踪。

## Acceptance Criteria

### AC-1: Skill 加载检测
- Given AI 调用 `read` 读取任意路径下以 `SKILL.md` 结尾的文件
- When `tool_call` 事件触发
- Then 创建 TrackedItem，status 为 `loaded`，name 为路径中 SKILL.md 的父目录名
- And 通过 steering 注入追踪提示词

### AC-2: 重复加载不重复创建
- Given 已有 TrackedItem(name: "foo", status: "loaded")
- When AI 再次 read 同一 SKILL.md
- Then 不创建新 TrackedItem

### AC-3: 终态 skill 可重新追踪
- Given 已有 TrackedItem(name: "foo", status: "completed")（终态）
- When AI 再次 read 同一 SKILL.md
- Then 创建新 TrackedItem(name: "foo", status: "loaded")

### AC-4: AI 状态流转
- Given TrackedItem(status: "loaded")
- When AI 调用 `skill_state` action=update, status=completed
- Then TrackedItem.status 变为 "completed"（终态）

### AC-5: 异常累加
- Given TrackedItem(status: "error", errorCount: 1)
- When AI 调用 `skill_state` action=update, status=error
- Then errorCount 变为 2，触发强制记录

### AC-6: 10 Turn 提醒
- Given TrackedItem(status: "loaded", loadedAtTurn: 5)
- When turn_end 事件触发，turnIndex: 15
- Then 注入 steering 提醒

### AC-7: 状态持久化与恢复
- Given session 中有 2 个 TrackedItem（1 loaded, 1 completed）
- When session 重新加载（session_start）
- Then 恢复 1 个 loaded 状态的 TrackedItem，completed 的被过滤

### AC-8: before_agent_start 注入
- Given 有 1 个非终态 TrackedItem
- When before_agent_start 事件触发
- Then 注入上下文消息列出活跃追踪

## Constraints

- **扩展目录：** `skill-state/`，工具名 `skill_state`
- **无跨扩展代码依赖：** 不 import subagent 扩展的代码。强制记录通过注入 steering 消息让 AI 调用 subagent 工具实现
- **Session 隔离：** 状态存储在闭包变量 + `appendEntry` 持久化，`session_start` 时重建
- **不使用 `child_process`：** 与 subagent 扩展不同，本扩展不直接 spawn 进程
- **技术栈：** TypeScript + Pi Extension API + typebox + pi-tui
- **单文件上限 1000 行**，函数上限 80 行
- **禁止 `any`**

## 业务用例

无业务用例。纯技术性工具扩展。

### UC-1: Skill 执行追踪
- **Actor**: AI Agent
- **场景**: AI 加载并执行一个 skill
- **预期结果**: skill 加载时自动创建追踪记录，AI 执行完成后调用工具标记终态

### UC-2: Skill 异常记录
- **Actor**: AI Agent + 扩展自动触发
- **场景**: AI 在执行 skill 时遇到困难，标记为 error，再次遇到困难后自动触发 subagent 记录问题
- **预期结果**: 问题记录通过 subagent 生成，TrackedItem 进入 recorded 终态

## Complexity Assessment

**中等。** 核心是一个 4 状态状态机 + 3 个事件 hook（tool_call、turn_end、before_agent_start）+ 1 个工具。没有复杂的 UI 或网络交互。主要风险在于提示词设计（让 AI 正确流转状态）和 10 turn 提醒的 timing。

**预估文件：**
- `src/state.ts` — 数据模型 + 序列化（~100 行）
- `src/templates.ts` — 提示词模板（~80 行）
- `src/index.ts` — 工厂 + 事件注册 + 工具定义 + 渲染（~400 行）

**总计：~580 行。**
