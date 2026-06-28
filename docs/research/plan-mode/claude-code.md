# Claude Code Plan Mode 调研报告

## 1. 状态机

### 设计决策

Plan Mode 是 Claude Code 权限模式系统的一个特殊状态。它不是一个独立的状态机，而是嵌入在 `PermissionMode` 体系中作为一个 mode 值。

核心模式列表（`src/types/permissions.ts:17-25`）：

```typescript
export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const
```

Ant 内部还有额外的 `auto` 和 `bubble` 模式。

### 状态转换

Plan Mode 的状态转换由 `transitionPermissionMode()` 统一管理（`src/utils/permissions/permissionSetup.ts`）：

| 从 | 到 | 触发方式 |
|---|---|---|
| `default` / `auto` / `acceptEdits` / ... | `plan` | EnterPlanMode 工具调用（需用户确认） |
| `plan` | `prePlanMode`（之前的模式） | ExitPlanMode 工具调用（需用户确认） |

关键设计点：

1. **prePlanMode 保存**：进入 plan 时，当前模式被保存到 `toolPermissionContext.prePlanMode`。退出时恢复到该模式（`ExitPlanModeV2Tool.ts:298-340`）。
2. **Plan + Auto 共存**：当用户从 `auto` 模式进入 plan，auto 模式的分类器（classifier）可以在 plan 期间保持激活。由 `shouldPlanUseAutoMode()` 决定（`permissionSetup.ts:shouldPlanUseAutoMode()`）。
3. **模式转换副作用**：`handlePlanModeTransition()`（`bootstrap/state.ts:1340-1360`）管理 plan_mode / plan_mode_exit attachment 标记。

### 关键源码引用

- 状态定义：`src/types/permissions.ts:17-25`
- 模式转换核心：`src/utils/permissions/permissionSetup.ts:transitionPermissionMode()`
- 进入时上下文准备：`src/utils/permissions/permissionSetup.ts:prepareContextForPlanMode()`
- 退出时模式恢复：`src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:268-340`
- Attachment 管理：`src/bootstrap/state.ts:1340-1360`

---

## 2. 进入机制

### 设计决策

Plan Mode 通过 `EnterPlanMode` 工具进入。这是一个 **AI 主动调用、用户被动确认** 的模式。

#### 触发方式

1. **AI 自动触发**：AI 根据任务复杂度判断是否需要进入 plan mode。prompt 中详细描述了何时使用/不使用的判断标准。
2. **用户通过 Shift+Tab 切换**：权限模式轮播（carousel）中包含 plan mode，用户可手动切换。
3. **Settings 默认模式**：`permissions.defaultMode: "plan"` 可将 plan 设为默认模式。

#### 两套 Prompt 策略

Claude Code 根据用户类型提供不同的 prompt（`EnterPlanModeTool/prompt.ts`）：

- **External 用户**（默认）：鼓励多用 plan mode，7 种场景建议使用（新功能、多种方案、代码修改、架构决策、多文件变更、需求不明、用户偏好重要）。
- **Ant 用户**（内部）：更保守，仅在"真正的架构模糊"、"需求不明"、"高影响重构"时使用。明确建议"有疑问就先动手做"。

#### 用户确认环节

`EnterPlanModeTool` 的 `shouldDefer: true` 意味着它被列入 deferred tools 列表。更关键的是，它通过 `checkPermissions` 返回 `{ behavior: 'ask', message: 'Exit plan mode?' }` 要求用户确认（ExitPlanMode 更明确地实现了这一点；EnterPlanMode 的确认通过 permission 系统的 `isReadOnly: true` + `shouldDefer: true` 隐式实现）。

#### 禁止场景

- 子代理（agent context）中不能使用：`if (context.agentId) throw new Error('EnterPlanMode tool cannot be used in agent contexts')`
- Channels 模式（Telegram/Discord）下禁用：因为 plan approval dialog 需要 TUI 交互

### 关键源码引用

- 工具定义：`src/tools/EnterPlanModeTool/EnterPlanModeTool.ts`
- External prompt：`src/tools/EnterPlanModeTool/prompt.ts:getEnterPlanModeToolPromptExternal()`
- Ant prompt：`src/tools/EnterPlanModeTool/prompt.ts:getEnterPlanModeToolPromptAnt()`
- 禁止场景：`EnterPlanModeTool.ts:58-61`（agent check）、`EnterPlanModeTool.ts:67-77`（channels check）

---

## 3. 工具限制

### 设计决策

Plan Mode 的工具限制通过**三层防护**实现：prompt 引导（软限制）+ 权限模式（中限制）+ tool disallow（硬限制）。

#### 第一层：Prompt 引导（主约束）

Plan Mode 的核心约束来自 system prompt attachment（`src/utils/messages.ts:getPlanModeV2Instructions()`）：

```
Plan mode is active. The user indicated that they do not want you to execute yet -- 
you MUST NOT make any edits (with the exception of the plan file mentioned below), 
run any non-readonly tools, or otherwise make any changes to the system.
```

Plan 文件是**唯一允许写入的文件**。Prompt 明确告知 AI 只能使用 `FileReadTool`、`GlobTool`、`GrepTool` 等只读工具。

#### 第二层：权限模式

在 `checkToolPermissions()`（`src/utils/permissions/permissions.ts:1270-1275`）中，plan mode 有特殊的 bypass 逻辑：

```typescript
const shouldBypassPermissions =
  appState.toolPermissionContext.mode === 'bypassPermissions' ||
  (appState.toolPermissionContext.mode === 'plan' &&
    appState.toolPermissionContext.isBypassPermissionsModeAvailable)
```

当从 `bypassPermissions` 进入 plan 时，权限仍然被 bypass。这意味着 plan mode 的工具限制在 bypass 模式下不生效——依赖 prompt 引导。

当 auto mode 在 plan 期间激活时，分类器（classifier）会评估工具调用的安全性（`permissions.ts:523-525`）：

```typescript
(appState.toolPermissionContext.mode === 'plan' &&
  (autoModeStateModule?.isAutoModeActive() ?? false))
```

#### 第三层：Plan Agent 的 disallowedTools

Plan Agent（`src/tools/AgentTool/built-in/planAgent.ts`）有硬编码的禁用列表：

```typescript
disallowedTools: [
  AGENT_TOOL_NAME,      // 禁止嵌套 agent
  EXIT_PLAN_MODE_TOOL_NAME,  // 禁止退出 plan mode
  FILE_EDIT_TOOL_NAME,  // 禁止编辑文件
  FILE_WRITE_TOOL_NAME, // 禁止写文件
  NOTEBOOK_EDIT_TOOL_NAME,   // 禁止编辑 notebook
]
```

这是子代理级别的硬限制，不可通过 prompt 绕过。

#### 主会话 vs 子代理的工具限制差异

| 场景 | 主会话（plan mode） | Plan Agent 子代理 |
|------|-------------------|-------------------|
| 文件读写 | 只读 + plan 文件可写 | 完全只读 |
| Bash | 只允许只读命令（prompt 引导） | 只允许只读命令（prompt + disallowed） |
| Agent 工具 | 可用（launch explore/plan agents） | 禁止 |
| ExitPlanMode | 可用 | 禁止 |

### 关键源码引用

- Prompt 引导：`src/utils/messages.ts:3224-3284`（Phase 1-5 workflow）
- Plan Agent disallowedTools：`src/tools/AgentTool/built-in/planAgent.ts:77-83`
- 权限 bypass 逻辑：`src/utils/permissions/permissions.ts:1270-1275`
- Auto + Plan 分类器：`src/utils/permissions/permissions.ts:523-525`

---

## 4. 退出机制

### 设计决策

退出 Plan Mode 通过 `ExitPlanMode` 工具实现，需要**用户确认**。

#### 退出流程

1. AI 调用 `ExitPlanMode` 工具
2. `checkPermissions` 返回 `{ behavior: 'ask', message: 'Exit plan mode?' }`（`ExitPlanModeV2Tool.ts:140-145`）
3. 用户在 TUI 中看到审批对话框，可以：
   - **批准**：退出 plan mode，恢复之前的权限模式
   - **拒绝**：留在 plan mode，继续规划
   - **编辑 plan**：CCR web UI 中用户可以编辑 plan 内容后再批准

#### 校验逻辑

退出前有严格的校验（`ExitPlanModeV2Tool.ts:116-130`）：

- 非 plan mode 调用 ExitPlanMode 会被拒绝
- 记录 `tengu_exit_plan_mode_called_outside_plan` 分析事件
- 防止在已退出的状态下重复退出

#### 模式恢复

退出时恢复 `prePlanMode`（`ExitPlanModeV2Tool.ts:298-340`）：

```typescript
let restoreMode = prev.toolPermissionContext.prePlanMode ?? 'default'
```

还有 circuit breaker 防护：如果 prePlanMode 是 `auto` 但 auto mode gate 已关闭，降级为 `default`。

#### 子代理（Teammate）退出

对于 teammate 场景（`ExitPlanModeV2Tool.ts:137-145`）：

- 不需要本地用户交互（`requiresUserInteraction` 返回 `false`）
- 如果是 `planModeRequired` 的 teammate，plan 需要发送给 team leader 审批
- 审批通过 mailbox 机制完成

### 关键源码引用

- 工具定义：`src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts`
- 用户确认：`ExitPlanModeV2Tool.ts:140-145`
- 校验逻辑：`ExitPlanModeV2Tool.ts:116-130`
- 模式恢复：`ExitPlanModeV2Tool.ts:298-340`
- Teammate 审批：`ExitPlanModeV2Tool.ts:149-184`

---

## 5. Plan 数据

### 设计决策

Plan 内容存储为**磁盘上的 Markdown 文件**，而非内存或数据库。

#### 存储路径

- 默认路径：`~/.claude/plans/{slug}.md`
- 可通过 `settings.plansDirectory` 自定义（需在项目根目录内）
- 子代理的 plan 文件：`{slug}-agent-{agentId}.md`

#### Slug 生成

- 使用随机单词生成（`generateWordSlug()`），不是 session ID
- 缓存到 `planSlugCache`，首次访问时生成
- 冲突时最多重试 10 次
- `/clear` 命令会清除 slug 缓存

#### 文件持久化

1. **本地模式**：直接读写磁盘文件
2. **远程模式（CCR）**：
   - 每次写入后调用 `persistFileSnapshotIfRemote()` 保存到 transcript
   - Resume 时从 file_snapshot 或 message history 恢复
   - Fork 时生成新 slug，复制原始 plan 内容

#### Plan 内容注入

`normalizeToolInput()`（`src/utils/api.ts:566-580`）在 ExitPlanMode 被调用前，从磁盘读取 plan 内容注入到工具输入中：

```typescript
case EXIT_PLAN_MODE_V2_TOOL_NAME: {
  const plan = getPlan(agentId)
  const planFilePath = getPlanFilePath(agentId)
  return plan !== null ? { ...input, plan, planFilePath } : input
}
```

这确保 hooks 和 SDK 能获取到完整的 plan 内容。

### 关键源码引用

- 数据结构：`src/utils/plans.ts`
- 路径管理：`plans.ts:getPlanFilePath()`
- Slug 生成：`plans.ts:getPlanSlug()`
- 文件恢复：`plans.ts:copyPlanForResume()`、`recoverPlanFromMessages()`
- Snapshot 持久化：`plans.ts:persistFileSnapshotIfRemote()`
- 内容注入：`src/utils/api.ts:566-580`

---

## 6. Plan → Execute 转换

### 设计决策

Plan 到执行的转换是一个**用户审批 + 模式切换**的原子操作。

#### 转换流程

```
[Plan Mode] 
    → AI 调用 ExitPlanMode
    → normalizeToolInput 注入 plan 内容
    → checkPermissions 请求用户确认（TUI 对话框）
    → 用户批准/编辑/拒绝
    → call() 执行：
        1. 保存用户编辑到磁盘
        2. 恢复 prePlanMode
        3. 处理 auto mode 状态
        4. 返回 plan 内容
    → mapToolResultToToolResultBlockParam 生成提示：
        "User has approved your plan. You can now start coding."
```

#### 用户审批环节

`requiresUserInteraction()` 对非 teammate 返回 `true`，触发 TUI 中的审批对话框。用户可以：

1. **直接批准**：plan 内容不变
2. **编辑 plan 后批准**（CCR web UI）：编辑后的 plan 通过 `permissionResult.updatedInput` 传回，同步到磁盘
3. **拒绝**：留在 plan mode

#### Plan 内容回传

退出后，plan 内容通过 `tool_result` 返回给 AI（`ExitPlanModeV2Tool.ts:362-375`）：

```typescript
return {
  type: 'tool_result',
  content: `User has approved your plan. You can now start coding. ...
  
## Approved Plan:
${plan}`,
  tool_use_id: toolUseID,
}
```

#### 上下文清理与恢复

退出 plan mode 后：
1. 设置 `hasExitedPlanMode = true`，防止重复退出
2. 设置 `needsPlanModeExitAttachment = true`，下轮对话会注入 `plan_mode_exit` attachment 提醒 AI 已退出
3. 如果从 auto mode 进入且 auto 期间被使用，设置 `needsAutoModeExitAttachment`

### 关键源码引用

- 退出流程：`src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts`
- Plan 注入：`src/utils/api.ts:566-580`
- 用户审批：`ExitPlanModeV2Tool.ts:140-145`
- 结果回传：`ExitPlanModeV2Tool.ts:350-375`

---

## 7. 进度追踪

### 设计决策

Plan Mode 的进度追踪分为两个阶段：**plan 阶段的工作流**和**执行阶段的验证**。

#### Plan 阶段：5-Phase 工作流

Plan Mode 有一套结构化的工作流（`src/utils/messages.ts:getPlanModeV2Instructions()`）：

| Phase | 目标 | 使用工具 |
|-------|------|---------|
| Phase 1: Initial Understanding | 探索代码库 | Explore agents（最多 3 个并行） |
| Phase 2: Design | 设计实现方案 | Plan agents（1-3 个并行） |
| Phase 3: Review | 审查方案 | 直接读取关键文件 + AskUserQuestion |
| Phase 4: Final Plan | 写入 plan 文件 | FileWrite / FileEdit |
| Phase 5: Exit | 请求用户审批 | ExitPlanMode |

并行度由 subscription 决定（`planModeV2.ts`）：
- Max / Enterprise / Team：3 个 plan agents
- 默认：1 个 plan agent
- Explore agents 固定 3 个

#### Interview Phase（Ant 内部）

Ant 用户有一套迭代式工作流（`getPlanModeInterviewInstructions()`），不强制使用 Explore/Plan agents，而是鼓励 AI 直接读文件 + 向用户提问，逐步构建 plan。

#### 执行阶段：VerifyPlanExecution

Plan 批准后，系统会注入 `verify_plan_reminder` attachment（`src/utils/messages.ts:4240-4248`），提醒 AI 在实现完成后调用 `VerifyPlanExecution` 工具验证所有 plan 条目已完成。

这是一个**软约束**——通过 attachment（system reminder）实现，不是硬性检查。如果 AI 忘记调用，后续轮次的 reminder 会再次提醒。

#### Teammate 进度追踪

对于 teammate 场景，plan 的审批状态通过 `inProcessTeammateHelpers` 追踪（`setAwaitingPlanApproval`），显示在 team 的任务列表中。

### 关键源码引用

- 5-Phase 工作流：`src/utils/messages.ts:3216-3284`
- Interview Phase：`src/utils/messages.ts:getPlanModeInterviewInstructions()`
- 并行度配置：`src/utils/planModeV2.ts:getPlanModeV2AgentCount()`
- 执行验证提醒：`src/utils/messages.ts:4240-4248`
- VerifyPlan reminder：`src/utils/attachments.ts:3892-3928`

---

## 8. Compact / 上下文

### 设计决策

Plan Mode 对上下文压缩（compact）有特殊处理，确保 plan 文件不会在压缩后丢失。

#### Plan 文件引用（plan_file_reference）

在 compact 操作期间（`src/services/compact/compact.ts:1473-1485`），如果存在 plan 文件，会创建 `plan_file_reference` attachment：

```typescript
export function createPlanAttachmentIfNeeded(agentId?: AgentId): AttachmentMessage | null {
  const planContent = getPlan(agentId)
  if (!planContent) return null
  return createAttachmentMessage({
    type: 'plan_file_reference',
    planFilePath: getPlanFilePath(agentId),
    planContent,
  })
}
```

这个 attachment 在 compact 后的上下文中被渲染为（`src/utils/messages.ts:3636-3640`）：

```
A plan file exists from plan mode at: {path}

Plan contents:

{plan content}

If this plan is relevant to the current work and not already complete, 
continue working on it.
```

#### Plan Mode Attachment 的 Sparse 模式

Plan Mode 有 full 和 sparse 两种 attachment 模式（`getPlanModeV2SparseInstructions()`）。Full 模式包含完整的 5-Phase 工作流说明，Sparse 模式是压缩版：

```
Plan mode still active (see full instructions earlier in conversation). 
Read-only except plan file ({path}). 
Follow 5-phase workflow. 
End turns with AskUserQuestion or ExitPlanMode.
```

这减少了上下文占用，同时保持关键约束可见。

#### Plan 恢复机制

Resume session 时（`src/utils/plans.ts:copyPlanForResume()`），plan 文件的恢复有三层 fallback：

1. 直接读取磁盘文件
2. 从 file_snapshot 恢复（CCR 远程 session）
3. 从 message history 恢复（搜索 ExitPlanMode tool_use 中的 plan 字段、user message 的 planContent 字段、plan_file_reference attachment）

### 关键源码引用

- Plan attachment 创建：`src/services/compact/compact.ts:1473-1485`
- plan_file_reference 渲染：`src/utils/messages.ts:3636-3640`
- Sparse 模式：`src/utils/messages.ts:getPlanModeV2SparseInstructions()`
- 恢复机制：`src/utils/plans.ts:copyPlanForResume()`、`recoverPlanFromMessages()`

---

## 对 Pi plan 扩展的启示

### 值得借鉴的设计

1. **Plan 文件即唯一 artifact**：Claude Code 的 plan 存储为 Markdown 文件，简单、透明、用户可直接编辑。Pi 的 plan 扩展可以采用类似方案——一个 plan 对应一个文件，路径对用户可见。

2. **两层 Prompt 策略**：External（鼓励多用 plan）和 Ant（保守使用）。Pi 可以根据用户的使用模式调整 plan 的触发频率。

3. **Phase 工作流 + 并行 Agent**：Plan Mode 的 5-Phase 工作流（Explore → Design → Review → Write Plan → Exit）结构清晰。Pi 的 plan 扩展可以定义类似的阶段，配合 subagent 并行探索。

4. **用户审批作为转换门控**：Enter/Exit PlanMode 都需要用户确认，这是关键的 UX 设计——防止 AI 在用户不期望时进入/退出 plan mode。

5. **Compact 保护**：通过 `plan_file_reference` attachment 确保 plan 在上下文压缩后不丢失。Pi 的 context-engineering 扩展已经有类似的 attachment 机制，plan 可以复用。

6. **prePlanMode 保存/恢复**：进入 plan 时保存之前的模式，退出时精确恢复。避免 plan mode 结束后丢失用户的偏好设置。

### 需要规避的设计

1. **过度依赖 prompt 引导**：Plan Mode 的核心约束（禁止写文件）主要靠 prompt 引导，而非工具层面的硬限制。在主会话中，AI 理论上可以绕过约束。Pi 可以考虑在工具层做更严格的过滤。

2. **Plan 内容回传的冗余**：退出时将完整 plan 内容通过 `tool_result` 回传给 AI，增加了 token 消耗。可以考虑只传 plan 文件路径，让 AI 按需读取。

3. **缺少 plan 版本管理**：Plan 文件只有最新版本，没有历史记录。如果用户想回退到之前的 plan，只能手动编辑。

### Pi 扩展的具体建议

| 借鉴点 | Pi 实现建议 |
|--------|-----------|
| Plan 文件存储 | 使用 `~/.pi/agent/plans/{slug}.md`，与 Pi 目录约定一致 |
| Phase 工作流 | 定义 3-4 个阶段（探索→设计→写入→审批），通过 tool + attachment 实现 |
| 用户审批 | Pi 的 tool 有 `checkPermissions` 等效机制（`renderToolUseMessage` + 用户确认），可复用 |
| Compact 保护 | 在 `context-engineering` 的 compact 流程中加入 plan 文件的 attachment |
| Interview Phase | Pi 可以默认启用迭代式工作流，让 AI 和用户交替推进 |
| Plan Agent | Pi 的 subagent 可以有 `plan` 类型，限制为只读工具集 |
