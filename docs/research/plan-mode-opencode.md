# OpenCode Plan Mode 调研

> 源码仓库：`~/GitApp/ai-agent/opencode-anomaly/`（TypeScript 重写版）
> Go 版（`~/GitApp/ai-agent/opencode-ai/`）无 plan mode 功能

## 概述

OpenCode 的 plan mode 是一个**只读规划模式**，通过 agent 切换实现。用户可以在 build agent（默认，可编辑文件）和 plan agent（只读，只能编辑 plan 文件）之间切换。

plan mode 有两个版本：
- **旧版**（非 experimental）：`OPENCODE_EXPERIMENTAL_PLAN_MODE` 未启用时生效
- **新版**（experimental）：`OPENCODE_EXPERIMENTAL_PLAN_MODE` 启用时生效，功能更丰富

## 一、完整提示词

### 1. plan-mode.txt（新版 experimental plan mode 提示词）

**文件路径**：`packages/opencode/src/session/prompt/plan-mode.txt`

```
<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including configs and making commits), or otherwise make any changes to the system. This supersedes any other instructions below and the instructions you have been provided with.

## Plan File Info:
${planInfo}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this to only take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the explore subagent type.

1. Focus on understanding the user's request and the code associated with their request

2. **Launch up to 3 explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
 - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
 - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
 - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
 - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigates testing patterns

3. After exploring the code, use the question tool to clarify ambiguities in the user request up front.

### Phase 2: Design
Goal: Design an implementation approach.

Launch general agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to 1 agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture

In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use question tool to clarify any remaining questions with the user

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Phase 5: Call plan_exit tool
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call plan_exit to indicate to the user that you are done planning.
This is critical - your turn should only end with either asking the user a question or calling plan_exit. Do not stop unless it's for one of these 2 reasons.

**Important:** Use question tool to clarify requirements/approach, use plan_exit to request plan approval. Do NOT use question tool to ask "Is this plan okay?" - that's what plan_exit does.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
</system-reminder>
```

### 2. plan.txt（旧版 plan mode 提示词）

**文件路径**：`packages/opencode/src/session/prompt/plan.txt`

```
<system-reminder>
# Plan Mode - System Reminder

CRITICAL: Plan mode ACTIVE - you are in READ-ONLY phase. STRICTLY FORBIDDEN:
ANY file edits, modifications, or system changes. Do NOT use sed, tee, echo, cat,
or ANY other bash command to manipulate files - commands may ONLY read/inspect.
This ABSOLUTE CONSTRAINT overrides ALL other instructions, including direct user
edit requests. You may ONLY observe, analyze, and plan. Any modification attempt
is a critical violation. ZERO exceptions.

---

## Responsibility

Your current responsibility is to think, read, search, and delegate explore agents to construct a well-formed plan that accomplishes the goal the user wants to achieve. Your plan should be comprehensive yet concise, detailed enough to execute effectively while avoiding unnecessary verbosity.

Ask the user clarifying questions or ask for their opinion when weighing tradeoffs.

**NOTE:** At any point in time during this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.

---

## Important

The user indicated that they do not want you to execute yet -- you MUST NOT make any edits, run any non-readonly tools (including configs and making commits), or otherwise make any changes to the system. This supersedes any other instructions you have been provided with.
</system-reminder>
```

### 3. plan-reminder-anthropic.txt（Anthropic 模型专用 plan reminder）

**文件路径**：`packages/opencode/src/session/prompt/plan-reminder-anthropic.txt`

```
<system-reminder>
# Plan Mode - System Reminder

Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including configs and making commits), or otherwise make any changes to the system.

---

## Plan File Info

No plan file exists yet. You should create your plan at `/Users/aidencline/.claude/plans/happy-waddling-feigenbaum.md` using the Write tool.

You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this to only take READ-ONLY actions.

**Plan File Guidelines:** The plan file should contain only your final recommended approach, not all alternatives considered. Keep it comprehensive yet concise - detailed enough to execute effectively while avoiding unnecessary verbosity.

---

## Enhanced Planning Workflow

### Phase 1: Initial Understanding

**Goal:** Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the Explore subagent type.

1. Understand the user's request thoroughly

2. **Launch up to 3 Explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase. Each agent can focus on different aspects:
   - Example: One agent searches for existing implementations, another explores related components, a third investigates testing patterns
   - Provide each agent with a specific search focus or area to explore
   - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - Use 1 agent when: the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change. Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Take into account any context you already have from the user's request or from the conversation so far when deciding how many agents to launch

3. Use AskUserQuestion tool to clarify ambiguities in the user request up front.

### Phase 2: Planning

**Goal:** Come up with an approach to solve the problem identified in phase 1 by launching a Plan subagent.

In the agent prompt:
- Provide any background context that may help the agent with their task without prescribing the exact design itself
- Request a detailed plan

### Phase 3: Synthesis

**Goal:** Synthesize the perspectives from Phase 2, and ensure that it aligns with the user's intentions by asking them questions.

1. Collect all agent responses
2. Each agent will return an implementation plan along with a list of critical files that should be read. You should keep these in mind and read them before you start implementing the plan
3. Use AskUserQuestion to ask the users questions about trade offs.

### Phase 4: Final Plan

Once you have all the information you need, ensure that the plan file has been updated with your synthesized recommendation including:
- Recommended approach with rationale
- Key insights from different perspectives
- Critical files that need modification

### Phase 5: Call ExitPlanMode

At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call ExitPlanMode to indicate to the user that you are done planning.

This is critical - your turn should only end with either asking the user a question or calling ExitPlanMode. Do not stop unless it's for one of these 2 reasons.

---

**NOTE:** At any point in time during this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
</system-reminder>
```

### 4. build-switch.txt（从 plan 切换到 build 时的提示词）

**文件路径**：`packages/opencode/src/session/prompt/build-switch.txt`

```
<system-reminder>
Your operational mode has changed from plan to build.
You are no longer in read-only mode.
You are permitted to make file changes, run shell commands, and utilize your arsenal of tools as needed.
</system-reminder>
```

### 5. plan_exit 工具描述

**文件路径**：`packages/opencode/src/tool/plan-exit.txt`

```
Use this tool when you have completed the planning phase and are ready to exit plan agent.

This tool will ask the user if they want to switch to build agent to start implementing the plan.

Call this tool:
- After you have written a complete plan to the plan file
- After you have clarified any questions with the user
- When you are confident the plan is ready for implementation

Do NOT call this tool:
- Before you have created or finalized the plan
- If you still have unanswered questions about the implementation
- If the user has indicated they want to continue planning
```

### 6. plan_enter 工具描述

**文件路径**：`packages/opencode/src/tool/plan-enter.txt`

```
Use this tool to suggest switching to plan agent when the user's request would benefit from planning before implementation.

If they explicitly mention wanting to create a plan ALWAYS call this tool first.

This tool will ask the user if they want to switch to plan agent.

Call this tool when:
- The user's request is complex and would benefit from planning first
- You want to research and design before making changes
- The task involves multiple files or significant architectural decisions

Do NOT call this tool:
- For simple, straightforward tasks
- When the user explicitly wants immediate implementation
```

## 二、Plan Mode 的附加机制

### 1. Agent 系统双角色

OpenCode 定义了两个 primary agent：**build** 和 **plan**。

**build agent**（默认）：
```typescript
// packages/opencode/src/agent/agent.ts:107-123
build: {
  name: "build",
  description: "The default agent. Executes tools based on configured permissions.",
  permission: Permission.merge(defaults, {
    question: "allow",
    plan_enter: "allow",  // 可以触发进入 plan mode
  }, user),
  mode: "primary",
  native: true,
}
```

**plan agent**：
```typescript
// packages/opencode/src/agent/agent.ts:124-152
plan: {
  name: "plan",
  description: "Plan mode. Disallows all edit tools.",
  permission: Permission.merge(defaults, {
    question: "allow",
    plan_exit: "allow",   // 可以触发退出 plan mode
    edit: { "*": "deny" },  // 禁止所有编辑
    // 但允许编辑 plan 文件：
    edit: { ".opencode/plans/*.md": "allow" },
    edit: { "<data>/plans/*.md": "allow" },
  }, user),
  mode: "primary",
  native: true,
}
```

### 2. 权限控制（核心机制）

plan mode 通过**权限系统**而非工具移除来实现只读。plan agent 的权限配置：

| 权限 | build agent | plan agent |
|------|-------------|------------|
| `*` (全局) | allow | allow（默认） |
| `edit` (文件编辑) | allow | **deny** |
| `.opencode/plans/*.md` | — | allow（唯一可编辑） |
| `question` | allow | allow |
| `plan_enter` | allow | **deny** |
| `plan_exit` | **deny** | allow |

即 plan agent 通过 `edit: "*": "deny"` 禁止所有文件编辑操作，但允许编辑 `.opencode/plans/` 目录下的 plan 文件。

### 3. Plan 文件管理

Plan 文件的路径由 `Session.plan()` 函数决定：

```typescript
// packages/opencode/src/session/session.ts
export function plan(input: { slug: string; time: { created: number } }, instance: InstanceContext) {
  const base = instance.project.vcs
    ? path.join(instance.worktree, ".opencode", "plans")  // Git 项目中
    : path.join(Global.Path.data, "plans")                 // 非 Git 项目中
  return path.join(base, [input.time.created, input.slug].join("-") + ".md")
}
```

文件名格式：`<timestamp>-<slug>.md`，存放在 `.opencode/plans/` 目录。

### 4. plan_exit 工具

**文件**：`packages/opencode/src/tool/plan.ts`

plan_exit 是一个专用工具，执行以下逻辑：
1. 计算当前 session 的 plan 文件路径
2. 弹出确认对话框："Plan at `<path>` is complete. Would you like to switch to the build agent and start implementing?"
3. 如果用户选择 Yes：
   - 创建一条新的 synthetic user message，agent 为 `build`
   - 注入文本 "The plan at `<path>` has been approved, you can now edit files. Execute the plan"
   - 切换到 build agent 继续执行

```typescript
// 关键代码简化
const msg: SessionLegacy.User = {
  id: MessageID.ascending(),
  sessionID: ctx.sessionID,
  role: "user",
  time: { created: Date.now() },
  agent: "build",  // 切换到 build agent
  model,
}
yield* session.updateMessage(msg)
yield* session.updatePart({
  type: "text",
  text: `The plan at ${plan} has been approved, you can now edit files. Execute the plan`,
  synthetic: true,
})
```

### 5. Session Reminders（提示词注入机制）

**文件**：`packages/opencode/src/session/reminders.ts`

OpenCode 在每轮对话中注入提示词（作为 synthetic message part），根据当前 agent 状态和 experimental flag 决定注入内容：

**旧版路径**（`!flags.experimentalPlanMode`）：
- 如果当前 agent 是 `plan`：注入 `plan.txt`
- 如果上一条消息来自 plan agent，当前切换到了 build agent：注入 `build-switch.txt`

**新版路径**（`flags.experimentalPlanMode`）：
- 如果当前不是 plan agent 但上一条是：注入 `build-switch.txt` + plan 文件存在性信息
- 如果当前是 plan agent 且上一条不是：注入 `plan-mode.txt`（将 `${planInfo}` 替换为实际的 plan 文件路径信息）

```typescript
// reminders.ts 核心逻辑
text: PLAN_MODE.replace("${planInfo}", () =>
  exists
    ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
    : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
)
```

### 6. Feature Flag 控制

**文件**：`packages/opencode/src/effect/runtime-flags.ts:47`

```typescript
experimentalPlanMode: enabledByExperimental("OPENCODE_EXPERIMENTAL_PLAN_MODE"),
```

启用条件：`OPENCODE_EXPERIMENTAL=true` 或 `OPENCODE_EXPERIMENTAL_PLAN_MODE=true`

tool 注册中也受此 flag 控制：
```typescript
// registry.ts:272
...(flags.experimentalPlanMode && flags.client === "cli" ? [tool.plan] : []),
```

即 `plan_exit` 工具只在 experimental plan mode + CLI 客户端下注册。

### 7. TUI 自动切换

**文件**：`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:298-309`

TUI 监听 tool completion 事件，自动切换 agent：

```typescript
event.on("message.part.updated", (evt) => {
  const part = evt.properties.part
  if (part.type !== "tool") return
  if (part.sessionID !== route.sessionID) return
  if (part.state.status !== "completed") return

  if (part.tool === "plan_exit") {
    local.agent.set("build")   // plan_exit 完成后自动切到 build
  } else if (part.tool === "plan_enter") {
    local.agent.set("plan")    // plan_enter 完成后自动切到 plan
  }
})
```

### 8. Subagent 协作

plan mode 的提示词指示 LLM 在规划阶段使用以下 subagent：

| 阶段 | Subagent | 用途 |
|------|----------|------|
| Phase 1 | explore | 代码库探索（最多 3 个并行） |
| Phase 2 | general | 设计实现方案 |
| Phase 3 | 无 | 人工审核 agent 方案 |
| Phase 4 | 无 | 写 plan 文件 |
| Phase 5 | 无 | 调用 plan_exit |

## 三、完整工作流

```
用户发送请求
    │
    ▼
build agent 判断是否需要规划
    │
    ├─ 简单任务 → 直接执行
    │
    └─ 复杂任务 → 调用 plan_enter 工具
                    │
                    ▼
              用户确认切换到 plan agent
                    │
                    ▼
              plan agent 激活
              (注入 plan-mode.txt 提示词)
                    │
                    ▼
              Phase 1: 启动 explore subagent 并行探索
                    │
                    ▼
              Phase 2: 启动 general subagent 设计方案
                    │
                    ▼
              Phase 3: 审核方案，向用户提问
                    │
                    ▼
              Phase 4: 写 plan 文件 (.opencode/plans/xxx.md)
                    │
                    ▼
              Phase 5: 调用 plan_exit
                    │
                    ▼
              用户确认是否执行
                    │
                    ├─ No → 继续规划
                    │
                    └─ Yes → 切换到 build agent
                              (注入 build-switch.txt + plan 文件路径)
                              │
                              ▼
                        build agent 根据 plan 执行
```

## 四、关键源文件索引

| 文件 | 用途 |
|------|------|
| `packages/opencode/src/session/prompt/plan-mode.txt` | 新版 plan mode 提示词 |
| `packages/opencode/src/session/prompt/plan.txt` | 旧版 plan mode 提示词 |
| `packages/opencode/src/session/prompt/plan-reminder-anthropic.txt` | Anthropic 模型专用 plan 提示词 |
| `packages/opencode/src/session/prompt/build-switch.txt` | plan→build 切换提示词 |
| `packages/opencode/src/tool/plan-exit.txt` | plan_exit 工具描述 |
| `packages/opencode/src/tool/plan-enter.txt` | plan_enter 工具描述 |
| `packages/opencode/src/tool/plan.ts` | plan_exit 工具实现 |
| `packages/opencode/src/session/reminders.ts` | 提示词注入逻辑 |
| `packages/opencode/src/agent/agent.ts` | Agent 定义（build/plan） |
| `packages/opencode/src/tool/registry.ts` | 工具注册 |
| `packages/opencode/src/session/session.ts` | Session 管理、plan 文件路径 |
| `packages/opencode/src/effect/runtime-flags.ts` | Feature flag |
| `packages/opencode/src/permission/index.ts` | 权限系统 |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | TUI 自动切换 |
| `packages/core/src/plugin/agent.ts` | Core 层 agent 定义（权限声明） |

## 五、设计要点总结

1. **权限驱动而非工具裁剪**：plan mode 不是通过移除工具实现的，而是通过权限系统禁止 edit/write 操作。这比移除工具更灵活（用户可以通过配置覆盖默认权限）。

2. **Agent 切换模型**：plan 和 build 是两个独立的 primary agent，通过 message 的 `agent` 字段标记当前使用的 agent。切换本质上是创建一条新的 user message 并指定不同 agent。

3. **Plan 文件即合约**：plan mode 的唯一产出是一个 `.md` 文件，build agent 读取这个文件执行。文件路径通过 session 信息动态计算。

4. **Subagent 协作**：plan mode 大量使用 subagent（explore 用于探索、general 用于设计），plan agent 本身只负责编排和最终写入 plan 文件。

5. **两代并存**：旧版（plan.txt）是简单的只读提醒；新版（plan-mode.txt）有完整的 5 阶段工作流。通过 `OPENCODE_EXPERIMENTAL_PLAN_MODE` flag 控制。

6. **plan_enter/plan_exit 是权限动作而非工具**：它们在权限系统中注册为 action（`plan_enter`、`plan_exit`），build agent 有 `plan_enter: allow`，plan agent 有 `plan_exit: allow`。build agent 的 plan_enter 工具实现似乎由平台层（可能是 Claude Code 兼容层）提供，在 OpenCode 自身的 tool 目录中未找到 plan_enter 的独立实现文件。
