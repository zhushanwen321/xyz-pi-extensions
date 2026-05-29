# OpenAI Codex CLI 上下文管理分析报告

> 分析时间：2026-05-28
> 仓库：https://github.com/openai/codex-cli
> 技术栈：Rust (workspace with ~80 crates)

---

## 一、概述

Codex CLI 是 OpenAI 开源的 AI coding agent 终端，使用 Rust 实现。其上下文管理是当前业界同类项目中最成熟的方案之一，核心策略是 **"主动压缩（Compaction）+ Token 预算监控 + 远程 API compact endpoint"**。

关键 crate：
- `codex-core` — 主 agent 循环、turn 调度、compaction 逻辑
- `codex-protocol` — 协议模型（ResponseItem, TokenUsage 等）
- `message-history` — 全局持久化消息历史（`~/.codex/history.jsonl`）
- `codex-utils-output-truncation` — 工具输出截断
- `memories/write`, `memories/read` — 长期记忆系统
- `rollout-trace` — rollout 轨迹 compaction 追踪

---

## 二、核心架构

### 2.1 数据结构

**`ContextManager`**（`core/src/context_manager/history.rs`）是整个上下文管理的核心：

```rust
pub(crate) struct ContextManager {
    items: Vec<ResponseItem>,          // 历史消息（oldest → newest）
    history_version: u64,              // 每次重写时递增
    token_info: Option<TokenUsageInfo>, // 服务端返回的 token 用量
    reference_context_item: Option<TurnContextItem>, // 用于上下文差异化注入
}
```

**`ResponseItem`** 是历史中的基本单元，包含多种变体：
- `Message { role, content }` — 用户消息、助手回复、developer 指令
- `FunctionCall / FunctionCallOutput` — 工具调用及结果
- `Reasoning` — 模型推理
- `Compaction / ContextCompaction` — 压缩后的摘要占位
- `LocalShellCall / WebSearchCall / ImageGenerationCall` 等

### 2.2 会话生命周期

```
Session (core/src/session/session.rs)
  └─ SessionState (core/src/state/session.rs)
       ├─ ContextManager               ← 消息历史
       ├─ AutoCompactWindow            ← Token 预算窗口
       ├─ server_reasoning_included    ← 服务端是否已算推理 token
       └─ previous_turn_settings       ← 上一轮的设置
```

每个 Session 有一个 `ContextManager`，所有消息按顺序存入 `Vec<ResponseItem>`，通过 `history_version` 追踪重写事件。

---

## 三、Token 预算管理

### 3.1 双层 Token 估算

**第一层：API 返回的精确值**（来自 `/v1/responses` 的 `token_usage`）
```rust
pub struct TokenUsageInfo {
    pub last_token_usage: TokenUsage,  // { input_tokens, output_tokens, total_tokens }
    pub model_context_window: Option<i64>,
}
```

**第二层：客户端估算**（用于 API 返回之间）
```rust
fn estimate_item_token_count(item: &ResponseItem) -> i64 {
    let bytes = estimate_response_item_model_visible_bytes(item);
    approx_tokens_from_byte_count_i64(bytes)  // bytes / 4
}
```
- 非推理项直接 JSON 序列化量字节
- 推理项使用 base64 解码后的"密文长度 * 3/4 - 650"估算
- 图片使用 7373 字节固定估算，`detail: original` 的图片用 32px patch 计数
- 结果用 LRU 缓存（32 项）优化重复计算

### 3.2 Token 预算配置

**两层配置来源：**

1. **模型元数据**（`protocol/src/openai_models.rs`）：
   - `context_window` — 模型上下文窗口大小
   - `auto_compact_token_limit` — 自动 compact 阈值，默认 = `context_window * 90%`
   - 用户配置不可超过此值的 90%

2. **用户配置**（`config/src/config_toml.rs`）：
   - `n_token_limit` — 用户自定义的自动 compact 阈值
   - `n_token_limit_scope` — 计费范围枚举：
     - `Total`（默认）— 全量活跃上下文计数
     - `BodyAfterPrefix` — 仅计数采样输出和在缓存 prefix 之后的增长

### 3.3 Token 使用跟踪

```rust
pub(crate) fn get_total_token_usage(&self, server_reasoning_included: bool) -> i64 {
    let last_tokens = self.token_info.last_token_usage.total_tokens;
    let items_after = items_after_last_model_generated_item().iter()
        .map(estimate_item_token_count).sum();
    if server_reasoning_included {
        last_tokens + items_after
    } else {
        // 加上非最后一次推理项的 token
        last_tokens + non_last_reasoning_tokens + items_after
    }
}
```

策略：服务端返回的精确 token 数 + 客户端对后续添加项的估算。如果是本地紧凑化（未经过 API），则补上推理 token 的估算。

---

## 四、Compaction（上下文压缩）

### 4.1 Compaction 触发时机

Compaction 是 Codex CLI 上下文管理的核心机制，有三种触发方式：

| 触发类型 | 时机 | 原因 |
|---------|------|------|
| **PreTurn** | 每次新 turn 开始前 | `token_limit_reached` |
| **MidTurn** | turn 中采样完成后 | `token_limit_reached && needs_follow_up` |
| **Manual** | 用户显式调用 `/compact` | 用户主动 |

触发链：
```
pre_sampling (turn.rs: run_pre_sampling_compact)
  └─ maybe_run_previous_model_inline_compact()
  └─ if token_limit_reached → run_auto_compact()

post_sampling (turn.rs)
  └─ if token_limit_reached && needs_follow_up → run_auto_compact()
```

### 4.2 三种 Compaction 实现

| 实现 | 方式 | 适用 |
|------|------|------|
| **Local/Inline** (`compact.rs`) | 用 LLM 生成摘要，本地替换历史 | 模型不支持远程 compact |
| **Remote v1** (`compact_remote.rs`) | 调用 API `/v1/responses/compact` | 支持远程 compact 的模型 |
| **Remote v2** (`compact_remote_v2.rs`) | 调用 API `/v1/responses` 流式 compact | 新 API 兼容层 |

选择逻辑：
```rust
pub(crate) fn should_use_remote_compact_task(provider: &ModelProviderInfo) -> bool {
    provider.supports_remote_compaction()
}
```

### 4.3 Local Compaction 流程（`compact.rs`）

```
run_auto_compact()
  └─ run_inline_auto_compact_task()
      └─ run_compact_task_inner()
          └─ run_compact_task_inner_impl()
              1. 构建 compaction prompt（模板: templates/compact/prompt.md）
              2. 克隆当前历史
              3. 调用 LLM 生成摘要（stream 方式）
              4. 从最后一条 assistant 消息提取摘要文本
              5. 收集用户消息（跳过摘要消息）
              6. build_compacted_history():
                 - 保留用户消息（限制 20,000 tokens）
                 - 在末尾追加摘要
                 - 从最新消息往回选取，超出 budget 则截断
              7. 如果需要注入初始上下文 → insert_initial_context_before_last...
              8. replace_compacted_history() 替换完整历史
              9. recompute_token_usage()
```

**Compaction Prompt**（`templates/compact/prompt.md`）：
> "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task. Include: Current progress and key decisions made, Important context, constraints, or user preferences, What remains to be done, Any critical data, examples, or references needed to continue."

**摘要前缀**（`templates/compact/summary_prefix.md`）：
> "Another language model started to solve this problem and produced a summary of its thinking process..."

### 4.4 Remote Compaction 流程（`compact_remote.rs`）

```
run_remote_compact_task_inner_impl()
  1. trim_function_call_history_to_fit_context_window()
     - 反复删除最后一条 codex 生成的 item（FunctionCallOutput 等），
       直到估计 token 数 <= context_window
  2. 构建含 tools 的 Prompt
  3. 调用 model_client.compact_conversation_history() → API 返回压缩后历史
  4. process_compacted_history():
     - 过滤掉 developer 消息（可能含过时的指令）
     - 过滤非用户消息的 user 消息
     - 插入初始上下文
  5. replace_compacted_history()
```

### 4.5 重试与错误处理

```rust
loop {
    let turn_input = history.clone().for_prompt(...);
    match attempt_result {
        Ok(()) => break,
        Err(ContextWindowExceeded) if turn_input_len > 1 => {
            // 删除最旧的 item，重试
            history.remove_first_item();
            retries = 0;
            continue;
        }
        Err(e) if retries < max_retries => {
            // 指数退避重试
            retries += 1;
            sleep(backoff(retries));
            continue;
        }
        Err(e) => return Err(e),
    }
}
```

### 4.6 Hooks 集成

Compaction 流程中插入 hooks：
```rust
let pre_compact_outcome = run_pre_compact_hooks(&sess, &turn_context, trigger).await;
// ... compaction ...
let post_compact_outcome = run_post_compact_hooks(&sess, &turn_context, trigger).await;
```

### 4.7 分析埋点

```rust
struct CompactionAnalyticsAttempt {
    thread_id, turn_id,
    trigger, reason, implementation, phase, strategy,
    active_context_tokens_before, active_context_tokens_after,
    started_at, completed_at, duration_ms,
    status: Completed | Interrupted | Failed,
    error: Option<String>,
}
```

---

## 五、工具调用结果处理

### 5.1 写入时的截断

`ContextManager::process_item()` 根据 `TruncationPolicy` 在记录时即时截断：
```rust
fn process_item(&self, item: &ResponseItem, policy: TruncationPolicy) -> ResponseItem {
    match item {
        ResponseItem::FunctionCallOutput { output } => {
            ResponseItem::FunctionCallOutput {
                output: truncate_function_output_payload(output, policy * 1.2),
            }
        }
        // ... shell, custom tool output 同样处理
    }
}
```

### 5.2 TruncationPolicy

```rust
pub enum TruncationPolicy {
    Bytes(usize),
    Tokens(usize),
}
```

截断方式：**保留头和尾，移除中间**（truncate_middle）
```rust
fn truncate_middle_with_token_budget(s: &str, max_tokens: usize) -> (String, Option<u64>) {
    // 保留前一半和后一半，中间用 "…{N} tokens truncated…" 替代
}
```

### 5.3 写入流控

每条工具输出的截断预算 = `TruncationPolicy * 1.2`，为 JSON 序列化留余量。

### 5.4 Compaction 时用户消息保留策略

```rust
fn build_compacted_history_with_limit(history, user_messages, summary, max_tokens) {
    // 从最新消息往前选取，直到达到 COMPACT_USER_MESSAGE_MAX_TOKENS (20,000)
    // 最后一条超出 budget 的用 truncate_text 截断
    // 在末尾追加摘要
}
```

---

## 六、AutoCompactWindow——增量预算跟踪

### 6.1 设计

`AutoCompactWindow`（`core/src/state/auto_compact_window.rs`）用于 **BodyAfterPrefix** 模式下跟踪"prefix cache 之外的增量 token"。

```rust
struct AutoCompactWindow {
    ordinal: u64,                    // 窗口序号，每次 compact 后递增
    prefill_input_tokens: Option<AutoCompactWindowPrefill>, // prefix cache 基线
}

enum AutoCompactWindowPrefill {
    ServerObserved(i64),  // API 返回的精确值（优先）
    Estimated(i64),       // 客户端估算（fallback）
}
```

### 6.2 优先级规则

```
ServerObserved > Estimated
```

一旦收到 API 返回的 `token_usage.input_tokens`，就用服务器精确值替换客户端估算。后续的 Compact 窗口会 `clear_prefill()`。

---

## 七、持久化历史（message-history）

**文件位置**：`~/.codex/history.jsonl`

**格式**：JSON Lines，每行：
```json
{"session_id":"<uuid>","ts":<unix_seconds>,"text":"<message>"}
```

**写入策略**：
- `O_APPEND` 模式 + 单次 `write()` 系统调用（`PIPE_BUF` 内保证原子性）
- 文件锁（`File::try_lock()`）防止并发写入交错
- 最大 10 次重试，每次 100ms 间隔

**大小管理**：
- `max_bytes` 用户可配置硬上限
- 超过时删除最旧行，保留新行 + 软上限（硬上限的 80%）
- 用 `fsetattrlist` 确保文件权限为 `0600`

**持久化策略**：
- `SaveAll` — 保存所有消息
- `None` — 不保存

---

## 八、长期记忆系统（Memories）

### 8.1 整体架构

```
memories/
  ├── write/    — 记忆写入管道
  │   ├── phase1.rs     — 第一阶段：从 rollout 提取候选记忆
  │   ├── phase2.rs     — 第二阶段：合并、去重、格式化
  │   ├── prompts.rs    — 记忆提取 prompt
  │   ├── storage.rs    — 文件存储（raw_memories.md）
  │   ├── extensions/   — 记忆扩展（第三方资源）
  │   │   ├── prune.rs  — 过期清理（7 天保留期）
  │   │   └── mod.rs
  │   └── workspace.rs  — workspace diff 能力
  ├── read/     — 记忆读取
  │   ├── lib.rs        — memory_root()
  │   ├── prompts.rs    — 注入 prompt 构建
  │   ├── citations.rs  — 引用解析
  │   └── usage.rs      — 用量统计
  └── mcp/      — MCP 接口层
```

### 8.2 两阶段提取

**Phase 1**（`gpt-5.4-mini`, `reasoning_effort: low`）：
- 扫描已完成的 rollout，用 prompt 提取用户偏好、项目约定、问题-解决方案对
- 每 rollout 独立处理，8 个并发

**Phase 2**：合并、去重、格式化后写入 `~/.codex/memories/raw_memories.md`

### 8.3 读取注入

`memories/read/src/prompts.rs::build_memory_tool_developer_instructions()`：
- 限制注入长度：`MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_SUMMARY_TOKEN_LIMIT = 2,500`
- 支持引用（citation）格式

---

## 九、上下文差异注入（Reference Context Item）

`ContextManager` 维护 `reference_context_item`，用于 turn-to-turn 的上下文差异注入。当上下文更新后，下一轮 turn 只需要 diff 而非完全重新注入：

```rust
reference_context_item: Option<TurnContextItem>
```

被 compaction 或 rollback 清空时，fallback 到完全重新注入。

---

## 十、关键设计决策总结

| 维度 | Codex CLI 方案 | 设计理由 |
|------|---------------|---------|
| **触发策略** | Token 阈值触发（PreTurn + MidTurn） | 避免到达 context window 上限才处理 |
| **压缩方式** | LLM 生成摘要（local）/ API compact（remote） | 保留语义完整性 |
| **用户消息保留** | 从后往前保留，20K token 上限 | 最新消息最重要 |
| **工具输出** | 写入时按 budget 截断（保留头尾） | 控制上下文增长 |
| **Token 估算** | 客户端 byte/4 估算 + API 精确值 | 平衡性能与精确度 |
| **Prefix Cache** | AutoCompactWindow + BodyAfterPrefix | 配合模型 prefix cache 优化 |
| **持久化** | JSONL + 文件锁 + 大小限制 | 简单可靠，支持多进程 |
| **长期记忆** | 两阶段 LLM 提取 + `raw_memories.md` | 跨会话知识持久化 |
| **Hooks 集成** | PreCompact + PostCompact hooks | 允许用户干预压缩流程 |
| **上下文差异** | reference_context_item 跟踪 | 减少每次 turn 的注入开销 |

---

## 十一、对无限上下文设计的启示

1. **不要等到溢出才压缩**：Codex CLI 用 `n_token_limit`（默认为 context_window 的 90%）作为提前触发阈值，而非等到 API 返回 context_window_exceeded 错误。

2. **两阶段 Token 估算**：服务端精确值 + 客户端近似值，平衡了准确性和实时性。

3. **增量预算跟踪（AutoCompactWindow）**：`BodyAfterPrefix` 策略配合 prefix caching，只对"新增"部分做预算管理，大幅降低 compact 频率。

4. **摘要优先而非丢弃**：compaction 不是简单丢弃历史，而是用 LLM 生成结构化摘要，并在摘要前保留一定量的最新用户消息。

5. **内容截断保留头尾**：工具输出截断不是从开头截断，而是保留头和尾，用 "…N tokens truncated…" 标记中间被截掉的部分。

6. **分层持久化**：运行时上下文（ContextManager）+ 本地文件历史（history.jsonl）+ 长期记忆（memories），三个层次各有不同的粒度、保留策略和访问模式。

7. **紧凑化后重置 prefix cache**：每次 compact 后清空 AutoCompactWindow 的 prefill baseline，新的 turn 重新开始计数。

8. **工具调用结果在写入时即截断**：而非等上下文快满时才处理。`process_item()` 使用 `policy * 1.2` 的乘数预留序列化开销。
