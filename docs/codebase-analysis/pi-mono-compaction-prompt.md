# Pi Mono 上下文压缩（Compaction）机制深度分析

> 基于源码版本：`packages/coding-agent/src/core/compaction/` 及相关模块

---

## 目录

1. [架构概览](#1-架构概览)
2. [提示词全文摘录](#2-提示词全文摘录)
3. [压缩触发条件与策略](#3-压缩触发条件与策略)
4. [压缩输入格式](#4-压缩输入格式)
5. [压缩输出格式与校验](#5-压缩输出格式与校验)
6. [文件操作追踪](#6-文件操作追踪)
7. [分支摘要（Branch Summarization）](#7-分支摘要branch-summarization)
8. [扩展点（Extension Hooks）](#8-扩展点extension-hooks)
9. [与 Claude Code 的异同对比](#9-与-claude-code-的异同对比)
10. [关键实现细节](#10-关键实现细节)

---

## 1. 架构概览

### 1.1 文件结构

```
packages/coding-agent/src/core/compaction/
├── compaction.ts           # 压缩主逻辑（27KB，核心入口）
├── branch-summarization.ts # 分支摘要逻辑（11KB）
├── utils.ts                # 共享工具（序列化、文件操作追踪、System Prompt）
└── index.ts                # 统一导出
```

相关外围文件：
- `core/messages.ts` — 消息类型定义、`convertToLlm()` 转换器、摘要注入前缀
- `core/session-manager.ts` — Session 树管理、`CompactionEntry` 持久化、`buildSessionContext()`
- `core/agent-session.ts` — 自动压缩触发、扩展事件分发、overflow 恢复
- `core/settings-manager.ts` — 压缩设置（enabled / reserveTokens / keepRecentTokens）
- `core/extensions/types.ts` — 扩展事件类型定义

### 1.2 数据流

```
AgentSession._checkCompaction()
  │
  ├─ 触发条件满足？
  │   ├─ Case 1: Context overflow error → 移除错误消息 → compact → 自动重试
  │   └─ Case 2: Threshold exceeded → compact → 不重试
  │
  ▼
prepareCompaction(pathEntries, settings)
  │  计算 tokens → 找切割点 → 提取消息 → 提取文件操作
  │
  ▼
Extension Hook: session_before_compact（可取消/替换）
  │
  ▼
compact(preparation, model, ...)
  │  ├─ generateSummary(messagesToSummarize)        ← 历史摘要
  │  └─ generateTurnPrefixSummary(turnPrefixMessages) ← 分割 turn 前缀摘要（如需要）
  │
  ▼
SessionManager.appendCompaction(summary, firstKeptEntryId, ...)
  │  写入 CompactionEntry 到 session 树
  │
  ▼
buildSessionContext() → 重载上下文
  │  CompactionSummaryMessage 注入为 user role 消息
  │
  ▼
Extension Hook: session_compact（通知完成）
```

---

## 2. 提示词全文摘录

### 2.1 System Prompt（`SUMMARIZATION_SYSTEM_PROMPT`）

> 文件：`core/compaction/utils.ts`

```
You are a context summarization assistant. Your task is to read a conversation
between a user and an AI coding assistant, then produce a structured summary
following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the
conversation. ONLY output the structured summary.
```

**设计要点：**
- 明确角色定位：**上下文摘要助手**
- 禁止行为：不继续对话、不回答对话中的问题
- 只允许输出结构化摘要

### 2.2 初始摘要 User Prompt（`SUMMARIZATION_PROMPT`）

> 文件：`core/compaction/compaction.ts`

```
The messages above are a conversation to summarize. Create a structured context
checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session
covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and
error messages.
```

**设计要点：**
- 明确受众：**另一个 LLM**（非人类阅读）
- Markdown 结构化格式，七段式：Goal → Constraints → Progress(Done/In Progress/Blocked) → Key Decisions → Next Steps → Critical Context
- 强调保留精确信息：文件路径、函数名、错误消息

### 2.3 增量更新摘要 Prompt（`UPDATE_SUMMARIZATION_PROMPT`）

> 文件：`core/compaction/compaction.ts`

当存在上一次压缩的 summary 时使用（**增量/迭代更新模式**）：

```
The messages above are NEW conversation messages to incorporate into the
existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and
error messages.
```

**设计要点：**
- 使用 `<previous-summary>` XML 标签包裹旧摘要，实现**迭代式压缩**
- 六条更新规则：保留、新增、更新进度、更新下一步、保留精确信息、可删除过时内容
- 格式与初始摘要一致，保持上下文结构稳定

### 2.4 Turn 前缀摘要 Prompt（`TURN_PREFIX_SUMMARIZATION_PROMPT`）

> 当切割点落在 turn 中间（非 user 消息边界）时使用

```
This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent
work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.
```

### 2.5 分支摘要 Prompt（`BRANCH_SUMMARY_PROMPT`）

> 文件：`core/compaction/branch-summarization.ts`

```
Create a structured summary of this conversation branch for context when
returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and
error messages.
```

### 2.6 摘要注入前缀（LLM 上下文中的呈现）

> 文件：`core/messages.ts`

**压缩摘要注入格式：**
```
The conversation history before this point was compacted into the following summary:

<summary>
{summary content}
</summary>
```

**分支摘要注入格式：**
```
The following is a summary of a branch that this conversation came back from:

<summary>
{summary content}
</summary>
```

---

## 3. 压缩触发条件与策略

### 3.1 默认设置

```typescript
DEFAULT_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: 16384,    // 保留给 prompt + response 的 token 空间
  keepRecentTokens: 20000,  // 切割时保留最近的消息 token 数
};
```

### 3.2 触发判定

```typescript
function shouldCompact(contextTokens, contextWindow, settings) {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}
```

**含义：** 当 `contextTokens > contextWindow - 16384` 时触发。例如 200K context window，token 使用超过 ~183K 时触发。

### 3.3 触发时机

压缩在 `AgentSession._checkCompaction()` 中被调用，有两个时机：

| 时机 | 触发条件 | 行为 |
|------|---------|------|
| **agent_end 后** | 每次 assistant 回复完成 | 检查 threshold / overflow |
| **prompt 提交前** | 用户提交新 prompt 前 | 捕获已 abort 的回复中的 usage 信息 |

### 3.4 两种触发场景

#### Case 1: Context Overflow（溢出恢复）

- LLM 返回 context overflow 错误
- **自动移除**错误消息，执行 compact
- **自动重试**用户的 prompt（willRetry = true）
- 仅允许一次恢复尝试（`_overflowRecoveryAttempted` 标记）
- 跳过来自不同模型的 overflow（防止从小 context 模型切换到大 context 模型时误触发）

#### Case 2: Threshold Exceeded（阈值触发）

- 上下文 token 使用超过阈值
- 执行 compact
- **不自动重试**，用户继续手动操作
- 对于 error 消息（无 usage 数据），从最后成功的 response 估算 token 数

### 3.5 手动触发

用户通过 `/compact` 命令（或 `/compact <custom instructions>`）手动触发。

### 3.6 Token 估算

```typescript
function estimateTokens(message) {
  // 基于字符数 / 4 的保守估算
  // 图像估算为 ~1200 tokens（4800 chars）
  // 不同 message role 有不同的字符计算逻辑
}
```

对于有实际 usage 数据的消息，优先使用 LLM 返回的精确 token 数（`totalTokens || input + output + cacheRead + cacheWrite`）。

---

## 4. 压缩输入格式

### 4.1 对话序列化

压缩前，所有 `AgentMessage` 先通过 `convertToLlm()` 转换为标准 LLM 格式，再通过 `serializeConversation()` 序列化为纯文本：

```typescript
// 序列化格式示例：
[User]: <用户输入文本>

[Assistant thinking]: <思维链内容>

[Assistant]: <回复文本>

[Assistant tool calls]: read(path="/src/foo.ts"); edit(path="/src/bar.ts", ...)

[Tool result]: <工具返回内容，截断到 2000 字符>
```

**关键设计：**
- **序列化为纯文本**而非保留原始消息结构 — 防止 LLM 将其视为待继续的对话
- Tool result **截断到 2000 字符**（`TOOL_RESULT_MAX_CHARS = 2000`），附带 `[... N more characters truncated]` 标记
- 消息类型映射：bashExecution → user role、custom → user role、branchSummary/compactionSummary → user role

### 4.2 Prompt 构建结构

```
User Message:
  <conversation>
    {序列化后的对话文本}
  </conversation>

  [<previous-summary>
    {上一次压缩的摘要（增量模式时）}
  </previous-summary>]

  {SUMMARIZATION_PROMPT 或 UPDATE_SUMMARIZATION_PROMPT}
  [Additional focus: {customInstructions}]  ← 可选自定义指令
```

System Message:
```
{SUMMARIZATION_SYSTEM_PROMPT}
```

### 4.3 消息收集

`prepareCompaction()` 从 session 树中收集需要摘要的消息：

1. 找到上次压缩的 boundary（`prevCompactionIndex`）
2. 从 boundary 到最新消息作为候选范围
3. 通过 `findCutPoint()` 确定切割位置
4. 切割点之前 → `messagesToSummarize`（待摘要）
5. 切割点之后 → 保留（不压缩）
6. 如果切割点在 turn 中间 → 额外生成 `turnPrefixMessages`

---

## 5. 压缩输出格式与校验

### 5.1 摘要结构

LLM 生成的摘要遵循七段 Markdown 结构：

```markdown
## Goal
...

## Constraints & Preferences
- ...

## Progress
### Done
- [x] ...
### In Progress
- [ ] ...
### Blocked
- ...

## Key Decisions
- **Decision**: rationale

## Next Steps
1. ...

## Critical Context
- ...
```

### 5.2 文件操作追踪（附加到摘要末尾）

摘要生成后，自动追加文件操作追踪信息：

```xml
<read-files>
/path/to/readonly/file1.ts
/path/to/readonly/file2.ts
</read-files>

<modified-files>
/path/to/edited/file1.ts
/path/to/written/file2.ts
</modified-files>
```

**来源：** 从 assistant 消息中的 tool call 提取（read / write / edit 操作），同时继承上次压缩的追踪数据。

### 5.3 Split Turn 时的合并格式

当切割点在 turn 中间时，最终摘要格式为：

```
{历史摘要}

---

**Turn Context (split turn):**

{Turn 前缀摘要}
```

### 5.4 输出校验

- `maxTokens` 限制为 `Math.min(0.8 * reserveTokens, model.maxTokens)`，通常为 ~13K tokens
- Split turn 时 turn prefix 的 `maxTokens` 为 `Math.min(0.5 * reserveTokens, model.maxTokens)`，通常为 ~8K tokens
- 如果 LLM 返回 error stop reason，抛出异常

### 5.5 摘要持久化

```typescript
interface CompactionEntry {
  type: "compaction";
  summary: string;              // 摘要全文（含文件追踪）
  firstKeptEntryId: string;     // 保留的第一个 entry 的 UUID
  tokensBefore: number;         // 压缩前的 token 数
  details?: T;                  // 扩展数据（readFiles / modifiedFiles）
  fromHook?: boolean;           // 是否由扩展生成
}
```

---

## 6. 文件操作追踪

### 6.1 追踪维度

```typescript
interface FileOperations {
  read: Set<string>;     // read 工具调用
  written: Set<string>;  // write 工具调用
  edited: Set<string>;   // edit 工具调用
}
```

### 6.2 去重逻辑

```typescript
function computeFileLists(fileOps) {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readOnly = [...fileOps.read].filter(f => !modified.has(f));
  return { readFiles: readOnly, modifiedFiles: [...modified] };
}
```

- 修改过的文件不重复出现在 readFiles 中
- 跨压缩周期累积追踪（从上一次 CompactionEntry.details 继承）

---

## 7. 分支摘要（Branch Summarization）

### 7.1 触发场景

当用户在 session 树中**导航到不同分支**时，需要对离开的分支生成摘要，以防上下文丢失。

### 7.2 入口

`collectEntriesForBranchSummary(session, oldLeafId, targetId)`:
- 找到 old 和 target 路径的**最近公共祖先**
- 收集从 old leaf 到公共祖先之间的所有 entries

### 7.3 Token Budget

```typescript
const contextWindow = model.contextWindow || 128000;
const tokenBudget = contextWindow - reserveTokens;  // 默认 ~111K
```

从**最新向最旧**遍历，优先保留最近的上下文。compaction 和 branch_summary 类型的 entry 即使超预算也尽量保留（< 90% 时允许）。

### 7.4 注入前缀

分支摘要注入 LLM 上下文时带有 preamble：

```
The user explored a different conversation branch before returning here.
Summary of that exploration:

{摘要内容}
```

---

## 8. 扩展点（Extension Hooks）

### 8.1 `session_before_compact`

```typescript
interface SessionBeforeCompactEvent {
  type: "session_before_compact";
  preparation: CompactionPreparation;  // 包含所有待压缩数据
  branchEntries: SessionEntry[];       // 完整分支 entries
  customInstructions?: string;
  signal: AbortSignal;                 // 可取消
}
```

扩展可以：
- **取消压缩**（`result.cancel = true`）
- **替换压缩结果**（`result.compaction = { summary, firstKeptEntryId, tokensBefore, details }`）
- 不返回则使用 Pi 内置摘要逻辑

### 8.2 `session_compact`

```typescript
interface SessionCompactEvent {
  type: "session_compact";
  compactionEntry: CompactionEntry;  // 已保存的压缩 entry
  fromExtension: boolean;            // 是否由扩展生成
}
```

压缩完成后的通知，扩展可利用此事件更新内部状态。

---

## 9. 与 Claude Code 的异同对比

### 9.1 架构差异

| 维度 | Pi Mono | Claude Code |
|------|---------|-------------|
| **摘要格式** | 七段 Markdown（Goal/Constraints/Progress/Decisions/Next Steps/Context） | 较自由的 narrative 摘要 |
| **增量更新** | ✅ 支持（`UPDATE_SUMMARIZATION_PROMPT` + `<previous-summary>` 标签） | 通常是单次摘要 |
| **Turn 分割** | ✅ 支持（mid-turn split + turn prefix summary） | 无此机制 |
| **文件追踪** | ✅ 结构化追踪（readFiles/modifiedFiles），XML 标签附加到摘要 | 无此机制 |
| **分支摘要** | ✅ 树形 session + 分支导航时自动摘要 | 线性 session，无分支 |
| **扩展系统** | ✅ 完整 hook（before_compact / session_compact），可取消/替换 | 插件 hooks 但无 compaction 钩子 |
| **序列化方式** | 纯文本序列化（`[User]: ...` `[Assistant]: ...`） | 类似但实现不同 |
| **System Prompt** | 独立 system prompt 约束角色 | 内联在 prompt 中 |

### 9.2 提示词差异

**Pi 的独特设计：**
1. **迭代式压缩**：`UPDATE_SUMMARIZATION_PROMPT` 允许 LLM 在已有摘要基础上更新，而非每次从头生成
2. **结构化强制**：EXACT format 要求 + 七段式标准，确保摘要格式一致
3. **双摘要并行**：历史摘要 + Turn 前缀摘要可并行生成（`Promise.all`）
4. **受众明确**："another LLM will use to continue the work" — 面向 LLM 而非人类

### 9.3 触发策略差异

| 维度 | Pi Mono | Claude Code |
|------|---------|-------------|
| **Threshold** | `contextTokens > contextWindow - 16384` | 类似但具体值不同 |
| **Overflow 恢复** | ✅ 自动移除错误 → compact → 重试（仅一次） | 有类似机制 |
| **模型切换保护** | ✅ 跳过来自不同模型的 overflow | — |
| **压缩后保护** | ✅ 跳过压缩前时间戳的旧 usage | — |
| **手动命令** | `/compact [instructions]` | `/compact` |

### 9.4 切割点算法差异

**Pi Mono 的 `findCutPoint()`：**
- 从最新消息向回遍历，累积 token 直到达到 `keepRecentTokens`（默认 20000）
- 在最近的合法切割点处切割
- 合法切割点：user / assistant / custom / bashExecution 消息（**绝不**在 tool result 处切割）
- 支持 mid-turn 切割（cut at assistant message），tool results 自然跟随保留
- 切割后扫描非消息 entry（bash、settings 等）向上包含

---

## 10. 关键实现细节

### 10.1 CompactionEntry 在 Session 树中的位置

CompactionEntry 作为 session 树的一个节点，`firstKeptEntryId` 指向保留的起始 entry。重建上下文时：

```
[CompactionSummaryMessage]   ← 压缩摘要（注入为 user role）
[kept entries...]            ← firstKeptEntryId 到 compaction 之间的保留消息
[post-compaction entries]    ← compaction 之后的新消息
```

### 10.2 上下文重建中的消息注入

`CompactionSummaryMessage` 通过 `convertToLlm()` 转换为标准 LLM 消息时，以 **user role** 注入，带有 `<summary>` XML 标签包裹：

```typescript
// messages.ts → convertToLlm()
case "compactionSummary":
  return {
    role: "user",
    content: [{
      type: "text",
      text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX
    }],
    timestamp: m.timestamp,
  };
```

### 10.3 并行摘要生成

当 split turn 时，历史摘要和 turn 前缀摘要通过 `Promise.all` 并行生成：

```typescript
const [historyResult, turnPrefixResult] = await Promise.all([
  generateSummary(messagesToSummarize, ...),
  generateTurnPrefixSummary(turnPrefixMessages, ...),
]);
summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
```

### 10.4 自动压缩中的防抖保护

1. **时间戳比较**：assistant 消息时间戳 ≤ 最新 CompactionEntry 时间戳 → 跳过（防止旧 usage 重触发）
2. **模型一致性**：overflow 只处理同一 provider+model 的错误
3. **单次恢复**：`_overflowRecoveryAttempted` 标记防止无限 compact-retry 循环
4. **Abort 支持**：压缩全程支持 abort（手动取消 `/compact` 或自动压缩取消）

### 10.5 Token 计算优先级

```typescript
function calculateContextTokens(usage) {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
```

优先使用 LLM 返回的 `totalTokens`，无则从分量估算。对于没有 usage 的尾部消息，用 `estimateTokens()`（chars/4）补充。

### 10.6 TUI 展示

压缩摘要消息在 TUI 中以折叠/展开方式展示：
- 折叠状态：`[compaction] Compacted from N tokens (expand to expand)`
- 展开状态：Markdown 渲染的完整摘要内容
- 使用 `customMessageBg` 主题色背景

---

## 附录 A：完整 Prompt 汇总

| Prompt 名称 | 文件 | 用途 |
|-------------|------|------|
| `SUMMARIZATION_SYSTEM_PROMPT` | `utils.ts` | 摘要生成的 System Prompt |
| `SUMMARIZATION_PROMPT` | `compaction.ts` | 初始摘要 User Prompt |
| `UPDATE_SUMMARIZATION_PROMPT` | `compaction.ts` | 增量更新摘要 User Prompt |
| `TURN_PREFIX_SUMMARIZATION_PROMPT` | `compaction.ts` | Turn 前缀摘要 Prompt |
| `BRANCH_SUMMARY_PROMPT` | `branch-summarization.ts` | 分支摘要 Prompt |
| `COMPACTION_SUMMARY_PREFIX/SUFFIX` | `messages.ts` | 摘要注入 LLM 上下文的包裹标签 |
| `BRANCH_SUMMARY_PREFIX/SUFFIX` | `messages.ts` | 分支摘要注入 LLM 上下文的包裹标签 |
| `BRANCH_SUMMARY_PREAMBLE` | `branch-summarization.ts` | 分支摘要前置说明文字 |

## 附录 B：关键常量

```typescript
DEFAULT_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: 16384,    // ~4K tokens 给 prompt/response
  keepRecentTokens: 20000, // 保留最近 ~5K tokens 的消息
};

TOOL_RESULT_MAX_CHARS = 2000;     // Tool result 序列化截断长度
Image estimation = 1200 tokens;   // 每张图像估算 ~1200 tokens
Token estimation = chars / 4;     // 文本 token 估算公式
```
