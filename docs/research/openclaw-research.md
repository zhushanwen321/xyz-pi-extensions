# OpenClaw 记忆与上下文管理系统调研报告

> 调研日期：2026-05-31
> 源码仓库：`~/GitApp/openclaw/`
> 核心模块版本：基于 main 分支最新代码

---

## 1. 项目概述

### 1.1 OpenClaw 是什么

OpenClaw 是一个 TypeScript/Node.js 实现的**个人 AI 助手平台**，定位为 "always-on personal assistant"。核心特征：

- **多平台接入**：通过 Channel 插件支持 WhatsApp、Telegram、Slack、Discord、iMessage 等 10+ 聊天平台
- **Agent 架构**：支持多 Agent 并发运行，每个 Agent 有独立的 identity、workspace、session 历史
- **Skills 系统**：基于 Markdown 的声明式 Prompt 注入框架，58 个内置 Skill + ClawHub 市场
- **工具生态**：文件操作、Shell 执行、浏览器控制、MCP 协议、Canvas 渲染、Subagent 委托

### 1.2 核心设计理念

从源码中可以提炼出几个关键设计决策：

1. **Context Engine 是可插拔的**：上下文管理被抽象为 `ContextEngine` 接口，默认实现（legacy）使用 transcript + compaction，但可以替换为自定义引擎
2. **Compaction 优先于截断**：对话历史不直接截断，而是通过摘要压缩（compaction）保留关键信息
3. **Prompt Cache 稳定性是第一公民**：System Prompt 被精心设计为 stable prefix + dynamic suffix 的结构，确保 Anthropic prompt cache 命中率
4. **文件即记忆**：`MEMORY.md`、`SOUL.md`、`AGENTS.md` 等文件作为持久化跨会话知识的载体
5. **Session 是一等公民**：每个对话都有完整的 JSONL transcript，支持分支、修复、导出

---

## 2. 对话/Transcript 管理

### 2.1 Transcript 的两个含义

OpenClaw 中 "transcript" 有两个不同的概念：

| 概念 | 位置 | 用途 |
|------|------|------|
| **对话 Transcript** | `~/.openclaw/agents/<agentId>/sessions/<session>.jsonl` | Agent 主循环的对话历史，每行一个 JSON 消息 |
| **会议 Transcript** | `TranscriptsStore`（`src/transcripts/store.ts`） | 实时会议/通话的文字记录，按日期/session 组织 |

### 2.2 对话 Transcript 存储格式

对话历史以 JSONL 格式存储，每行是一个 `AgentMessage` 对象：

```
~/.openclaw/agents/<agentId>/sessions/
├── <session-id>.jsonl          # 活跃 session
└── <session-id>.compacted.jsonl  # 压缩后的历史
```

每条记录包含角色（user/assistant/toolResult）、内容、时间戳等字段。Transcript 支持分支（branching），通过 DAG 结构管理编辑和回溯。

### 2.3 会议 Transcript 系统

`TranscriptsStore`（`src/transcripts/store.ts`）管理实时会议记录：

```
<rootDir>/
├── 2026-05-30/
│   ├── meeting-2026-05-30T10-00-00/
│   │   ├── metadata.json       # TranscriptSessionDescriptor
│   │   ├── utterances.jsonl    # 逐行发言记录
│   │   └── summary.md          # 自动生成的摘要
```

**Summary 生成**（`src/transcripts/summary.ts`）是纯规则提取，不使用 LLM：

- **Overview**：取前 4 句话
- **Decisions**：正则匹配 `decided|decision|we will|agreed|approved` 等关键词
- **Action Items**：正则匹配 `todo|action|follow up|next step|ship|fix|send`
- **Risks**：正则匹配 `risk|blocked|concern|issue|problem|deadline`

这是一个轻量级的信息抽取方案，适用于会议场景但不适用于长对话的语义压缩。

### 2.4 Transcript 修复机制

OpenClaw 有完善的 transcript 修复体系：

- **`session-transcript-repair.ts`**：修复 tool_use/tool_result 的配对关系，处理孤立的 tool result
- **`session-file-repair.ts`**：修复损坏的 JSONL 文件
- **`transcript-redact.ts`**：敏感信息脱敏（API key、token 等）
- **`transcript-policy.ts`**：控制哪些消息进入 transcript（过滤内部消息、心跳等）

---

## 3. 上下文管理策略

这是 OpenClaw 最核心的设计之一，涉及多个模块的协作。

### 3.1 Context Engine 架构

OpenClaw 将上下文管理抽象为 `ContextEngine` 接口（`src/context-engine/types.ts`）：

```typescript
interface ContextEngine {
  readonly info: ContextEngineInfo;

  // 生命周期
  bootstrap?(params): Promise<BootstrapResult>;     // 初始化
  maintain?(params): Promise<ContextEngineMaintenanceResult>; // 维护（可重写 transcript）
  ingest(params): Promise<IngestResult>;             // 消费单条消息
  ingestBatch?(params): Promise<IngestBatchResult>;  // 批量消费

  // 核心操作
  assemble(params): Promise<AssembleResult>;         // 组装上下文
  compact(params): Promise<CompactResult>;           // 压缩上下文

  // 高级能力
  search?(params): Promise<SearchResult>;            // 语义搜索
  rewriteTranscriptEntries?(params): Promise<...>;   // 安全重写 transcript
}
```

默认使用 `legacy` 引擎（`src/context-engine/legacy.ts`），它实现了经典的 transcript + compaction 模式。

**关键设计**：`AssembleResult` 支持两种投影模式：
- `per_turn`：每个 turn 都重新组装上下文（默认）
- `thread_bootstrap`：只在 epoch 变化时注入一次，复用后端线程（适用于持久化后端如 Anthropic）

### 3.2 Compaction（上下文压缩）

#### 3.2.1 触发时机

Compaction 由 `embedded-agent-subscribe.handlers.compaction.ts` 管理，在以下情况下触发：

1. **Token 超预算**：当对话历史的 token 数超过 context window 的可分配份额
2. **模型切换**：从大模型切换到小模型时，可能需要压缩
3. **手动触发**：用户通过 `/compact` 命令手动触发
4. **Handoff 场景**：模型因配额限制切换时，需要生成 handoff summary

#### 3.2.2 压缩流程

完整的压缩流程（`src/agents/compaction.ts`）：

```
对话历史
  ↓
1. pruneHistoryForContextShare — 按预算裁剪历史
   - 默认保留 50% context window 给历史（handoff 时只 20%）
   - 从最早的 chunk 开始丢弃
   - 修复 tool_use/tool_result 配对
   ↓
2. buildStageSplitPlan — 规划分块策略
   - 单块模式（总 token < maxChunkTokens）
   - 多块模式（按 token 份额分割，保持 tool call 配对）
   ↓
3. summarizeWithFallback — 生成摘要（三级容错）
   ├─ 尝试 1：完整摘要（summarizeChunks）
   ├─ 尝试 2：排除超大消息后重试
   └─ 尝试 3：使用部分摘要 + "[N messages oversized]" 标注
   ↓
4. 摘要替换历史
   - 摘要作为 user message 插入
   - 被压缩的消息从活跃 transcript 中移除
```

#### 3.2.3 关键常量和参数

```typescript
// src/agents/agent-compaction-constants.ts
MIN_PROMPT_BUDGET_TOKENS = 8_000    // prompt 最小预算
MIN_PROMPT_BUDGET_RATIO = 0.5       // prompt 至少占 50% context window

// src/agents/compaction-planning.ts
BASE_CHUNK_RATIO = 0.4              // 基础分块比例
MIN_CHUNK_RATIO = 0.15              // 最小分块比例
SAFETY_MARGIN = 1.2                 // 20% 安全余量（补偿 token 估算误差）
SUMMARIZATION_OVERHEAD_TOKENS = 4096 // 摘要 prompt 的固定开销
```

#### 3.2.4 Token 估算

使用 `chars/4` 启发式估算（`estimateTokens`），配合 1.2 倍安全余量补偿多字节字符和特殊 token。

#### 3.2.5 Identifier Preservation

压缩时默认保留所有标识符（UUID、hash、hostname、IP、port、URL、文件名），支持三种策略：
- `strict`：默认，强制保留所有标识符
- `custom`：自定义保留指令
- `off`：不保留

这个设计很关键——LLM 生成的摘要容易"改写"或"缩写"标识符，导致后续操作引用错误。

#### 3.2.6 Handoff Summary

当模型因配额限制切换时，使用专门的 handoff 指令：

```typescript
const HANDOFF_INSTRUCTIONS = [
  "Generate a concise recovery briefing for a new LLM taking over this session.",
  "LEADER HIERARCHY REINFORCEMENT:",
  "- Explicitly state that the new model is the LEADER (Orchestrator).",
  "- Identify any active autonomous units as SUBORDINATES.",
  "MUST CAPTURE:",
  "- Current high-level goal and project path.",
  "- Status of the latest tool executions.",
  "- Critical files currently being modified.",
  "- Pending items and next intended steps.",
].join("\n");
```

Handoff summary 有 4000 token 的硬上限，且使用更严格的 20% 历史预算（普通压缩是 50%）。

### 3.3 Context Window Guard

`src/agents/context-window-guard.ts` 实现了上下文窗口的安全守卫：

```typescript
CONTEXT_WINDOW_HARD_MIN_TOKENS = 4_000    // 绝对最低值
CONTEXT_WINDOW_WARN_BELOW_TOKENS = 8_000  // 警告阈值
CONTEXT_WINDOW_HARD_MIN_RATIO = 0.1       // 最小比例（10%）
CONTEXT_WINDOW_WARN_BELOW_RATIO = 0.2     // 警告比例（20%）
```

上下文窗口的来源优先级：
1. **modelsConfig**：用户配置的 `models.providers.<id>.models[].contextTokens`
2. **model**：模型自身报告的 contextTokens/contextWindow
3. **agentContextTokens**：`agents.defaults.contextTokens` 配置上限
4. **default**：兜底默认值

对 Anthropic GA 模型（claude-opus-4.8、claude-sonnet-4.6 等）硬编码为 1M token。

### 3.4 System Prompt 构建

System Prompt（`src/agents/system-prompt.ts`）是一个精心设计的多层结构：

```
┌─────────────────────────────────────────────────────────┐
│  Stable Prefix（缓存命中区域）                              │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ Identity: "You are a personal assistant..."          │ │
│  │ Tooling: 工具列表 + 使用指引                           │ │
│  │ Workspace: 工作目录 + 文件操作规则                     │ │
│  │ Safety: 安全约束                                      │ │
│  │ Context Files: AGENTS.md / SOUL.md / MEMORY.md 等    │ │
│  │ Docs: 文档路径                                        │ │
│  │ Skills: 可用 skill 目录（XML 格式）                    │ │
│  │ Memory: 记忆搜索指引                                  │ │
│  └─────────────────────────────────────────────────────┘ │
│  ─ ─ ─ ─ ─ ─ Cache Boundary ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│  Dynamic Suffix（每个 turn 可能变化）                       │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ Runtime: 时间、模型、OS 信息                           │ │
│  │ Heartbeat: 心跳指令                                   │ │
│  │ Bootstrap: 引导模式指令                               │ │
│  │ Dynamic Context Files: HEARTBEAT.md 等               │ │
│  │ Extra System Prompt: 额外注入                         │ │
│  │ Provider Sections: 模型提供商特定内容                   │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**关键设计**：

1. **Cache Boundary**（`SYSTEM_PROMPT_CACHE_BOUNDARY`）：明确标记 stable/dynamic 分界线，stable prefix 在连续 turn 间保持不变以命中 prompt cache
2. **Context Files 排序**：按固定顺序注入：`agents.md(10) → soul.md(20) → identity.md(30) → user.md(40) → tools.md(50) → bootstrap.md(60) → memory.md(70)`
3. **Prompt Mode**：支持 `full`（完整）、`minimal`（子 agent）、`none`（基本）三种模式
4. **Stable Prefix Cache**：使用 SHA-256 hash 缓存 stable prefix，避免重复构建

### 3.5 Bootstrap 系统

Bootstrap 是 session 初始化时的上下文注入机制：

- **`BOOTSTRAP.md`**：workspace 中的引导文件，定义初始化流程
- **Bootstrap Budget**（`bootstrap-budget.ts`）：控制 bootstrap 文件的 token 预算
- **Bootstrap Cache**（`bootstrap-cache.ts`）：缓存 bootstrap 文件内容，避免重复读取
- **Bootstrap Files**（`bootstrap-files.ts`）：扫描和加载 bootstrap 相关文件

Bootstrap prompt 指导模型：
- 如果能完成 BOOTSTRAP.md 流程，就完成
- 如果不能，解释阻塞、继续可能的步骤、提供最简下一步
- 不允许假装 bootstrap 完成

---

## 4. Skills 系统

### 4.1 核心设计："Prompt-as-Skill"

OpenClaw 的 Skill **不是可执行代码**，而是**结构化的 Prompt 注入**。每个 Skill 由一个 `SKILL.md` 文件定义：

```markdown
---
name: session-logs
description: "Search and analyze your own session logs..."
---

# Session Logs Skill
...（完整指令）
```

模型在 system prompt 中看到 skill 目录（name + description + location），按需用 `read` 工具加载完整内容。

### 4.2 多来源层级加载

6 个来源按优先级从低到高，后加载覆盖前：

```
extra (配置额外目录)
  → bundled (内置 skills/)
    → managed (~/.openclaw/skills/)
      → agents-skills-personal (~/.agents/skills/)
        → agents-skills-project (<workspace>/.agents/skills/)
          → workspace (<workspace>/skills/)
```

### 4.3 Token 预算管理

System prompt 中 skill 部分有严格的 token 预算：

- `maxSkillsInPrompt`：最多 150 个 skill
- `maxSkillsPromptChars`：最多 18,000 字符

三级降级策略：
1. **完整格式**：name + description + location（XML）
2. **紧凑格式**：只有 name + location
3. **二分截断**：找到最大可容纳数量

### 4.4 记忆相关的 Skill

| Skill | 机制 | 跨会话能力 |
|-------|------|-----------|
| **session-logs** | 告诉模型 JSONL 文件位置，用 jq/rg 查询 | 可搜索所有历史会话 |
| **summarize** | 委托外部 CLI 工具 | 摘要外部内容 |
| **oracle** | 发送给第二模型审查 | 支持 session 持久化 |
| **obsidian** | 读写 Obsidian vault | 可持久化笔记 |
| **notion** | 通过 CLI 操作 Notion | 可持久化到 Notion |
| **coding-agent** | 委托编码任务给 Codex/Claude Code | 后台 worker + 完成通知 |

Skill 本身**不提供记忆**——它们提供读写外部持久化存储的能力。

### 4.5 安全模型

四层防护：
1. **安装时**：`scanSkillInstallSource` 静态扫描（检测 eval、child_process、exfiltration 等）
2. **加载时**：`resolveContainedSkillPath` 路径逃逸检查
3. **运行时**：`resolveSkillDispatchTools` 11 层工具策略管线
4. **审计时**：workspace-audit（symlink 逃逸检测）+ ClawHub 安全审查

---

## 5. Session/Cross-session 管理

### 5.1 Session 生命周期

```
创建 → 运行（ingest messages, assemble context, compaction）
    → 挂起（suspension）
    → 恢复（resume）
    → 归档（archive）
    → 清理（cleanup）
```

关键文件：
- `session-id.ts`：session ID 生成和解析
- `session-lifecycle-events.ts`：生命周期事件（start/stop/compaction）
- `session-write-lock.ts`：并发写入锁
- `session-suspension.ts`：session 挂起/恢复

### 5.2 跨会话记忆机制

OpenClaw 的跨会话记忆通过**多个机制协同**实现：

#### 5.2.1 MEMORY.md（文件即记忆）

`src/memory/root-memory-files.ts` 定义了 workspace 根目录的 `MEMORY.md` 文件：

- 存放路径：`<workspace>/MEMORY.md`
- 用途：持久化用户偏好和行为指引
- 在 system prompt 中注入："MEMORY.md: durable user preferences and behavior guidance"
- 作为 context file 排序权重 70（最高优先级的上下文文件之一）

#### 5.2.2 Memory Search（向量搜索）

`src/agents/memory-search.ts` 实现了一个完整的**向量搜索记忆系统**：

**存储**：
- SQLite 数据库：`~/.openclaw/memory/<agentId>.sqlite`
- FTS5 全文搜索 + 向量搜索（hybrid）
- 支持 OpenAI、本地模型等多种 embedding provider

**数据源**：
- `memory`：MEMORY.md 等文件
- `sessions`：历史会话（实验性，`experimental.sessionMemory`）

**Chunking 策略**：
- 默认 chunk 大小：400 token
- 重叠：80 token
- 安全 sanitization：过滤 toolResult.details 和 runtime-context 消息

**查询参数**：
```typescript
maxResults: 6           // 最多返回 6 个结果
minScore: 0.35          // 最低相似度阈值
vectorWeight: 0.7       // 向量搜索权重 70%
textWeight: 0.3         // 文本搜索权重 30%
candidateMultiplier: 4  // 候选集放大倍数
```

**同步策略**：
- `onSessionStart`：session 开始时同步
- `onSearch`：搜索前同步
- `watch`：文件监视实时同步
- `intervalMinutes`：定时同步（默认关闭）
- `sessions.deltaBytes: 100KB` / `deltaMessages: 50`：session 增量同步阈值
- `postCompactionForce: true`：压缩后强制同步

**高级特性**：
- MMR（Maximal Marginal Relevance）：多样性去重，lambda=0.7
- Temporal Decay：时间衰减，半衰期 30 天（默认关闭）
- Multimodal：支持多模态 embedding（实验性）

#### 5.2.3 Session Logs

`skills/session-logs/SKILL.md` 让模型可以搜索自己的历史会话 JSONL 文件。这不是自动的——模型需要主动用 `read` + `exec(jq/rg)` 来查询。

#### 5.2.4 Context Files

workspace 中的持久化文件作为跨会话知识载体：

| 文件 | 权重 | 用途 |
|------|------|------|
| AGENTS.md | 10 | Agent 指令 |
| SOUL.md | 20 | 人格/语调 |
| IDENTITY.md | 30 | 身份信息 |
| USER.md | 40 | 用户偏好 |
| TOOLS.md | 50 | 工具使用指引 |
| BOOTSTRAP.md | 60 | 初始化流程 |
| MEMORY.md | 70 | 持久化记忆 |
| HEARTBEAT.md | dynamic | 心跳任务 |

### 5.3 Trajectory 系统

`src/trajectory/` 实现了会话轨迹的导出和分析：

```typescript
type TrajectoryEvent = {
  traceSchema: "openclaw-trajectory";
  schemaVersion: 1;
  traceId: string;
  source: "runtime" | "transcript" | "export";
  type: string;
  sessionId: string;
  provider?: string;
  modelId?: string;
  data?: Record<string, unknown>;
};
```

Trajectory 用于调试、审计和回放，不直接影响上下文管理。

### 5.4 OS Summary

`src/infra/os-summary.ts` 提供运行环境信息，注入 system prompt 的 runtime 部分：

```typescript
type OsSummary = {
  platform: NodeJS.Platform;
  arch: string;        // x64, arm64
  release: string;
  label: string;       // "macos 15.5 (arm64)"
};
```

带缓存，只在进程生命周期内计算一次。

---

## 6. 与 Pi 的 infinite-context 功能对比

### 6.1 架构对比

| 维度 | OpenClaw | Pi (infinite-context) |
|------|----------|----------------------|
| **上下文管理** | 可插拔 ContextEngine 接口 | 内置无限上下文方案 |
| **压缩策略** | LLM-based compaction（多级容错） | 依赖底层模型的上下文处理 |
| **摘要生成** | 使用同一模型 + 自定义指令 | — |
| **记忆系统** | SQLite 向量搜索 + FTS hybrid | — |
| **跨会话** | MEMORY.md + 向量搜索 + session logs | — |
| **Prompt Cache** | 精心设计的 stable/dynamic 分割 | — |
| **Skill 系统** | 58 内置 + ClawHub 市场 | 内置 skills 目录 |
| **Token 估算** | chars/4 + 1.2x 安全余量 | — |

### 6.2 上下文窗口管理对比

| 策略 | OpenClaw | Pi |
|------|----------|-----|
| **溢出检测** | Context Window Guard（hard/warn 阈值） | — |
| **溢出处理** | Compaction（摘要替换历史） | — |
| **预算分配** | 50% 历史 + 50% prompt（可配置） | — |
| **安全余量** | 1.2x（20% buffer） | — |
| **最小预算** | 8000 token / 50% context window | — |

### 6.3 Compaction 细节对比

OpenClaw 的 compaction 是一个**生产级的容错系统**：

1. **主路径**：分块 → 逐块摘要 → 合并
2. **容错 1**：排除超大消息后重试
3. **容错 2**：使用部分摘要 + 标注
4. **容错 3**：兜底文本 "Context contained N messages, summary unavailable"
5. **重试**：每块 3 次重试，指数退避

这种多级容错设计值得借鉴。

---

## 7. 可借鉴的设计

### 7.1 Context Engine 可插拔架构

`ContextEngine` 接口的设计非常优雅——将上下文管理抽象为 bootstrap → ingest → assemble → compact → maintain 的完整生命周期，支持自定义实现。这允许：
- 默认使用 transcript + compaction
- 切换到 RAG-based 方案
- 实验新的上下文策略

### 7.2 Compaction 的多级容错

从完整摘要 → 排除超大消息 → 部分摘要 → 兜底文本，每一级都有合理的降级策略。特别是：
- `partialSummary` 的传播：某块失败时，已成功的块的摘要不会丢失
- `oversized` 检测：单条消息超过 context window 50% 时自动排除
- `repairToolUseResultPairing`：裁剪后自动修复 tool call 配对

### 7.3 Prompt Cache 稳定性设计

System Prompt 的 stable prefix + dynamic suffix 分割是 Anthropic prompt cache 的最佳实践：
- Stable prefix 在连续 turn 间保持不变，命中 cache
- Dynamic suffix 包含时间、运行时信息等变化内容
- 使用 SHA-256 hash 缓存 stable prefix 的构建结果

### 7.4 Identifier Preservation

LLM 摘要时保留所有标识符（UUID、hostname、文件路径等）是一个重要的工程细节。没有这个机制，压缩后的对话中标识符可能被"改写"，导致后续工具调用失败。

### 7.5 Memory Search 的 Hybrid 方案

FTS + 向量搜索的 hybrid 方案（70% 向量 + 30% 文本）是一个务实的平衡：
- 向量搜索捕获语义相似性
- FTS 确保精确关键词匹配不遗漏
- MMR 去重避免返回高度重复的结果

### 7.6 "文件即记忆" 模式

MEMORY.md / SOUL.md 等文件作为跨会话知识的载体，简单直接：
- 人类可读可编辑
- Git 可追踪
- 不依赖额外的数据库或服务

### 7.7 Tool Call Pairing 修复

压缩后自动修复 tool_use/tool_result 的配对关系（`repairToolUseResultPairing`），处理孤立 tool result 被 API 拒绝的问题。这是 compaction 系统中容易被忽视但至关重要的细节。

### 7.8 Session Compaction 后强制同步记忆

`postCompactionForce: true` 确保每次压缩后，新生成的摘要会立即同步到 memory search 索引。这避免了"压缩了但记忆搜索还是旧数据"的 stale data 问题。

---

## 8. 不足之处

### 8.1 Token 估算粗糙

使用 `chars/4` 启发式估算 token 数，即使用 1.2x 安全余量补偿，仍然不够精确。特别是：
- 多字节字符（中文、日文）严重低估
- 代码中的特殊 token（缩进、注释符号）不准确
- 没有使用 tiktoken 等专业 tokenizer

### 8.2 Compaction 摘要质量不可控

LLM 生成的摘要质量高度依赖模型能力和 prompt 设计：
- 摘要可能丢失关键细节（即使有 identifier preservation）
- 多次递归压缩会导致信息逐级损失
- 没有摘要质量的自动评估机制

### 8.3 Memory Search 配置过于复杂

`ResolvedMemorySearchConfig` 有 40+ 个配置项，包括 embedding provider、chunking、sync、query、hybrid、cache 等多个子维度。默认值虽然合理，但自定义配置门槛很高。

### 8.4 Context Engine 的 legacy 实现过于庞大

legacy engine 承载了所有默认行为，与 agent runner 深度耦合。虽然接口设计优雅，但实际替换引擎需要理解大量内部状态。

### 8.5 没有结构化记忆提取

Memory 系统依赖用户手动维护 MEMORY.md 或依赖向量搜索从历史对话中检索。缺少：
- 自动从对话中提取结构化知识（用户偏好、项目信息、决策记录等）
- 知识图谱或实体关系的构建
- 主动遗忘机制（过时信息的淘汰）

### 8.6 Session Logs 搜索过于原始

模型需要用 `jq` + `rg` 手动搜索 JSONL 文件，这：
- 依赖模型对 jq 语法的掌握
- 搜索效率低（全表扫描）
- 无法做语义搜索

### 8.7 缺乏跨 Agent 记忆共享

每个 Agent 有独立的 memory 数据库和 session 历史，没有跨 Agent 的知识共享机制。如果用户在多个 Agent 之间切换，知识无法自然传递。

### 8.8 Compaction 的递归损失

多轮 compaction 会产生"摘要的摘要"，信息逐级损失。没有机制检测或缓解这种递归损失（比如保留原始 transcript 的关键片段而非只保留摘要）。

### 8.9 System Prompt 构建复杂度

`buildAgentSystemPrompt` 函数超过 1300 行，包含大量条件分支和 prompt 模板。维护成本高，且难以预测最终 prompt 的确切内容和 token 数量。

---

## 附录：关键文件索引

| 模块 | 关键文件 | 行数 |
|------|---------|------|
| **Compaction** | `src/agents/compaction.ts` | ~430 |
| **Compaction Planning** | `src/agents/compaction-planning.ts` | ~390 |
| **Context Engine Types** | `src/context-engine/types.ts` | ~387 |
| **System Prompt** | `src/agents/system-prompt.ts` | ~1360 |
| **Memory Search Config** | `src/agents/memory-search.ts` | ~380 |
| **Context Window Guard** | `src/agents/context-window-guard.ts` | ~190 |
| **Context Window Resolution** | `src/agents/context.ts` | ~360 |
| **Transcript Summary** | `src/transcripts/summary.ts` | ~90 |
| **Transcript Store** | `src/transcripts/store.ts` | ~270 |
| **Root Memory Files** | `src/memory/root-memory-files.ts` | ~70 |
| **Agent Compaction Constants** | `src/agents/agent-compaction-constants.ts` | ~15 |
