# Coding Agent 上下文管理实现调研

> 调研日期：2026-05-31
> 调研范围：Claude Code、Aider、Qwen Code、OpenCode 的上下文管理源码
> 调研目标：理解各工具的上下文压缩、代码索引、跨会话记忆实现，为 Pi infinite-context 设计提供参考

---

## 目录

1. [Claude Code — 渐进式压缩架构](#1-claude-code)
2. [Aider — RepoMap 图排序](#2-aider)
3. [Qwen Code — 结构化压缩与 Markdown 记忆](#3-qwen-code)
4. [OpenCode — 简洁截断式摘要](#4-opencode)
5. [横向对比](#5-横向对比)
6. [对 Pi infinite-context 的启示](#6-对-pi-infinite-context-的启示)

---

## 1. Claude Code

> 源码路径：`~/GitApp/claude-code-source-code/`
> 关键目录：`src/services/compact/`、`src/services/SessionMemory/`、`src/services/extractMemories/`

### 1.1 架构总览

Claude Code 采用**五级渐进式压缩**策略，从零成本客户端清理到高成本 LLM 摘要：

```
Level 0: Time-Based MicroCompact  — 客户端清空旧 tool_result，零 API 调用
Level 1: Cached MicroCompact      — cache_edits API 删除，不破坏缓存前缀
Level 2: API Context Management   — 服务端原生清除 thinking/tool 内容
Level 3: SessionMemory Compact    — 结构化记忆文件替代 LLM 摘要（实验性）
Level 4: Full Compact             — LLM 生成完整摘要，成本最高但保真度最高
```

### 1.2 压缩触发条件（`autoCompact.ts`）

| 常量 | 值 | 含义 |
|------|-----|------|
| `AUTOCOMPACT_BUFFER_TOKENS` | 13,000 | 自动触发缓冲 |
| `WARNING_THRESHOLD_BUFFER_TOKENS` | 20,000 | 警告阈值缓冲 |
| `MAX_OUTPUT_TOKENS_FOR_SUMMARY` | 20,000 | 摘要输出预留 |
| `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` | 3 | 连续失败熔断器 |

以 200K 窗口为例：
- 有效窗口 = 200,000 - 20,000 = 180,000
- 自动触发阈值 = 180,000 - 13,000 ≈ **167,000（93% 使用率）**

触发排除条件：
- compact/session_memory 查询源（递归防护）
- 用户禁用 autoCompact
- 连续失败 ≥ 3 次（熔断器）

### 1.3 Full Compact 流程（`compact.ts`）

核心数据流：

```
输入: messages[] + context
  │
  ├─ 1. 执行 PreCompact Hooks
  ├─ 2. stripImagesFromMessages() — 图片→[image] 文本标记
  ├─ 3. stripReinjectedAttachments() — 去掉会被重新注入的附件
  ├─ 4. streamCompactSummary() — 流式调用 LLM 生成摘要
  │      ├─ 优先: runForkedAgent() 复用主线程 prompt cache
  │      └─ 降级: queryModelWithStreaming()
  ├─ 5. PTL 重试循环（truncateHeadForPTLRetry，最多 3 次）
  ├─ 6. 创建 post-compact 附件（文件/skill/plan/delta）
  ├─ 7. 执行 SessionStart Hooks
  └─ 8. 创建 boundary 标记 + summary 消息
```

摘要 Prompt 要求模型输出 9 个结构化段落：

1. Primary Request and Intent — 用户请求和意图
2. Key Technical Concepts — 技术概念
3. Files and Code Sections — 文件和代码段
4. Errors and fixes — 错误与修复
5. Problem Solving — 问题解决过程
6. All user messages — 所有用户消息
7. Pending Tasks — 待办任务
8. Current Work — 当前工作详情
9. Optional Next Step — 下一步

**Post-Compact 附件重建**：

| 附件类型 | 限制 |
|----------|------|
| 最近读取的文件 | 最多 5 个，每个 ≤5,000 token |
| Skill 内容 | 总 ≤25,000 token，单个 ≤5,000 token |
| Plan 文件 | 不限 |

### 1.4 MicroCompact（`microCompact.ts`）

不调用 LLM，直接清空旧 tool_result 内容。三种策略按优先级：

1. **Time-Based MC** — 距上次 assistant > 60min（缓存已冷）→ 直接清空
2. **Cached MC**（Anthropic only）— 用 cache_edits API 删除（缓存还热）
3. 无降级 → 交给 autocompact

可压缩的工具集：`Read, Bash, Grep, Glob, WebSearch, WebFetch, Edit, Write`

Time-Based MC 配置：
- `gapThresholdMinutes: 60`（距上次响应超过 60 分钟）
- `keepRecent: 5`（保留最近 5 条 tool_result）
- 清空文本：`[Old tool result content cleared]`

### 1.5 API MicroCompact（`apiMicrocompact.ts`）

利用 Anthropic API 原生 `context_management.edits` 能力：

| 策略 | 触发阈值 | 行为 |
|------|---------|------|
| `clear_thinking` | 始终 | 清除 thinking 块（保留最近 1 轮） |
| `clear_tool_uses`（结果） | input ≥ 180K | 清除 Bash/Glob/Grep/Read 等结果 |
| `clear_tool_uses`（调用） | input ≥ 180K | 清除非 Edit/Write 的调用 |

### 1.6 消息分组策略（`grouping.ts`）

分组边界：**assistant 消息的 `message.id` 变化**。同一个 API 流式响应中的多个 content block 共享相同 `id`，粒度比"按用户消息分组"更细。

### 1.7 会话记忆系统

双层记忆架构：

```
┌──────────────────────────────────────┐
│  SessionMemory（会话级）              │
│  - 触发: token 阈值 + 工具调用数     │
│  - 存储: Markdown，10 个 section     │
│  - 上限: 总 12,000 / section 2,000   │
│  - 生命周期: 随会话结束消失          │
├──────────────────────────────────────┤
│  extractMemories（持久级）            │
│  - 触发: 每个查询循环结束            │
│  - 存储: memdir 目录，每主题一个 .md │
│  - 索引: MEMORY.md（200 行上限）     │
│  - 生命周期: 永久                    │
└──────────────────────────────────────┘
```

SessionMemory 的 10 个 Section：

| Section | 用途 |
|---------|------|
| Session Title | 5-10 词信息密集标题 |
| Current State | 正在做什么、待办、下一步 |
| Task specification | 用户要求构建什么 |
| Files and Functions | 重要文件及作用 |
| Workflow | 常用命令和执行顺序 |
| Errors & Corrections | 错误和修复方式 |
| Codebase Documentation | 系统组件和工作原理 |
| Learnings | 经验教训 |
| Key results | 精确输出结果 |
| Worklog | 步骤级工作日志 |

SessionMemory Compact 是实验性策略，用记忆文件替代 LLM 摘要，**不需要额外 API 调用**。配置：
- `minTokens: 10,000`（保留至少 10K）
- `maxTokens: 40,000`（最多保留 40K）

### 1.8 持久记忆（`extractMemories`）

每个查询循环结束时运行，提取持久记忆写入 `~/.claude/projects/<path>/memory/`。

写入流程（两步法）：
1. 写记忆文件（如 `user_role.md`、`feedback_testing.md`）— frontmatter 格式
2. 更新 `MEMORY.md` 索引 — 每条一行 ≤150 字符，超 200 行截断

互斥设计：主 agent 和 forked agent 对记忆写入互斥（扫描 assistant 消息中的 Edit/Write tool_use 目标路径）。

### 1.9 Token 计算策略

| 场景 | 方法 | 精度 | 成本 |
|------|------|------|------|
| Autocompact 阈值检查 | `tokenCountWithEstimation()` | 精确+估算混合 | 零 |
| `/context` 命令 | `countMessagesTokensWithAPI()` | 精确 | API 调用 |
| MicroCompact 估算 | `roughTokenCountEstimation()` | 粗估（字符/4） | 零 |

计算公式：
- 完整 = `input_tokens + cache_creation + cache_read + output_tokens`
- 粗估 = 4 字节 ≈ 1 token，JSON 文件 2 字节 ≈ 1 token，图片/PDF 按 2000 token

### 1.10 CLAUDE.md 注入

加载优先级（从低到高）：

```
1. Managed — /etc/claude-code/CLAUDE.md（管理员策略）
2. User    — ~/.claude/CLAUDE.md（用户全局）
3. Project — CLAUDE.md, .claude/CLAUDE.md, .claude/rules/*.md（项目级）
4. Local   — CLAUDE.local.md（用户私有）
5. AutoMem — memory.md（自动记忆）
6. TeamMem — 团队记忆入口
```

发现方式：从 CWD 向上遍历到根目录，越靠近 CWD 优先级越高。支持 `@include` 指令（最大深度 5 层）。

### 1.11 Agent 记忆

三种作用域：

| 作用域 | 路径 | 生命周期 |
|--------|------|---------|
| `user` | `~/.claude/agent-memory/<agentType>/MEMORY.md` | 跨项目共享 |
| `project` | `.claude/agent-memory/<agentType>/MEMORY.md` | 可 VCS 共享 |
| `local` | `.claude/agent-memory-local/<agentType>/MEMORY.md` | 本地特有 |

快照同步机制：项目仓库 `.claude/agent-memory-snapshots/` 中的快照文件用于新成员初始化和更新提示。

### 1.12 Compact 后清理

| 清理项 | 条件 |
|--------|------|
| `resetMicrocompactState()` | 始终 |
| `getUserContext.cache.clear()` | 仅主线程 |
| `resetGetMemoryFilesCache()` | 仅主线程 |
| `clearSystemPromptSections()` | 始终 |
| `clearClassifierApprovals()` | 始终 |

**故意不清除**：`sentSkillNames`（重新注入约 4K token 是纯 cache_creation 消耗）和已调用的 skill 内容（需跨多次 compact 存活）。

---

## 2. Aider

> 源码路径：`~/GitApp/aider/`
> 关键文件：`aider/repomap.py`、`aider/coders/base_coder.py`、`aider/coders/chat_chunks.py`

### 2.1 架构总览

Aider 的核心创新是 **RepoMap**——用 PageRank 算法对代码标识符进行重要性排序，生成压缩的代码地图。

```
源代码文件 → tree-sitter AST 解析 → PageRank 图排序 → 智能二分截断 → 压缩的代码地图
```

### 2.2 RepoMap 第一阶段：tree-sitter AST 提取（`get_tags_raw`）

流程：
1. 加载语言的 tree-sitter parser
2. 加载预定义的 tags query（SCM 格式），定义 `name.definition.class`、`name.definition.function`、`name.reference.call` 等捕获规则
3. 解析 AST 并运行 query，将 capture 分为 `def`（定义）和 `ref`（引用）两类

降级策略：某些语言（如 C++）的 SCM 只有 `def` 没有 `ref`，此时回退到 **Pygments** 词法分析补全引用：

```python
lexer = guess_lexer_for_filename(fname, code)
tokens = [token[1] for token in lexer.get_tokens(code) if token[0] in Token.Name]
```

缓存：每个文件的 tags 结果按 `{fname: {mtime, data}}` 缓存到 SQLite（diskcache），mtime 不变则直接返回。

### 2.3 RepoMap 第二阶段：PageRank 图排序（`get_ranked_tags`）

构建**多边有向图（MultiDiGraph）**，边表示"引用者 → 定义者"关系。

**边权重智能调节**（核心设计）：

| 条件 | 权重倍数 | 设计意图 |
|------|---------|---------|
| 用户提到了该标识符 | 10x | 用户关注的内容更重要 |
| 标识符有意义的命名（≥8 字符，snake/camel） | 10x | 过滤 `i`, `x` 等低价值标识符 |
| 下划线开头（私有） | 0.1x | 降权内部实现 |
| 被 >5 个文件定义（通用名） | 0.1x | 降权 `get/set/run` 等 |
| 引用者在 chat_files 中 | 50x | 当前编辑文件的依赖最重要 |
| 引用次数 | √n | 防止高频低价值标识符主导 |

**Personalization PageRank**：为 chat_files、mentioned_fnames 等节点设置更高的初始权重。

**从节点排名到定义排名**：将每个节点的 PageRank 分数沿出边按权重比例分配到具体的定义上。

### 2.4 RepoMap 第三阶段：智能截断与渲染

**二分搜索找到最优 tag 数量**：

```python
while lower_bound <= upper_bound:
    tree = self.to_tree(ranked_tags[:middle])
    num_tokens = self.token_count(tree)
    pct_err = abs(num_tokens - max_map_tokens) / max_map_tokens
    if pct_err < 0.15:  # 15% 误差内接受
        break
```

**渲染**（`TreeContext`）：对每个文件，只显示有 tag 的行及其上下文，单行截断 100 字符。

**Token 计数优化**：大文件时采样 1/100 的行估算。

### 2.5 Token 预算分配

| 分块 | Token 预算 | 占比（128K 窗口） | 说明 |
|------|-----------|------------------|------|
| System prompt | ~1-3K | 2% | 编辑格式指令 |
| Repo map | 1-4K | 1-3% | `max_input_tokens / 8`，上限 4096 |
| Chat files | 不定 | 变动大 | 用户添加的文件全文 |
| Done messages | 1-8K | 1-6% | `max_input_tokens / 16`，上限 8192 |
| Cur messages | 不定 | 变动大 | 当前轮对话 |
| Reminder | ~0.5K | <1% | 仅在有余量时追加 |
| **预留给 output** | 剩余 | **~85%+** | LLM 生成的代码修改 |

Repo Map 无 chat 文件时放大 8 倍（`map_mul_no_files: 8`），但不超过 `contextWindow - 4096`。

### 2.6 ChatChunks 分块策略

```python
@dataclass
class ChatChunks:
    system: List          # 系统提示词
    examples: List        # few-shot 示例
    done: List            # 历史对话
    repo: List            # repo map
    readonly_files: List  # 只读文件内容
    chat_files: List      # 可编辑文件内容
    cur: List             # 当前对话轮次
    reminder: List        # 提醒提示词
```

组装顺序利用 LLM 的 **primacy bias**（开头）和 **recency bias**（末尾）：

```
system → examples → readonly_files → repo → done → chat_files → cur → reminder
```

**Prompt Cache 优化**（Anthropic）：按稳定性从高到低在分块边界放置 cache breakpoints：

```
cache_control: examples → repo → chat_files
```

### 2.7 历史消息压缩（`history.py::ChatSummary`）

触发阈值：`max_chat_history_tokens = min(max(max_input_tokens / 16, 1024), 8192)`

**两级分割策略**：

```
1. 从尾部累加，找到占预算一半的分割点
2. head（较早对话）→ LLM 生成摘要
3. tail（最近对话）→ 原样保留
4. 如果 summary + tail 仍超限 → 递归压缩（最多 3 层）
```

**后台异步执行**：`summarize_start()` 在后台线程中执行摘要，`summarize_end()` 在下次 `format_chat_chunks` 时等待结果。

摘要提示词关键要求：
- 用第一人称复述（"I asked you..."）
- 包含函数名、库名、包名
- 包含代码块中的文件名
- 旧部分少细节，新部分多细节

### 2.8 Architect 模式的两阶段上下文

```
Stage 1: ArchitectCoder（强模型）
  上下文: system + repo_map + chat_files
  任务: 理解需求，设计修改方案
  输出: 纯文本修改描述
      ↓ 自动流转
Stage 2: EditorCoder（可以是不同模型）
  上下文: 只包含 architect 的输出 + chat_files
  注意: 无 repo_map，无历史对话
  任务: 按 architect 指示精确编辑代码
```

**上下文隔离设计**：
- Architect 看到完整的 repo map + 历史对话，负责高层决策
- Editor 只看到文件全文 + architect 指令，专注精确编辑
- 两个阶段的 token 预算完全独立

### 2.9 ContextCoder 反射式文件选择

不做代码编辑，唯一任务是**决定哪些文件应该纳入上下文**：
- 强制每次刷新 repo map，并扩大预算 8 倍
- 反射循环：让 LLM 列出需要的文件 → 更新 chat_files → 再问 LLM → 直到收敛

### 2.10 关键常量汇总

| 常量 | 值 | 作用 |
|------|-----|------|
| `map_mul_no_files` | 8 | 无 chat 文件时 repo map 放大倍数 |
| `padding` | 4096 | 给其他内容预留空间 |
| 二分截断误差 | 15% | token 数与目标的可接受偏差 |
| `max_chat_history_tokens` | [1024, 8192] | 历史消息摘要后 token 上限 |
| `max_reflections` | 3 | 最大反射（重试）次数 |
| ident 提权（chat_files 引用） | 50x | 当前编辑文件引用的标识符权重 |
| ident 降权（私有 `_`） | 0.1x | 下划线开头的标识符降权 |
| ident 降权（通用名） | 0.1x | 被 >5 文件定义的标识符降权 |

### 2.11 RepoMap 缓存

三级缓存：

```
Level 1: map_cache → 完整 repo map 文本（处理时间 > 1s 时启用）
Level 2: TAGS_CACHE → 每文件 tags 结果（SQLite diskcache，mtime 失效）
Level 3: tree_cache → TreeContext 渲染结果（mtime + lois 变化失效）
```

---

## 3. Qwen Code

> 源码路径：`~/GitApp/qwen-code/`
> 关键目录：`packages/core/src/core/`、`packages/core/src/tools/`

### 3.1 架构总览

```
用户输入
  ↓
GeminiClient.sendMessageStream()          ← 客户端层
  ├── 思考块空闲清理（>5min → 保留最近1轮）
  ├── ChatCompressionService.compress()   ← 压缩判断 + 执行
  ├── IDE Context 增量注入
  ├── System Reminders 动态追加
  └── Turn.run() → ContentGenerator       ← 实际 API 调用
```

所有模型通过统一 `ContentGenerator` 接口暴露，使用 `@google/genai` 的 Gemini 类型作为通用中间格式：

```
ContentGenerator (统一接口)
  ├── OpenAIContentGenerator    → OpenAI 兼容 API
  ├── AnthropicContentGenerator → Claude 系列
  ├── GeminiContentGenerator    → Gemini / Vertex AI
  └── QwenContentGenerator      → Qwen OAuth 模式
```

### 3.2 Token 预算分配

关键常量：

| 常量 | 值 | 说明 |
|------|-----|------|
| `DEFAULT_TOKEN_LIMIT` | 131,072 | 128K 默认输入 |
| `CAPPED_DEFAULT_MAX_TOKENS` | 8,000 | 输出封顶 |
| `ESCALATED_MAX_TOKENS` | 64,000 | 截断后自动升档 |

模型输入限制示例：Gemini/Qwen3 1M、GPT-5.x 272K、Claude 200K、DeepSeek 128K。

输出 Token 两级策略：
- 默认 8K（99% 输出 < 5K token，32K 默认值过度预留 GPU 槽位）
- 被截断后自动升档到 64K（仅触发一次）

### 3.3 对话压缩策略（`chatCompressionService.ts`）

三层保护机制：

| 层级 | 阈值 | 行为 |
|------|------|------|
| **压缩** | 70% × contextWindowSize | 自动将旧历史总结为 XML 快照 |
| **会话限制** | 用户可配置 `sessionTokenLimit` | 超限终止会话 |
| **轮次限制** | `maxSessionTurns` + 硬上限 100 | 超限停止 agent loop |

**压缩流程**：

```
1. 检查 currentTokens < 70% × contextWindow → NOOP
2. 按字符数分割（非 token，避免额外 API）
   - 从前往后累积，找 ≥70% 字符数的最近 user 边界
   - 分为 [待压缩 70%] + [保留 30%]
3. 调用 LLM 生成结构化 XML 摘要
4. 压缩后历史结构：
   [user: <state_snapshot> 摘要]
   → [model: "Got it. Thanks for the additional context!"]
   → [保留的最近 30% 历史]
```

**压缩 Prompt 要求生成结构化 XML**：

```xml
<state_snapshot>
  <overall_goal><!-- 一句话目标 --></overall_goal>
  <key_knowledge><!-- 关键知识 --></key_knowledge>
  <file_system_state><!-- 文件状态 --></file_system_state>
  <recent_actions><!-- 最近操作 --></recent_actions>
  <current_plan><!-- 当前计划 --></current_plan>
</state_snapshot>
```

**压缩失败处理**：失败后设置 `hasFailedCompressionAttempt = true`，阻止后续自动压缩（防振荡），但 `/compress`（force=true）仍可手动触发。

### 3.4 Thinking 块管理

```
空闲 < 5 分钟：保留所有 thinking blocks（推理连贯性）
空闲 > 5 分钟：锁存 thinkingClearLatched = true（不可逆）
  → 每次新查询前仅保留最近 1 轮 thinking
  → 锁存器仅在 /clear 时重置
```

### 3.5 Memory Tool（跨会话记忆）

**存储机制：Markdown 文件区段操作**

```
全局范围：~/.qwen/QWEN.md
项目范围：./QWEN.md（当前工作目录）
```

写入区段：`## Qwen Added Memories`

```markdown
## Qwen Added Memories
- 我偏好暗色主题
- 使用 TypeScript 严格模式
```

**关键发现：只有 `save_memory`（写入），没有 `read_memory`（读取）。**

记忆读取通过 **QWEN.md 文件自动注入系统上下文**实现。`loadServerHierarchicalMemory()` 执行层级文件发现：

```
~/.qwen/QWEN.md (全局)
  ↓ 向上扫描
CWD → ... → 项目根目录(.git) 下的所有 QWEN.md
  ↓ 并行读取（每批 20 个文件）
  ↓ 处理 @import 指令
  ↓ 拼接为带来源标记的字符串
```

设计评价：

| 优点 | 缺点 |
|------|------|
| 人类可读可编辑 | 无结构化查询能力 |
| 与上下文注入统一 | 所有记忆每次都发，浪费 token |
| 无额外依赖 | 集成测试 skip（模型意图识别不稳定） |

### 3.6 各模型适配器差异

| 维度 | OpenAI | Anthropic | Gemini |
|------|--------|-----------|--------|
| **架构** | 三层（Generator→Pipeline→Provider） | 两层（Generator+Converter） | 单层（原生 SDK） |
| **Token 计数** | 客户端估算（字符/4） | 客户端估算（字符/4） | API 调用（精确） |
| **Thinking** | 透传 reasoning 对象 | 完整支持（budget/signature） | thinkingLevel |
| **Prompt Cache** | 无 | cache_control | 由 SDK 处理 |

Anthropic Thinking 配置：low=16K、medium=32K、high=64K budget_tokens。

### 3.7 Subagent 上下文隔离

| 维度 | 机制 |
|------|------|
| **模型隔离** | 原型链 Config 副本，不同 agent 可用不同模型 |
| **工具隔离** | `tools[]` 白名单 |
| **会话隔离** | 每次 `execute()` 创建独立 Chat + AbortController |

五级存储优先级：`session > project > user > extension > builtin`

### 3.8 重试机制

| 重试类型 | 条件 | 最大次数 | 延迟 |
|---------|------|---------|------|
| 内容重试 | 无效响应 | 2 | 500ms |
| 限流重试 | 429/TPM | 10 | 60s（固定） |
| 流异常重试 | 无 finish reason | 2 | 2s × 重试次数 |

---

## 4. OpenCode

> 源码路径：`~/GitApp/opencode-ai/`
> 关键文件：`internal/llm/agent/agent.go`、`internal/llm/prompt/summarizer.go`

### 4.1 架构总览

```
TUI 层 (autoCompact 触发)
  → Agent 层 (Summarize 方法 / 消息截断)
    → Provider 层 (消息清洗 + 发送)
      → Prompt 层 (系统提示词 + 项目上下文)
        → Model 层 (ContextWindow 定义)
```

### 4.2 Summarizer（摘要器）

摘要提示词（所有模型共用）：

```
Focus on information helpful for continuing the conversation:
- What was done
- What is currently being worked on
- Which files are being modified
- What needs to be done next
```

**摘要执行流程**：

```
1. 获取会话所有消息
2. 将全部消息 + 摘要提示词 → summarizeProvider.SendMessages()
   - 不传任何工具（纯文本生成）
   - summarizeProvider 可配置与主 agent 不同的模型
3. 生成摘要文本
4. 在原会话中创建一条 Assistant 类型摘要消息
5. session.SummaryMessageID 指向该消息
```

**摘要消费（上下文截断）**：

```go
// 加载会话后，如果存在 SummaryMessageID
if session.SummaryMessageID != "" {
    msgs = msgs[summaryMsgIndex:]  // 截断：只保留摘要之后的消息
    msgs[0].Role = message.User    // 摘要消息角色改为 User
}
```

**核心设计**：压缩是一次性的不可逆操作。原始对话从上下文中移除，但消息仍保留在 SQLite 数据库中。

### 4.3 AutoCompact 自动触发

```go
// 触发条件
tokens >= int64(float64(contextWindow) * 0.95) && config.Get().AutoCompact

// Token 计算（累加）
sess.CompletionTokens = usage.OutputTokens + usage.CacheReadTokens
sess.PromptTokens = usage.InputTokens + usage.CacheCreationTokens
```

**阈值**：PromptTokens + CompletionTokens ≥ ContextWindow × 0.95

**问题**：累加值不反映当前上下文实际 token 数。摘要后 `PromptTokens` 被重置为 0，但此前的累加不准确。

手动触发：`Ctrl+K` → "Compact Session"

### 4.4 Agent 核心循环

```
processGeneration()
  ├─ 1. messages.List(sessionID)
  ├─ 2. 如果 SummaryMessageID != "" → 截断历史
  ├─ 3. createUserMessage()
  └─ 4. for 循环 (Agent Loop):
       ├─ streamAndHandleEvents(msgHistory)
       ├─ finishReason == tool_use → msgHistory 增长，continue
       └─ 否则返回
```

**关键缺陷**：Agent Loop 中工具调用轮次无限制，上下文线性增长直到 AutoCompact 触发。没有中间层 token 预算管理。

消息清洗仅过滤空消息，没有基于 token 预算的截断、优先级排序或滑动窗口。

### 4.5 模型上下文窗口

| 模型 | ContextWindow | DefaultMaxTokens |
|------|-------------|-----------------|
| Claude 4 Sonnet | 200,000 | 50,000 |
| GPT-4.1 | 1,047,576 | 20,000 |
| Gemini 2.5 Pro | 1,000,000 | 50,000 |
| O3 | 200,000 | — |

MaxTokens 安全上限：不超过 `ContextWindow / 2`。

### 4.6 代码上下文注入

**ContextPaths 扫描的文件**：

```
.github/copilot-instructions.md
.cursorrules, .cursor/rules/
CLAUDE.md, CLAUDE.local.md
opencode.md, opencode.local.md
OpenCode.md, OpenCode.local.md
```

注入方式：仅 Coder 和 Task agent 注入项目上下文。使用 `sync.Once`（进程生命周期内只加载一次）。

环境信息注入：每次创建 Coder 提示词时运行 `ls` 工具获取目录结构，一次性注入。

分厂商提示词：Anthropic 版强调简洁和 Memory，OpenAI 版强调 agent 行为和编码规范。

### 4.7 工具输出截断

```go
const MaxOutputLength = 30000  // bash 输出上限 30KB

// 截断策略：保留首尾各 15KB，中间标注截断行数
func truncateOutput(content string) string {
    halfLength := MaxOutputLength / 2
    start := content[:halfLength]
    end := content[len(content)-halfLength:]
    return fmt.Sprintf("%s\n\n... [%d lines truncated] ...\n\n%s", start, truncatedLinesCount, end)
}
```

### 4.8 跨会话记忆

**唯一的持久化机制：OpenCode.md 文件**

通过系统提示词引导模型使用该文件：
1. 存储常用 bash 命令
2. 记录用户代码风格偏好
3. 维护代码库结构信息

**不存在的机制**：
- 向量数据库 / RAG
- 文件索引 / 代码库索引
- 会话间知识迁移
- 全局用户偏好数据库

### 4.9 关键常量汇总

| 常量 | 值 | 说明 |
|------|-----|------|
| AutoCompact 阈值 | ContextWindow × 0.95 | 触发自动压缩 |
| Bash 输出截断 | 30,000 bytes | 首尾各 15KB |
| Bash 默认超时 | 60,000 ms | 1 分钟 |
| Bash 最大超时 | 600,000 ms | 10 分钟 |
| MaxTokens 兜底 | 4,096 | 全局兜底 |
| Provider 重试次数 | 8 | API 调用重试 |

---

## 5. 横向对比

### 5.1 压缩策略对比

| 维度 | Claude Code | Aider | Qwen Code | OpenCode |
|------|------------|-------|-----------|----------|
| **压缩层级** | 5 级渐进式 | 1 级（后台摘要） | 1 级（70% 阈值压缩） | 1 级（95% 阈值摘要） |
| **触发阈值** | 93% context window | `max_input / 16` 历史上限 | 70% context window | 95% context window |
| **压缩格式** | 自然语言 9 段摘要 | 自然语言摘要 | 结构化 XML `<state_snapshot>` | 自然语言自由摘要 |
| **是否调 LLM** | 是（Full）/ 否（Micro） | 是（弱模型优先） | 是 | 是（独立 provider） |
| **可逆性** | transcript 保留 | 不明 | 不明 | 数据库保留原文 |
| **中间层保护** | Agent Loop 内无 | Agent Loop 内无 | 无 | 无 |
| **Cache 感知** | 深度集成（Fork Agent 复用 cache） | Anthropic cache breakpoints | 仅 Anthropic 适配器 | 无 |

### 5.2 代码上下文管理对比

| 维度 | Claude Code | Aider | Qwen Code | OpenCode |
|------|------------|-------|-----------|----------|
| **代码索引** | 无全局索引，工具按需搜索 | **RepoMap（PageRank）** | 无全局索引，工具按需搜索 | 无全局索引，工具按需搜索 |
| **文件选择** | 用户指定 + LLM 自动添加 | PageRank + 用户 chat_files | 用户指定 | 用户指定 |
| **Token 预算** | 文件恢复 ≤50K | repo map ≤ context/8 | 无显式预算 | 无显式预算 |
| **AST 分析** | 无 | tree-sitter | 无 | 无 |

### 5.3 跨会话记忆对比

| 维度 | Claude Code | Aider | Qwen Code | OpenCode |
|------|------------|-------|-----------|----------|
| **持久化方式** | Markdown 文件 + MEMORY.md 索引 | 无持久化 | Markdown 区段操作 | Markdown 文件 |
| **记忆提取** | 自动（extractMemories） | 无 | LLM 主动调用 save_memory | 手动 |
| **记忆范围** | 全局 + 项目 + 本地 | 无 | 全局 + 项目 | 项目 |
| **Agent 记忆** | 三作用域 + 快照同步 | 无 | 无 | 无 |
| **文件注入** | CLAUDE.md 层级发现 | 无 | QWEN.md 层级发现 | OpenCode.md 单文件 |
| **结构化程度** | 高（10 section 模板） | — | 低（Markdown 列表） | 低（自由文本） |

### 5.4 Token 管理精度对比

| 维度 | Claude Code | Aider | Qwen Code | OpenCode |
|------|------------|-------|-----------|----------|
| **计数方式** | 混合（精确+粗估） | LLM tokenizer + 采样 | Gemini API 精确，其余粗估 | API usage 累加 |
| **实时性** | 较好（最后 API usage + 增量） | 好（每次 token_count） | 好 | 差（累加不准确） |
| **溢出预防** | 是（多级压缩） | 是（后台摘要） | 是（70% 触发压缩） | 弱（95% 才触发） |

### 5.5 架构复杂度对比

| 维度 | Claude Code | Aider | Qwen Code | OpenCode |
|------|------------|-------|-----------|----------|
| **代码量（上下文管理）** | ~15 文件，最复杂 | ~5 核心文件 | ~8 核心文件 | ~5 文件，最简单 |
| **模型支持** | Anthropic 原生 | 多厂商 | 多厂商（统一 Gemini IR） | 多厂商 |
| **Thinking 管理** | API 原生支持 | 无 | 空闲检测 + 锁存 | 无 |
| **Subagent 隔离** | 进程级 | 无 | 原型链 + 工具白名单 | 无 |

---

## 6. 对 Pi infinite-context 的启示

### 6.1 值得借鉴的设计

#### 从 Claude Code

1. **渐进式压缩**：不要只有一种压缩策略。从零成本的客户端清理（清空旧 tool_result）到高成本的 LLM 摘要，按需升级。
2. **Cache 感知设计**：压缩时考虑 prompt cache 命中率。Time-Based MC 在缓存过期后才改内容；Fork Agent 复用主线程 cache。
3. **结构化摘要模板**：9 段摘要模板确保关键信息不丢失，比自由文本摘要更可靠。
4. **双层记忆**：SessionMemory（会话内）+ extractMemories（跨会话），不同生命周期不同策略。
5. **熔断器**：连续失败自动停止，防止压缩本身变成问题。

#### 从 Aider

1. **PageRank 代码地图**：这是最值得借鉴的代码上下文创新。用图排序算法让 LLM 理解代码库结构，而非暴力塞入文件全文。
2. **ChatChunks 分块 + Cache breakpoints**：按稳定性分块，在分块边界放置 cache 控制点。
3. **Architect/Editor 两阶段**：将"理解"和"编辑"的上下文需求解耦，独立管理 token 预算。
4. **后台异步摘要**：不阻塞主流程，在下次需要时等待结果。
5. **弱模型优先摘要**：用便宜模型做摘要，节省成本。

#### 从 Qwen Code

1. **结构化 XML 压缩**：`<state_snapshot>` 比自然语言摘要更结构化，便于后续解析和恢复。
2. **Thinking 块空闲清理**：5 分钟空闲后自动清理旧 thinking，这是其他工具都没有的优化。
3. **输出 Token 两级策略**：默认 8K，截断后自动升档 64K，平衡 GPU 槽位利用和完整性。
4. **统一模型 IR**：所有模型适配器通过统一接口暴露，简化上层代码。

### 6.2 Pi 应避免的陷阱

1. **累加 token 统计**（OpenCode 的问题）：用 `usage.input_tokens + output_tokens` 累加不等于当前上下文的实际 token 数，特别是摘要后。
2. **只在 95% 才触发**（OpenCode 的问题）：太晚了，容易在 agent loop 中间溢出。
3. **sync.Once 加载项目上下文**（OpenCode 的问题）：运行时修改配置文件不会生效。
4. **没有中间层保护**（OpenCode 的问题）：agent loop 中工具调用无限制增长，没有任何中间截断。
5. **全量记忆每次发送**（Qwen Code 的问题）：QWEN.md 所有记忆每次都注入，不按相关性过滤。

### 6.3 建议的 Pi infinite-context 架构

基于以上分析，建议 Pi 的上下文管理采用以下架构：

```
┌──────────────────────────────────────────────────────┐
│  Level 0: Tool Output Expiration                     │
│  - 超时（如 30min）的 tool_result 自动清空           │
│  - 零 API 调用成本                                   │
├──────────────────────────────────────────────────────┤
│  Level 1: Smart Truncation                           │
│  - 按消息优先级截断（system > user > recent tool）   │
│  - 保留最近 N 轮完整，早期仅保留摘要                  │
├──────────────────────────────────────────────────────┤
│  Level 2: Structured Compact                         │
│  - LLM 生成结构化摘要（借鉴 Claude Code 9 段模板）  │
│  - 使用弱模型/便宜模型（借鉴 Aider）                 │
│  - 70% 触发（借鉴 Qwen Code）                        │
├──────────────────────────────────────────────────────┤
│  Level 3: Code Context (RepoMap-like)                │
│  - PageRank 图排序代码标识符（借鉴 Aider）           │
│  - 按相关性动态注入，不暴力全量                       │
├──────────────────────────────────────────────────────┤
│  Memory Layer                                        │
│  - 会话内: SessionMemory 结构化文件                  │
│  - 跨会话: 层级 Markdown（借鉴 Claude Code）         │
│  - 按相关性注入（非全量）                            │
└──────────────────────────────────────────────────────┘
```

关键设计原则：
1. **渐进而非一刀切**：从零成本操作开始，逐步升级到高成本方案
2. **Cache 感知**：压缩策略考虑 prompt cache 命中率
3. **结构化优于自由文本**：摘要模板确保关键信息不丢
4. **分离关注点**：代码理解（RepoMap）vs 对话历史（Compact）vs 持久记忆（Memory）是三个独立问题
5. **70% 触发，95% 兜底**：给压缩留够执行时间，不要等到快溢出才行动
