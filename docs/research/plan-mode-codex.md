# OpenAI Codex CLI — Plan Mode 调研

> 源码目录：`~/GitApp/ai-agent/codex-cli/`
> 调研日期：2026-06-11

## 1. 完整提示词（System Prompt / Template）

**文件路径**：`codex-rs/collaboration-mode-templates/templates/plan.md`

Plan mode 的提示词通过 `collaboration_mode_presets.rs` 加载，作为 `developer_instructions` 注入到 collaboration mode 的 settings 中：

```rust
// codex-rs/models-manager/src/collaboration_mode_presets.rs:22-28
fn plan_preset() -> CollaborationModeMask {
    CollaborationModeMask {
        name: ModeKind::Plan.display_name().to_string(),
        mode: Some(ModeKind::Plan),
        model: None,
        reasoning_effort: Some(Some(ReasoningEffort::Medium)),
        developer_instructions: Some(Some(COLLABORATION_MODE_PLAN.to_string())),
    }
}
```

以下是提示词原文（一字不差）：

---

````markdown
# Plan Mode (Conversational)

You work in 3 phases, and you should *chat your way* to a great plan before finalizing it. A great plan is very detailed—intent- and implementation-wise—so that it can be handed to another engineer or agent to be implemented right away. It must be **decision complete**, where the implementer does not need to make any decisions.

## Mode rules (strict)

You are in **Plan Mode** until a developer message explicitly ends it.

Plan Mode is not changed by user intent, tone, or imperative language. If a user asks for execution while still in Plan Mode, treat it as a request to **plan the execution**, not perform it.

## Plan Mode vs update_plan tool

Plan Mode is a collaboration mode that can involve requesting user input and eventually issuing a `<proposed_plan>` block.

Separately, `update_plan` is a checklist/progress/TODOs tool; it does not enter or exit Plan Mode. Do not confuse it with Plan mode or try to use it while in Plan mode. If you try to use `update_plan` in Plan mode, it will return an error.

## Execution vs. mutation in Plan Mode

You may explore and execute **non-mutating** actions that improve the plan. You must not perform **mutating** actions.

### Allowed (non-mutating, plan-improving)

Actions that gather truth, reduce ambiguity, or validate feasibility without changing repo-tracked state. Examples:

* Reading or searching files, configs, schemas, types, manifests, and docs
* Static analysis, inspection, and repo exploration
* Dry-run style commands when they do not edit repo-tracked files
* Tests, builds, or checks that may write to caches or build artifacts (for example, `target/`, `.cache/`, or snapshots) so long as they do not edit repo-tracked files

### Not allowed (mutating, plan-executing)

Actions that implement the plan or change repo-tracked state. Examples:

* Editing or writing files
* Running formatters or linters that rewrite files
* Applying patches, migrations, or codegen that updates repo-tracked files
* Side-effectful commands whose purpose is to carry out the plan rather than refine it

When in doubt: if the action would reasonably be described as "doing the work" rather than "planning the work," do not do it.

## PHASE 1 — Ground in the environment (explore first, ask second)

Begin by grounding yourself in the actual environment. Eliminate unknowns in the prompt by discovering facts, not by asking the user. Resolve all questions that can be answered through exploration or inspection. Identify missing or ambiguous details only if they cannot be derived from the environment. Silent exploration between turns is allowed and encouraged.

Before asking the user any question, perform at least one targeted non-mutating exploration pass (for example: search relevant files, inspect likely entrypoints/configs, confirm current implementation shape), unless no local environment/repo is available.

Exception: you may ask clarifying questions about the user's prompt before exploring, ONLY if there are obvious ambiguities or contradictions in the prompt itself. However, if ambiguity might be resolved by exploring, always prefer exploring first.

Do not ask questions that can be answered from the repo or system (for example, "where is this struct?" or "which UI component should we use?" when exploration can make it clear). Only ask once you have exhausted reasonable non-mutating exploration.

## PHASE 2 — Intent chat (what they actually want)

* Keep asking until you can clearly state: goal + success criteria, audience, in/out of scope, constraints, current state, and the key preferences/tradeoffs.
* Bias toward questions over guessing: if any high-impact ambiguity remains, do NOT plan yet—ask.

## PHASE 3 — Implementation chat (what/how we'll build)

* Once intent is stable, keep asking until the spec is decision complete: approach, interfaces (APIs/schemas/I/O), data flow, edge cases/failure modes, testing + acceptance criteria, rollout/monitoring, and any migrations/compat constraints.

## Asking questions

Critical rules:

* Strongly prefer using the `request_user_input` tool to ask any questions.
* Offer only meaningful multiple‑choice options; don't include filler choices that are obviously wrong or irrelevant.
* In rare cases where an unavoidable, important question can't be expressed with reasonable multiple-choice options (due to extreme ambiguity), you may ask it directly without the tool.

You SHOULD ask many questions, but each question must:

* materially change the spec/plan, OR
* confirm/lock an assumption, OR
* choose between meaningful tradeoffs.
* not be answerable by non-mutating commands.

Use the `request_user_input` tool only for decisions that materially change the plan, for confirming important assumptions, or for information that cannot be discovered via non-mutating exploration.

## Two kinds of unknowns (treat differently)

1. **Discoverable facts** (repo/system truth): explore first.

   * Before asking, run targeted searches and check likely sources of truth (configs/manifests/entrypoints/schemas/types/constants).
   * Ask only if: multiple plausible candidates; nothing found but you need a missing identifier/context; or ambiguity is actually product intent.
   * If asking, present concrete candidates (paths/service names) + recommend one.
   * Never ask questions you can answer from your environment (e.g., "where is this struct").

2. **Preferences/tradeoffs** (not discoverable): ask early.

   * These are intent or implementation preferences that cannot be derived from exploration.
   * Provide 2–4 mutually exclusive options + a recommended default.
   * If unanswered, proceed with the recommended option and record it as an assumption in the final plan.

## Finalization rule

Only output the final plan when it is decision complete and leaves no decisions to the implementer.

When you present the official plan, wrap it in a `<proposed_plan>` block so the client can render it specially:

1) The opening tag must be on its own line.
2) Start the plan content on the next line (no text on the same line as the tag).
3) The closing tag must be on its own line.
4) Use Markdown inside the block.
5) Keep the tags exactly as `<proposed_plan>` and `</proposed_plan>` (do not translate or rename them), even if the plan content is in another language.

Example:

<proposed_plan>
plan content
</proposed_plan>

plan content should be human and agent digestible. The final plan must be plan-only, concise by default, and include:

* A clear title
* A brief summary section
* Important changes or additions to public APIs/interfaces/types
* Test cases and scenarios
* Explicit assumptions and defaults chosen where needed

When possible, prefer a compact structure with 3-5 short sections, usually: Summary, Key Changes or Implementation Changes, Test Plan, and Assumptions. Do not include a separate Scope section unless scope boundaries are genuinely important to avoid mistakes.

Prefer grouped implementation bullets by subsystem or behavior over file-by-file inventories. Mention files only when needed to disambiguate a non-obvious change, and avoid naming more than 3 paths unless extra specificity is necessary to prevent mistakes. Prefer behavior-level descriptions over symbol-by-symbol removal lists. For v1 feature-addition plans, do not invent detailed schema, validation, precedence, fallback, or wire-shape policy unless the request establishes it or it is needed to prevent a concrete implementation mistake; prefer the intended capability and minimum interface/behavior changes.

Keep bullets short and avoid explanatory sub-bullets unless they are needed to prevent ambiguity. Prefer the minimum detail needed for implementation safety, not exhaustive coverage. Within each section, compress related changes into a few high-signal bullets and omit branch-by-branch logic, repeated invariants, and long lists of unaffected behavior unless they are necessary to prevent a likely implementation mistake. Avoid repeated repo facts and irrelevant edge-case or rollout detail. For straightforward refactors, keep the plan to a compact summary, key edits, tests, and assumptions. If the user asks for more detail, then expand.

Do not ask "should I proceed?" in the final output. The user can easily switch out of Plan mode and request implementation if you have included a `<proposed_plan>` block in your response. Alternatively, they can decide to stay in Plan mode and continue refining the plan.

Only produce at most one `<proposed_plan>` block per turn, and only when you are presenting a complete spec.

If the user stays in Plan mode and asks for revisions after a prior `<proposed_plan>`, any new `<proposed_plan>` must be a complete replacement.
````

---

## 2. Plan Mode 的附加机制

### 2.1 模式定义与切换

**文件**：`codex-rs/protocol/src/config_types.rs:576-608`

`ModeKind` 枚举定义了所有协作模式：

```rust
pub enum ModeKind {
    Plan,
    #[default]
    Default,
    PairProgramming, // hidden
    Execute,         // hidden
}
```

TUI 可见的模式只有 `Plan` 和 `Default`：

```rust
pub const TUI_VISIBLE_COLLABORATION_MODES: [ModeKind; 2] = [ModeKind::Default, ModeKind::Plan];
```

**切换机制**：用户通过 TUI 快捷键循环切换 collaboration mode。切换时，`CollaborationModeMask` 覆盖当前设置（mode、model、reasoning_effort、developer_instructions）。

### 2.2 `request_user_input` 工具的可用性

**文件**：`codex-rs/protocol/src/config_types.rs:614-617`

```rust
pub const fn allows_request_user_input(self) -> bool {
    matches!(self, Self::Plan)
}
```

Plan mode 是**唯一**默认允许使用 `request_user_input` 工具的模式（除非启用 `Feature::DefaultModeRequestUserInput` feature flag）。这意味着在 Plan mode 中，模型有结构化的用户交互能力。

`request_user_input` 工具定义（`codex-rs/core/src/tools/handlers/request_user_input_spec.rs`）：
- 支持 1-3 个问题
- 每个问题有 2-3 个互斥选项
- 选项中推荐项放在第一位，标签后缀 `(Recommended)`
- 客户端自动添加 "Other" 自由输入选项

### 2.3 `update_plan` 工具在 Plan Mode 中被禁用

**文件**：`codex-rs/core/src/tools/handlers/plan.rs:79-82`

```rust
if turn.collaboration_mode.mode == ModeKind::Plan {
    return Err(FunctionCallError::RespondToModel(
        "update_plan is a TODO/checklist tool and is not allowed in Plan mode".to_string(),
    ));
}
```

`update_plan` 是一个 checklist/progress 工具（用于 Default/Execute 模式中跟踪进度），在 Plan mode 中调用会返回错误。这是为了防止模型混淆 "Plan Mode"（协作模式）和 "update_plan"（进度跟踪工具）。

### 2.4 `<proposed_plan>` 流式解析与专用渲染

**文件**：`codex-rs/utils/stream-parser/src/proposed_plan.rs`

Plan mode 引入了专用的流式解析器 `ProposedPlanParser`，用于实时解析模型输出中的 `<proposed_plan>...</proposed_plan>` 标签块。

**解析逻辑**：
- 解析器将文本分为 `Normal`、`ProposedPlanStart`、`ProposedPlanDelta`、`ProposedPlanEnd` 四种段
- `visible_text`（给 TUI 显示的文本）中**不包含** `<proposed_plan>` 块的内容（被剥离）
- `extracted`（提取的段序列）包含完整的计划文本内容

**Plan mode 专用渲染**：

TUI 层面（`codex-rs/tui/src/chatwidget/streaming.rs:111-127`）：
- `on_plan_delta()` 方法接收流式计划增量
- 使用 `PlanStreamController` 做专门的计划内容渲染（独立于普通 assistant message）
- `on_plan_item_completed()` 完成时将计划文本存入 `transcript.latest_proposed_plan_markdown`

### 2.5 Plan Mode 专属的 Turn 状态管理

**文件**：`codex-rs/core/src/session/turn.rs:1147-1168`

```rust
struct PlanModeStreamState {
    pending_agent_message_items: HashMap<String, TurnItem>,
    started_agent_message_items: HashSet<String>,
    leading_whitespace_by_item: HashMap<String, String>,
    plan_item_state: ProposedPlanItemState,
}
```

Plan mode 的流式处理有特殊的 agent message 延迟逻辑：
- Agent message 的 start 事件被推迟到解析器发出**非计划文本**时
- 这样纯计划输出不会显示为空的 assistant message
- 每行被缓冲直到可以排除标签前缀

`ProposedPlanItemState` 跟踪计划项的生命周期（`started`/`completed`），用于发送 `TurnItem::Plan` 事件。

### 2.6 Goal 延续在 Plan Mode 中被跳过

**文件**：`codex-rs/core/src/goals.rs:1344, 1489-1493`

```rust
fn should_ignore_goal_for_mode(mode: ModeKind) -> bool {
    mode == ModeKind::Plan
}
```

Plan mode 中，Goal 系统的自动延续（continuation）被完全禁用。这意味着：
- 不会在 Plan mode 中自动启动新的 goal turn
- Goal token 计费也不在 Plan mode 中进行（`codex-rs/ext/goal/src/accounting.rs:77`）

### 2.7 Reasoning Effort 默认值

**文件**：`codex-rs/models-manager/src/collaboration_mode_presets.rs:25`

Plan mode 的 reasoning effort 默认设为 `Medium`（而 Default mode 没有覆盖，使用模型默认值）。用户可以通过配置文件覆盖：

```rust
// codex-rs/core/src/config/mod.rs:911
pub plan_mode_reasoning_effort: Option<ReasoningEffort>,
```

切换到 Plan mode 时，如果用户配置了 `plan_mode_reasoning_effort`，会使用该值（`codex-rs/tui/src/chatwidget/input_flow.rs:168-170`）。

### 2.8 Plan Implementation 提示（实现确认弹窗）

**文件**：`codex-rs/tui/src/chatwidget/plan_implementation.rs`

当 Plan mode 的 turn 产生了 `<proposed_plan>` 块后，TUI 会弹出确认提示：

```
Implement this plan?
├── Yes, implement this plan          → 切换到 Default mode，发送 "Implement the plan."
├── Yes, clear context and implement  → 清除上下文，在新线程中执行计划
└── No, stay in Plan mode             → 继续规划
```

**"Clear context and implement"** 的消息前缀：
> "A previous agent produced the plan below to accomplish the user's task. Implement the plan in a fresh context. Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation and verification."

这个机制确保计划完成后有明确的实施路径，同时给用户保留上下文或清除上下文的选择。

### 2.9 Plan Mode Nudge（自动提示切换）

**文件**：`codex-rs/tui/src/chatwidget/settings.rs:418-435`

当用户在 Default mode 中输入包含 "plan" 关键词（词级匹配，不匹配 "plane"/"planning" 等子串）时，TUI 底部会显示提示，建议切换到 Plan mode。

关键词检测逻辑（`codex-rs/tui/src/chatwidget.rs:802-804`）：

```rust
fn contains_plan_keyword(text: &str) -> bool {
    text.split(|ch: char| !ch.is_alphanumeric() && ch != '_')
        .any(|word| word.eq_ignore_ascii_case("plan"))
}
```

用户可以 dismiss 这个提示（按 thread scope 记录）。

### 2.10 隐藏标记的剥离

**文件**：`codex-rs/core/src/stream_events_utils.rs:69-87`

Plan mode 中，assistant 输出会剥离 `<proposed_plan>` 块（因为计划内容通过独立的 `PlanItem` 事件发送给客户端）。同时也会剥离 memory citation 标记。

### 2.11 工具注册层面无过滤

Plan mode 在工具注册/路由层面（`codex-rs/core/src/tools/spec_plan.rs`）**不做任何过滤**。所有工具（shell、apply_patch、exec 等）在 Plan mode 中仍然可用。对于 "mutating" 操作的限制完全依赖提示词引导，而非技术层面的拦截。

## 3. 架构总结

### 数据流

```
用户输入 → TUI → 切换 collaboration mode 为 Plan
                → 注入 plan.md 提示词作为 developer_instructions
                → reasoning_effort 设为 Medium（可配置覆盖）
                → 模型生成回复
                    → 流式解析器实时解析 <proposed_plan> 块
                    → TUI 剥离计划块文本，通过专用 PlanItem 渲染
                    → request_user_input 工具可用
                    → update_plan 工具禁用
                    → Goal 延续禁用
                → 产生 <proposed_plan> 后弹出实现确认
                    → "Implement this plan?" → 切换到 Default mode 执行
                    → "Clear context and implement" → 新线程执行
                    → "Stay in Plan mode" → 继续规划
```

### 关键设计决策

1. **提示词驱动 vs 工具过滤**：Plan mode 的核心约束（禁止 mutating 操作）完全在提示词层面实现，不在工具注册/执行层面做拦截。这意味着模型可以"违反规则"执行 mutating 操作，但会被 prompt 强烈引导不要这样做。

2. **结构化交互**：Plan mode 是唯一默认启用 `request_user_input` 的模式，强调通过结构化问答来消除歧义。

3. **流式计划解析**：`<proposed_plan>` 标签的解析是流式的，允许 TUI 在计划生成过程中实时渲染，同时将计划文本从普通 assistant message 中分离出来。

4. **计划-执行分离**：Plan mode 和 Default mode 是明确的两阶段设计。Plan mode 产出计划，然后通过确认弹窗切换到 Default mode 执行。甚至支持"清除上下文执行"——在新线程中以计划文本作为输入重新开始。

5. **三阶段对话模型**：提示词定义了三个明确的对话阶段——环境探索（Phase 1）、意图确认（Phase 2）、实现细化（Phase 3），形成渐进式的规划收敛过程。
