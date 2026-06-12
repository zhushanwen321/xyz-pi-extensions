# Codex Tool Description 提示词分析

> 源码版本：codex-rs/core (codex-cli 开源仓库)
> 分析日期：2026-06-12
> 分析范围：所有 `*_spec.rs` 中的 tool description + 主 prompt 中的行为指令 + 独立模板文件

## 概览

按信息密度分类：

| 分类 | 字数范围 | Tool |
|------|---------|------|
| **精简型** | <50 字 | get_goal, exec_command, write_stdin, send_message, resume_agent, list_agents, report_agent_job_result, request_user_input, test_sync_tool, view_image, read_mcp_resource, apply_patch(spec) |
| **标准型** | 50-150 字 | create_goal, update_plan(spec), shell_command, spawn_agent_v2, send_input, followup_task, wait_agent(v1/v2), close_agent, spawn_agents_on_csv, request_plugin_install, list_available_plugins_to_install, tool_search, list_mcp_resources, list_mcp_resource_templates |
| **密集型** | >150 字 | **update_goal**(~250字), **spawn_agent_v1 with usage_hint**(~800字), **apply_patch(template)**(~800字), **update_plan(prompt指引)**(~400字) |

**规律**：需要精确约束"什么时候该用/不该用"的 tool 写了密集提示词，而"操作类"tool（执行命令、读写 stdin）多为精简型。

---

## 逐 Tool 分析

### Tool: get_goal

**description 原文**：
```
Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.
```

- **长度**: 25 字
- **结构**: 单句概述，纯功能描述
- **Anti-pattern**: 0 条
- **行为指令**: 无
- **亮点/特色**: 最简工具——只读查询，无需约束行为。列举了返回的具体信息项（status, budgets, token, elapsed-time），帮助模型判断何时调用。

---

### Tool: create_goal

**description 原文**：
```
Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.
Set token_budget only when an explicit token budget is requested. Fails if a goal exists; use update_goal only for status.
```

- **长度**: 47 字
- **结构**: 两句话，第一句是调用条件，第二句是参数约束 + 失败条件
- **Anti-pattern**: 2 条
  1. "do not infer goals from ordinary tasks" — 防止模型自行创建目标
  2. "Fails if a goal exists" — 前置告知失败条件
- **行为指令**: "use update_goal only for status" — 引导到正确工具
- **亮点/特色**: **前置约束模式**——在 description 中直接限制调用时机，而非只描述功能。这是 Codex 工具描述的核心设计哲学：description 不只是"说明书"，更是"行为约束"。

参数级提示词（`objective` 字段）：
```
Required. The concrete objective to start pursuing. This starts a new active goal only when no goal is currently defined; if a goal already exists, this tool fails.
```
注意参数描述重复了 description 中的约束——这种"关键约束在两层都说"的冗余是有意的。

---

### Tool: update_goal

**description 原文**：
```
Update the existing goal.
Use this tool only to mark the goal achieved or genuinely blocked.
Set status to `complete` only when the objective has actually been achieved and no required work remains.
Set status to `blocked` only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic continuations, and the agent cannot make meaningful progress without user input or an external-state change.
If the user resumes a goal that was previously marked `blocked`, treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least three consecutive resumed goal turns, set status to `blocked` again.
Once the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to `blocked`.
Do not use `blocked` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.
Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.
You cannot use this tool to pause, resume, budget-limit, or usage-limit a goal; those status changes are controlled by the user or system.
When marking a budgeted goal achieved with status `complete`, report the final token usage from the tool result to the user.
```

- **长度**: ~250 字
- **结构**:
  1. 概述（1句）
  2. 调用条件（1句）
  3. `complete` 的精确条件（1句）
  4. `blocked` 的精确条件（1句，含数字阈值"at least three consecutive"）
  5. 恢复后的行为规则（1句）
  6. 阻塞后的收尾动作（1句）
  7. **反模式**（5条"Do not"）
  8. 能力边界声明（1句"You cannot..."）
  9. 完成后的后续动作（1句）
- **Anti-pattern**: 5 条
  1. "Do not use `blocked` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification" — 精确枚举误用场景
  2. "Do not mark a goal complete merely because its budget is nearly exhausted" — 防止 budget-hack
  3. "Do not mark a goal complete merely because you are stopping work" — 防止偷懒
  4. "Do not keep reporting that you are still blocked while leaving the goal active" — 防止空转
  5. 能力边界："You cannot use this tool to pause, resume, budget-limit, or usage-limit a goal" — 明确告知哪些操作不属于此 tool
- **行为指令**: 精确的状态转换规则——`blocked` 需要 "three consecutive goal turns"，恢复后重新计数
- **亮点/特色**:
  1. **数字阈值量化**——"at least three consecutive" 不是模糊的"多次"，而是精确数字
  2. **反模式列表式展开**——每条反模式都给出具体的误用场景（hard/slow/uncertain/incomplete）
  3. **能力边界声明**——"You cannot" 句式明确告知 tool 不支持的操作
  4. **完成后的交互动作**——"report the final token usage to the user" 把 tool response 和用户交互绑定

参数级提示词（`status` 字段）：
```
Required. Set to `complete` only when the objective is achieved and no required work remains. Set to `blocked` only after the same blocking condition has recurred for at least three consecutive goal turns and the agent is at an impasse. After a previously blocked goal is resumed, the resumed run starts a fresh blocked audit.
```
参数描述与 description 高度重叠——再次体现"关键约束双层冗余"策略。

---

### Tool: update_plan

**description 原文（spec）**：
```
Updates the task plan.
Provide an optional explanation and a list of plan items, each with a step and status.
At most one step can be in_progress at a time.
```

- **长度**: 30 字（spec 中）
- **结构**: 三句：概述 + 参数说明 + 状态约束
- **Anti-pattern**: 0 条
- **行为指令**: "At most one step can be in_progress at a time" — 状态机约束
- **亮点/特色**: spec 中极简，但主 prompt 中有大量补充指引（见下方）。这体现了 **"spec + prompt 双层"** 设计模式：spec 中只放最核心的约束，复杂的行为指引放在 system prompt 中。

**主 prompt 中的补充指引**（`gpt_5_2_prompt.md` 的 Planning 章节）：

```
You have access to an `update_plan` tool which tracks steps and progress and renders them to the user. Using the tool helps demonstrate that you've understood the task and convey how you're approaching it. Plans can help to make complex, ambiguous, or multi-phase work clearer and more collaborative for the user. A good plan should break the task into meaningful, logically ordered steps that are easy to verify as you go.

Note that plans are not for padding out simple work with filler steps or stating the obvious. The content of your plan should not involve doing anything that you aren't capable of doing (i.e. don't try to test things that you can't test). Do not use plans for simple or single-step queries that you can just do or answer immediately.

Do not repeat the full contents of the plan after an `update_plan` call — the harness already displays it. Instead, summarize the change made and highlight any important context or next step.

Before running a command, consider whether or not you have completed the previous step, and make sure to mark it as completed before moving on to the next step. It may be the case that you complete all steps in your plan after a single pass of implementation. If this is the case, you can simply mark the planned steps as completed. Sometimes, you may need to change plans in the middle of a task: call `update_plan` with the updated plan and make sure to provide an `explanation` of the rationale when doing so.

Maintain statuses in the tool: exactly one item in_progress at a time; mark items complete when done; post timely status transitions. Do not jump an item from pending to completed: always set it to in_progress first. Do not batch-complete multiple items after the fact. Finish with all items completed or explicitly canceled/deferred before ending the turn. Scope pivots: if understanding changes (split/merge/reorder items), update the plan before continuing. Do not let the plan go stale while coding.

Use a plan when:
- The task is non-trivial and will require multiple actions over a long time horizon.
- There are logical phases or dependencies where sequencing matters.
- The work has ambiguity that benefits from outlining high-level goals.
- You want intermediate checkpoints for feedback and validation.
- When the user asked you to do more than one thing in a single prompt
- The user has asked you to use the plan tool (aka "TODOs")
- You generate additional steps while working, and plan to do them before yielding to the user
```

以及 `update_plan` 工具指南章节：
```
A tool named `update_plan` is available to you. You can use it to keep an up‑to‑date, step‑by‑step plan for the task.

To create a new plan, call `update_plan` with a short list of 1‑sentence steps (no more than 5-7 words each) with a `status` for each step (`pending`, `in_progress`, or `completed`).

When steps have been completed, use `update_plan` to mark each finished step as `completed` and the next step you are working on as `in_progress`. There should always be exactly one `in_progress` step until everything is done. You can mark multiple items as complete in a single `update_plan` call.

If all steps are complete, ensure you call `update_plan` to mark all steps as `completed`.
```

- **prompt 中的 Anti-pattern**: 7+ 条
  1. "plans are not for padding out simple work with filler steps or stating the obvious"
  2. "Do not use plans for simple or single-step queries"
  3. "Do not repeat the full contents of the plan after an update_plan call"
  4. "Do not jump an item from pending to completed: always set it to in_progress first"
  5. "Do not batch-complete multiple items after the fact"
  6. "Do not let the plan go stale while coding"
  7. 正面/负面示例：提供 3 组 High-quality plans vs Low-quality plans 的对比
- **亮点/特色**:
  1. **正反面示例对比**——唯一的 tool 提供了高质量/低质量 plan 的具体示例
  2. **状态转换精确约束**——"exactly one item in_progress at a time"，"Do not jump from pending to completed"
  3. **分层冗余**——同一约束在 Planning 章节和 Tool Guidelines 章节各说一次

---

### Tool: exec_command

**description 原文**：
```
Runs a command in a PTY, returning output or a session ID for ongoing interaction.
```

- **长度**: 15 字
- **结构**: 单句，功能 + 返回值
- **Anti-pattern**: 0 条
- **行为指令**: 无
- **亮点/特色**: 纯操作类 tool，不需要行为约束。返回值说明"session ID for ongoing interaction"暗示了与 write_stdin 的配合关系。

Windows 版本额外附加了 `windows_shell_guidance()`，包含 3 条安全规则（跨 shell 破坏性命令、递归删除验证、后台进程窗口隐藏）。

---

### Tool: write_stdin

**description 原文**：
```
Writes characters to an existing unified exec session and returns recent output.
```

- **长度**: 14 字
- **结构**: 单句
- **Anti-pattern**: 0 条
- **行为指令**: 无
- **亮点/特色**: 与 exec_command 配对使用的工具，description 通过 "existing unified exec session" 暗示了前置条件。

---

### Tool: shell_command

**description 原文（Unix）**：
```
Runs a shell command and returns its output.
- Always set the `workdir` param when using the shell_command function. Do not use `cd` unless absolutely necessary.
```

**description 原文（Windows）**：
```
Runs a Powershell command (Windows) and returns its output.

Examples of valid command strings:

- ls -a (show hidden): "Get-ChildItem -Force"
- recursive find by name: "Get-ChildItem -Recurse -Filter *.py"
- recursive grep: "Get-ChildItem -Path C:\\myrepo -Recurse | Select-String -Pattern 'TODO' -CaseSensitive"
- ps aux | grep python: "Get-Process | Where-Object { $_.ProcessName -like '*python*' }"
- setting an env var: "$env:FOO='bar'; echo $env:FOO"
- running an inline Python script: "@'\nprint('Hello, world!')\n'@ | python -"
```

- **长度**: Unix ~30 字, Windows ~120 字
- **结构**: Unix 版单句 + 1 条行为指令；Windows 版包含 6 个示例
- **Anti-pattern**: 1 条 — "Do not use `cd` unless absolutely necessary"
- **行为指令**: "Always set the `workdir` param" — 强制使用参数而非 cd
- **亮点/特色**:
  1. **平台差异化**——Windows 版本增加了大量示例，因为 PowerShell 语法与 Unix shell 差异大
  2. **示例驱动**——Windows 版用 6 个具体的"Unix 命令 → PowerShell 等价物"对照来减少误用

---

### Tool: apply_patch

**spec 中的 description**：
```
Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.
```

- **长度**: 20 字（spec 中）
- **结构**: 单句 + 格式说明
- **Anti-pattern**: 1 条 — "do not wrap the patch in JSON" — 防止模型把 freeform tool 当成 function call

**主 prompt 中的完整指引**（`prompt_with_apply_patch_instructions.md` + `apply_patch_tool_instructions.md`）：

完整的 apply_patch 指引约 800 字，包含：
1. 格式规范（Begin/End Patch 包络、三种操作头：Add/Delete/Update）
2. Hunk 语法（@@ 标记、+/- 行前缀）
3. Context 规则（默认 3 行、不足时用 @@ 标识、重复代码块用多层 @@）
4. 完整 BNF 语法定义
5. 3 个完整示例
6. 3 条重要规则（必须有操作头、新建文件也要 + 前缀、只能用相对路径）
7. 调用示例

**Anti-pattern**: 3 条
1. "do not wrap the patch in JSON" — 格式错误
2. "File references can only be relative, NEVER ABSOLUTE" — 路径约束
3. "NEVER try `applypatch` or `apply-patch`, only `apply_patch`" — 名称防错（在主 prompt 中）

- **亮点/特色**:
  1. **Freeform tool + Lark 语法**——apply_patch 是唯一使用 grammar-based freeform tool 的，通过 Lark 语法定义严格约束输出格式
  2. **三文件冗余**——同一份指引出现在 3 个位置：spec 中、`prompt_with_apply_patch_instructions.md`、`prompts/templates/apply_patch_tool_instructions.md`
  3. **BNF 语法定义**——用形式化语法而非自然语言描述格式，消除歧义

---

### Tool: spawn_agent (v1 with usage_hint)

**description 原文**（完整版，启用 usage_hint 时）：

```
Spawn a sub-agent for a well-scoped task. Returns the spawned agent id plus the user-facing nickname when available. Spawned agents inherit your current model by default. Omit `model` to use that preferred default; set `model` only when an explicit override is needed.

This spawn_agent tool provides you access to sub-agents that inherit your current model by default. Do not set the `model` field unless the user explicitly asks for a different model or there is a clear task-specific reason. You should follow the rules and guidelines below to use this tool.

Only use `spawn_agent` if and only if the user explicitly asks for sub-agents, delegation, or parallel agent work.
Requests for depth, thoroughness, research, investigation, or detailed codebase analysis do not count as permission to spawn.

### When to delegate vs. do the subtask yourself
- First, quickly analyze the overall user task and form a succinct high-level plan. Identify which tasks are immediate blockers on the critical path, and which tasks are sidecar tasks that are needed but can run in parallel without blocking the next local step. As part of that plan, explicitly decide what immediate task you should do locally right now. Do this planning step before delegating to agents so you do not hand off the immediate blocking task to a submodel and then waste time waiting on it.
- Use a subagent when a subtask is easy enough for it to handle and can run in parallel with your local work. Prefer delegating concrete, bounded sidecar tasks that materially advance the main task without blocking your immediate next local step.
- Do not delegate urgent blocking work when your immediate next step depends on that result. If the very next action is blocked on that task, the main rollout should usually do it locally to keep the critical path moving.
- Keep work local when the subtask is too difficult to delegate well and when it is tightly coupled, urgent, or likely to block your immediate next step.

### Designing delegated subtasks
- Subtasks must be concrete, well-defined, and self-contained.
- Delegated subtasks must materially advance the main task.
- Do not duplicate work between the main rollout and delegated subtasks.
- Avoid issuing multiple delegate calls on the same unresolved thread unless the new delegated task is genuinely different and necessary.
- Narrow the delegated ask to the concrete output you need next.
- For coding tasks, prefer delegating concrete code-change worker subtasks over read-only explorer analysis when the subagent can make a bounded patch in a clear write scope.
- When delegating coding work, instruct the submodel to edit files directly in its forked workspace and list the file paths it changed in the final answer.
- For code-edit subtasks, decompose work so each delegated task has a disjoint write set.

### After you delegate
- Call wait_agent very sparingly. Only call wait_agent when you need the result immediately for the next critical-path step and you are blocked until it returns.
- Do not redo delegated subagent tasks yourself; focus on integrating results or tackling non-overlapping work.
- While the subagent is running in the background, do meaningful non-overlapping work immediately.
- Do not repeatedly wait by reflex.
- When a delegated coding task returns, quickly review the uploaded changes, then integrate or refine them.

### Parallel delegation patterns
- Run multiple independent information-seeking subtasks in parallel when you have distinct questions that can be answered independently.
- Split implementation into disjoint codebase slices and spawn multiple agents for them in parallel when the write scopes do not overlap.
- Delegate verification only when it can run in parallel with ongoing implementation and is likely to catch a concrete risk before final integration.
- The key is to find opportunities to spawn multiple independent subtasks in parallel within the same round, while ensuring each subtask is well-defined, self-contained, and materially advances the main task.
```

- **长度**: ~800 字（启用 usage_hint 时）
- **结构**: 4 大章节（When to delegate / Designing subtasks / After you delegate / Parallel patterns），每个章节下 3-7 条 bullet points
- **Anti-pattern**: ~12 条
  1. "Do not set the `model` field unless the user explicitly asks" — 参数约束
  2. "Only use `spawn_agent` if and only if the user explicitly asks" — 调用条件
  3. "Requests for depth, thoroughness, research... do not count as permission to spawn" — 精确排除误判场景
  4. "Do not delegate urgent blocking work when your immediate next step depends on that result" — 关键路径约束
  5. "Keep work local when the subtask is too difficult to delegate well" — 能力边界
  6. "Do not duplicate work between the main rollout and delegated subtasks" — 防重
  7. "Avoid issuing multiple delegate calls on the same unresolved thread" — 防重复委派
  8. "Call wait_agent very sparingly" — 防轮询
  9. "Do not redo delegated subagent tasks yourself" — 防替代
  10. "Do not repeatedly wait by reflex" — 防忙等
  11. "prefer delegating concrete code-change worker subtasks over read-only explorer analysis" — 行为偏好
  12. "decompose work so each delegated task has a disjoint write set" — 并发安全
- **行为指令**: 非常密集——包含决策树（delegate vs local）、后续动作（review + integrate）、并行模式
- **亮点/特色**:
  1. **最密集的 tool description**——800 字，包含完整的子 agent 编排指南
  2. **决策框架**——"When to delegate vs. do the subtask yourself" 不是简单规则，而是决策树
  3. **生命周期式结构**——按时间线组织：delegate 前（规划）→ 设计 → delegate 后（等待 + 集成）→ 并行模式
  4. **关键路径概念**——引入 "critical path" 概念，让模型理解任务依赖关系

---

### Tool: spawn_agent (v2)

**description 原文**（简化版，无 usage_hint）：

```
Spawns an agent to work on the specified task. If your current task is `/root/task1` and you spawn_agent with task_name "task_3" the agent will have canonical task name `/root/task1/task_3`.
You are then able to refer to this agent as `task_3` or `/root/task1/task_3` interchangeably. However an agent `/root/task2/task_3` would only be able to communicate with this agent via its canonical name `/root/task1/task_3`.
The spawned agent will have the same tools as you and the ability to spawn its own subagents.
Spawned agents inherit your current model by default. Omit `model` to use that preferred default; set `model` only when an explicit override is needed.
It will be able to send you and other running agents messages, and its final answer will be provided to you when it finishes.
The new agent's canonical task name will be provided to it along with the message.
```

- **长度**: ~100 字
- **结构**: 概述 + 命名空间说明 + 能力声明 + 继承规则 + 通信机制
- **Anti-pattern**: 0 条（v2 版本移除了 usage_hint 中的密集指引）
- **行为指令**: 无
- **亮点/特色**:
  1. **路径命名系统**——用 `/root/task1/task_3` 的路径命名来区分 agent，比 v1 的 agent_id 更直观
  2. **与 v1 的设计取舍**——v2 把密集的行为指引移到了别处（可能在 orchestrator prompt 中），description 只保留 API 语义

---

### Tool: send_input (v1)

**description 原文**：
```
Send a message to an existing agent. Use interrupt=true to redirect work immediately. You should reuse the agent by send_input if you believe your assigned task is highly dependent on the context of a previous task.
```

- **长度**: 40 字
- **结构**: 功能 + 用法建议
- **Anti-pattern**: 0 条
- **行为指令**: "You should reuse the agent by send_input if you believe your assigned task is highly dependent on the context of a previous task" — 引导复用而非新建
- **亮点/特色**: 通过"context dependency"来引导模型做 spawn vs send_input 的决策

---

### Tool: send_message

**description 原文**：
```
Send a message to an existing agent. The message will be delivered promptly. Does not trigger a new turn.
```

- **长度**: 20 字
- **结构**: 功能 + 时序特性 + 行为边界
- **Anti-pattern**: 0 条
- **行为指令**: "Does not trigger a new turn" — 关键语义约束，区分 send_message 和 followup_task
- **亮点/特色**: 一句话区分了两个容易混淆的 tool

---

### Tool: followup_task

**description 原文**：
```
Send a follow-up task to an existing non-root target agent and trigger a turn in that target. If the target is currently mid-turn, the message is queued and will be used to start the target's next turn, after the current turn completes.
```

- **长度**: 45 字
- **结构**: 功能 + 边界条件（non-root）+ 行为语义（触发 turn）+ 队列语义
- **Anti-pattern**: 0 条
- **行为指令**: "trigger a turn in that target" vs send_message 的 "Does not trigger a new turn" — 精确区分
- **亮点/特色**: 边界条件 "non-root target agent" 防止对 root agent 误用

---

### Tool: resume_agent

**description 原文**：
```
Resume a previously closed agent by id so it can receive send_input and wait_agent calls.
```

- **长度**: 18 字
- **结构**: 功能 + 目的说明
- **Anti-pattern**: 0 条
- **行为指令**: 无
- **亮点/特色**: 通过 "so it can receive" 暗示了 resume 后的操作空间

---

### Tool: wait_agent (v1)

**description 原文**：
```
Wait for agents to reach a final status. Completed statuses may include the agent's final message. Returns empty status when timed out. Once the agent reaches a final status, a notification message will be received containing the same completed status.
```

- **长度**: 45 字
- **结构**: 功能 + 返回值说明 + 超时行为 + 通知机制
- **Anti-pattern**: 0 条
- **行为指令**: 无
- **亮点/特色**: 解释了超时后的行为（"Returns empty status when timed out"）和通知机制

---

### Tool: wait_agent (v2)

**description 原文**：
```
Wait for a mailbox update from any live agent, including queued messages and final-status notifications. Does not return the content; returns either a summary of which agents have updates (if any), or a timeout summary if no mailbox update arrives before the deadline.
```

- **长度**: 48 字
- **结构**: 功能 + 两种返回场景
- **Anti-pattern**: 1 条 — "Does not return the content" — 降低期望
- **行为指令**: 无
- **亮点/特色**: v2 的邮箱模型比 v1 的阻塞等待更灵活

---

### Tool: list_agents

**description 原文**：
```
List live agents in the current root thread tree. Optionally filter by task-path prefix.
```

- **长度**: 16 字
- **结构**: 功能 + 可选参数
- **Anti-pattern**: 0 条
- **行为指令**: 无
- **亮点/特色**: 简洁。"root thread tree" 限定了范围

---

### Tool: close_agent (v1 & v2)

**description 原文**：
```
Close an agent and any open descendants when they are no longer needed, and return the target agent's previous status before shutdown was requested. Don't keep agents open for too long if they are not needed anymore.
```

- **长度**: 42 字
- **结构**: 功能 + 级联行为（descendants）+ 返回值 + 资源管理建议
- **Anti-pattern**: 1 条 — "Don't keep agents open for too long if they are not needed anymore"
- **行为指令**: "Don't keep agents open for too long" — 资源管理约束
- **亮点/特色**: 级联关闭（"and any open descendants"）的行为在 description 中明确声明

---

### Tool: spawn_agents_on_csv

**description 原文**：
```
Process a CSV by spawning one worker sub-agent per row. The instruction string is a template where `{column}` placeholders are replaced with row values. Each worker must call `report_agent_job_result` with a JSON object (matching `output_schema` when provided); missing reports are treated as failures. This call blocks until all rows finish and automatically exports results to `output_csv_path` (or a default path).
```

- **长度**: 80 字
- **结构**: 功能 + 模板语法 + worker 义务 + 失败条件 + 阻塞语义 + 输出行为
- **Anti-pattern**: 1 条 — "missing reports are treated as failures" — 隐含的行为约束
- **行为指令**: worker 必须调用 report_agent_job_result —— 这是 worker 侧的行为约束，嵌入在 coordinator 侧的 description 中
- **亮点/特色**:
  1. **跨 agent 行为约束**——coordinator 的 description 中定义了 worker 的义务
  2. **模板语法说明**——`{column}` 占位符用法

---

### Tool: report_agent_job_result

**description 原文**：
```
Worker-only tool to report a result for an agent job item. Main agents should not call this.
```

- **长度**: 18 字
- **结构**: 使用者限定 + 功能 + 排除规则
- **Anti-pattern**: 1 条 — "Main agents should not call this" — 明确排除
- **行为指令**: 角色约束——只有 worker 可用
- **亮点/特色**: 一句话同时定义了目标用户和排除用户

---

### Tool: request_user_input

**description 原文**（动态生成）：
```
Request user input for one to three short questions and wait for the response. This tool is only available in {allowed_modes} mode.
```

- **长度**: 25 字
- **结构**: 功能 + 可用性约束
- **Anti-pattern**: 0 条
- **行为指令**: "one to three short questions" — 数量约束
- **亮点/特色**: description 是**动态生成**的，根据当前 mode 填充 `{allowed_modes}`

参数级提示词中有更密集的约束：
- options 的 array description: "Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with '(Recommended)'. Do not include an 'Other' option in this list; the client will add a free-form 'Other' option automatically."
- questions 的 array description: "Questions to show the user. Prefer 1 and do not exceed 3"

---

### Tool: request_plugin_install

**description 原文**：
```
# Request plugin/connector install

Use this tool only after `list_available_plugins_to_install` returns a plugin or connector that exactly matches the user's explicit request.

Do not use it for adjacent capabilities, broad recommendations, or tools that merely seem useful. Pass the returned `tool_type` through directly, and pass the returned `id` as `tool_id`.

IMPORTANT: DO NOT call this tool in parallel with other tools.
```

- **长度**: 75 字
- **结构**: 标题 + 调用前置条件 + 反模式 + 并行约束
- **Anti-pattern**: 3 条
  1. "Do not use it for adjacent capabilities, broad recommendations, or tools that merely seem useful" — 精确排除"看起来有用但不是用户要的"
  2. "Do not call this tool in parallel with other tools" — 并行约束（全大写 IMPORTANT）
  3. "only after...returns" — 严格的时序依赖
- **行为指令**: "Pass the returned `tool_type` through directly" — 透传约束
- **亮点/特色**:
  1. **工具链约束**——描述了与 list_available_plugins_to_install 的依赖关系
  2. **IMPORTANT 大写强调**——并行约束用大写标记，说明这是高风险误操作

---

### Tool: list_available_plugins_to_install

**description 原文**：
```
# List plugin/connector install candidates

Use this tool only when both are true:
- The user explicitly asks to use a specific plugin or connector that is not already available in the current context or active `tools` list.
- `tool_search` is not available, or it has already been called and did not find or make the requested tool callable.

Returns known plugins and connectors that can be passed to `request_plugin_install`. When both a plugin and a connector match, prefer the plugin; use the connector only when its corresponding plugin is already installed.
```

- **长度**: 85 字
- **结构**: 标题 + 双条件 AND 门 + 返回值说明 + 优先级规则
- **Anti-pattern**: 0 条（但通过严格条件间接约束）
- **行为指令**:
  1. 双条件 AND——两个条件都满足才能调用
  2. "prefer the plugin; use the connector only when its corresponding plugin is already installed" — 优先级规则
- **亮点/特色**:
  1. **条件门控**——用"only when both are true"创建严格的调用条件
  2. **工具链编排**——与 tool_search 形成调用链：先 tool_search → 失败 → 才用此 tool
  3. **引用动态常量**——`{TOOL_SEARCH_TOOL_NAME}` 和 `{REQUEST_PLUGIN_INSTALL_TOOL_NAME}` 用运行时常量替换

---

### Tool: tool_search

**description 原文**（动态生成）：
```
# Tool discovery

Searches over deferred tool metadata with BM25 and exposes matching tools for the next model call.

You have access to tools from the following sources:
{source_descriptions}
Some of the tools may not have been provided to you upfront, and you should use this tool (`tool_search`) to search for the required tools. For MCP tool discovery, always use `tool_search` instead of `list_mcp_resources` or `list_mcp_resource_templates`.
```

- **长度**: ~80 字（不含动态 source_descriptions）
- **结构**: 标题 + 技术说明 + 来源列表（动态）+ 行为约束
- **Anti-pattern**: 1 条 — "always use `tool_search` instead of `list_mcp_resources` or `list_mcp_resource_templates`" — 排斥替代方案
- **行为指令**: "you should use this tool to search for the required tools" — 引导主动搜索
- **亮点/特色**:
  1. **动态来源列表**——`{source_descriptions}` 根据实际配置生成
  2. **BM25 搜索说明**——技术细节直接写在 description 中
  3. **替代关系声明**——明确与 MCP resource tool 的优先级

---

### Tool: view_image

**description 原文**：
```
View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.
```

- **长度**: 22 字
- **结构**: 功能 + 适用场景
- **Anti-pattern**: 0 条
- **行为指令**: "Use this for images already available on disk" — 限定了使用场景（本地 vs URL）
- **亮点/特色**: 通过"already available on disk"排除了 URL 图片的场景

---

### Tool: list_mcp_resources

**description 原文**：
```
Lists resources provided by MCP servers. Resources allow servers to share data that provides context to language models, such as files, database schemas, or application-specific information. Prefer resources over web search when possible.
```

- **长度**: 38 字
- **结构**: 功能 + 概念解释 + 使用偏好
- **Anti-pattern**: 0 条
- **行为指令**: "Prefer resources over web search when possible" — 优先级引导
- **亮点/特色**: "Prefer...over..." 句式简洁地建立了优先级

---

### Tool: list_mcp_resource_templates

**description 原文**：
```
Lists resource templates provided by MCP servers. Parameterized resource templates allow servers to share data that takes parameters and provides context to language models, such as files, database schemas, or application-specific information. Prefer resource templates over web search when possible.
```

- **长度**: 42 字
- **结构**: 功能 + 概念解释（比 list_mcp_resources 多了"Parameterized"）+ 使用偏好
- **Anti-pattern**: 0 条
- **行为指令**: "Prefer resource templates over web search when possible" — 同上
- **亮点/特色**: 与 list_mcp_resources 几乎同构，通过"Parameterized"区分

---

### Tool: read_mcp_resource

**description 原文**：
```
Read a specific resource from an MCP server given the server name and resource URI.
```

- **长度**: 16 字
- **结构**: 纯功能描述
- **Anti-pattern**: 0 条
- **行为指令**: 无
- **亮点/特色**: 最简——参数名已经自解释

---

### Tool: test_sync_tool

**description 原文**：
```
Internal synchronization helper used by Codex integration tests.
```

- **长度**: 10 字
- **结构**: 一句话定位
- **Anti-pattern**: 0 条
- **行为指令**: 无
- **亮点/特色**: 内部测试工具，不面向用户

---

### Tool: request_permissions

**description 原文**：
```
Request additional filesystem or network permissions from the user and wait for the client to grant a subset of the requested permission profile. Granted permissions apply automatically to later shell-like commands in the current turn, or for the rest of the session if the client approves them at session scope.
```

- **长度**: 48 字
- **结构**: 功能 + 生命周期说明（turn scope vs session scope）
- **Anti-pattern**: 0 条
- **行为指令**: 区分了两种授权范围（turn vs session）
- **亮点/特色**: 权限生命周期说明——告诉模型权限何时过期

---

## 横向对比

### 密集提示词的 Tool（>150 字）

| Tool | 字数 | 为什么需要密集提示词 |
|------|------|---------------------|
| **update_goal** | ~250 | 状态转换是高风险操作——误标 complete/blocked 会直接影响用户的工作流。需要精确的"什么时候该用"规则 |
| **spawn_agent v1** | ~800 | 子 agent 编排是最复杂的行为——delegate vs local 的决策、并行模式、资源管理、等待策略。模型在这个 tool 上犯错的概率最高 |
| **apply_patch (template)** | ~800 | 自定义格式 tool——模型必须严格遵循语法，否则 patch 失败。用 BNF 语法 + 示例消除歧义 |
| **update_plan (prompt)** | ~400 | 状态转换规则 + 使用场景判断 + 正反面示例。plan tool 容易被滥用或忽略，需要明确的触发条件 |

### 精简提示词的 Tool（<50 字）

| Tool | 字数 | 为什么可以精简 |
|------|------|---------------|
| **get_goal** | 25 | 只读查询，无副作用 |
| **exec_command** | 15 | 操作类 tool，行为由参数决定 |
| **write_stdin** | 14 | 与 exec_command 配对，语义自明 |
| **view_image** | 22 | 操作单一，无需约束 |
| **test_sync_tool** | 10 | 内部工具，不面向用户 |

### 什么类型的 Tool 需要密集提示词

1. **有高风险副作用的 tool**（update_goal, apply_patch）——错误使用会破坏用户状态
2. **需要复杂决策的 tool**（spawn_agent）——模型需要决策框架而非简单规则
3. **有精确格式要求的 tool**（apply_patch）——格式错误直接导致失败
4. **容易被误用的 tool**（update_plan）——模型倾向于过度使用或使用不足

### 设计模式对比

| 模式 | 用于 | 示例 |
|------|------|------|
| **spec 精简 + prompt 密集** | 行为约束需要大段解释 | update_plan, apply_patch |
| **spec 密集** | 约束与 tool 紧密绑定 | update_goal |
| **动态 description** | 内容依赖运行时配置 | request_user_input, tool_search, spawn_agent |
| **模板 + 常量替换** | 引用其他 tool 名 | list_available_plugins, request_plugin_install |

---

## 写法模式总结

### 1. Description 结构模板

**精简型**（操作类/只读类）：
```
[动作] + [对象] + [返回值/副作用]
```
示例：`Runs a command in a PTY, returning output or a session ID for ongoing interaction.`

**标准型**（需要轻量约束）：
```
[动作] + [对象] + [条件/约束] + [排除规则]
```
示例：`Create a goal only when explicitly requested...; do not infer goals from ordinary tasks.`

**密集型**（需要行为指引）：
```
[概述]
[调用条件]
[状态转换规则]
[反模式列表]
[能力边界声明]
[后续动作]
```
示例：update_goal, spawn_agent

### 2. Anti-pattern 写法模式

| 模式 | 写法 | 示例 |
|------|------|------|
| **场景枚举** | "Do not X merely because A, B, C, or D" | update_goal: "Do not use blocked merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification" |
| **条件排除** | "Do not X when Y" | spawn_agent: "Do not delegate urgent blocking work when your immediate next step depends on that result" |
| **绝对禁止** | "NEVER X" | apply_patch: "NEVER try `applypatch`" |
| **行为替代** | "Do not X; instead Y" | "Do not repeat the full contents; instead, summarize the change" |
| **能力边界** | "You cannot use this tool to X; those are controlled by Y" | update_goal: "You cannot use this tool to pause, resume, budget-limit..." |
| **大写强调** | "IMPORTANT: DO NOT X" | request_plugin_install: parallel 约束 |

### 3. 行为指令格式

| 格式 | 用途 | 示例 |
|------|------|------|
| **精确数字** | 状态转换阈值 | "at least three consecutive goal turns" |
| **排他性** | 只能/必须 | "Only use if and only if the user explicitly asks" |
| **优先级** | A > B | "prefer the plugin; use the connector only when..." |
| **决策树** | 复杂决策 | "When to delegate vs. do the subtask yourself" 下的 4 条规则 |
| **生命周期** | 时序约束 | "After a previously blocked goal is resumed, treat the resumed run as a fresh blocked audit" |
| **动态注入** | 运行时配置 | `{allowed_modes}`, `{source_descriptions}`, `{TOOL_SEARCH_TOOL_NAME}` |

### 4. 约束分布策略

Codex 采用 **分层约束** 策略，同一行为约束可能出现在多个位置：

| 层级 | 位置 | 粒度 | 示例 |
|------|------|------|------|
| Tool description | `*_spec.rs` | 核心约束（最精简） | update_goal 的 complete/blocked 条件 |
| 参数 description | `JsonSchema::string(Some(...))` | 参数级约束 | objective: "only when no goal is currently defined" |
| System prompt | `gpt_5_2_prompt.md` | 行为指引 + 示例 | update_plan 的 Planning 章节 |
| 独立模板 | `templates/*.md` | 格式规范 | apply_patch 的 BNF 语法 |
| Tool response | 运行时返回值 | 嵌入指令 | goal 的 continuation/budget_limit 模板 |

**关键洞察**：
- **核心约束在 description 和参数描述中双层冗余**（update_goal 的 blocked 条件在 description 和 status 参数中各出现一次）
- **复杂行为指引放在 system prompt 而非 description**（update_plan 的状态转换规则不在 spec 中，在 prompt 中）
- **格式规范放在独立模板**（apply_patch 的完整语法在模板文件中，spec 只有一句话）

### 5. Tool Response 中嵌入行为指令

Codex 在 tool 的运行时返回值中也嵌入了行为指令（非 description，但属于 tool 提示词体系的一部分）：

**goal continuation 模板**（`templates/goals/continuation.md`）：
- "Keep the full objective intact. If it cannot be finished now, make concrete progress toward the real requested end state, leave the goal active, and do not redefine success around a smaller or easier task."
- "Completion audit" — 完整的完成审计流程（10+ 条规则）
- "Blocked audit" — 完整的阻塞审计流程（5 条规则）

**goal budget_limit 模板**（`templates/goals/budget_limit.md`）：
- "do not start new substantive work for this goal"
- "Do not call update_goal unless the goal is actually complete"

**goal objective_updated 模板**：
- "Adjust the current turn to pursue the updated objective. Avoid continuing work that only served the previous objective unless it also helps the updated objective."

这些模板在 goal tool 的**返回值**中注入，形成 tool description → tool response → 行为指令的完整链条。

---

## 关键设计洞察

1. **Description 是行为约束，不是说明书**——Codex 的 tool description 重心不在描述功能（"这个 tool 能做什么"），而在约束行为（"什么时候该用/不该用"）

2. **数字阈值优于模糊描述**——"at least three consecutive turns" 优于 "multiple times"，消除了模型的判断歧义

3. **反模式需要具体场景**——"Do not use blocked merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification" 列出了 5 个具体场景，比 "Do not use blocked inappropriately" 有效得多

4. **能力边界要显式声明**——"You cannot use this tool to pause, resume, budget-limit, or usage-limit a goal" 比让模型猜测更有用

5. **跨 tool 关系要在 description 中声明**——"use update_goal only for status", "prefer resources over web search", "always use tool_search instead of list_mcp_resources"

6. **动态 description 适配运行时配置**——request_user_input、tool_search、spawn_agent 的 description 都根据配置动态生成，确保约束与实际环境一致

7. **约束密度与操作风险成正比**——只读 tool (get_goal, 25字) vs 状态变更 tool (update_goal, 250字) vs 复杂编排 tool (spawn_agent, 800字)
