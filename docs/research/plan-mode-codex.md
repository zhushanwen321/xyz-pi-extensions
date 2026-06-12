# Codex CLI Plan Mode 调研报告

> 源码版本：codex-cli main 分支（2026-06）
> 项目语言：Rust（codex-rs/）+ 少量 TypeScript（codex-cli/）

---

## 1. 状态机 / 协作模式

### 模式枚举

Codex 定义了 4 种 `ModeKind`，其中 TUI 用户可见的只有 2 种：

```rust
// protocol/src/config_types.rs:576
pub enum ModeKind {
    Plan,
    #[default]
    Default,  // alias: code, pair_programming, execute, custom
    PairProgramming,  // hidden
    Execute,          // hidden
}

pub const TUI_VISIBLE_COLLABORATION_MODES: [ModeKind; 2] =
    [ModeKind::Default, ModeKind::Plan];
```

**核心设计决策**：将「协作模式」建模为 first-class concept（`CollaborationMode`），而非简单的状态标记。每个模式自带独立的 model、reasoning effort 和 developer instructions。

### 模式数据结构

```rust
// protocol/src/config_types.rs:623
pub struct CollaborationMode {
    pub mode: ModeKind,
    pub settings: Settings,  // { model, reasoning_effort, developer_instructions }
}
```

### 模式 Mask 机制

```rust
// protocol/src/config_types.rs:702
pub struct CollaborationModeMask {
    pub name: String,
    pub mode: Option<ModeKind>,
    pub model: Option<String>,
    pub reasoning_effort: Option<Option<ReasoningEffort>>,
    pub developer_instructions: Option<Option<String>>,
}
```

Mask 是 partial update 结构体，所有字段 optional。用于：
- 预设切换（plan_preset → default_preset）
- 按需覆盖 model / reasoning effort
- 保留未指定字段的当前值

### Plan 模式特有能力

```rust
impl ModeKind {
    pub const fn allows_request_user_input(self) -> bool {
        matches!(self, Self::Plan)
    }
}
```

Plan mode 是唯一允许使用 `request_user_input` 工具的模式——这是 prompt 模板中「多轮提问」功能的底层支撑。

---

## 2. 进入机制

用户有三种方式进入 Plan Mode：

### 2.1 Shift+Tab 循环切换

最核心的 UI 入口。按 `BackTab`（Shift+Tab）在 Default ↔ Plan 间循环：

```rust
// tui/src/chatwidget/interaction.rs:142
KeyEvent { code: KeyCode::BackTab, ... }
    if self.collaboration_modes_enabled()
        && !self.bottom_pane.is_task_running()
        && self.bottom_pane.no_modal_or_popup_active() =>
{
    self.cycle_collaboration_mode();
}
```

```rust
// tui/src/chatwidget/settings.rs:685
pub(super) fn cycle_collaboration_mode(&mut self) {
    let next_mask = collaboration_modes::next_mask(
        self.model_catalog.as_ref(),
        self.active_collaboration_mask.as_ref(),
    );
    self.set_collaboration_mask_from_user_action(next_mask);
}
```

循环逻辑：

```rust
// tui/src/collaboration_modes.rs
pub(crate) fn next_mask(model_catalog, current) -> Option<CollaborationModeMask> {
    let presets = filtered_presets(model_catalog);  // [Default, Plan]
    let next_index = presets.iter()
        .position(|mask| mask.mode == current_kind)
        .map_or(0, |idx| (idx + 1) % presets.len());
    presets.get(next_index).cloned()
}
```

**切换约束**：
- Turn 运行中禁止切换到不同模式（允许同模式消息排队）
- 切换时自动更新 session 的 collaboration_mode 设置

### 2.2 关键词 Nudge（提示引导）

当用户在 Default 模式输入含 "plan" 词的文本时，TUI 显示 nudge 提示：

```rust
// tui/src/chatwidget.rs:802
fn contains_plan_keyword(text: &str) -> bool {
    text.split(|ch: char| !ch.is_alphanumeric() && ch != '_')
        .any(|word| word.eq_ignore_ascii_case("plan"))
}
```

Nudge 显示条件（`settings.rs:418`）：
- 当前在 Default 模式
- 输入框启用且无 task/modal 运行
- 非 `/` 或 `!` 开头的命令
- 包含 "plan" 关键词（精确匹配，不含 "plane"/"planning"）
- 当前 thread scope 未被 Esc 关闭过

用户按 `BackTab` 接受 nudge → 切换到 Plan 模式；按 `Esc` 关闭 nudge（scope 级别记忆）。

### 2.3 程序化切换

`submit_user_message_with_mode` 方法支持在发送消息时附带目标模式：

```rust
// plan_implementation.rs:36
let actions: Vec<SelectionAction> = vec![Box::new(move |tx| {
    tx.send(AppEvent::SubmitUserMessageWithMode {
        text: user_text.clone(),
        collaboration_mode: mask.clone(),
    });
})];
```

这是 Plan → Execute 确认弹窗的实现基础。

---

## 3. 工具限制

### Plan Mode 下 update_plan 被禁用

Plan Mode 中，`update_plan` 工具调用会直接报错：

```rust
// core/src/tools/handlers/plan.rs:68
if turn.collaboration_mode.mode == ModeKind::Plan {
    return Err(FunctionCallError::RespondToModel(
        "update_plan is a TODO/checklist tool and is not allowed in Plan mode".to_string(),
    ));
}
```

**设计意图**：`update_plan` 是 Default/Execute 模式下的进度追踪工具（checkbox todo list），与 Plan mode 的 `<proposed_plan>` 输出机制是正交的两套系统。Prompt 模板中明确说明：

> Plan Mode is not changed by user intent, tone, or imperative language.
> `update_plan` is a checklist/progress/TODOs tool; it does not enter or exit Plan Mode.

### Prompt 层面的 mutating 限制

Plan mode prompt 模板通过 instructions 限制行为，而非工具级硬限制：

- **允许**：读文件、搜索、静态分析、dry-run 命令、build/test（不修改 repo 文件）
- **禁止**：编辑文件、运行 formatter/linter、apply patch、side-effectful 命令

这是 soft constraint（模型自行遵守），不是 runtime enforcement。

---

## 4. Plan 数据结构

### 4.1 update_plan 工具（进度追踪，非 Plan Mode）

```rust
// protocol/src/plan_tool.rs
pub enum StepStatus {
    Pending,
    InProgress,
    Completed,
}

pub struct PlanItemArg {
    pub step: String,
    pub status: StepStatus,
}

pub struct UpdatePlanArgs {
    pub explanation: Option<String>,
    pub plan: Vec<PlanItemArg>,
}
```

工具 schema 定义（`plan_spec.rs`）：

```
name: "update_plan"
parameters: {
  explanation?: string,
  plan: [{ step: string, status: "pending"|"in_progress"|"completed" }]
}
constraint: at most one step can be in_progress at a time
```

### 4.2 Proposed Plan（Plan Mode 输出）

Plan Mode 的最终产出不是通过 tool call，而是通过特殊的 `<proposed_plan>` 标签直接嵌入 assistant 文本输出：

```
<proposed_plan>
plan content in markdown
</proposed_plan>
```

**解析流程**：
1. 服务端 streaming 检测到 `<proposed_plan>` 标签
2. TUI 通过 `PlanDelta` 通知接收流式内容
3. `on_plan_delta()` → `PlanStreamController` 处理渲染
4. `on_plan_item_completed()` → 存储到 `transcript.latest_proposed_plan_markdown`

```rust
// tui/src/chatwidget/streaming.rs:110
pub(super) fn on_plan_delta(&mut self, delta: String) {
    if self.active_mode_kind() != ModeKind::Plan { return; }
    self.transcript.plan_delta_buffer.push_str(&delta);
    // ... streaming rendering
}

// tui/src/chatwidget/streaming.rs:142
pub(super) fn on_plan_item_completed(&mut self, text: String) {
    self.transcript.latest_proposed_plan_markdown = Some(plan_text.clone());
    self.transcript.saw_plan_item_this_turn = true;
    // ... finalize streaming, store to history
}
```

---

## 5. Plan → Execute 转换

### 触发条件

Turn 完成时自动检测（`turn_runtime.rs:214`）：

```rust
pub(super) fn maybe_prompt_plan_implementation(&mut self) {
    if self.active_mode_kind() != ModeKind::Plan { return; }
    if !self.transcript.saw_plan_item_this_turn { return; }
    if self.has_queued_follow_up_messages() { return; }
    if !self.bottom_pane.no_modal_or_popup_active() { return; }
    if rate_limit prompt is pending { return; }
    self.open_plan_implementation_prompt();
}
```

**关键条件**：
- 当前在 Plan 模式
- 本 turn 产出了 `<proposed_plan>`（`saw_plan_item_this_turn == true`）
- 没有排队的后续消息
- 没有 modal/popup 阻塞

### 确认弹窗

```rust
// tui/src/chatwidget/plan_implementation.rs
pub(super) fn selection_view_params(...) -> SelectionViewParams {
    // 三个选项：
    // 1. "Yes, implement this plan" → SubmitUserMessageWithMode(Default mode, "Implement the plan.")
    // 2. "Yes, clear context and implement" → ClearUiAndSubmitUserMessage(plan + prefix)
    // 3. "No, stay in Plan mode" → dismiss
}
```

三个选项的语义：

| 选项 | 行为 | 适用场景 |
|------|------|---------|
| Yes, implement | 切换到 Default 模式，发送 "Implement the plan." | 上下文充足 |
| Yes, clear context | 清空上下文，以 plan 文本作为新 session 输入 | 上下文已大量消耗 |
| No, stay | 继续当前 Plan 模式 | 需要修改 plan |

**Clear Context 的实现**：

```
"A previous agent produced the plan below to accomplish the user's task.
Implement the plan in a fresh context. Treat the plan as the source of
user intent, re-read files as needed, and carry the work through
implementation and verification.\n\n{plan_markdown}"
```

上下文用量显示：弹窗中 "Clear context" 选项会展示已用百分比（如 "Fresh thread. Context: 89% used."）。

### 防重入

- Turn 运行中禁止切换到不同模式
- Replay 的 turn 不会触发 popup
- 已排队消息时不弹窗
- 重复 turn complete 只弹一次

---

## 6. 进度追踪

### update_plan 工具（Default/Execute 模式）

`update_plan` 是一个独立于 Plan Mode 的 checkbox/todo 工具，在 Default 和 Execute 模式下可用：

```rust
// core/src/tools/handlers/plan.rs:39
fn tool_name(&self) -> ToolName {
    ToolName::plain("update_plan")
}
```

调用流程：
1. 模型调用 `update_plan({ explanation, plan: [{step, status}] })`
2. `PlanHandler::handle()` 解析参数
3. 发送 `EventMsg::PlanUpdate(args)` 事件
4. TUI 接收后渲染为 checkbox 风格的 todo list

### TUI 渲染

```rust
// tui/src/history_cell/plans.rs:257
fn display_lines(&self, width: u16) -> Vec<Line<'static>> {
    // ✔ (crossed_out dim) — completed
    // □ (cyan bold)       — in_progress
    // □ (dim)             — pending
}
```

**限制**：Plan Mode 下此工具被禁用，避免了「plan the planning」的概念混乱。

---

## 7. TUI 交互

### 7.1 Plan Nudge（输入框下方提示）

当用户在 Default 模式输入含 "plan" 的文本时，输入框下方显示 nudge 条。用户可：
- `BackTab` 接受 → 切到 Plan 模式
- `Esc` 关闭 → scope 级别记忆（换 thread 后重新显示）

### 7.2 Mode 指示器

状态栏显示当前 mode 名称。切换时如果有 model/reasoning 变化，在聊天历史中插入信息消息：

```
"Model changed to gpt-5.4-mini medium for Plan mode."
```

### 7.3 Plan Streaming 渲染

Plan 内容流式输出时：
- `PlanStreamController` 管理实时渲染
- 内容缩进 4 格，带竖线前缀
- 标题使用 "Proposed Plan" 加粗显示
- 完成后存储为 `ProposedPlanCell`（支持 resize 重绘）

### 7.4 Plan Implementation 弹窗

Turn 完成且含 proposed plan 时，底部弹出选择框：
- 标题："Implement this plan?"
- 三个选项（见第 5 章）
- 显示 context usage 百分比
- 支持 `Esc` 关闭

### 7.5 Reasoning Effort 作用域

Plan 模式有独立的 reasoning effort override：

```rust
// settings.rs:715
if mask.mode == Some(ModeKind::Plan)
    && let Some(effort) = self.config.plan_mode_reasoning_effort
{
    mask.reasoning_effort = Some(Some(effort));
}
```

切换 reasoning 时弹出 scope 选择：
- "Apply to Plan mode override" — 只影响 Plan
- "Apply to global default and Plan mode override" — 同时更新全局

---

## 8. 模板系统

### 架构

```
collaboration-mode-templates/
├── src/lib.rs          # include_str! 编译时嵌入
└── templates/
    ├── plan.md
    ├── default.md
    ├── execute.md
    └── pair_programming.md
```

```rust
// collaboration-mode-templates/src/lib.rs
pub const PLAN: &str = include_str!("../templates/plan.md");
pub const DEFAULT: &str = include_str!("../templates/default.md");
pub const EXECUTE: &str = include_str!("../templates/execute.md");
pub const PAIR_PROGRAMMING: &str = include_str!("../templates/pair_programming.md");
```

### 注入机制

模板通过 `CollaborationModeMask.developer_instructions` 字段注入到 session：

```rust
// models-manager/src/collaboration_mode_presets.rs
fn plan_preset() -> CollaborationModeMask {
    CollaborationModeMask {
        name: "Plan".to_string(),
        mode: Some(ModeKind::Plan),
        model: None,
        reasoning_effort: Some(Some(ReasoningEffort::Medium)),
        developer_instructions: Some(Some(COLLABORATION_MODE_PLAN.to_string())),
    }
}
```

注入位置是 developer message，通过特殊标签包裹：

```rust
// core/src/context/collaboration_mode_instructions.rs
fn markers(&self) -> (&'static str, &'static str) {
    (COLLABORATION_MODE_OPEN_TAG, COLLABORATION_MODE_CLOSE_TAG)
}
```

Default 模板支持变量替换（`{{KNOWN_MODE_NAMES}}` → "Default and Plan"），Plan 模板是纯静态文本。

### Plan 模板核心内容

plan.md 的 3 阶段设计：

1. **Phase 1 — Ground in the environment**：先探索后提问，最小化向用户提问
2. **Phase 2 — Intent chat**：确认目标 + 成功标准 + 范围 + 约束
3. **Phase 3 — Implementation chat**：确认方案决策完全（decision complete）

关键规则：
- `request_user_input` 工具优先于直接文字提问
- 只在 options 有意义时提供多选
- plan 必须是 decision complete（实施者无需做决策）
- 最终 plan 用 `<proposed_plan>` 标签包裹
- 不问 "should I proceed?"

### Execute 模板核心内容

execute.md 的定位是 autonomous execution：
- Assumptions-first（遇到缺失信息先假设再执行）
- Long-horizon execution（milestone 拆分 + 逐步验证）
- 使用 `update_plan` 报告进度

---

## 对 Pi plan 扩展的启示

### 1. 模式与工具的解耦设计值得借鉴

Codex 将「协作模式」（plan/default）和「工具能力」（update_plan/request_user_input）做了清晰解耦：
- `ModeKind` 控制哪些工具可用（`allows_request_user_input()`）
- Prompt 模板控制行为约束（soft constraint）
- 工具 handler 做硬性校验（Plan mode 下 update_plan 报错）

**启示**：Pi plan 扩展应明确「plan mode 是模式级概念还是 skill 级概念」，避免工具和模式耦合。

### 2. Plan 产出是流式文本而非结构化数据

Codex 的 `<proposed_plan>` 是纯 Markdown 文本流，不是 JSON/tool call。这让它：
- 对模型来说生成自然（不强制 schema）
- 对 TUI 来说渲染灵活（markdown render）
- 对 clear-context 场景来说拼接简单（文本前缀 + plan body）

**启示**：Pi plan 扩展可以考虑「plan 输出用 markdown 流而非结构化 tool call」，降低模型 compliance 成本。结构化只在 task breakdown 阶段需要。

### 3. 两级进度追踪

- Plan Mode：`<proposed_plan>` 流式输出 → 最终 plan 文本
- Execute Mode：`update_plan` 工具 → checkbox todo list

两者独立、正交，服务于不同阶段。

**启示**：Pi plan 扩展如果引入 execute 阶段，需要独立的进度追踪机制（如 todo 扩展），不应复用 plan 的数据结构。

### 4. 用户确认 + Clear Context 的优雅处理

"Clear context and implement" 选项解决了 plan 阶段消耗大量 context 的实际问题。前置文本将 plan 定义为新 session 的 user intent：

**启示**：Pi 的 plan → execute 转换也需要考虑 context 消耗。可以借鉴「plan 文本作为新 session 输入」的模式。

### 5. Nudge 而非强制

Codex 不强制用户进入 Plan mode——它通过关键词检测 + nudge UI 引导用户。用户可以忽略、关闭、或接受。

**启示**：Pi plan 扩展的入口设计应优先考虑「低摩擦引导」而非「强制流程」。

### 6. Preset/Mask 模式实现模式切换

`CollaborationModeMask` 的 partial update 设计让模式切换非常灵活——每个 preset 只覆盖自己关心的字段（model、effort、instructions），其余继承当前值。

**启示**：Pi plan 扩展如果引入模式概念，应采用类似 Mask 的 partial update 模式，而非全量替换。
