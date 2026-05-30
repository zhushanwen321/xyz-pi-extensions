# Coding Agent 上下文压缩提示词横评与学习

> 对比分析 Claude Code、Codex CLI、Pi Mono、OpenCode 四个 coding agent 的上下文压缩提示词设计，
> 提炼可借鉴的设计模式，指导 infinite-context-engine 的压缩提示词优化。

---

## 1. 四项目压缩提示词速览

### 1.1 Claude Code — 最成熟、最复杂

**提示词结构**：9 段式结构化摘要 + `<analysis>` 思考草稿 + `<summary>` 输出

| 段落 | 内容 |
|------|------|
| Primary Request and Intent | 用户的所有显式请求和意图 |
| Key Technical Concepts | 重要技术概念、技术和框架 |
| Files and Code Sections | 具体文件和代码段，**包括完整代码片段** |
| Errors and fixes | 所有错误及修复方式 |
| Problem Solving | 已解决和正在排障的问题 |
| All user messages | **所有非工具结果的用户消息**（原文保留！） |
| Pending Tasks | 明确的待处理任务 |
| Current Work | 压缩前正在进行的精确工作 |
| Optional Next Step | 与最近工作直接相关的下一步 |

**独特机制**：
- 三层压缩体系（微压缩 → Session Memory 压缩 → 大压缩）
- **禁止工具调用**的前导+尾部双重提醒
- `<analysis>` 草稿本 → `<summary>` 输出的两阶段生成
- 自定义压缩指令（用户 Hook 可注入）
- 部分压缩支持（from/up_to 两种方向）

### 1.2 Codex CLI — 交接文档式

**提示词**：
```
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary
for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
```

**独特机制**：
- **交接文档**（handoff summary）视角 — "帮助下一个 LLM 无缝继续工作"
- 摘要前缀模板：告知新 LLM "这是前一个 LLM 的思考摘要，避免重复工作"
- 三条压缩路径：本地 LLM / OpenAI remote compact V1 / V2
- 自定义提示词支持（配置文件覆盖）

### 1.3 Pi Mono — 迭代式增量压缩

**提示词**：7 段式 Markdown 结构

| 段落 | 内容 |
|------|------|
| Goal | 用户目标（可多项） |
| Constraints & Preferences | 约束、偏好 |
| Progress (Done/In Progress/Blocked) | 任务进度 |
| Key Decisions | 决策及理由 |
| Next Steps | 有序的下一步 |
| Critical Context | 继续工作所需的数据、引用 |

**独特机制**：
- **迭代式压缩**：`<previous-summary>` + UPDATE_SUMMARIZATION_PROMPT，增量更新而非全量重写
- 文件操作追踪（自动记录 create/modify/delete）
- 分支摘要（branch summarization）
- Turn 前缀摘要（切割点在 turn 中间时）
- 扩展点：`session_before_compact` / `session_compact` 事件

### 1.4 OpenCode — 最简单

**提示词**：
```
You are a helpful AI assistant tasked with summarizing conversations.

When asked to summarize, provide a detailed but concise summary of the conversation.
Focus on information that would be helpful for continuing the conversation, including:
- What was done
- What is currently being worked on
- Which files are being modified
- What needs to be done next

Your summary should be comprehensive enough to provide context but concise enough
to be quickly understood.
```

**评价**：最简单的实现，约 60 词系统提示词 + 30 词用户提示词，无结构化格式约束。

---

## 2. 关键设计模式对比

| 维度 | Claude Code | Codex CLI | Pi Mono | OpenCode |
|------|-------------|-----------|---------|----------|
| **提示词长度** | ~3000 词 | ~100 词 | ~300 词 | ~60 词 |
| **输出格式** | 9 段 Markdown | 自由文本 | 7 段 Markdown | 自由文本 |
| **思考过程** | `<analysis>` 草稿 | 无 | 无 | 无 |
| **增量压缩** | 无（全量重写） | 无 | ✅ `<previous-summary>` | 无 |
| **工具调用防护** | ✅ 双重提醒 | 无 | 无 | 无 |
| **用户消息保留** | ✅ 原文保留所有 | 隐含 | 隐含 | 隐含 |
| **自定义指令** | ✅ Hook 注入 | ✅ 配置文件 | 无 | 无 |
| **摘要受众** | 后续 LLM | 后续 LLM | 后续 LLM | 后续 LLM |
| **文件操作追踪** | 隐含 | 无 | ✅ 显式追踪 | 无 |
| **分支摘要** | 无 | 无 | ✅ | 无 |

---

## 3. 我们应该学习什么

### 3.1 核心发现：我们的提示词缺了什么

当前 infinite-context 的压缩提示词存在的问题：

| 问题 | 现状 | 应改为 |
|------|------|--------|
| 无结构化输出 | 自由格式 JSON 树 | 应要求结构化的 Markdown 段落 |
| 无思考过程 | 直接输出 | 应先 `<analysis>` 再 `<summary>` |
| 无"受众意识" | 泛泛的"compression engine" | 应明确"为后续 LLM 生成 checkpoint" |
| 无增量更新 | 每次全量重写 | 应支持 `<previous-summary>` 增量 |
| 摘要太短 | "concise" → 119 tokens | 应设最小长度下限 |
| 无用户消息保留 | 只提取摘要 | 应保留关键用户消息原文 |
| 无工具调用防护 | 无 | 添加工具调用禁令 |
| 摘要无前缀包装 | 裸 `[nodeId] summary` | 应添加上下文前缀告知新 LLM |

### 3.2 具体可学习的模式

#### 模式 1：结构化摘要（Claude Code / Pi Mono）

**为什么重要**：结构化摘要确保关键信息不遗漏，且便于 LLM 快速定位。

**建议**：每个树节点的摘要应遵循轻量结构化格式：

```
[用户请求] → [采取的行动] → [关键结果]
文件: path/to/file.ts (函数名, 行号)
决策: 使用 X 方案而非 Y，因为 Z
```

#### 模式 2：分析→摘要两阶段（Claude Code）

**为什么重要**：先让模型在 `<analysis>` 中"思考"整个对话，再生成摘要。这显著提高摘要质量和信息保留率。

**建议**：在压缩提示词中添加 `<analysis>` 草稿要求：

```
First, analyze each segment in <analysis> tags:
- What was the user's request?
- What did the assistant do? (specific files, functions, changes)
- What decisions were made?
- What errors occurred and how were they fixed?

Then produce the compressed tree in <summary> tags.
```

#### 模式 3：增量/迭代压缩（Pi Mono）

**为什么重要**：Pi Mono 的 `<previous-summary>` + UPDATE 模式避免每次全量重写，保留历史压缩积累的信息。

**建议**：当已存在压缩树时，传递旧摘要给 LLM，要求增量更新而非全量重写。

#### 模式 4：交接文档视角（Codex CLI）

**为什么重要**：把压缩摘要定位为"给下一个 LLM 的交接文档"，而非"信息压缩"。这改变 LLM 的输出策略。

**建议**：提示词开头改为：
```
You are creating a CONTEXT CHECKPOINT for another AI that will continue this work.
Your summary must contain enough detail for seamless continuation.
```

#### 模式 5：摘要前缀包装（Codex CLI）

**为什么重要**：摘要注入回上下文时，需要告知 LLM "这是之前的摘要"。

**建议**：在 context-handler 的 `createSummaryMessage` 中添加前缀：
```
[Context Checkpoint] A previous AI session produced this summary of earlier work.
Use it to avoid duplicating work:
[nodeId] summary...
```

#### 模式 6：工具调用防护（Claude Code）

**为什么重要**：压缩用 `maxTurns: 1`，如果模型尝试调用工具就白费了。

**建议**：在提示词首尾添加禁令。

#### 模式 7：自定义压缩指令（Claude Code / Codex CLI）

**为什么重要**：不同项目/用户可能关注不同信息。

**建议**：允许用户通过 `.pi/config` 添加自定义压缩指令。

#### 模式 8：保留用户消息原文（Claude Code）

**为什么重要**：Claude Code 明确要求 "All user messages" 段落保留所有用户消息原文。用户的反馈和修改指令是最不应该丢失的信息。

**建议**：在压缩输出中增加 `userMessages` 字段，保留每个段的关键用户消息。

---

## 4. 优化优先级建议

按 ROI（投入产出比）排序：

| 优先级 | 改进 | 预期效果 | 工作量 |
|--------|------|----------|--------|
| **P0** | 结构化输出格式 + 最小长度约束 | 从 119 tokens → 预估 500-1000 tokens | 小 |
| **P0** | 交接文档视角（改 system prompt） | LLM 理解任务目标，输出更有用 | 极小 |
| **P1** | 分析→摘要两阶段 | 摘要质量显著提升 | 中（需后处理去除 analysis） |
| **P1** | 摘要前缀包装 | 新 LLM 理解上下文来源 | 小 |
| **P2** | 增量/迭代压缩 | 长会话中信息积累更好 | 大 |
| **P2** | 保留用户消息原文 | 关键反馈不丢失 | 中 |
| **P3** | 工具调用防护 | 防止压缩失败 | 极小 |
| **P3** | 自定义压缩指令 | 灵活性 | 中 |

---

## 5. 各项目详细分析文档

- [Claude Code 压缩分析](./claude-code-compaction-prompt.md)（30KB，12 章节）
- [Codex CLI 压缩分析](./codex-cli-compaction-prompt.md)（15KB，10 章节）
- [Pi Mono 压缩分析](./pi-mono-compaction-prompt.md)（22KB，10 章节）
- [OpenCode 压缩分析](./opencode-compaction-prompt.md)（16KB，9 章节）
