# Hermes Agent 记忆与上下文管理系统调研

> 调研时间：2026-05-31  
> 源码版本：hermes-agent main 分支（2026年5月）  
> 调研范围：记忆系统、上下文压缩、Skill 自学习、会话搜索、Trajectory 压缩  
> 总分析代码量：~13,300 行

---

## 目录

1. [项目概述](#1-项目概述)
2. [记忆系统架构](#2-记忆系统架构)
3. [上下文压缩机制（核心）](#3-上下文压缩机制核心)
4. [对话压缩流程](#4-对话压缩流程)
5. [Skill 自学习系统](#5-skill-自学习系统)
6. [会话搜索](#6-会话搜索)
7. [Trajectory 压缩](#7-trajectory-压缩)
8. [System Prompt 构建与记忆注入](#8-system-prompt-构建与记忆注入)
9. [与 Pi 的 infinite-context 设计对比](#9-与-pi-的-infinite-context-设计对比)
10. [可借鉴的设计](#10-可借鉴的设计)
11. [不足与不适用之处](#11-不足与不适用之处)

---

## 1. 项目概述

### Hermes 是什么

Hermes Agent 是 Nous Research 出品的 self-improving AI agent，基于 Python 实现。核心卖点是 **"closed learning loop"**——agent 从对话经验中自动创建 skill，跨 session 搜索记忆，构建用户模型，形成一个持续自我改进的闭环。

### 核心设计理念

Hermes 的架构围绕几个关键理念：

1. **持久化记忆**：通过 MemoryManager + pluggable MemoryProvider，将对话经验持久化到外部存储，跨 session 检索
2. **上下文压缩**：用 LLM 做结构化摘要，替代被压缩的消息，保持对话连续性
3. **Skill 自学习**：Curator 从 agent 的对话经验中提取可复用的 skill，形成知识积累
4. **Session 搜索**：FTS5 全文搜索历史会话，让 agent 能回顾过去的解决方案
5. **Profile 隔离**：多 profile 支持独立的记忆、skill、配置空间

### 代码规模

| 模块 | 核心文件 | 代码行数 |
|------|---------|---------|
| 上下文压缩 | `agent/context_compressor.py` | 2,078 |
| 对话压缩 | `agent/conversation_compression.py` | 732 |
| Skill 策展 | `agent/curator.py` | 1,800 |
| 记忆管理 | `agent/memory_manager.py` | 640 |
| 对话循环 | `agent/conversation_loop.py` | 4,707 |
| 会话搜索 | `tools/session_search_tool.py` | 602 |
| Trajectory 压缩 | `trajectory_compressor.py` | 1,508 |
| System Prompt | `agent/system_prompt.py` | 407 |
| 上下文引擎接口 | `agent/context_engine.py` | 226 |

---

## 2. 记忆系统架构

### 2.1 分层设计

Hermes 的记忆系统采用 **策略模式 + 插件模式** 的分层架构：

```
┌──────────────────────────────────────┐
│         MemoryManager                │  ← 统一编排层
│  (orchestrator, 1 builtin + 1 ext)  │
├──────────────────┬───────────────────┤
│  BuiltinProvider │  ExternalProvider │  ← 策略接口
│  (MEMORY.md /    │  (honcho/mem0/    │
│   USER.md)       │   supermemory/    │
│                  │   hindsight/...)  │
└──────────────────┴───────────────────┘
```

**关键设计约束：只允许一个外部 memory provider**。尝试注册第二个外部 provider 会被拒绝，并记录 warning。原因是防止 tool schema 膨胀和 memory backend 冲突。

### 2.2 MemoryProvider ABC

`MemoryProvider`（`agent/memory_provider.py`）定义了完整的 provider 接口：

```python
class MemoryProvider(ABC):
    # 核心生命周期
    is_available() -> bool           # 检查是否可用（不发网络请求）
    initialize(session_id, **kwargs) # 初始化连接/资源
    system_prompt_block() -> str     # 注入 system prompt 的静态文本
    prefetch(query, session_id) -> str    # 预取相关记忆
    sync_turn(user, assistant, ...)       # 同步一个完成的 turn
    get_tool_schemas() -> List[Dict]      # 暴露给模型的 tool schema
    handle_tool_call(name, args) -> str   # 处理 tool 调用
    shutdown()                            # 清理关闭

    # 可选钩子
    on_turn_start(turn_number, message, **kwargs)
    on_session_end(messages)
    on_session_switch(new_session_id, parent_session_id, reset)
    on_pre_compress(messages) -> str      # 压缩前提取洞察
    on_memory_write(action, target, content, metadata)  # 镜像内置记忆写入
    on_delegation(task, result, child_session_id)        # 观察 subagent 工作
```

**设计亮点**：

1. **prefetch + queue_prefetch 分离**：`prefetch()` 在每个 turn 之前调用返回缓存的记忆，`queue_prefetch()` 在 turn 之后触发后台预取下一个 turn 的记忆——实现流水线式记忆检索。

2. **on_pre_compress 钩子**：压缩发生前，provider 有机会从即将被丢弃的消息中提取洞察，返回的文本会被包含在压缩摘要的 prompt 中。

3. **on_session_switch**：当 agent 的 session_id 发生变化（/resume、/branch、/reset、压缩）时通知 provider 刷新缓存状态。

4. **on_delegation**：父 agent 观察 subagent 的任务和结果，即使 subagent 本身没有 provider session（`skip_memory=True`）。

### 2.3 MemoryManager 编排

`MemoryManager`（`agent/memory_manager.py`）是统一的编排层，关键方法：

- `add_provider()`：注册 provider，构建 tool_name → provider 的路由映射
- `build_system_prompt()`：收集所有 provider 的 system prompt block
- `prefetch_all()`：并行收集所有 provider 的预取结果
- `sync_all()`：同步 turn 到所有 provider
- `handle_tool_call()`：根据 tool_name 路由到正确的 provider
- `on_pre_compress()`：收集所有 provider 的压缩前洞察

**StreamingContextScrubber**：一个有状态的流式清洗器，用于从 streaming 输出中移除 `<memory-context>` 标签及其内容。这防止记忆上下文泄露到用户界面。设计了一个小状态机处理 chunk 边界的标签分割问题。

### 2.4 记忆注入方式

记忆通过两种方式注入对话：

1. **System Prompt 的 volatile 层**：每次 session 重建时，从 `MEMORY.md` 和 `USER.md` 加载内容注入 system prompt 的 volatile tier。

2. **prefetch 动态注入**：每个 turn 前调用 `prefetch_all()`，结果包装在 `<memory-context>` 标签中注入用户消息前。

```python
def build_memory_context_block(raw_context: str) -> str:
    return (
        "<memory-context>\n"
        "[System note: The following is recalled memory context, "
        "NOT new user input. Treat as authoritative reference data — "
        "this is the agent's persistent memory and should inform all responses.]\n\n"
        f"{clean}\n"
        "</memory-context>"
    )
```

### 2.5 内置记忆存储

内置 provider 使用文件系统存储：
- `MEMORY.md`：agent 的通用记忆（工具知识、代码库经验、工作偏好）
- `USER.md`：用户画像（偏好、沟通风格、项目习惯）

这些文件存储在 `$HERMES_HOME/memories/` 下，支持 profile 隔离。

### 2.6 外部 Provider 生态

`plugins/memory/` 下有 8 个内置 provider：

| Provider | 说明 |
|----------|------|
| `honcho` | Nous Research 自家的记忆后端 |
| `mem0` | Mem0 开源记忆框架 |
| `supermemory` | SuperMemory 服务 |
| `hindsight` | Hindsight 记忆系统 |
| `byterover` | ByteRover 记忆 |
| `holographic` | Holographic 记忆 |
| `openviking` | OpenViking 记忆 |
| `retaindb` | 本地 SQLite 记忆 |

---

## 3. 上下文压缩机制（核心）

### 3.1 架构定位

`ContextCompressor`（`agent/context_compressor.py`，2078 行）是 Hermes 最核心的上下文管理组件，实现了 `ContextEngine` ABC。它是可替换的——第三方可以通过 `plugins/context_engine/` 目录提供替代实现（如 LCM DAG 引擎）。

```python
class ContextCompressor(ContextEngine):
    """Algorithm:
      1. Prune old tool results (cheap, no LLM call)
      2. Protect head messages (system prompt + first exchange)
      3. Protect tail messages by token budget (most recent ~20K tokens)
      4. Summarize middle turns with structured LLM prompt
      5. On subsequent compactions, iteratively update the previous summary
    """
```

### 3.2 压缩触发条件

压缩触发通过 `should_compress()` 检查：

```python
def should_compress(self, prompt_tokens: int = None) -> bool:
    tokens = prompt_tokens or self.last_prompt_tokens
    if tokens < self.threshold_tokens:  # 默认 50% context_length
        return False
    # 反抖动：如果最近两次压缩每次节省 <10%，跳过
    if self._ineffective_compression_count >= 2:
        return False
    return True
```

**关键参数**：
- `threshold_percent`：触发阈值，默认 **0.50**（context 的 50%）
- `MINIMUM_CONTEXT_LENGTH`：最低阈值下限，防止大 context 模型过早触发
- `protect_first_n`：保护头部 N 条消息（默认 3，不包含 system prompt）
- `protect_last_n`：保护尾部最少 N 条消息（默认 20，实际由 token budget 决定）
- `summary_target_ratio`：摘要目标比例，默认 0.20

### 3.3 压缩算法五阶段

#### Phase 1: Tool Result 修剪（无 LLM 调用）

```python
_prune_old_tool_results(messages, protect_tail_count, protect_tail_tokens)
```

这是最廉价的前置清理，不需要调用 LLM：

1. **去重**：对相同内容的 tool result 做 MD5 去重，只保留最新的完整副本，旧副本替换为 `[Duplicate tool output — same content as a more recent call]`

2. **摘要替换**：对超过 200 字符的旧 tool result，生成一行式摘要，如：
   ```
   [terminal] ran `npm test` -> exit 0, 47 lines output
   [read_file] read config.py from line 1 (3,400 chars)
   ```

3. **截断 tool_call 参数**：对 assistant 消息中超过 500 字符的 tool call 参数做 JSON 结构化截断，保持 JSON 合法

4. **图片剥离**：对多模态 tool result（如 computer_use 截图），移除 base64 图片数据，保留文本摘要

**保护尾部**：通过 token budget 从尾部向前累积，保护最近 N 个 token 范围内的消息。提供 `protect_tail_tokens`（优先）和 `protect_tail_count`（保底）两种机制。

#### Phase 2: 确定压缩边界

```python
compress_start = _protect_head_size(messages)     # system + protect_first_n
compress_start = _align_boundary_forward(messages, compress_start)  # 不从 tool result 中间开始
compress_end = _find_tail_cut_by_tokens(messages, compress_start)   # token budget 从后往前
```

**边界对齐机制**：
- **前向对齐**（`_align_boundary_forward`）：如果压缩起点落在 tool result 中间，向前推到第一个非 tool 消息
- **后向对齐**（`_align_boundary_backward`）：如果压缩终点落在 tool_call/result 组中间，向后拉到整个组的起点
- **用户消息锚定**（`_ensure_last_user_message_in_tail`）：确保最后一条 user 消息始终在尾部——这是修复 #10896 的关键，防止 agent 在压缩后"忘记"用户的最新请求

#### Phase 3: 结构化 LLM 摘要

核心是 `_generate_summary()` 方法，使用 **结构化模板** 进行摘要：

```
## Active Task       ← 最重要的字段，记录用户最近的未完成请求原文
## Goal              ← 用户整体目标
## Constraints & Preferences
## Completed Actions ← 编号列表，包含工具名、目标、结果
## Active State      ← 工作目录、分支、修改文件、测试状态
## In Progress       ← 压缩触发时正在进行的工作
## Blocked           ← 未解决的阻塞
## Key Decisions     ← 重要决策及原因
## Resolved Questions
## Pending User Asks
## Relevant Files
## Remaining Work
## Critical Context  ← 不包含密钥/凭据
```

**迭代摘要**：如果存在上一次压缩的摘要（`_previous_summary`），不是从头摘要，而是做增量更新：

```
PREVIOUS SUMMARY:
{previous_summary}

NEW TURNS TO INCORPORATE:
{new_content}
```

**焦点压缩**：`/compress <topic>` 支持焦点引导，摘要器优先保留与焦点相关的信息，非相关内容更激进压缩。

**摘要预算**：
```python
def _compute_summary_budget(self, turns_to_summarize):
    content_tokens = estimate_messages_tokens_rough(turns_to_summarize)
    budget = int(content_tokens * _SUMMARY_RATIO)
    return max(_MIN_SUMMARY_TOKENS, min(budget, self.max_summary_tokens))
    # max_summary_tokens = min(context_length * 0.05, _SUMMARY_TOKENS_CEILING)
```

#### Phase 4: 确定性 fallback

当 LLM 摘要失败时，使用 `_build_static_fallback_summary()` 生成本地确定性 fallback：

不调用任何 LLM，从消息中提取：
- 用户最近的请求
- 完成的动作列表
- 涉及的文件
- 阻塞/错误信息
- 最后被丢弃的 turns

**两种失败处理模式**（通过 `compression.abort_on_summary_failure` 配置）：
- `False`（默认）：插入 fallback 摘要，继续运行
- `True`：完全中止压缩，返回原消息不变，等待用户手动 `/compress`

#### Phase 5: 组装与清理

压缩后的消息组装：

1. **系统消息注记**：在 system prompt 末尾追加压缩说明 `[Note: Some earlier conversation turns have been compacted...]`

2. **摘要角色选择**：智能选择摘要消息的 role（user/assistant），避免与前后邻居产生连续相同 role。如果两种 role 都冲突，则将摘要合并到下一条尾部消息中

3. **Orphan 清理**（`_sanitize_tool_pairs`）：
   - 移除没有对应 assistant tool_call 的 tool result
   - 为没有对应 tool result 的 assistant tool_call 插入 stub result

4. **历史图片剥离**：替换所有压缩后消息中的图片为文本占位符

5. **反抖动追踪**：如果压缩节省 <10%，递增 `_ineffective_compression_count`，连续两次无效后停止自动压缩

### 3.4 摘要模型容错

摘要可以使用独立模型（`summary_model_override`），失败时有完善的 fallback 链路：

```
配置的 summary_model 失败
  → 识别错误类型（404/503/timeout/JSON decode/connection error）
  → 回退到主模型（_fallback_to_main_for_compression）
  → 主模型也失败
  → 确定性 fallback 或 abort
```

模型失败有 cooldown 机制（30-60 秒），防止无限重试。

### 3.5 Prompt Cache 保护

Hermes 对 prompt cache 的保护极其重视：

> "The agent's system prompt is built once per session and reused across all turns — only context compression triggers a rebuild."

System prompt 分为三层：
- **stable**：身份、工具指导、skill prompt、环境提示——整个 session 不变
- **context**：AGENTS.md 等上下文文件——session 内不变
- **volatile**：记忆快照、用户画像、时间戳——仅在压缩重建时刷新

时间戳只精确到**日期**（不精确到分钟），确保 system prompt 在一天内 byte-stable，最大化 prefix cache 命中率。

---

## 4. 对话压缩流程

### 4.1 compress_context 函数

`agent/conversation_compression.py` 中的 `compress_context()` 是压缩的入口编排函数，串联了所有子系统：

```
compress_context(agent, messages, system_message)
  │
  ├─ 1. check_compression_model_feasibility()  # 懒检查 aux provider 可用性
  ├─ 2. try_acquire_compression_lock()         # SQLite 级别防并发压缩
  ├─ 3. memory_manager.on_pre_compress()       # 通知外部 provider
  ├─ 4. context_compressor.compress()          # 核心五阶段压缩
  ├─ 5. todo_store.format_for_injection()      # 注入 todo 状态
  ├─ 6. _invalidate_system_prompt()            # 使缓存失效
  ├─ 7. _build_system_prompt()                 # 重建 system prompt
  ├─ 8. session_db.end_session(old_id)         # 结束旧 session
  │     session_db.create_session(new_id)      # 创建新 session
  ├─ 9. commit_memory_session()                # 触发记忆提取
  ├─ 10. memory_manager.on_session_switch()    # 通知 provider
  ├─ 11. reset_file_dedup(task_id)             # 清理文件去重缓存
  └─ 12. release_compression_lock()            # 释放锁
```

### 4.2 Session 分裂

压缩后 session 不会原地修改，而是**分裂为父子两个 session**：

```python
old_session_id = agent.session_id
agent.session_id = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"
agent._session_db.create_session(
    session_id=agent.session_id,
    parent_session_id=old_session_id,  # 父子关系
)
```

这个设计确保：
1. 旧 session 的完整消息保留在 SQLite 中（可搜索）
2. 新 session 有干净的起始点
3. 父子关系通过 `parent_session_id` 维持 lineage

### 4.3 并发压缩锁

通过 SQLite 实现的分布式锁防止两个 AIAgent 实例（主 agent 和后台 review fork）同时压缩同一个 session：

```python
_lock_db.try_acquire_compression_lock(_lock_sid, _lock_holder)
```

锁 key 是**旧 session_id**（rotation 前），因为这是并发路径看到和操作的目标。如果获取锁失败，跳过压缩——另一个路径的 rotation 会产生正确的新 session_id。

### 4.4 压缩后的上下文估算

压缩后使用 rough estimate 诊断，但不将其作为 provider 报告的真实 usage：

```python
agent.context_compressor.awaiting_real_usage_after_compression = True
```

设置这个 flag 后，下一次 API 响应的真实 `prompt_tokens` 会覆盖 rough estimate，避免 schema-heavy 请求的 rough overestimate 触发不必要的二次压缩。

---

## 5. Skill 自学习系统

### 5.1 Skill 生命周期

Curator（`agent/curator.py`，1800 行）管理 skill 的完整生命周期：

```
[用户对话] → agent 创建 skill → [active] → (闲置) → [stale] → (继续闲置) → [archived]
                                            ↑              ↑
                                         user pin         curator 自动
                                         (豁免一切自动转换)
```

状态转换规则：
- **active → stale**：超过 `stale_after_days`（默认 30 天）无活动
- **stale → archived**：超过 `archive_after_days`（默认 90 天）无活动
- **任意状态**：用户 pin 后豁免所有自动转换

### 5.2 Skill 来源

Hermes 有三种 skill 来源：

1. **内置 skill**：`skills/` 目录，随仓库分发，默认加载
2. **Optional skill**：`optional-skills/` 目录，需要显式安装
3. **Agent 创建的 skill**：agent 在对话中创建的 skill，**curator 只管理这一类**

关键约束：curator **只触碰 `created_by: "agent"` 的 skill**。内置和 hub 安装的 skill 完全不受影响。

### 5.3 使用追踪

`tools/skill_usage.py` 维护 sidecar 文件 `~/.hermes/skills/.usage.json`，追踪每个 skill 的：

- `use_count`：使用次数
- `view_count`：查看次数
- `patch_count`：修改次数
- `last_activity_at`：最后活动时间
- `state`：当前状态（active / stale / archived）
- `pinned`：是否被 pin

这些指标驱动 curator 的自动转换决策。

### 5.4 LLM Review

Curator 使用 LLM 对 skill 进行质量审查：

1. 后台定期运行 review 循环
2. 对每个 active skill 生成审查 prompt
3. LLM 评估 skill 的描述准确性、完整性、可用性
4. 根据审查结果自动改进或标记待改进

### 5.5 备份与回滚

`agent/curator_backup.py` 在每次 curator 运行前创建 `tar.gz` 快照，用户可以通过 `hermes curator rollback` 恢复。

### 5.6 Skill Hub

`tools/skills_hub.py` 实现了 skill 的在线仓库（OptionalSkillSource），支持：
- `hermes skills install official/<category>/<skill>`
- `hermes skills search <query>`
- 分类包括：autonomous-ai-agents, blockchain, devops, mlops, security, web-development 等

### 5.7 Skill 在 System Prompt 中的注入

Skill 内容在 system prompt 的 **stable 层** 注入：

```python
if has_skills_tools:
    skills_prompt = _r.build_skills_system_prompt(
        available_tools=agent.valid_tool_names,
        available_toolsets=avail_toolsets,
    )
```

这意味着 skill 内容被缓存——只有在新 session 或压缩重建时才会刷新。

---

## 6. 会话搜索

### 6.1 架构

`tools/session_search_tool.py`（602 行）基于 **SQLite FTS5** 实现历史会话全文搜索，不调用 LLM。

### 6.2 三种调用形态

| 形态 | 参数 | 用途 |
|------|------|------|
| **Discovery** | `query` | FTS5 搜索，返回匹配的 session + 上下文 |
| **Scroll** | `session_id` + `around_message_id` | 在已知 session 中滑动浏览 |
| **Browse** | 无参数 | 列出最近的 session |

### 6.3 Discovery 模式详解

FTS5 搜索返回的结果结构精心设计：

```json
{
  "session_id": "...",
  "title": "...",
  "snippet": "FTS5 高亮匹配片段",
  "bookend_start": "session 前 3 条 user+assistant 消息（目标/开头）",
  "messages": "±5 条消息窗口，anchor 消息标记",
  "bookend_end": "session 最后 3 条 user+assistant 消息（结论/决策）"
}
```

**Bookend 设计**：只返回 session 开头（目标）和结尾（结论）的 3 条消息，加上匹配点附近的 ±5 条窗口。这样 agent 能理解"目标→匹配→结论"的完整故事，而不需要加载整个 transcript。

### 6.4 Lineage 去重

压缩产生的父子 session 会导致同一个逻辑会话在 FTS5 中有多行命中。Discovery 模式通过 `_resolve_to_parent()` 将所有 session 解析到 lineage root，然后去重，确保一个逻辑会话只返回一条结果。

### 6.5 Lineage Rebind

Scroll 模式中，如果 `around_message_id` 实际在子 session 中（压缩产生的 child），会自动 rebind 到正确的 session：

```python
if owning and owning != session_id:
    a_root = _resolve_to_parent(db, session_id)
    o_root = _resolve_to_parent(db, owning)
    if a_root == o_root:  # 同一个 lineage
        # 透明 rebind
        view = db.get_messages_around(owning, around_message_id, window=window)
```

---

## 7. Trajectory 压缩

### 7.1 用途

`trajectory_compressor.py`（1508 行）不是运行时组件，而是**离线训练数据预处理工具**。它压缩 agent 的对话轨迹（trajectory）到固定 token 预算内，用于 fine-tuning 训练数据的制备。

### 7.2 配置

```python
class CompressionConfig:
    tokenizer_name = "moonshotai/Kimi-K2-Thinking"
    target_max_tokens = 15250          # 压缩目标 token 数
    summary_target_tokens = 750        # 摘要 token 数
    protect_first_system = True        # 保护第一条 system
    protect_first_human = True         # 保护第一条 human
    protect_first_gpt = True          # 保护第一条 assistant
    protect_first_tool = True          # 保护第一条 tool
    protect_last_n_turns = 4           # 保护最后 4 轮
    summarization_model = "google/gemini-3-flash-preview"
```

### 7.3 压缩算法

与运行时压缩类似，但更简单：

1. 计算 trajectory 总 token 数
2. 如果在目标内，跳过
3. 确定可压缩区域（保护 head + tail）
4. 从可压缩区域开头累积 turns，直到节省足够的 token
5. 用 LLM 生成摘要替换被压缩的 turns
6. 摘要以 `human` 角色注入（ShareGPT 格式）

### 7.4 与运行时压缩的区别

| 维度 | 运行时压缩 | Trajectory 压缩 |
|------|-----------|----------------|
| 目的 | 保持对话连续性 | 制备训练数据 |
| 消息格式 | OpenAI format | ShareGPT format |
| 摘要模板 | 13 段结构化模板 | 简单摘要 |
| 并发 | 无（单 trajectory） | 支持异步并行（50 并发） |
| Tool pair 清理 | 有 | 无 |
| 反抖动 | 有 | 无 |

---

## 8. System Prompt 构建与记忆注入

### 8.1 三层架构

System prompt（`agent/system_prompt.py`）由三层拼接：

```
stable + "\n\n" + context + "\n\n" + volatile
```

#### Stable 层（整个 session 不变）

- SOUL.md 或 DEFAULT_AGENT_IDENTITY
- 工具指导（memory/session_search/skill_manage/kanban）
- Tool-use enforcement（针对特定模型的工具调用强化）
- Skills prompt（根据 available_toolsets 动态生成）
- 环境探测（WSL/Termux 等）
- Profile 提示
- Platform hints

#### Context 层

- 调用方提供的 `system_message`
- AGENTS.md / .cursorrules 等上下文文件

#### Volatile 层（每次 session 开始/压缩重建时刷新）

- MEMORY.md 内容
- USER.md 内容
- 外部 memory provider block
- 日期 + session_id + model + provider

### 8.2 缓存策略

System prompt 只在两种情况下重建：
1. 新 session 开始
2. 上下文压缩触发后

**否则复用缓存的 `_cached_system_prompt`**。这是 prompt cache 命中率的核心保证。

日期只用 `%A, %B %d, %Y` 格式（如 "Saturday, May 31, 2026"），不用时间，确保一天内 byte-stable。

### 8.3 上下文引用

`agent/context_references.py` 实现了 `@file:` / `@folder:` / `@url:` / `@diff` / `@staged` / `@git:` 引用语法，允许用户在消息中引用外部内容：

```
@file:src/main.py:10-20    → 注入文件第 10-20 行
@folder:src/               → 注入目录结构
@url:https://...           → 抓取并注入 URL 内容
@diff                      → 注入 git diff
@git:3                     → 注入最近 3 条 git log + patch
```

注入的内容附带 token 估算，有硬限制（context length 的 50%）和软限制（25%），超过硬限制直接拒绝。

**安全机制**：阻止引用敏感路径（`.ssh/`、`.aws/`、`.env` 等）。

---

## 9. 与 Pi 的 infinite-context 设计对比

### 9.1 设计哲学差异

| 维度 | Hermes Agent | Pi (infinite-context) |
|------|-------------|----------------------|
| **核心思路** | LLM 结构化摘要替换 | tree-context 注入 + 原生 compact |
| **压缩方式** | 生成一段长摘要替代中间消息 | 利用模型原生 compact 能力 |
| **记忆持久化** | 插件化外部 provider + 文件 | tree-context 文件树 |
| **上下文引擎** | 可替换 ABC（compressor/lcm） | 原生 compact + tree 注入 |
| **Session 管理** | 分裂式（父子 lineage） | 无分裂 |

### 9.2 压缩策略对比

**Hermes 的五阶段压缩**：
1. Tool result 修剪（去重 + 摘要）
2. Head/Tail 保护
3. LLM 结构化摘要（13 段模板）
4. Fallback 机制
5. Tool pair 清理 + 图片剥离

**Pi 的 tree-compact**：
- 利用模型自身的 compact 能力
- tree-context 文件系统作为持久化层
- 不需要自建摘要器

### 9.3 记忆持久化对比

**Hermes**：
- 文件存储（MEMORY.md / USER.md）+ 外部 provider
- prefetch/queue_prefetch 流水线
- `<memory-context>` 标签注入

**Pi**：
- tree-context 文件树
- 更轻量，无外部依赖

### 9.4 对 Prompt Cache 的处理

**Hermes**：极度重视，三层 system prompt 设计 + byte-stable 日期格式 + 只在压缩时重建

**Pi**：需要评估 tree-context 注入对 cache 的影响

### 9.5 会话搜索对比

**Hermes**：FTS5 全文搜索 + bookend 设计 + lineage 去重 + scroll 模式——非常完善的会话检索系统

**Pi**：目前没有内置的跨 session 搜索能力

---

## 10. 可借鉴的设计

### 10.1 五阶段压缩流水线

Hermes 的压缩不是一步到位，而是先做廉价的无损清理（tool result 修剪），再做昂贵的有损压缩（LLM 摘要）。这个思路可以用于 Pi 的 compact 增强：
- **Phase 0**：在调用 compact 之前，先做 tool result 去重和大内容截断
- 这样 compact API 需要处理的内容更少，成本更低

### 10.2 结构化摘要模板

Hermes 的 13 段摘要模板设计值得参考，特别是：
- **Active Task**：明确记录用户最近的未完成请求
- **Completed Actions**：编号列表，包含工具名、目标、结果
- **Active State**：当前工作状态（分支、文件、测试状态）

如果 Pi 需要增强 compact 质量，可以借鉴这种结构化模板来指导 compact 的 prompt。

### 10.3 反抖动保护

连续两次压缩节省 <10% 时停止自动压缩——这个机制防止了压缩循环（压缩→不够→再压缩→还是不够）。Pi 的 compact 也需要类似保护。

### 10.4 Bookend 式会话搜索

Hermes 的 session search 是一个完整的"会话搜索引擎"，bookend 设计（开头 3 条 + 匹配 ±5 条 + 结尾 3 条）非常精巧——用户能从一次搜索就理解"目标→发现→结论"，而不需要加载整个 session。这对 coding agent 尤其有价值——过去的调试经验、架构决策都能被检索。

### 10.5 StreamingContextScrubber

流式清洗 memory-context 标签的状态机设计，解决了 chunk 边界标签分割的问题。如果 Pi 需要在 streaming 输出中注入/清洗特殊标记，这个模式可以直接复用。

### 10.6 压缩后的 Tool Pair 清理

`_sanitize_tool_pairs()` 处理压缩后 orphan tool_call/result 的逻辑非常细致：
- 移除没有对应 call 的 result
- 为没有对应 result 的 call 插入 stub

这对保持 OpenAI API 消息格式的合法性至关重要。

### 10.7 User Message 锚定

压缩时确保最后一条 user 消息始终在尾部保护区内——这是一个容易被忽略但极其重要的 bug fix（#10896）。如果用户的最新请求被压缩进摘要，agent 可能"忘记"正在执行的任务。

### 10.8 摘要角色智能选择

压缩后摘要消息需要选择 user 或 assistant 角色，但必须避免与前后邻居产生连续相同 role。Hermes 的策略：
1. 避免与 head 的 role 冲突
2. 避免与 tail 的 role 冲突
3. 如果两种都冲突，将摘要合并到 tail 的第一条消息

---

## 11. 不足与不适用之处

### 11.1 摘要质量不可控

Hermes 的压缩高度依赖 LLM 摘要质量。即使有 13 段结构化模板，摘要仍然是有损的：
- 代码细节（行号、变量名、具体值）容易丢失
- 调试过程中的中间状态难以完整保留
- 多次迭代摘要后信息衰减加速

对 coding agent 来说，精确的代码上下文比对话上下文更重要，LLM 摘要无法替代原始代码。

### 11.2 Token 开销大

每次压缩都需要调用一次 LLM 做摘要（即使使用便宜的 aux model），对 coding agent 的长对话来说，可能触发多次压缩，累积的 token 开销不小。

### 11.3 不适合代码密集场景

Hermes 设计为通用 agent（telegram/discord/web），对话以自然语言为主。但 coding agent 的消息包含大量代码片段、tool 输出、diff、日志——这些内容很难被 LLM 摘要准确保留。

特别是：
- `read_file` 返回的源码 → 摘要后只剩"读取了文件 X"
- `terminal` 返回的测试输出 → 摘要后只剩"测试通过/失败"
- `patch` 的变更 → 摘要后只剩"修改了文件 X"

### 11.4 Session 分裂增加复杂度

压缩后 session 分裂为父子两个，引入了：
- Lineage 追踪和去重逻辑
- Lineage rebind 机制
- 跨 session 的消息引用问题
- 对搜索系统的额外复杂度

对 Pi 来说，如果不分裂 session，可以避免这些复杂度。

### 11.5 摘要模型单点故障

如果 aux model 不可用，整个压缩流程退化为确定性 fallback（质量大打折扣）或完全中止。虽然有 fallback-to-main-model 的容错，但主模型通常更贵、更慢。

### 11.6 Skill 学习的 ROI 存疑

Curator 从对话经验中提取 skill，但：
- 大多数 coding task 是一次性的，不适合 skill 化
- Skill 质量依赖 LLM 审查，审查本身可能有误
- Skill 膨胀问题：长期使用后 skill 数量可能爆炸

### 11.7 Prompt Cache 脆弱性

虽然 Hermes 极力保护 prompt cache，但任何压缩都必然导致 cache miss（因为 system prompt 需要重建）。对长对话来说，可能触发多次压缩，每次都是一次 full cache miss。

### 11.8 缺乏细粒度的记忆管理

MEMORY.md 是一个纯文本文件，没有结构化查询能力。对比专业记忆系统（如 mem0 的知识图谱），Hermes 的内置记忆只是"一个文本块"。

### 11.9 Context Engine 可替换性的局限

虽然设计了 `ContextEngine` ABC 允许替换实现，但实际上整个系统深度依赖 `ContextCompressor` 的具体行为（如 `_previous_summary`、`_last_compress_aborted` 等），第三方 engine 很难做到完全透明替换。

---

## 附录 A：关键常量与阈值

| 常量 | 值 | 含义 |
|------|---|------|
| `threshold_percent` | 0.50 | 压缩触发阈值 |
| `protect_first_n` | 3 | 保护头部非 system 消息数 |
| `protect_last_n` | 20 | 保护尾部最少消息数 |
| `summary_target_ratio` | 0.20 | 摘要目标比例 |
| `_SUMMARY_RATIO` | ~0.15 | 摘要 token 占比 |
| `_SUMMARY_TOKENS_CEILING` | ~8000 | 摘要最大 token |
| `_CHARS_PER_TOKEN` | ~4 | 估算用字符/token 比 |
| `_CONTENT_MAX` | 6000 | 摘要输入每条消息最大字符 |
| `_TOOL_ARGS_MAX` | 1500 | tool call 参数最大字符 |
| `_SUMMARY_FAILURE_COOLDOWN` | 60s | 摘要失败冷却时间 |
| Trajectory `target_max_tokens` | 15250 | 训练数据压缩目标 |
| Trajectory `protect_last_n_turns` | 4 | 保护最后 4 轮 |

## 附录 B：核心数据流

```
用户消息
  │
  ├─ preprocess_context_references()    # @file: @url: 等引用展开
  ├─ memory_manager.prefetch_all()      # 预取记忆
  ├─ build_memory_context_block()       # 包装为 <memory-context>
  │
  ▼
[API Call]
  │
  ├─ should_compress() ?               # 检查是否需要压缩
  │   ├─ Yes → compress_context()      # 执行压缩
  │   │         ├─ on_pre_compress()   # 通知 provider
  │   │         ├─ compress()          # 五阶段压缩
  │   │         ├─ session 分裂         # 创建子 session
  │   │         ├─ on_session_switch() # 通知 provider
  │   │         └─ rebuild system prompt
  │   └─ No → 继续
  │
  ├─ memory_manager.sync_all()         # 同步 turn 到所有 provider
  ├─ memory_manager.queue_prefetch_all() # 触发后台预取
  └─ session_db 操作                    # 持久化消息
```
