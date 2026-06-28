---
verdict: draft
---

# goal widget 精简 + slug + budget 显示

## Background

goal 扩展的 widget 当前显示冗长信息（多行面板含 Objective 全文 + Token/Time 进度条）。用户期望：
1. goal 目标在 widget 用一个 AI 生成的 slug 当紧凑标题。
2. widget 显示已消耗 budget / 总 budget（token + time 两个现有维度），以及当前进展轮数。

延续 `2026-06-24-goal-v2-refactor` 重构，零数据模型破坏，改动隔离。

## Functional Requirements

### FR-1: 新增 slug 字段（optional，向后兼容）

- `GoalRuntimeState` 新增 `slug?: string`。
- `deserializeState` 用可选解析（`data.slug as string | undefined`），旧持久化数据无 slug 不 throw。
- `createGoalState` 接受可选 slug 参数；缺省时由调用方决定是否生成。
- `makeHistoryEntry` 把 slug 带入 history entry（向后兼容：旧 entry 无 slug，显示时 fallback 到 objective 截断）。

### FR-2: slug 生成与来源

- `goal_control create`：AI 提供 slug（参数）+ 可选 objective。
- `/goal <objective>` 命令路径：从 objective 自动生成 slug（kebab-case，长度上限）。
- objective 缺省时，slug 即作为目标展示主体。
- [SLUG-RULE] slug 生成规则待定（kebab-case? 长度? 冲突?）—— subagent 追踪项。

### FR-3: widget 显示精简

状态栏（单行，紧凑）：
- 标题用 slug（无 slug 时 fallback 到 objective 截断）
- 显示 `currentTurnIndex`（已跑轮数，无分母）
- token 维度：配了预算显示 `used/budget (remaining)`；没配显示 `used (no budget)`
- time 维度：配了预算显示 `Xm/Ym (Zm remaining)`；没配显示 `Xm elapsed (no budget)`
- 终态/状态后缀沿用现状（Paused/Blocked/Completed/...）

### FR-4: prompt 引擎不变

- `contextInjectionPrompt` / `continuationPrompt` / `objectiveUpdatedPrompt` 仍读 `state.objective`（完整描述，方向感不丢）。
- slug 仅用于 widget 显示 + history，不注入 prompt（除非 prompt 标题需要，待追踪）。

## Acceptance Criteria

- AC-1: `goal_control(create, slug="refactor-auth", objective="重构 auth 模块")` 后，widget 状态栏标题显示 `refactor-auth`。
- AC-2: 配了 `tokenBudget=50000`、`tokensUsed=12000` 时，widget 显示 token 行含 `12k/50k` 或等价格式。
- AC-3: 未配预算时，widget 显示 `Token: 12k used (no budget)` 样式。
- AC-4: widget 显示当前 `currentTurnIndex`。
- AC-5: 旧持久化数据（无 slug 字段）能正常 deserialize，不 throw。
- AC-6: prompt 注入的 objective 内容不变（方向感保留）。
- AC-7: tsc + eslint + vitest 全绿。

## Constraints

- 零 Pi 依赖新增（projection 层维持）。
- 不破坏现有 prompt 引擎。
- 向后兼容旧持久化数据。
- slug 为 optional，全链路 fallback。

## 业务用例

### UC-1: AI 通过 toolcall 创建带 slug 的 goal
- **Actor**: AI agent
- **场景**: 用户说"开始重构 auth 模块"，AI 调 `goal_control(create, slug="refactor-auth", objective="重构 auth 模块...")`
- **预期结果**: goal 创建，widget 状态栏显示 `◆ refactor-auth Turn 0 | token/time 行`

### UC-2: 用户用命令创建 goal（自动生成 slug）
- **Actor**: 用户
- **场景**: 用户输入 `/goal 重构 auth 模块`
- **预期结果**: slug 自动从 objective 生成，widget 显示 slug 标题

## [AMBIGUOUS] 待澄清

- [SLUG-RULE] slug 生成规则（kebab-case? 长度上限? 重复时处理?）
- [PROMPT-SLUG] prompt 标题是否也用 slug（如 `[GOAL] refactor-auth`），还是仍用 objective？
- [WIDGET-LAYOUT] 状态栏四要素（slug + 轮数 + token + time）单行排版方案
