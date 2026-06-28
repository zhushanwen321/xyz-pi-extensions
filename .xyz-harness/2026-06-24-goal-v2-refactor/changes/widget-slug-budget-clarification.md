# widget 精简 + slug + budget 显示 — 需求澄清记录

> 本轮针对「goal widget 优化」需求，用 spec-clarify skill 澄清。
> 主题目录沿用 `2026-06-24-goal-v2-refactor`（同一 goal 重构的延续）。

## 背景

用户原始诉求（2 点）：
1. goal 目标简化成一个 slug，由 AI 生成。
2. goal widget 显示当前进展轮数/总轮数预算，以及当前消耗 token/总 token 预算。

## 已确认决策

### D-widget-1: slug 与 objective 的关系（新增 slug，objective 保留）

- `GoalRuntimeState` 新增 **可选** `slug?: string` 字段。
- widget **状态栏**用 slug 当紧凑标题（`◆ refactor-auth ...`）；完整 `objective` 仍用于注入每轮 context prompt（方向感不丢）。
- `goal_control create` 时 AI 给 slug + 可选 objective；`/goal` 命令路径自动从 objective 生成 slug。
- objective 缺省时 fallback 到 slug。
- 改动隔离，**不破坏**现有 prompt 引擎（contextInjection/continuation 仍读 objective）。

### D-widget-2: 不引入 turn 预算（用户纠正）

- **不**新增 `turnBudget` 字段，**不**新增 turn 维度的预算引擎逻辑。
- widget 显示的是「已用 budget / 总 budget」，针对**现有**两个维度（token + time）。
- 「当前进展轮数」用**已有的** `currentTurnIndex`（已存在，turn_end 自增），作为已跑轮数显示，**无分母**。

### D-widget-3: 无预算时显示已消耗绝对值

- 当 `BudgetConfig` 为空（DEFAULT_BUDGET={}）时，widget **仍显示**已消耗量（只有分子无分母）：
  - `Token: 12k used (no budget)`
  - `Time: 5m elapsed (no budget)`
- 配了哪个维度才显示哪个的分母/进度；没配的显示绝对值。让用户始终能看到消耗进度。

## 待 subagent 追踪（5 视角）

- slug 生成规则（kebab-case? 长度上限? slug 冲突处理?）
- slug 在 prompt 中的使用（contextInjection 标题用 slug 还是仍用 objective?）
- goal-history entry 是否带 slug
- /goal 命令自动生成 slug 的算法
- deserialize 兼容（旧持久化数据无 slug）
- widget 状态栏布局（slug + 轮数 + 两个 budget 在一行的排版）

## Round 1 追踪后新增决策（解决 12 个 gap）

> 详见 `tracing-widget-slug-round-1.md`。

### D-create-args: goal_control create 的 slug + objective 都必填（GAP-2）
- handleCreate 守卫：slug 和 objective 缺一不可。
- objective 仍注入 prompt（方向感完整），slug 仅 widget 标题 + history。

### D-command-trigger: /goal <objective> 改为「提示词触发器」（GAP-1）
- slug 永远由 AI 在 toolcall 时生成——不存在「命令路径自动生成 slug」的算法问题。
- /goal <objective> 不直接 createGoal，而是 sendUserMessage 引导 AI 调 goal_control create。
- goal 创建的唯一路径 = goal_control toolcall。
- 其余子命令（status/pause/resume/clear/update/history）保持直接执行。

### D-update-slug: /goal update 时 slug 置空（GAP-6）
- update 是直接执行路径（重塑），旧 slug 不匹配新 objective → 置空。
- widget fallback 到 objective 截断。不需要单独的改 slug 机制（GAP-9 不建）。

### D-widget-layout: widget 精简（GAP-7/GAP-8）
- 状态栏标题 = slug（fallback objective 截断）。
- 移除侧边面板的 Objective 全文行（精简；完整 objective 注入 prompt，看全文用 /goal status）。
- 无预算时显示已消耗绝对值（`12k tokens`、`1m30s`），配预算显示百分比/进度条。
- 终态行维持现状（GAP-12：终态不显示无预算绝对值）。
- prompt 标题行 [GOAL] 不变（GAP-10：slug 仅 widget 用，不注入 prompt 标题）。

### F 类事实遗漏（spec 漏的改造点，已补入实现）
- GAP-3: service.createGoal 签名也要加 slug 参数（不止 createGoalState）。
- GAP-4: deserialize slug 必须用可选解析（误用 req 致旧数据 state 全丢）→ 已加测试覆盖。
- GAP-5: handleHistory 显示层也要 slug fallback（不止 entry 字段）。
- GAP-7: 无预算显示绝对值是全新渲染逻辑 + 需新建 formatTokens 缩写函数。
- GAP-11: goal_control create 返回文本 + renderResult/renderCall 带 slug。
