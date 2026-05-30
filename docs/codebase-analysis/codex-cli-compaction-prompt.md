# Codex CLI 上下文压缩（Compaction）机制深度分析

> 分析基于 OpenAI Codex CLI Rust 代码库（`codex-rs/`），日期：2026-05-30

---

## 1. 总体结论

**Codex CLI 使用 LLM 进行上下文压缩，而非简单的 rule-based 截断。**

它提供三种压缩实现路径：
1. **Local Inline Compaction**（Memento 策略）— 本地 LLM 调用生成摘要
2. **Remote Compaction V1**（ResponsesCompact 策略）— 调用 OpenAI `/v1/responses/compact` 端点
3. **Remote Compaction V2**（Responses 策略）— 通过标准 Responses API 发送 `CompactionTrigger` 信号

选择哪条路径取决于 **模型提供商是否支持远程压缩**（`provider.supports_remote_compaction()`）。

---

## 2. 压缩提示词（Compaction Prompt）

### 2.1 系统提示词模板

文件路径：`codex-rs/core/templates/compact/prompt.md`

```markdown
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
```

**核心设计理念：** 以"交接文档"的形式生成摘要，而非简单的信息提取。强调"帮助下一个 LLM 无缝继续工作"。

### 2.2 摘要前缀模板

文件路径：`codex-rs/core/templates/compact/summary_prefix.md`

```markdown
Another language model started to solve this problem and produced a summary of its thinking process. 
You also have access to the state of the tools that were used by that language model. 
Use this to build on the work that has already been done and avoid duplicating work. 
Here is the summary produced by the other language model, use the information in this summary 
to assist with your own analysis:
```

**用途：** 压缩后的摘要不是裸文本，而是以此前缀包装为 `user` 角色消息，告知新的 LLM 上下文这是前一个 LLM 的思考摘要，应当避免重复工作。

### 2.3 自定义提示词支持

用户可通过配置覆盖默认压缩提示词：

```rust
// codex-rs/core/src/config/mod.rs
pub compact_prompt: Option<String>,
pub experimental_compact_prompt_file: Option<String>,
```

优先级：CLI 覆盖 > 配置文件中的 `compact_prompt` > `experimental_compact_prompt_file` > 默认模板

---

## 3. 三种压缩实现路径

### 3.1 Local Inline Compaction（Memento 策略）

**代码入口：** `compact.rs::run_inline_auto_compact_task()`

**工作流程：**

```
1. 获取压缩提示词（compact_prompt）
2. 将提示词作为 UserInput::Text 构建 input
3. 调用 LLM（与正常推理使用相同的模型和 API）
4. LLM 返回的 assistant 消息即作为摘要
5. 提取摘要文本，附加 SUMMARY_PREFIX
6. 收集原始历史中的用户消息（逆序，20K token 预算内）
7. 构建 compacted history: [initial_context? + 保留的用户消息 + 摘要]
8. 替换会话历史
```

**关键特点：**
- 使用与正常推理相同的 Responses API 流式调用
- 摘要由模型的自然语言回复充当，没有结构化输出要求
- 重试逻辑：上下文溢出时从头部删除历史项，其他错误使用指数退避
- 压缩后发出警告："Long threads and multiple compactions can cause the model to be less accurate"

**用户消息保留策略：**
```rust
const COMPACT_USER_MESSAGE_MAX_TOKENS: usize = 20_000;
```
从最新的用户消息开始倒序保留，直到达到 20K token 预算。超出部分截断。

### 3.2 Remote Compaction V1（ResponsesCompact 策略）

**代码入口：** `compact_remote.rs::run_remote_compact_task()`

**工作流程：**

```
1. 获取历史快照
2. 裁剪尾部 Codex 生成的项以适配上下文窗口
3. 构建 Prompt（包含 base_instructions + personality + tools）
4. 调用 /v1/responses/compact 端点（OpenAI 专用 API）
5. 获取 compact endpoint 返回的新历史
6. 过滤：保留 user 消息、hook prompt、compaction 项；丢弃 developer 消息
7. 如需注入初始上下文，在最后一个真实用户消息之前插入
8. 替换会话历史
```

**与 Local 的核心区别：**
- 压缩逻辑在 OpenAI 服务端执行（`compact_conversation_history()` API 调用）
- 不使用本地压缩提示词
- 服务端返回的是处理过的 `replacement_history`
- 有专门的 trace 追踪机制（`CompactionTraceContext`）

**历史裁剪（trim_function_call_history_to_fit_context_window）：**
在发送给远程端点之前，如果历史超过上下文窗口，从尾部删除 Codex 生成的项（function call output 等），直到适配。

### 3.3 Remote Compaction V2（Responses 策略）

**代码入口：** `compact_remote_v2.rs`

**工作流程：**

```
1. 获取历史快照 + 裁剪（同 V1）
2. 构建 Prompt 时在 input 末尾追加 ResponseItem::CompactionTrigger
3. 通过标准 Responses API 流式调用
4. 从流中收集恰好一个 Compaction 类型的输出项
5. 构建 compacted history: 保留 user/developer/system 消息 + Compaction 输出
6. 后处理：过滤 + 注入初始上下文
7. 替换会话历史
```

**与 V1 的核心区别：**
- 使用标准 Responses API（而非专用 `/compact` 端点）
- 通过 `CompactionTrigger` 信号项触发模型压缩行为
- 模型返回 `Compaction` 类型的加密内容项
- 保留 developer 和 system 消息（V1 丢弃 developer）
- 支持复用 client session（websocket 场景）

---

## 4. 压缩触发条件

### 4.1 触发方式

| 触发类型 | CompactionTrigger | CompactionReason | CompactionPhase |
|----------|-------------------|------------------|-----------------|
| 用户手动 | `Manual` | `UserRequested` | `StandaloneTurn` |
| 自动-上下文限制 | `Auto` | `ContextLimit` | `PreTurn` |
| 自动-中途压缩 | `Auto` | `ContextLimit` | `MidTurn` |
| 自动-模型降级 | `Auto` | `ModelDownshift` | `PreTurn` |

### 4.2 自动压缩判定逻辑

```rust
// codex-rs/core/src/session/turn.rs

async fn auto_compact_token_status() -> AutoCompactTokenStatus {
    // 两种作用域：
    match config.model_auto_compact_token_limit_scope {
        AutoCompactTokenLimitScope::Total => {
            // 比较 active_context_tokens vs 模型默认 auto_compact_token_limit
        }
        AutoCompactTokenLimitScope::BodyAfterPrefix => {
            // 比较 (active_context_tokens - prefill_input_tokens) 
            //   vs config.model_auto_compact_token_limit
            // 同时检查是否超过模型 context_window
        }
    }
    
    let token_limit_reached = 
        auto_compact_scope_tokens >= auto_compact_scope_limit 
        || full_context_window_limit_reached;
}
```

**两种触发时机：**

1. **Pre-turn 压缩**（`run_pre_sampling_compact`）：在采样请求之前运行，检查是否需要压缩
2. **Mid-turn 压缩**：在一次推理完成后，如果 token 超限且还有后续工作（tool call 返回后需要 follow-up），则在中途压缩

### 4.3 模型降级压缩（ModelDownshift）

当会话切换到更小上下文窗口的模型时，会先在旧模型上压缩，再切换：

```rust
async fn maybe_run_previous_model_inline_compact() {
    if old_context_window > new_context_window
        && previous_model_limit_reached
        && old_model != new_model {
        // 在旧模型上压缩
    }
}
```

---

## 5. 压缩输入输出格式

### 5.1 Local Compaction 的输入

```json
{
  "input": [
    // ... 完整历史 ...
    {
      "role": "user",
      "content": "<压缩提示词文本>"
    }
  ]
}
```

### 5.2 Remote V2 的输入

```json
{
  "input": [
    // ... 完整历史 ...
    { "type": "compaction_trigger" }  // 最后一项
  ],
  "instructions": "<base_instructions>",
  "tools": [...]
}
```

### 5.3 Local Compaction 的输出

```json
{
  "replacement_history": [
    // 可选: initial_context (developer/system 消息)
    { "role": "user", "content": "用户消息1" },
    { "role": "user", "content": "用户消息2" },
    {
      "role": "user",
      "content": "<SUMMARY_PREFIX>\n<LLM生成的摘要文本>"
    }
  ]
}
```

### 5.4 Remote V2 的输出

```json
{
  "replacement_history": [
    { "role": "developer", "content": "..." },
    { "role": "user", "content": "真实用户消息" },
    { "type": "compaction", "encrypted_content": "..." }  // 加密的压缩内容
  ]
}
```

### 5.5 Compaction Checkpoint（Rollout Trace）

压缩安装时记录的结构化数据：

```rust
pub struct CompactionCheckpointTracePayload<'a> {
    pub input_history: &'a [ResponseItem],        // 压缩前的历史
    pub replacement_history: &'a [ResponseItem],   // 压缩后的替换历史
}
```

---

## 6. 初始上下文注入策略

压缩后的一个关键问题是如何恢复系统指令/初始上下文。

```rust
pub(crate) enum InitialContextInjection {
    BeforeLastUserMessage,  // Mid-turn: 在最后一个用户消息前注入
    DoNotInject,            // Pre-turn/Manual: 不注入，下一轮采样会完整重建
}
```

**Mid-turn 压缩**需要注入，因为模型期望看到 compaction 摘要作为历史最后一项，初始上下文必须放在最后一个真实用户消息之前。

**Pre-turn/Manual 压缩**不需要注入，因为 `reference_context_item` 被清除，下一轮正常采样会完整重建初始上下文。

---

## 7. Hook 系统

压缩过程有 Pre/Post hook 点：

```rust
// Pre-compact hook: 可以阻止压缩
let pre_compact_outcome = run_pre_compact_hooks(&sess, &turn_context, trigger).await;
match pre_compact_outcome {
    PreCompactHookOutcome::Continue => {}
    PreCompactHookOutcome::Stopped { reason } => { return Err(CodexErr::TurnAborted); }
}

// Post-compact hook: 压缩成功后执行
let post_compact_outcome = run_post_compact_hooks(&sess, &turn_context, trigger).await;
if let PostCompactHookOutcome::Stopped = post_compact_outcome {
    return Err(CodexErr::TurnAborted);
}
```

---

## 8. Rollout Trace 中的压缩模型

在 `rollout-trace` crate 中，压缩被建模为一个完整的生命周期：

```
CompactionRequestStarted → CompactionRequestCompleted/Failed → CompactionInstalled
```

关键数据结构：
- `CompactionRequest`：记录一次压缩请求尝试（模型、provider、请求/响应 payload）
- `Compaction`：记录一次已安装的压缩（input/replacement/marker item ids）
- `ConversationItemKind::CompactionMarker`：在对话流中标记压缩边界

**Reducer 的核心机制：**
- 压缩安装后，设置 `pending_compaction_replacement_item_ids`
- 下一个完整采样请求使用这些 replacement ids 作为快照基准
- 这确保压缩后重复的 developer/context prefix 被识别为新的 post-compaction 对话项

---

## 9. 与 Claude Code 的对比

| 维度 | Codex CLI | Claude Code |
|------|-----------|-------------|
| **压缩方式** | LLM 生成摘要（Local）或服务端压缩（Remote） | LLM 生成摘要 |
| **提示词风格** | "交接文档"模式 — 帮下一个 LLM 无缝继续 | "总结到目前为止的对话" |
| **摘要注入** | 以 `user` 角色 + SUMMARY_PREFIX 注入 | 以特定格式注入 |
| **用户消息保留** | 20K token 预算，倒序保留最近的用户消息 | 保留策略不同 |
| **触发条件** | 基于 token 预算（可配置作用域）+ 上下文窗口 | 基于上下文窗口比例 |
| **Mid-turn 压缩** | ✅ 支持（工具调用后可立即压缩） | ✅ 支持 |
| **模型降级压缩** | ✅ 切换到更小模型前先压缩 | 不适用 |
| **远程压缩** | ✅ OpenAI 专用 `/compact` 端点 | 不适用 |
| **自定义提示词** | ✅ 完全可自定义（配置文件/CLI） | 有限支持 |
| **Hook 系统** | ✅ Pre/Post compact hooks | Hooks 支持 |
| **Trace 追踪** | ✅ 完整的压缩生命周期追踪 | 不适用 |

### 核心差异分析

1. **Codex 的"交接文档"提示词**更强调任务连续性，而 Claude Code 更侧重信息摘要。Codex 的提示词明确要求包含"clear next steps"，这对于长任务链的上下文保持非常关键。

2. **SUMMARY_PREFIX 的设计**很有价值——它明确告诉新 LLM "这是前一个 LLM 的摘要，你应该在此基础上继续工作，避免重复"。这种 framing 比简单的摘要注入更能引导模型行为。

3. **Remote Compaction** 是 Codex 独有的优势——利用 OpenAI 服务端的专用压缩端点，可以得到比本地压缩更好的质量（因为服务端可能有专门的压缩模型）。

4. **用户消息保留策略**（20K token 倒序）是一个实用的折衷——保留关键用户输入的同时控制总 token 数。

---

## 10. 关键代码文件索引

| 文件 | 作用 |
|------|------|
| `core/templates/compact/prompt.md` | 压缩提示词模板 |
| `core/templates/compact/summary_prefix.md` | 摘要前缀模板 |
| `core/src/compact.rs` | Local inline compaction 实现 |
| `core/src/compact_remote.rs` | Remote compaction V1 实现 |
| `core/src/compact_remote_v2.rs` | Remote compaction V2 实现 |
| `core/src/tasks/compact.rs` | 压缩任务分发（local/remote 选择） |
| `core/src/session/turn.rs` | 自动压缩触发逻辑 |
| `core/src/state/auto_compact_window.rs` | 压缩窗口 token 计数 |
| `core/src/session/turn_context.rs` | `compact_prompt()` 访问器 |
| `core/src/config/mod.rs` | `compact_prompt` 配置解析 |
| `rollout-trace/src/reducer/compaction.rs` | 压缩 trace reducer |
| `rollout-trace/src/reducer/conversation.rs` | 压缩 checkpoint 还原 |
| `rollout-trace/src/compaction.rs` | 压缩 trace writer |
| `core/tests/suite/compact.rs` | 压缩集成测试 |

---

## 11. 可借鉴的设计点

1. **交接文档式提示词**：比简单摘要更有效，明确要求"next steps"和"critical data"

2. **SUMMARY_PREFIX 框架**：用前缀文本明确告知模型这是压缩摘要，避免模型将摘要误解为当前任务指令

3. **Mid-turn 压缩 + 初始上下文注入**：在长工具调用链中也能保持上下文，初始上下文注入位置（最后一个用户消息前）经过精心设计

4. **压缩窗口（AutoCompactWindow）**：区分 prefill（前缀缓存）和 body（增量内容），基于增量 token 数触发压缩而非总量

5. **模型降级压缩**：切换模型时先在旧模型上压缩，避免上下文在新模型的更小窗口中溢出

6. **Pre/Post compact hooks**：允许用户在压缩前后执行自定义逻辑

7. **多层 fallback**：Remote V2 → Remote V1 → Local Inline，确保在任何环境下都有压缩能力
